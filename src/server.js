// Hosted mode: an MCP server over Streamable HTTP with its own OAuth front door, for any MCP client, on any machine
// that runs Docker. Same design as paper-remote-mcp's remote server:
//
// MCP clients see one OAuth authorization server + protected resource (the MCP authorization spec's shape). Signing in
// is Figma Desktop's own sign-in: after consent we create a Figma app-auth request, the person approves it on
// Figma's page in their own browser, and pastes back the one-time figma://app_auth/redeem?g_secret=… link Figma hands
// to the desktop app. We redeem it for a Figma web session. No Figma password ever touches this server.
//
// Nothing is stored. Everything handed out is AES-256-GCM ciphertext under SEAL_KEY, its purpose bound as associated
// data, carrying the state it needs:
//   client_id (DCR)  the registration                                        /register
//   state            the client's authorization request (10 min)            /authorize → consent → /authorize (POST)
//   flow             that request + Figma's app-auth id and cookies + a nonce (10 min)   sign-in page → /signin
//   code             Figma session cookies + user + the request (60 s)       /signin → the client → /token
//   access token     Figma session cookies, user id, grant id (1 h)          /mcp
//   refresh token    the same + the client id (30 days)                       /token: checked with Figma, renewals resealed
// Tool runs hold an account's browser context in memory (src/pool.js), and image assets for an hour (src/assets.js).
//
//   GET  /                                             landing page
//   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728
//   GET  /.well-known/oauth-authorization-server       RFC 8414
//   POST /register                                     RFC 7591 (public clients)
//   GET  /authorize | POST /authorize                  consent page | its answer (→ the sign-in page)
//   POST /signin                                       the pasted link
//   POST /token                                        authorization_code, refresh_token
//   POST /mcp                                          Streamable HTTP (JSON responses)
//   GET  /assets/<id>/<name>                           images from tool results (unguessable, 1 h)
import { timingSafeEqual as cryptoEqual } from 'node:crypto';
import http from 'node:http';
import { assetResponse, createAssetStore } from './assets.js';
import { figmaCookies, isSignedOut } from './figma.js';
import { dispatch } from './mcp.js';
import { LOOPBACK, consentPage, homePage, signInPage } from './pages.js';
import { createPool } from './pool.js';
import { checkSession, createAppAuth, grantUrl, redeemAppAuth, secretFromPaste } from './session.js';

const REQUEST_TTL = 600,
  CODE_TTL = 60,
  ACCESS_TTL = 3_600,
  REFRESH_TTL = 30 * 86_400;
const METADATA_MAX_BYTES = 10_240;
const MAX_BODY = 1024 * 1024;
const UNAVAILABLE = 'Figma is temporarily unavailable';
const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };
const HTML_HEADERS = {
  'content-type': 'text/html;charset=UTF-8',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
};
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id',
  'access-control-expose-headers': 'mcp-session-id, www-authenticate',
  'access-control-max-age': '86400',
};

/** @typedef {import('./figma.js').Cookie} Cookie */
/** @typedef {{ clientId: string, redirectUri: string, state?: string, codeChallenge: string, resource: string }} AuthRequest */
/** @typedef {{ redirectUris: string[], name?: string }} ClientMetadata */
/** @typedef {{ s: Cookie[], u: string, r: string, g: string, c: string }} Grant */
/**
 * @typedef {{ run<T>(user: string, cookies: Cookie[], fn: (e: import('./engine.js').Engine) => Promise<T>): Promise<T>,
 *   tools(user: string, cookies: Cookie[]): Promise<import('./engine.js').Tool[]>, warm(user: string, cookies: Cookie[]): void }} Pool
 */
// Sealed payloads use one-letter keys to keep tokens short: s = Figma session cookies, u = Figma user id, r = resource,
// c = client id, g = grant id, a = authorization request, i = Figma app-auth id, k = its cookies, n = nonce.

const enc = new TextEncoder(),
  dec = new TextDecoder();
const now = () => Math.floor(Date.now() / 1000);
const b64u = (/** @type {Uint8Array} */ bytes) => Buffer.from(bytes).toString('base64url');
const unb64u = (/** @type {string} */ s) => new Uint8Array(Buffer.from(s, 'base64url'));
const random = (n = 32) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const s256 = async (/** @type {string} */ v) => b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(v))));
/** Constant-time string comparison @param {string} a @param {string} b */
const timingSafeEqual = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && cryptoEqual(x, y);
};
/** The resources a token may be bound to (RFC 8707); the MCP endpoint is the canonical one @param {URL} url */
const resources = (url) => [`${url.origin}/mcp`, url.origin, `${url.origin}/`];

// --- sealing -------------------------------------------------------------------------------------------------------

/** @param {string} raw */
function importKey(raw) {
  const bytes = unb64u(raw.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  if (bytes.length !== 32) throw new Error('SEAL_KEY must be 32 random bytes, base64 (openssl rand -base64 32)');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
const pipe = async (/** @type {Uint8Array} */ bytes, /** @type {CompressionStream | DecompressionStream} */ through) =>
  new Uint8Array(await new Response(new Blob([/** @type {BlobPart} */ (bytes)]).stream().pipeThrough(through)).arrayBuffer());

/**
 * Encrypts `value` for `purpose` (it never opens as another), expiring after `ttl` seconds.
 * ponytail: one key, no rotation; rotating SEAL_KEY signs everyone out. Add a SEAL_KEY_PREVIOUS if that matters.
 * @param {Promise<CryptoKey>} key @param {string} purpose @param {object} value @param {number} [ttl]
 */
export async function seal(key, purpose, value, ttl) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = await pipe(enc.encode(JSON.stringify(ttl ? { ...value, exp: now() + ttl } : value)), new CompressionStream('deflate-raw'));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(purpose) }, await key, body));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64u(out);
}

/**
 * The value sealed for `purpose`; undefined when it isn't one (forged, another purpose's or key's) or has expired.
 * @template T @param {Promise<CryptoKey>} key @param {string} purpose @param {string | null | undefined} token
 * @returns {Promise<T | undefined>}
 */
export async function open(key, purpose, token) {
  if (!token) return undefined;
  try {
    const raw = unb64u(token);
    const algorithm = { name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: enc.encode(purpose) };
    const body = new Uint8Array(await crypto.subtle.decrypt(algorithm, await key, raw.slice(12)));
    const value = JSON.parse(dec.decode(await pipe(body, new DecompressionStream('deflate-raw'))));
    return value.exp && value.exp < now() ? undefined : value;
  } catch {
    return undefined;
  }
}

// --- responses -----------------------------------------------------------------------------------------------------

const json = (/** @type {unknown} */ body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...NO_STORE, ...CORS, ...headers } });
const plain = (/** @type {string} */ body, status = 400) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain;charset=UTF-8', ...NO_STORE } });
const oauthError = (/** @type {string} */ error, /** @type {string} */ description, status = 400) =>
  json({ error, error_description: description }, status);
/** @param {string} to @param {Record<string, string | undefined>} params @param {string[]} [cookies] */
function redirect(to, params, cookies = []) {
  const url = new URL(to);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  const headers = new Headers({ location: url.href, ...NO_STORE });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status: 302, headers });
}
/** @param {string} body @param {string[]} [cookies] */
function page(body, cookies = [], status = 200) {
  const headers = new Headers(HTML_HEADERS);
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(body, { status, headers });
}

// A flow's cookie is named after its value's first characters, so two sign-ins at once in one browser don't collide.
const cookieName = (/** @type {string} */ prefix, /** @type {string} */ value) => `__Host-${prefix}-${value.slice(0, 12)}`;
const setCookie = (/** @type {string} */ prefix, /** @type {string} */ value, /** @type {number} */ maxAge) =>
  `${cookieName(prefix, value)}=${maxAge ? value : ''}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
/** Whether the browser holds the flow cookie for `value` @param {Request} request @param {string} prefix @param {string} value */
function hasCookie(request, prefix, value) {
  const name = cookieName(prefix, value);
  for (const pair of (request.headers.get('cookie') ?? '').split(/;\s*/)) {
    const at = pair.indexOf('=');
    if (pair.slice(0, at) === name) return timingSafeEqual(pair.slice(at + 1), value);
  }
  return false;
}

// --- clients -------------------------------------------------------------------------------------------------------

/** `asked` is one of `registered`: exactly, or a loopback http URI on any port (RFC 8252 §7.3) */
export function redirectMatches(/** @type {string[]} */ registered, /** @type {string} */ asked) {
  if (registered.includes(asked)) return true;
  let to;
  try {
    to = new URL(asked);
  } catch {
    return false;
  }
  if (to.protocol !== 'http:' || !LOOPBACK.has(to.hostname)) return false;
  return registered.some((uri) => {
    try {
      const r = new URL(uri);
      return r.protocol === 'http:' && r.hostname === to.hostname && r.pathname === to.pathname && r.search === to.search;
    } catch {
      return false;
    }
  });
}
/** A redirect URI a client may register: absolute, no fragment, never a script @param {unknown} value */
const validRedirect = (value) => {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return !url.hash && !['javascript:', 'data:', 'vbscript:', 'file:'].includes(url.protocol);
  } catch {
    return false;
  }
};
/** @returns {ClientMetadata | undefined} */
function clientMetadata(/** @type {any} */ doc) {
  const uris = doc?.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every(validRedirect)) return undefined;
  const name = typeof doc.client_name === 'string' && doc.client_name.length <= 100 ? doc.client_name : undefined;
  return { redirectUris: uris, name };
}

/**
 * Whether a client metadata document's host looks public: not an IP literal, localhost or an internal name, so
 * `client_id` can't make this server fetch from its own network.
 * ponytail: names only, no DNS check (a public name resolving to a private address still gets fetched); resolve and
 * check the address if this server runs next to anything sensitive.
 * @param {string} host
 */
const publicHost = (host) =>
  !/^\[|^\d+\.\d+\.\d+\.\d+$|^localhost$|\.(localhost|local|internal|lan|home|corp)$/i.test(host) && host.includes('.');

/** A response body as text, or undefined past `max` bytes @param {Response} res @param {number} max */
async function cappedText(res, max) {
  const reader = res.body?.getReader();
  if (!reader) return undefined;
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if ((size += value.length) > max) return void reader.cancel();
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// --- the app -------------------------------------------------------------------------------------------------------

/**
 * The server as a fetch handler, so tests drive it without sockets.
 * @param {{ sealKey: string, publicUrl?: string, pool: Pool, assets: ReturnType<typeof createAssetStore>, devMode?: boolean,
 *   figma?: { createAppAuth: typeof createAppAuth, redeemAppAuth: typeof redeemAppAuth, checkSession: typeof checkSession },
 *   fetchClient?: typeof fetch }} options
 */
export function createApp({ sealKey, publicUrl, pool, assets, devMode = false, figma = { createAppAuth, redeemAppAuth, checkSession }, fetchClient = fetch }) {
  const key = importKey(sealKey);
  key.catch(() => {});

  /** The client a `client_id` names: a metadata document's https URL (fetched), or one /register sealed. @param {string | null} id */
  async function findClient(id) {
    if (!id) return undefined;
    if (id.startsWith('https://')) {
      let docUrl;
      try {
        docUrl = new URL(id);
      } catch {
        return undefined;
      }
      if (docUrl.pathname === '/' || !publicHost(docUrl.hostname)) return undefined;
      const res = await fetchClient(id, { headers: { accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
      const raw = res?.ok ? await cappedText(res, METADATA_MAX_BYTES).catch(() => undefined) : undefined;
      let doc;
      try {
        doc = raw && JSON.parse(raw);
      } catch {}
      return doc?.client_id === id ? clientMetadata(doc) : undefined;
    }
    /** @type {{ m: any } | undefined} */
    const sealed = await open(key, 'client', id);
    return sealed && clientMetadata(sealed.m);
  }

  /** RFC 7591. Every client is public (PKCE is its proof). @param {Request} request */
  async function register(request) {
    const client = clientMetadata(await request.json().catch(() => undefined));
    if (!client) return oauthError('invalid_redirect_uri', 'redirect_uris: 1–10 absolute URIs, no fragment');
    const m = { redirect_uris: client.redirectUris, client_name: client.name };
    return json(
      {
        client_id: await seal(key, 'client', { m }),
        client_id_issued_at: now(),
        ...m,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      201,
    );
  }

  /** @param {URL} url */
  async function authorizePage(url) {
    const param = (/** @type {string} */ name) => url.searchParams.get(name);
    const clientId = param('client_id');
    const client = await findClient(clientId);
    if (!clientId || !client) return plain('Invalid client_id');
    const redirectUri = param('redirect_uri') ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
    if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri)) {
      return plain('Invalid redirect_uri: it is not one this client registered');
    }
    const state = param('state') ?? undefined;
    // From here errors go back to the client, as OAuth requires (RFC 6749 §4.1.2.1)
    const refuse = (/** @type {string} */ error, /** @type {string} */ description) =>
      redirect(redirectUri, { error, error_description: description, state, iss: url.origin });
    if (param('response_type') !== 'code') return refuse('unsupported_response_type', 'Only response_type=code is supported');
    const codeChallenge = param('code_challenge');
    if (!codeChallenge || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeChallenge)) return refuse('invalid_request', 'code_challenge is required (PKCE)');
    if (param('code_challenge_method') !== 'S256') return refuse('invalid_request', 'code_challenge_method must be S256');
    const resource = param('resource') ?? `${url.origin}/mcp`;
    if (!resources(url).includes(resource)) return refuse('invalid_target', 'The requested resource is not served here');
    /** @type {AuthRequest} */
    const authRequest = { clientId, redirectUri, ...(state && { state }), codeChallenge, resource };
    const csrf = random();
    const html = consentPage({
      clientName: client.name || 'An MCP client',
      redirectUri,
      clientHost: clientId.startsWith('https://') ? new URL(clientId).host : undefined,
      state: await seal(key, 'request', authRequest, REQUEST_TTL),
      csrfToken: csrf,
    });
    return page(html, [setCookie('CSRF', csrf, REQUEST_TTL)]);
  }

  /** The consent page's answer: back to the client (Cancel), or a Figma app-auth request and the sign-in page. */
  async function consent(/** @type {Request} */ request, /** @type {URL} */ url) {
    const form = new URLSearchParams(await request.text());
    const csrf = form.get('csrf_token') ?? '';
    if (!csrf || !hasCookie(request, 'CSRF', csrf)) return plain('Invalid CSRF token');
    /** @type {AuthRequest | undefined} */
    const authRequest = await open(key, 'request', form.get('state'));
    if (!authRequest) return plain('This authorization request has expired. Start again from your MCP client.');
    const clear = setCookie('CSRF', csrf, 0);
    if (form.get('action') !== 'approve') {
      return redirect(authRequest.redirectUri, { error: 'access_denied', state: authRequest.state, iss: url.origin }, [clear]);
    }
    const appAuth = await figma.createAppAuth();
    if (!appAuth) return page(signInPage({ flow: '', grantUrl: 'https://www.figma.com/', message: `${UNAVAILABLE}. Go back to your MCP client and try again.` }), [clear], 503);
    const nonce = random();
    const flow = await seal(key, 'signin', { a: authRequest, i: appAuth.id, k: appAuth.cookies, n: nonce }, REQUEST_TTL);
    return page(signInPage({ flow, grantUrl: grantUrl(appAuth.id) }), [clear, setCookie('SIGNIN', nonce, REQUEST_TTL)]);
  }

  /** The pasted figma:// link: its secret redeemed for a Figma session, and the client gets our code. */
  async function signIn(/** @type {Request} */ request, /** @type {URL} */ url) {
    const form = new URLSearchParams(await request.text());
    const flow = form.get('flow') ?? '';
    /** @type {{ a: AuthRequest, i: string, k: Cookie[], n: string } | undefined} */
    const job = await open(key, 'signin', flow);
    if (!job || !hasCookie(request, 'SIGNIN', job.n)) return plain('This sign-in has expired. Start again from your MCP client.');
    const again = (/** @type {string} */ message) => page(signInPage({ flow, grantUrl: grantUrl(job.i), message }));
    const secret = secretFromPaste(form.get('link') ?? '');
    if (!secret) return again('That is not the figma://app_auth/redeem?g_secret=… link. Copy the whole link and paste it here.');
    const session = await figma.redeemAppAuth(secret, job.k);
    if (session === undefined) return again(`${UNAVAILABLE}. Try again.`);
    if (session === null) return again('Figma refused that link: it may have expired or been used already (Figma Desktop may have used it). Approve again and paste the new link.');
    // ponytail: nothing is stored, so a code is not single-use; it lives 60 s and is useless without the PKCE verifier.
    const ourCode = await seal(key, 'code', { a: job.a, s: figmaCookies(session.cookies), u: session.user }, CODE_TTL);
    return redirect(job.a.redirectUri, { code: ourCode, state: job.a.state, iss: url.origin }, [setCookie('SIGNIN', job.n, 0)]);
  }

  /** Seals a grant into the client's token pair. @param {Grant} grant */
  async function issue({ s, u, c, r, g }) {
    return json({
      access_token: await seal(key, 'access', { s, u, r, g }, ACCESS_TTL),
      token_type: 'Bearer',
      expires_in: ACCESS_TTL,
      refresh_token: await seal(key, 'refresh', { s, u, c, r, g }, REFRESH_TTL),
      resource: r,
    });
  }

  async function token(/** @type {Request} */ request, /** @type {URL} */ url) {
    const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (type !== 'application/x-www-form-urlencoded') return oauthError('invalid_request', 'Content-Type must be application/x-www-form-urlencoded');
    const form = new URLSearchParams(await request.text());
    const basic = /^basic\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
    let clientId = form.get('client_id');
    if (!clientId && basic) {
      try {
        clientId = decodeURIComponent(atob(basic).split(':')[0]);
      } catch {}
    }
    if (!clientId) return oauthError('invalid_client', 'client_id is required', 401);
    const resource = form.get('resource');
    if (resource && !resources(url).includes(resource)) return oauthError('invalid_target', 'The resource is not served here');

    if (form.get('grant_type') === 'authorization_code') {
      /** @type {{ a: AuthRequest, s: Cookie[], u: string } | undefined} */
      const code = await open(key, 'code', form.get('code'));
      if (!code || code.a.clientId !== clientId) return oauthError('invalid_grant', 'Invalid authorization code');
      const redirectUri = form.get('redirect_uri');
      if (redirectUri && redirectUri !== code.a.redirectUri) return oauthError('invalid_grant', 'Invalid redirect_uri');
      const verifier = form.get('code_verifier');
      if (!verifier) return oauthError('invalid_request', 'code_verifier is required (PKCE)');
      if (!timingSafeEqual(await s256(verifier), code.a.codeChallenge)) return oauthError('invalid_grant', 'Invalid PKCE code_verifier');
      if (resource && resource !== code.a.resource) return oauthError('invalid_target', 'resource does not match the authorized resource');
      return issue({ s: code.s, u: code.u, c: clientId, r: code.a.resource, g: random(12) });
    }
    if (form.get('grant_type') === 'refresh_token') {
      /** @type {Grant | undefined} */
      const refresh = await open(key, 'refresh', form.get('refresh_token'));
      if (!refresh || refresh.c !== clientId) return oauthError('invalid_grant', 'Invalid refresh token');
      if (resource && resource !== refresh.r) return oauthError('invalid_target', 'resource does not match the authorized resource');
      const cookies = await figma.checkSession(refresh.s);
      if (cookies === null) return oauthError('invalid_grant', 'The Figma session has ended. Sign in again.');
      if (!cookies) return oauthError('temporarily_unavailable', `${UNAVAILABLE}. Try again.`, 503);
      return issue({ ...refresh, s: cookies });
    }
    return oauthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  }

  /** @param {URL} url @param {boolean} presented */
  const unauthorized = (url, presented) =>
    json({ error: 'invalid_token', error_description: presented ? 'The access token is invalid or expired' : 'Authorization needed' }, 401, {
      'www-authenticate': `Bearer ${presented ? 'error="invalid_token", ' : ''}resource_metadata="${url.origin}/.well-known/oauth-protected-resource/mcp"`,
    });

  /**
   * Streamable HTTP, JSON responses only, one JSON-RPC message per POST. Stateless: the session id is a random UUID
   * with the client's name after it, so later requests can tell Figma which client this is.
   * @param {Request} request @param {URL} url
   */
  async function mcp(request, url) {
    const bearer = /^bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
    /** @type {Omit<Grant, 'c'> | undefined} */
    const access = await open(key, 'access', bearer);
    if (!access || !resources(url).includes(access.r)) return unauthorized(url, Boolean(bearer));
    if (request.method === 'DELETE') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST, DELETE', ...CORS } });
    let msg;
    try {
      msg = JSON.parse(await request.text());
    } catch {
      return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'One JSON-RPC message per request' } }, 400);
    }
    let name = 'unknown';
    try {
      name = dec.decode(unb64u(request.headers.get('mcp-session-id')?.split('.')[1] ?? '')) || name;
    } catch {}
    /** @type {import('./engine.js').ClientInfo} */
    let clientInfo = { name };
    const reply = await dispatch(msg, {
      devMode,
      clientInfo: () => clientInfo,
      onInitialize: (c) => {
        clientInfo = c;
        pool.warm(access.u, access.s); // the first tool call shouldn't wait for the account's browser context
      },
      // Every engine use runs in the account's queue: one page state, one call at a time.
      engine: async () => ({
        tools: () => pool.tools(access.u, access.s),
        call: (...args) => pool.run(access.u, access.s, (e) => e.call(...args)),
        plugin: (...args) => pool.run(access.u, access.s, (e) => e.plugin(...args)),
      }),
    }).catch((err) => {
      if (isSignedOut(err)) return 'auth';
      throw err;
    });
    if (reply === 'auth') return unauthorized(url, true);
    if (!reply) return new Response(null, { status: 202, headers: CORS });
    const headers = msg.method === 'initialize' ? { 'mcp-session-id': `${crypto.randomUUID()}.${b64u(enc.encode(clientInfo.name))}` } : {};
    return json(reply, 200, headers);
  }

  return {
    /** @param {Request} request */
    async fetch(request) {
      const url = new URL(request.url);
      if (publicUrl) url.href = new URL(url.pathname + url.search, publicUrl).href;
      const { pathname: path } = url,
        method = request.method;
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
        return json({ resource: `${url.origin}/mcp`, authorization_servers: [url.origin], bearer_methods_supported: ['header'], resource_name: 'Figma Remote MCP' });
      }
      if (path === '/.well-known/oauth-authorization-server') {
        return json({
          issuer: url.origin,
          authorization_endpoint: `${url.origin}/authorize`,
          token_endpoint: `${url.origin}/token`,
          registration_endpoint: `${url.origin}/register`,
          response_types_supported: ['code'],
          response_modes_supported: ['query'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: ['S256'],
          authorization_response_iss_parameter_supported: true,
          client_id_metadata_document_supported: true,
        });
      }
      if (path === '/mcp') return mcp(request, url);
      if (path === '/authorize') return method === 'POST' ? consent(request, url) : authorizePage(url);
      if (path === '/signin' && method === 'POST') return signIn(request, url);
      if (path === '/token' && method === 'POST') return token(request, url);
      if (path === '/register' && method === 'POST') return register(request);
      if (path === '/healthz') return json({ ok: true });
      if (path === '/' && method === 'GET') return page(homePage(`${url.origin}/mcp`));
      return assetResponse(assets, method, path) ?? plain('Not found', 404);
    },
  };
}

/** @param {{ port: number, log: import('./figma.js').Log }} options */
export async function startServer({ port, log }) {
  const sealKey = process.env.SEAL_KEY;
  if (!sealKey) throw new Error('SEAL_KEY is required (openssl rand -base64 32)');
  const publicUrl = process.env.PUBLIC_URL;
  // Asset links use PUBLIC_URL; without one, this machine's own address (never a request's Host header, which
  // anyone can set).
  const origin = publicUrl?.replace(/\/+$/, '') ?? `http://localhost:${port}`;
  const assets = createAssetStore({ baseUrl: () => origin });
  const pool = createPool({ log, putAsset: assets.put });
  const app = createApp({ sealKey, publicUrl, pool, assets, devMode: process.env.FIGMA_DEV_MODE_TOOLS === '1' });
  await importKey(sealKey);

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        if ((size += chunk.length) > MAX_BODY) return void res.writeHead(413).end('Request body over 1 MB');
        chunks.push(chunk);
      }
      const body = chunks.length && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined;
      const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, {
        method: req.method,
        headers,
        ...(body && { body, duplex: 'half' }),
      });
      const response = await app.fetch(request);
      /** @type {Record<string, string | string[]>} */
      const out = {};
      response.headers.forEach((value, name) => {
        if (name !== 'set-cookie') out[name] = value;
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) out['set-cookie'] = cookies;
      res.writeHead(response.status, out);
      res.end(Buffer.from(await response.arrayBuffer()));
      if (!(req.url ?? '').startsWith('/assets/')) log.info(`${req.method} ${(req.url ?? '').split('?')[0]} ${response.status} ${Date.now() - started}ms`);
    } catch (err) {
      log.error(`${req.method} ${(req.url ?? '').split('?')[0]}: ${/** @type {any} */ (err)?.stack ?? err}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Internal error');
    }
  });
  // 0.0.0.0: in Docker the publish rule restricts exposure (e.g. -p 127.0.0.1:8080:8080); HOST=127.0.0.1 for a bare run.
  const host = process.env.HOST || '0.0.0.0';
  server.listen(port, host, () => log.info(`figma-remote-mcp listening on http://${host}:${port}${publicUrl ? ` (public ${publicUrl})` : ''}`));
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      server.close();
      pool.close().finally(() => process.exit(0));
    });
  }
  return { server, close: () => pool.close() };
}

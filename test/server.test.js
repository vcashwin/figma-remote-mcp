// The hosted server's whole OAuth + sign-in + MCP flow against a faked Figma and a faked engine pool. `npm test`
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createAssetStore } from '../src/assets.js';
import { createApp, open, redirectMatches } from '../src/server.js';

const ORIGIN = 'https://figma-mcp.example';
const REGISTERED = 'http://127.0.0.1:33418/callback';
const REDIRECT = 'http://127.0.0.1:50000/callback'; // the same loopback URI on another port (RFC 8252)
const SECRET = 'g-secret-0123456789abcdef';
const SEAL_KEY = randomBytes(32).toString('base64');
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const sessionCookie = (value = 'v1') => ({ name: '__Host-figma.authn', value, domain: 'www.figma.com', path: '/' });

/** A faked Figma: app-auth requests and redemptions, and a session check whose answer the test sets. */
function fakeFigma() {
  const state = { created: 0, redeemed: /** @type {string[]} */ ([]), check: /** @type {'ok' | 'out' | 'down'} */ ('ok') };
  return {
    state,
    figma: {
      createAppAuth: async () => (state.created++, { id: 'app-auth-id-1', cookies: [{ name: 'figma.session', value: 'anon', domain: '.www.figma.com', path: '/' }] }),
      redeemAppAuth: async (/** @type {string} */ secret, /** @type {any[]} */ cookies) => {
        if (secret === 'down-down-down-down') return undefined;
        if (secret !== SECRET || state.redeemed.includes(secret)) return null;
        state.redeemed.push(secret);
        assert.equal(cookies[0].value, 'anon', 'redeemed with the cookies the request was created with');
        return { cookies: [...cookies, sessionCookie()], user: '1000000000000000001' };
      },
      checkSession: async (/** @type {any[]} */ cookies) =>
        state.check === 'ok' ? cookies.map((c) => (c.name === '__Host-figma.authn' ? { ...c, value: 'v2' } : c)) : state.check === 'out' ? null : undefined,
    },
  };
}

/** A faked pool: records which account each call ran for, and with which cookies */
function fakePool() {
  const runs = /** @type {{ user: string, cookies: any[], what: string }[]} */ ([]);
  const engine = /** @type {any} */ ({
    tools: async () => [{ name: 'get_metadata', inputSchema: { type: 'object', properties: { nodeId: { type: 'string' } } } }],
    plugin: async (/** @type {string} */ name, /** @type {any} */ args) =>
      args.fileKey === 'signed-out' ? Promise.reject(Object.assign(new Error('ended'), { code: 'auth' })) : { content: [{ type: 'text', text: `${name} ok` }] },
    call: async (/** @type {string} */ name, /** @type {any} */ args) =>
      args.fileKey === 'signed-out' ? Promise.reject(Object.assign(new Error('ended'), { code: 'auth' })) : { content: [{ type: 'text', text: `${name} ok` }] },
  });
  /** @type {any} */
  const pool = {
    runs,
    warmed: 0,
    run: async (/** @type {string} */ user, /** @type {any[]} */ cookies, /** @type {any} */ fn) => (runs.push({ user, cookies, what: 'run' }), fn(engine)),
    tools: async (/** @type {string} */ user, /** @type {any[]} */ cookies) => (runs.push({ user, cookies, what: 'tools' }), engine.tools()),
    warm: () => void pool.warmed++,
  };
  return pool;
}

function setup() {
  const { figma, state } = fakeFigma();
  const pool = fakePool();
  const app = createApp({ sealKey: SEAL_KEY, publicUrl: ORIGIN, pool, assets: createAssetStore({ baseUrl: () => ORIGIN }), figma });
  const call = (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) => app.fetch(new Request(`http://internal${path}`, init));
  const form = (/** @type {Record<string, string>} */ body, cookie = '') => ({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie && { cookie }) },
    body: new URLSearchParams(body).toString(),
  });
  return { app, call, form, state, pool };
}

const field = (/** @type {string} */ html, /** @type {string} */ name) =>
  /** @type {string} */ (new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1]).replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)));
const cookieOf = (/** @type {Response} */ res, /** @type {string} */ prefix) =>
  /** @type {string} */ (res.headers.getSetCookie().find((c) => c.startsWith(`__Host-${prefix}`))).split(';')[0];

/** Register → consent → sign-in page. @param {ReturnType<typeof setup>} s */
async function toSignIn(s) {
  const reg = await (await s.call('/register', { method: 'POST', body: JSON.stringify({ redirect_uris: [REGISTERED], client_name: 'Claude <Code>' }) })).json();
  const query = new URLSearchParams({ client_id: reg.client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 's1' });
  const consent = await s.call(`/authorize?${query}`);
  const html = await consent.text();
  assert.match(html, /Claude &#60;Code&#62;/, 'the client name is escaped');
  assert.match(html, /Unverified app/);
  const signIn = await s.call('/authorize', s.form({ state: field(html, 'state'), csrf_token: field(html, 'csrf_token'), action: 'approve' }, cookieOf(consent, 'CSRF')));
  return { reg, signIn, page: await signIn.text(), cookie: cookieOf(signIn, 'SIGNIN') };
}

test('metadata and the 401 challenge point clients at this server', async () => {
  const s = setup();
  const prm = await (await s.call('/.well-known/oauth-protected-resource/mcp')).json();
  assert.deepEqual([prm.resource, prm.authorization_servers], [`${ORIGIN}/mcp`, [ORIGIN]]);
  const as = await (await s.call('/.well-known/oauth-authorization-server')).json();
  assert.equal(as.token_endpoint, `${ORIGIN}/token`);
  const res = await s.call('/mcp', { method: 'POST', body: '{}' });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /resource_metadata="https:\/\/figma-mcp\.example\/\.well-known\/oauth-protected-resource\/mcp"/);
});

test('register → consent → Figma approval (pasted link) → code → token → refresh → MCP', async () => {
  const s = setup();
  const { reg, page, cookie } = await toSignIn(s);
  assert.equal(s.state.created, 1, 'a Figma app-auth request per sign-in');
  assert.match(page, /https:\/\/www\.figma\.com\/app_auth\/app-auth-id-1\/grant\?desktop_protocol=figma/);
  assert.match(page, /npx figma-remote-mcp grant/);
  const flow = field(page, 'flow');

  const garbage = await (await s.call('/signin', s.form({ flow, link: 'nope' }, cookie))).text();
  assert.match(garbage, /not the figma:\/\/app_auth\/redeem/);
  const down = await (await s.call('/signin', s.form({ flow, link: 'down-down-down-down' }, cookie))).text();
  assert.match(down, /temporarily unavailable/);
  const noCookie = await s.call('/signin', s.form({ flow, link: `figma://app_auth/redeem?g_secret=${SECRET}` }));
  assert.match(await noCookie.text(), /expired/, 'the flow is bound to the browser that started it');

  const done = await s.call('/signin', s.form({ flow, link: `figma://app_auth/redeem?g_secret=${SECRET}` }, cookie));
  assert.equal(done.status, 302);
  const back = new URL(/** @type {string} */ (done.headers.get('location')));
  assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
  assert.equal(back.searchParams.get('state'), 's1');
  assert.equal(back.searchParams.get('iss'), ORIGIN);
  const again = await (await s.call('/signin', s.form({ flow, link: `figma://app_auth/redeem?g_secret=${SECRET}` }, cookie))).text();
  assert.match(again, /refused that link/, 'a used secret is refused');

  const code = /** @type {string} */ (back.searchParams.get('code'));
  const badPkce = await (await s.call('/token', s.form({ grant_type: 'authorization_code', code, client_id: reg.client_id, code_verifier: 'x'.repeat(43) }))).json();
  assert.equal(badPkce.error, 'invalid_grant');
  const tokens = await (await s.call('/token', s.form({ grant_type: 'authorization_code', code, client_id: reg.client_id, code_verifier: verifier, redirect_uri: REDIRECT }))).json();
  assert.equal(tokens.token_type, 'Bearer');
  assert.equal(tokens.expires_in, 3600);

  // refresh asks Figma and seals its renewals in
  const refreshed = await (await s.call('/token', s.form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: reg.client_id }))).json();
  assert.ok(refreshed.access_token);
  const raw = SEAL_KEY.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const key = crypto.subtle.importKey('raw', Buffer.from(raw, 'base64url'), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const grant = /** @type {any} */ (await open(key, 'access', refreshed.access_token));
  assert.equal(grant.s.find((/** @type {any} */ c) => c.name === '__Host-figma.authn').value, 'v2');
  assert.equal(await open(key, 'refresh', refreshed.access_token), undefined, "an access token never opens as a refresh token");

  s.state.check = 'down';
  assert.equal((await s.call('/token', s.form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: reg.client_id }))).status, 503);
  s.state.check = 'out';
  assert.equal((await (await s.call('/token', s.form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: reg.client_id }))).json()).error, 'invalid_grant');
  assert.equal((await (await s.call('/token', s.form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: 'other' }))).json()).error, 'invalid_grant');

  // MCP
  const mcp = (/** @type {object} */ body, sid = '') =>
    s.call('/mcp', { method: 'POST', headers: { authorization: `Bearer ${refreshed.access_token}`, 'content-type': 'application/json', ...(sid && { 'mcp-session-id': sid }) }, body: JSON.stringify(body) });
  const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'cursor' } } });
  const sid = /** @type {string} */ (init.headers.get('mcp-session-id'));
  assert.equal(s.pool.warmed, 1, 'initialize starts the editor');
  assert.equal((await init.json()).result.serverInfo.name, 'figma-remote-mcp');
  const list = await (await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sid)).json();
  assert.equal(list.result.tools.length, 71);
  assert.ok(list.result.tools[0].inputSchema.properties.fileKey);
  const called = await (await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_metadata', arguments: { fileKey: 'abc' } } }, sid)).json();
  assert.deepEqual(called.result, { content: [{ type: 'text', text: 'get_metadata ok' }] });
  assert.ok(s.pool.runs.every((/** @type {any} */ r) => r.user === '1000000000000000001'), 'calls run as the signed-in Figma user');
  assert.equal((await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_metadata', arguments: { fileKey: 'signed-out' } } }, sid)).status, 401, "Figma signing out is the client's 401");
  assert.equal((await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid)).status, 202);
  assert.equal((await mcp(/** @type {any} */ ([1, 2]), sid)).status, 400);
});

test('consent: Cancel returns access_denied; a missing CSRF cookie is refused', async () => {
  const s = setup();
  const reg = await (await s.call('/register', { method: 'POST', body: JSON.stringify({ redirect_uris: [REGISTERED] }) })).json();
  const query = new URLSearchParams({ client_id: reg.client_id, redirect_uri: REGISTERED, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 's2' });
  const consent = await s.call(`/authorize?${query}`);
  const html = await consent.text();
  const body = { state: field(html, 'state'), csrf_token: field(html, 'csrf_token') };
  assert.match(await (await s.call('/authorize', s.form({ ...body, action: 'approve' }))).text(), /Invalid CSRF/);
  const cancel = await s.call('/authorize', s.form({ ...body, action: 'deny' }, cookieOf(consent, 'CSRF')));
  const to = new URL(/** @type {string} */ (cancel.headers.get('location')));
  assert.deepEqual([to.searchParams.get('error'), to.searchParams.get('state')], ['access_denied', 's2']);
  assert.equal(s.state.created, 0, 'no Figma request without consent');
});

test('authorize refuses unregistered redirects, missing PKCE, script redirects and forged clients', async () => {
  const s = setup();
  const reg = await (await s.call('/register', { method: 'POST', body: JSON.stringify({ redirect_uris: [REGISTERED] }) })).json();
  const ask = (/** @type {Record<string, string>} */ p) =>
    s.call(`/authorize?${new URLSearchParams({ client_id: reg.client_id, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', ...p })}`);
  assert.match(await (await ask({ redirect_uri: 'https://evil.example/cb' })).text(), /Invalid redirect_uri/);
  const noPkce = await ask({ redirect_uri: REGISTERED, code_challenge: '' });
  assert.equal(new URL(/** @type {string} */ (noPkce.headers.get('location'))).searchParams.get('error'), 'invalid_request');
  assert.match(await (await ask({ redirect_uri: REGISTERED, client_id: 'forged' })).text(), /Invalid client_id/);
  for (const internal of ['https://127.0.0.1/client.json', 'https://localhost/c.json', 'https://metadata.internal/c.json', 'https://intranet/c.json']) {
    assert.match(await (await ask({ redirect_uri: REGISTERED, client_id: internal })).text(), /Invalid client_id/, internal);
  }
  assert.equal((await s.call('/register', { method: 'POST', body: JSON.stringify({ redirect_uris: ['javascript:alert(1)'] }) })).status, 400);
  assert.ok(redirectMatches([REGISTERED], REDIRECT));
  assert.ok(!redirectMatches([REGISTERED], 'http://127.0.0.1:50000/other'));
  assert.ok(!redirectMatches(['https://a.example/cb'], 'https://a.example:444/cb'));
});

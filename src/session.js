// A Figma web session as a list of cookies, and the three requests the hosted sign-in makes: Figma Desktop's own
// app-auth flow (create a request, the person approves it in their own browser, redeem the one-time secret).
import { FIGMA, USER_AGENT, cookieHeader, figmaCookies } from './figma.js';

/** @typedef {import('./figma.js').Cookie} Cookie */
const HOST = new URL(FIGMA).host;
const now = () => Math.floor(Date.now() / 1000);
const headers = (/** @type {Cookie[]} */ cookies = []) => ({
  'user-agent': USER_AGENT,
  'content-type': 'application/json',
  origin: FIGMA,
  'x-csrf-bypass': 'yes',
  ...(cookies.length && { cookie: cookieHeader(cookies) }),
});

/**
 * Set-Cookie renewals applied to `cookies` (a renewed cookie replaces its old self; a deleted one goes).
 * @param {Cookie[]} cookies @param {string[]} lines Set-Cookie headers from `host` @param {string} [host]
 * @returns {Cookie[]}
 */
export function renewCookies(cookies, lines, host = HOST) {
  let out = cookies;
  for (const line of lines) {
    const [pair, ...rest] = line.split(';');
    const at = pair.indexOf('=');
    if (at < 1) continue;
    /** @type {Record<string, string>} */
    const attr = {};
    for (const a of rest) {
      const i = a.indexOf('=');
      attr[(i < 0 ? a : a.slice(0, i)).trim().toLowerCase()] = i < 0 ? '' : a.slice(i + 1).trim();
    }
    const name = pair.slice(0, at).trim();
    const domain = attr.domain ? `.${attr.domain.replace(/^\./, '')}` : host;
    const path = attr.path || '/';
    const maxAge = Number.parseInt(attr['max-age'], 10);
    const expires = Number.isFinite(maxAge) ? now() + maxAge : attr.expires ? Math.floor(Date.parse(attr.expires) / 1000) : -1;
    out = out.filter((c) => !(c.name === name && c.domain === domain && (c.path ?? '/') === path));
    if (expires === -1 || expires > now()) {
      const sameSite = (attr.samesite || 'lax').toLowerCase();
      out.push({
        name,
        value: pair.slice(at + 1).trim(),
        domain,
        path,
        expires,
        httpOnly: 'httponly' in attr,
        secure: 'secure' in attr,
        sameSite: /** @type {any} */ (sameSite[0].toUpperCase() + sameSite.slice(1)),
      });
    }
  }
  return figmaCookies(out);
}

/**
 * Cookies in the form Playwright's addCookies takes: host-only ones (no leading dot, e.g. __Host-*) by URL.
 * @param {Cookie[]} cookies
 */
export const playwrightCookies = (cookies) =>
  cookies.map(({ domain, path = '/', ...c }) =>
    domain.startsWith('.') ? { ...c, domain, path } : { ...c, url: `https://${domain}${path}` },
  );

/**
 * Starts a sign-in: Figma's app-auth request (what Figma Desktop's sign-in creates). Its id and the anonymous
 * cookies Figma binds it to; undefined when Figma couldn't be asked.
 * @returns {Promise<{ id: string, cookies: Cookie[] } | undefined>}
 */
export async function createAppAuth() {
  const res = await fetch(`${FIGMA}/api/session/app_auth`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ app_type: 'desktop' }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
  const id = res?.ok ? (await res.json().catch(() => undefined))?.meta?.id : undefined;
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(id)) return undefined;
  return { id, cookies: renewCookies([], /** @type {Response} */ (res).headers.getSetCookie()) };
}

/** The page where the person approves a sign-in, in their own browser @param {string} id */
export const grantUrl = (id) => `${FIGMA}/app_auth/${id}/grant?desktop_protocol=figma`;

/** The one-time secret out of a pasted `figma://app_auth/redeem?g_secret=…` link, or the bare secret @param {string} text */
export function secretFromPaste(text) {
  const raw = /[?&]g_secret=([A-Za-z0-9._~%-]{16,512})/.exec(text.trim())?.[1] ?? /^([A-Za-z0-9._~-]{16,512})$/.exec(text.trim())?.[1];
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined; // a broken %-escape: not a link Figma made
  }
}

/**
 * Redeems the secret for a Figma session, with the cookies the request was created with.
 * null: Figma refused it (wrong, used or expired); undefined: Figma couldn't be asked.
 * @param {string} secret @param {Cookie[]} cookies
 * @returns {Promise<{ cookies: Cookie[], user: string } | null | undefined>}
 */
export async function redeemAppAuth(secret, cookies) {
  const res = await fetch(`${FIGMA}/api/session/app_auth/redeem`, {
    method: 'POST',
    headers: headers(cookies),
    body: JSON.stringify({ g_secret: secret }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
  if (!res) return undefined;
  if (res.status >= 500) return undefined;
  const user = res.ok ? (await res.json().catch(() => undefined))?.meta?.workspace?.userId : undefined;
  if (typeof user !== 'string' && typeof user !== 'number') return null;
  return { cookies: renewCookies(cookies, res.headers.getSetCookie()), user: String(user) };
}

/**
 * Whether Figma still signs these cookies in (GET /api/session/check): the cookies with Figma's renewals; null when
 * signed out; undefined when Figma couldn't say.
 * @param {Cookie[]} cookies @returns {Promise<Cookie[] | null | undefined>}
 */
export async function checkSession(cookies) {
  const res = await fetch(`${FIGMA}/api/session/check`, {
    headers: headers(cookies),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
  if (res?.status === 401 || res?.status === 403) return null;
  if (res?.status !== 200) return undefined;
  return renewCookies(cookies, res.headers.getSetCookie());
}

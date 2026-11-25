// Facts about figma.com shared by every part of figma-remote-mcp. Dependency-free.

export const FIGMA = 'https://www.figma.com';
// Figma's CDN refuses HeadlessChrome's user agent (CloudFront 403), so every request says it is desktop Chrome.
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
// SwiftShader gives the editor WebGL without a GPU; a container's /dev/shm is small.
export const CHROMIUM_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader',
];
// Figma Desktop's own local server (for `relay`-style comparisons and doctor).
export const DESKTOP_MCP_URL = 'http://127.0.0.1:3845/mcp';

// Every browser context: Figma's CDN refuses HeadlessChrome's own user agent.
export const CONTEXT_OPTIONS = { userAgent: USER_AGENT, viewport: { width: 1440, height: 900 } };

/**
 * An error carrying a code: 'auth' (signed out: sign in again), 'forbidden' (Figma refuses this account here),
 * 'unavailable' (try again), 'gone' (the editor page crashed or closed: open the file again).
 * @param {'auth' | 'forbidden' | 'unavailable' | 'gone'} code @param {string} message
 */
export const figmaError = (code, message) => Object.assign(new Error(message), { code });
export const signedOutError = () => figmaError('auth', 'The Figma session has ended. Sign in again.');
/** Whether to open the most recently used file on `initialize` (FIGMA_WARM=0 turns it off) */
export const WARM = process.env.FIGMA_WARM !== '0';
/** Whether an error means Figma signed this session out @param {unknown} err */
export const isSignedOut = (err) => /** @type {any} */ (err)?.code === 'auth';

const KEY = /^[A-Za-z0-9]{10,64}$/;
const EDITORS = { design: 'design', file: 'design', proto: 'design', board: 'board', slides: 'slides', make: 'make' };

/**
 * A file named by a bare key or any figma.com URL: its key (a branch's own key for branch URLs), its editor and the
 * node the URL points at. null when it names no file.
 * @param {unknown} raw
 * @returns {{ key: string, editor: string, nodeId?: string } | null}
 */
export function parseFile(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (KEY.test(value)) return { key: value, editor: 'design' };
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!/(^|\.)figma\.com$/.test(url.hostname)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const editor = EDITORS[/** @type {keyof typeof EDITORS} */ (parts[0])];
  if (!editor || !KEY.test(parts[1] ?? '')) return null;
  const branch = parts[2] === 'branch' && KEY.test(parts[3] ?? '') ? parts[3] : undefined;
  const node = url.searchParams.get('node-id');
  return {
    key: branch ?? parts[1],
    editor,
    ...(node && /^\d+[:-]\d+$/.test(node) && { nodeId: node.replace('-', ':') }),
  };
}

/** Where the editor opens a file @param {{ key: string, editor: string }} file */
export const fileUrl = (file) => `${FIGMA}/${file.editor}/${file.key}/`;

const ANALYTICS = /^(_ga|_gid|_gcl|_fbp|_uet|ajs_|amplitude|__stripe|_dd_s|OptanonConsent|__cf_bm|_cfuvid)/;
/**
 * A Figma session: figma.com's own cookies, without analytics.
 * @template {{ name: string, domain: string }} C @param {C[]} cookies @returns {C[]}
 */
export const figmaCookies = (cookies) =>
  cookies.filter((c) => /(^|\.)figma\.com$/.test(c.domain.replace(/^\./, '')) && !ANALYTICS.test(c.name));

/** The Cookie header for these cookies @param {{ name: string, value: string }[]} cookies */
export const cookieHeader = (cookies) => cookies.map((c) => `${c.name}=${c.value}`).join('; ');

/** @typedef {{ name: string, value: string, domain: string, path?: string, expires?: number, httpOnly?: boolean,
 *   secure?: boolean, sameSite?: 'Strict' | 'Lax' | 'None' }} Cookie  a Playwright cookie */
/** @typedef {{ debug(s: string): void, info(s: string): void, warn(s: string): void, error(s: string): void }} Log */

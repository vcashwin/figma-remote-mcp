// `grant`: approves a hosted server's sign-in from this machine. Opens Figma's approval page in a browser window,
// waits for the person to click "Open the desktop app", catches the figma://app_auth/redeem?g_secret=… link Figma
// sends to the desktop app (browsers never show it), prints it and copies it to the clipboard.
import { spawn } from 'node:child_process';
import { openProfile } from './login.js';

const GRANT = /^https:\/\/www\.figma\.com\/app_auth\/[A-Za-z0-9-]{8,64}\/grant(\?.*)?$/;
const REDEEM = /^[a-z][a-z0-9+.-]*:\/\/[^?]*app_auth[^?]*\?.*g_secret=/i;

/** Copies text with the platform's clipboard tool; false when there is none @param {string} text */
const copy = (text) =>
  new Promise((resolve) => {
    const [cmd, ...args] =
      process.platform === 'darwin' ? ['pbcopy'] : process.platform === 'win32' ? ['clip'] : ['xclip', '-selection', 'clipboard'];
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    child.stdin.end(text);
  });

/** @param {{ profile: string, url?: string, out?: (s: string) => void }} options */
export async function grant({ profile, url, out = (s) => process.stderr.write(`${s}\n`) }) {
  if (!url || !GRANT.test(url)) throw new Error('Pass the approval page address the sign-in page shows: https://www.figma.com/app_auth/<id>/grant…');
  const context = await openProfile(profile, { headless: false });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    /** @type {(link: string) => void} */
    let found = () => {};
    const link = new Promise((/** @type {(link: string) => void} */ resolve) => (found = resolve));
    const watch = (/** @type {string} */ u) => REDEEM.test(u) && found(u);
    context.on('request', (r) => watch(r.url()));
    page.on('framenavigated', (f) => watch(f.url()));
    // The page sets location.href to the figma:// link; catch it in the page too, before Chrome hands it to the OS.
    await page.exposeFunction('__figmaRemoteGrant', (/** @type {string} */ u) => watch(u));
    await page.addInitScript(() => {
      const nav = /** @type {any} */ (window).navigation;
      nav?.addEventListener('navigate', (/** @type {any} */ e) => {
        if (/^figma[a-z-]*:/.test(e.destination?.url ?? '')) /** @type {any} */ (window).__figmaRemoteGrant(e.destination.url);
      });
    });
    await page.goto(url);
    out('In the window: sign in if Figma asks, pick your account, then click "Open the desktop app".');
    const closed = new Promise((resolve) => context.on('close', () => resolve(null)));
    const got = await Promise.race([link, closed]);
    if (!got) throw new Error('The window was closed before approving.');
    const copied = await copy(got);
    out(copied ? '✓ Copied. Paste it into the sign-in page:' : 'Paste this into the sign-in page:');
    process.stdout.write(`${got}\n`);
  } finally {
    await context.close().catch(() => {});
  }
}

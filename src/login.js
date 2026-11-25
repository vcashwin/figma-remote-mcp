// Local sign-in: a visible browser window on figma.com with its own profile (~/.figma-remote-mcp/profile), which the
// headless editor reuses afterwards. Figma's sign-in page as usual: the password never passes through this code.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { CHROMIUM_ARGS, CONTEXT_OPTIONS, FIGMA, USER_AGENT } from './figma.js';

export const defaultProfile = () => process.env.FIGMA_REMOTE_PROFILE || join(homedir(), '.figma-remote-mcp', 'profile');

/**
 * A browser context on the profile. Installed Google Chrome first (Figma's Google sign-in refuses Playwright's
 * Chromium more often), Playwright's Chromium otherwise.
 * @param {string} dir @param {{ headless: boolean }} options
 */
export async function openProfile(dir, { headless }) {
  const options = { headless, args: CHROMIUM_ARGS, ...CONTEXT_OPTIONS };
  try {
    return await chromium.launchPersistentContext(dir, { ...options, channel: 'chrome' });
  } catch (err) {
    if (/ProcessSingleton|SingletonLock|profile.*in use/i.test(String(err))) {
      throw new Error(`The profile ${dir} is in use by another figma-remote-mcp (quit it first).`);
    }
    return chromium.launchPersistentContext(dir, options);
  }
}

/**
 * Who the context's cookies sign in as: `/api/session/check` answers 200 when signed in.
 * @param {import('playwright').BrowserContext} context
 * @returns {Promise<{ status: number | null, user: { id: string, email?: string, handle?: string } | null }>}
 */
export async function whoAmI(context) {
  try {
    const res = await context.request.get(`${FIGMA}/api/session/check`, { headers: { 'user-agent': USER_AGENT } });
    if (res.status() !== 200) return { status: res.status(), user: null };
    const body = await res.json().catch(() => null);
    const user = body?.meta?.user ?? body?.meta ?? body?.user;
    return { status: 200, user: user?.id ? { id: String(user.id), email: user.email, handle: user.handle } : null };
  } catch {
    return { status: null, user: null };
  }
}

/** @param {{ profile?: string, out?: (s: string) => void }} [options] */
export async function login({ profile = defaultProfile(), out = (s) => process.stderr.write(`${s}\n`) } = {}) {
  const context = await openProfile(profile, { headless: false });
  try {
    if ((await whoAmI(context)).status === 200) {
      out(`Already signed in (profile ${profile}).`);
      return;
    }
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${FIGMA}/login`);
    await page.bringToFront();
    out('Sign in to Figma in the browser window. This finishes on its own once Figma confirms the session.');
    for (;;) {
      if (!context.pages().length) throw new Error('The window was closed before signing in.');
      const { status } = await whoAmI(context);
      if (status === 200) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    out(`✓ Signed in. Session saved in ${profile}`);
  } finally {
    await context.close().catch(() => {});
  }
}

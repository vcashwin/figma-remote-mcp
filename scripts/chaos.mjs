#!/usr/bin/env node
// Resilience check on a real file: the engine must recover from a crashed page and a reload in the middle of a call.
//   node scripts/chaos.mjs <fileKey|url>     (uses the `login` profile; read-only tools only)
import { createEngine } from '../src/engine.js';
import { defaultProfile, openProfile } from '../src/login.js';

const file = process.argv[2];
if (!file) throw new Error('usage: node scripts/chaos.mjs <fileKey|url>');
const log = { debug() {}, info: (/** @type {string} */ s) => console.log(`    ${s}`), warn: (/** @type {string} */ s) => console.log(`    warn: ${s}`), error: console.error };
const context = await openProfile(defaultProfile(), { headless: true });
const engine = await createEngine({ context, putAsset: (n) => n, log });
const page = () => /** @type {import('playwright').Page} */ (context.pages().find((p) => /\/design\//.test(p.url())));
let failed = 0;
/** @param {string} name @param {() => Promise<any>} fn */
const step = async (name, fn) => {
  const t = performance.now();
  const r = await fn().catch((err) => ({ isError: true, content: [{ text: String(err?.message ?? err) }] }));
  const ok = !r?.isError;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${name} (${((performance.now() - t) / 1000).toFixed(1)}s)${ok ? '' : `: ${r.content[0].text.slice(0, 160)}`}`);
};
try {
  await step('cold call', () => engine.plugin('get_metadata', { fileKey: file }));
  await step('warm call', () => engine.plugin('get_pages', {}));
  // 1. the renderer crashes between calls
  const cdp = await context.newCDPSession(page());
  await cdp.send('Page.crash').catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  await step('call after a page crash (reopens the file)', () => engine.plugin('get_pages', {}));
  // 2. Figma reloads the editor in the middle of a read
  const reading = engine.plugin('get_design_context', { depth: 3 });
  await new Promise((r) => setTimeout(r, 5));
  void page().reload().catch(() => {});
  await step('read interrupted by a reload (runs again)', () => reading);
  // 3. a reload between calls: the plugin is gone, the next call starts it again
  await page().reload();
  await step('call after an idle reload (plugin restarted)', () => engine.plugin('get_metadata', {}));
  // 4. idle long enough to freeze, then a call
  await new Promise((r) => setTimeout(r, 7000));
  await step('call on a frozen page', () => engine.plugin('get_pages', {}));
} finally {
  await engine.close();
}
console.log(failed ? `${failed} step(s) failed` : 'all recovered');
process.exitCode = failed ? 1 : 0;

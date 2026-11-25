#!/usr/bin/env node
// Resilience check on a real file (uses the `login` profile; read-only tools only). Every step must recover:
//   a crashed page, a reload in the middle of a read, a reload between calls, a frozen page, and (over MCP stdio)
//   a killed Chrome.
//   node scripts/chaos.mjs <fileKey|url>
import { createEngine } from '../src/engine.js';
import { execSync } from 'node:child_process';
import { defaultProfile, openProfile } from '../src/login.js';
import { startClient } from './mcp-client.mjs';

const file = process.argv[2];
if (!file) throw new Error('usage: node scripts/chaos.mjs <fileKey|url>');
const warnings = /** @type {string[]} */ ([]);
const log = { debug() {}, info: (/** @type {string} */ s) => console.log(`    ${s}`), warn: (/** @type {string} */ s) => (warnings.push(s), console.log(`    warn: ${s}`)), error: console.error };
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
  // 2. Figma reloads the editor in the middle of a read (a big one, so the reload lands while it runs)
  const before = warnings.length;
  const reading = engine.plugin('get_document', {});
  await new Promise((r) => setTimeout(r, 150));
  void page().reload().catch(() => {});
  await step('read interrupted by a reload', () => reading);
  console.log(`    (${warnings.slice(before).some((w) => /running it again/.test(w)) ? 'the reload landed mid-read: it ran again' : 'the read finished before the reload landed'})`);
  // 3. a reload between calls: the plugin is gone, the next call starts it again
  await page().reload();
  await step('call after an idle reload (plugin restarted)', () => engine.plugin('get_metadata', {}));
  // 4. idle long enough to freeze, then a call
  await new Promise((r) => setTimeout(r, 7000));
  await step('call on a frozen page', () => engine.plugin('get_pages', {}));
} finally {
  await engine.close();
}

// 5. over MCP stdio: Chrome is killed under the server
const client = startClient({ FIGMA_WARM: '0' });
await client.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'chaos' } });
const mcpStep = async (/** @type {string} */ name) => step(name, async () => (await client.call('get_pages', { fileKey: file }))[1].result);
await mcpStep('MCP call');
for (const pid of execSync(`pgrep -P ${client.child.pid}`).toString().trim().split('\n')) process.kill(Number(pid), 'SIGKILL');
await new Promise((r) => setTimeout(r, 1000));
await mcpStep('MCP call after Chrome was killed (relaunched)');
await client.close();
console.log(failed ? `${failed} step(s) failed` : 'all recovered');
process.exitCode = failed ? 1 : 0;

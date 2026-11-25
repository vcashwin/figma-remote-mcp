#!/usr/bin/env node
// Latency benchmark on a real file: cold start (browser, editor, plugin) and warm calls per tool.
//   node scripts/bench.mjs <fileKey|url> [runs=15]      (uses the `login` profile; read-only tools only)
import { createEngine } from '../src/engine.js';
import { defaultProfile, openProfile } from '../src/login.js';

const [file, runsArg] = process.argv.slice(2);
if (!file) throw new Error('usage: node scripts/bench.mjs <fileKey|url> [runs]');
const runs = Number(runsArg ?? 15);
const t0 = performance.now();
const since = () => `${((performance.now() - t0) / 1000).toFixed(2)}s`;
const log = { debug() {}, info: (/** @type {string} */ s) => console.log(`  ${since()} ${s}`), warn: console.warn, error: console.error };
const ms = async (/** @type {() => Promise<any>} */ fn) => {
  const s = performance.now();
  const r = await fn();
  if (r?.isError) throw new Error(r.content[0].text);
  return performance.now() - s;
};
const pct = (/** @type {number[]} */ xs, /** @type {number} */ p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

const context = await openProfile(defaultProfile(), { headless: true });
console.log(`browser launched         ${since()}`);
const engine = await createEngine({ context, putAsset: (n) => n, log });
try {
  const first = await ms(() => engine.plugin('get_metadata', { fileKey: file }));
  console.log(`first call (cold)        ${(first / 1000).toFixed(2)}s  (total ${since()})`);
  const meta = JSON.parse((await engine.plugin('get_metadata', {})).content[0].text);
  const ctx = JSON.parse((await engine.plugin('get_design_context', { depth: 1 })).content[0].text);
  const node = JSON.stringify(ctx).match(/"id":"(\d+:\d+)","name":"[^"]*","type":"(FRAME|COMPONENT|SECTION|INSTANCE|GROUP)"/)?.[1];
  console.log(`file: ${meta.pageCount} pages; benchmark node ${node}`);
  /** @type {[string, Record<string, unknown>][]} */
  const tools = [
    ['get_metadata', {}],
    ['get_node', { nodeId: node }],
    ['get_design_context', { depth: 2, detail: 'compact' }],
    ['get_variable_defs', {}],
    ['get_screenshot', { nodeIds: [node], scale: 1 }],
  ];
  console.log(`\nwarm calls (${runs} runs)      p50       p95`);
  for (const [tool, args] of tools) {
    const xs = [];
    for (let i = 0; i < runs; i++) xs.push(await ms(() => engine.plugin(tool, args)));
    console.log(`${tool.padEnd(24)} ${pct(xs, 50).toFixed(0).padStart(5)}ms ${pct(xs, 95).toFixed(0).padStart(7)}ms`);
  }
  await new Promise((r) => setTimeout(r, 7000)); // the page freezes after 5 s idle
  console.log(`\nafter freeze: get_node   ${(await ms(() => engine.plugin('get_node', { nodeId: node }))).toFixed(0)}ms`);
} finally {
  await engine.close();
}

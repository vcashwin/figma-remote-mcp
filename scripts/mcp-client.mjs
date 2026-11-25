// A minimal MCP stdio client for the scripts: spawns `src/cli.js mcp`, sends JSON-RPC, times each answer.
import { spawn } from 'node:child_process';

/** @param {Record<string, string>} [env] */
export function startClient(env = {}) {
  const child = spawn(process.execPath, [new URL('../src/cli.js', import.meta.url).pathname, 'mcp'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ...env },
  });
  let buf = '';
  /** @type {Map<number, (m: any) => void>} */
  const waiting = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
      const m = JSON.parse(buf.slice(0, i));
      waiting.get(m.id)?.(m);
    }
  });
  let id = 0;
  return {
    child,
    /** One request; [milliseconds, message] @param {string} method @param {object} [params] @returns {Promise<[number, any]>} */
    async rpc(method, params = {}) {
      const started = performance.now();
      const m = await new Promise((r) => {
        const n = ++id;
        waiting.set(n, r);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
      });
      return [performance.now() - started, m];
    },
    /** @param {string} name @param {object} args */
    call(name, args) {
      return this.rpc('tools/call', { name, arguments: args });
    },
    close: () => new Promise((r) => (child.on('exit', r), child.stdin.end())),
  };
}

/** @param {number[]} xs @param {number} p */
export const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

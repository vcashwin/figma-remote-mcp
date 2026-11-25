// Local mode: an MCP server over stdio for one person, backed by a headless editor on the profile `login` signed in.
// Image assets are served on a loopback port, as Figma Desktop serves them on 3845.
import http from 'node:http';
import { createInterface } from 'node:readline';
import { assetResponse, createAssetStore } from './assets.js';
import { createEngine, isAlive } from './engine.js';
import { WARM, figmaError } from './figma.js';
import { defaultProfile, openProfile, whoAmI } from './login.js';
import { dispatch } from './mcp.js';

/**
 * @param {{ profile?: string, headful?: boolean, devMode?: boolean, warm?: boolean, log: import('./figma.js').Log, input?: NodeJS.ReadableStream,
 *   output?: NodeJS.WritableStream }} options
 */
export async function startStdio({ profile = defaultProfile(), headful = false, devMode = false, warm = WARM, log, input = process.stdin, output = process.stdout }) {
  /** @type {number} */
  let port = 0;
  const assets = createAssetStore({ baseUrl: () => `http://127.0.0.1:${port}` });
  const server = http.createServer((req, res) => {
    const response = assetResponse(assets, req.method ?? 'GET', (req.url ?? '/').split('?')[0]);
    if (!response) return void res.writeHead(404).end();
    res.writeHead(response.status, Object.fromEntries(response.headers));
    response.arrayBuffer().then((b) => res.end(Buffer.from(b)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;

  /** @type {Promise<import('./engine.js').Engine> | null} */
  let engine = null;
  // Started on first use or by the warm-up after `initialize` (which itself answers at once); started again if Chrome died.
  const getEngine = async () => {
    // Chrome died (or was closed): start a new one
    if (engine && !(await engine.then(isAlive, () => false))) engine = null;
    return (engine ??= (async () => {
      const context = await openProfile(profile, { headless: !headful });
      if ((await whoAmI(context)).status === 401) {
        await context.close();
        throw figmaError('auth', 'Not signed in to Figma. Run: npx figma-remote-mcp login');
      }
      return createEngine({ context, putAsset: assets.put, log });
    })().catch((err) => {
      engine = null;
      throw err;
    }));
  };

  let clientInfo = { name: 'unknown' };
  const ctx = {
    devMode,
    engine: getEngine,
    clientInfo: () => clientInfo,
    onInitialize: (/** @type {{ name: string }} */ c) => {
      clientInfo = c;
      // the first call likely names the file you're working on: have the most recent one open and ready
      if (warm) getEngine().then((e) => e.warm(), () => {});
    },
  };
  /** @param {object} msg */
  const send = (msg) => output.write(`${JSON.stringify(msg)}\n`);

  const lines = createInterface({ input });
  // One message at a time: the tools act on shared page state, as the desktop's do.
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  lines.on('line', (line) => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      try {
        const reply = await dispatch(msg, ctx);
        if (reply) send(reply);
      } catch (err) {
        // signed out: say so in Figma's place (the client shows it), and keep serving so `login` can fix it
        send({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32001, message: String(/** @type {any} */ (err)?.message ?? err) } });
      }
    }).catch((err) => log.error(`stdio: ${err?.message ?? err}`));
  });

  const close = async () => {
    server.close();
    await (await engine?.catch(() => null))?.close();
  };
  lines.on('close', () => queue.then(close).then(() => process.exit(0)));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => close().finally(() => process.exit(0)));
  log.info('figma-remote-mcp ready on stdio');
  return { close };
}

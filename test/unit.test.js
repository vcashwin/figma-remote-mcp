// The pure pieces: file URLs, the pasted sign-in link, cookie renewals, assets, the MCP dispatcher. `npm test`
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetResponse, createAssetStore } from '../src/assets.js';
import { errorResult, resolveAssets } from '../src/engine.js';
import { figmaCookies, parseFile } from '../src/figma.js';
import { dispatch, withFileKey } from '../src/mcp.js';
import { playwrightCookies, renewCookies, secretFromPaste } from '../src/session.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

test('parseFile: keys, editor URLs, branches and node ids; anything else is null', () => {
  assert.deepEqual(parseFile('aBcDeFgHiJkLmNoPqRsTuV'), { key: 'aBcDeFgHiJkLmNoPqRsTuV', editor: 'design' });
  assert.deepEqual(parseFile('https://www.figma.com/design/aBcDeFgHiJkLmNoPqRsTuV/My-File?node-id=12-34&t=x'), {
    key: 'aBcDeFgHiJkLmNoPqRsTuV',
    editor: 'design',
    nodeId: '12:34',
  });
  assert.deepEqual(parseFile('https://figma.com/design/aaaaaaaaaaaa/branch/bbbbbbbbbbbb/y'), { key: 'bbbbbbbbbbbb', editor: 'design' });
  assert.equal(parseFile('https://www.figma.com/board/cccccccccccc/x')?.editor, 'board');
  assert.equal(parseFile('https://www.figma.com/file/dddddddddddd/x')?.editor, 'design');
  for (const bad of ['', 'short', 'https://evil.example/design/aaaaaaaaaaaa/x', 'https://www.figma.com/files/recent', 42, null, 'javascript:alert(1)']) {
    assert.equal(parseFile(bad), null, String(bad));
  }
});

test('secretFromPaste: the figma:// link, the bare secret, nothing else', () => {
  const secret = 'AbC123_-xyzXYZ0987654321';
  assert.equal(secretFromPaste(`figma://app_auth/redeem?g_secret=${secret}`), secret);
  assert.equal(secretFromPaste(`  figma://app_auth/redeem?g_secret=${secret}&x=1  `), secret);
  assert.equal(secretFromPaste(secret), secret);
  assert.equal(secretFromPaste('figma://app_auth/redeem?g_secret=a%2Bb%2Fcccccccccccccccc'), 'a+b/cccccccccccccccc');
  for (const bad of ['', 'hello', 'figma://app_auth/redeem', 'has spaces in it but long enough', 'figma://app_auth/redeem?g_secret=abcdefghijklmnop%C3']) {
    assert.equal(secretFromPaste(bad), undefined, bad);
  }
});

test("renewCookies: renewals replace, deletions remove, other sites' cookies never enter", () => {
  const start = [
    { name: '__Host-figma.authn', value: 'old', domain: 'www.figma.com', path: '/' },
    { name: 'figma.mst', value: 'keep', domain: '.www.figma.com', path: '/' },
    { name: 'gone', value: 'x', domain: 'www.figma.com', path: '/' },
  ];
  const out = renewCookies(start, [
    '__Host-figma.authn=new; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600',
    'gone=; Path=/; Max-Age=0',
    'evil=1; Domain=evil.example; Path=/',
  ]);
  assert.deepEqual(out.map((c) => `${c.name}=${c.value}`).sort(), ['__Host-figma.authn=new', 'figma.mst=keep']);
  const authn = out.find((c) => c.name === '__Host-figma.authn');
  assert.equal(authn?.httpOnly, true);
  assert.equal(authn?.sameSite, 'Lax');
  assert.deepEqual(figmaCookies([{ name: '_ga', value: '1', domain: '.figma.com' }, { name: 'a', value: '1', domain: '.figma.com' }]).map((c) => c.name), ['a']);
  // host-only cookies (no leading dot, e.g. __Host-*) go to Playwright by URL
  assert.deepEqual(playwrightCookies(out).map((c) => ('url' in c ? c.url : c.domain)).sort(), ['.www.figma.com', 'https://www.figma.com/']);
});

test('resolveAssets: each localhost:3845 link fetched once and rewritten; failures keep the link', async () => {
  const fetched = /** @type {string[]} */ ([]);
  const stored = /** @type {string[]} */ ([]);
  const result = await resolveAssets(
    {
      content: [
        { type: 'text', text: "const a = 'http://localhost:3845/assets/abc.png'; const b = 'http://localhost:3845/assets/abc.png';" },
        { type: 'text', text: 'http://localhost:3845/assets/icon.svg http://localhost:3845/assets/missing.png' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
    },
    async (name) => {
      fetched.push(name);
      if (name === 'missing.png') throw new Error('Asset missing.png not found');
      return Buffer.from(name).toString('base64');
    },
    (name, base64, mime) => (stored.push(`${name}:${mime}:${Buffer.from(base64, 'base64')}`), `https://host/assets/id/${name}`),
    quiet,
  );
  assert.deepEqual(fetched, ['abc.png', 'icon.svg', 'missing.png']);
  assert.deepEqual(stored, ['abc.png:image/png:abc.png', 'icon.svg:image/svg+xml:icon.svg']);
  assert.equal(result.content[0].text, "const a = 'https://host/assets/id/abc.png'; const b = 'https://host/assets/id/abc.png';");
  assert.equal(result.content[1].text, 'https://host/assets/id/icon.svg http://localhost:3845/assets/missing.png');
  assert.deepEqual(result.content[2], { type: 'image', data: 'AAAA', mimeType: 'image/png' });
});

test('asset store: unguessable URLs, served with their type, gone after the TTL', async () => {
  let clock = 0;
  const realNow = Date.now;
  Date.now = () => clock;
  try {
    const store = createAssetStore({ baseUrl: () => 'https://mcp.example', ttlMs: 1000 });
    const url = store.put('a b.png', Buffer.from('PNG').toString('base64'), 'image/png');
    assert.match(url, /^https:\/\/mcp\.example\/assets\/[A-Za-z0-9_-]{24}\/a%20b\.png$/);
    const path = new URL(url).pathname;
    const res = /** @type {Response} */ (assetResponse(store, 'GET', path));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(await res.text(), 'PNG');
    assert.equal(/** @type {Response} */ (assetResponse(store, 'GET', '/assets/guess/a%20b.png')).status, 404);
    assert.equal(assetResponse(store, 'GET', '/other'), undefined);
    clock = 2000;
    assert.equal(/** @type {Response} */ (assetResponse(store, 'GET', path)).status, 404);
  } finally {
    Date.now = realNow;
  }
});

test('asset store: past the byte budget the oldest go first', () => {
  const store = createAssetStore({ baseUrl: () => '', maxBytes: 10 });
  const first = new URL(store.put('1', Buffer.alloc(6).toString('base64'), 'x'), 'http://h').pathname;
  const second = new URL(store.put('2', Buffer.alloc(6).toString('base64'), 'x'), 'http://h').pathname;
  assert.equal(store.get(first), undefined);
  assert.ok(store.get(second));
  const huge = new URL(store.put('3', Buffer.alloc(50).toString('base64'), 'x'), 'http://h').pathname;
  assert.ok(store.get(huge), 'an asset over the whole budget still serves its fresh link');
});

/** A fake engine: two Dev Mode tools (one takes fileKey itself) and a plugin that echoes */
function fakeEngine() {
  const calls = /** @type {any[]} */ ([]);
  const tools = [
    { name: 'get_metadata', inputSchema: { type: 'object', properties: { nodeId: { type: 'string' } } } },
    { name: 'get_motion_context', inputSchema: { type: 'object', properties: { fileKey: { type: 'string', description: "Figma's" } } } },
  ];
  return {
    calls,
    engine: /** @type {any} */ ({
      tools: async () => tools,
      plugin: async (/** @type {string} */ name, /** @type {any} */ args) => (calls.push(['plugin', name, args]), { content: [{ type: 'text', text: 'plugin done' }] }),
      call: async (/** @type {string} */ name, /** @type {any} */ args, /** @type {any} */ client, /** @type {any} */ def) => (calls.push(['call', name, args, client, def?.name]), { content: [{ type: 'text', text: 'done' }] }),
    }),
  };
}

test('dispatch: initialize, the plugin catalog with fileKey, plugin calls, prompts, errors', async () => {
  const { engine, calls } = fakeEngine();
  let client = { name: 'unknown' };
  let engines = 0;
  const ctx = { engine: async () => (engines++, engine), clientInfo: () => client, onInitialize: (/** @type {any} */ c) => (client = c) };
  const rpc = (/** @type {string} */ method, /** @type {any} */ params = {}, id = 1) => dispatch({ jsonrpc: '2.0', id, method, params }, ctx);

  const init = /** @type {any} */ (await rpc('initialize', { protocolVersion: '2025-03-26', clientInfo: { name: 'claude-code', version: '2' } }));
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.equal(init.result.serverInfo.name, 'figma-remote-mcp');
  assert.match(init.result.instructions, /fileKey/);
  assert.deepEqual(client, { name: 'claude-code', version: '2' });
  assert.equal(/** @type {any} */ (await rpc('initialize', { protocolVersion: '1999-01-01', clientInfo: { name: 'claude-code', version: '2' } })).result.protocolVersion, '2025-06-18');

  const list = /** @type {any} */ (await rpc('tools/list')).result.tools;
  assert.equal(list.length, 72);
  assert.ok(list.every((/** @type {any} */ t) => t.inputSchema.properties.fileKey), 'every tool takes fileKey');
  assert.ok(!list.some((/** @type {any} */ t) => t.name.startsWith('dev_mode_')));
  assert.equal(engines, 0, 'listing needs no editor');

  assert.deepEqual(/** @type {any} */ (await rpc('tools/call', { name: 'get_node', arguments: { fileKey: 'k', nodeId: '1:2' } })).result, { content: [{ type: 'text', text: 'plugin done' }] });
  assert.deepEqual(calls.at(-1), ['plugin', 'get_node', { fileKey: 'k', nodeId: '1:2' }]);
  assert.deepEqual(/** @type {any} */ (await rpc('tools/call', { name: 'dev_mode_get_metadata', arguments: {} })).result, errorResult('Unknown tool: dev_mode_get_metadata'), 'Dev Mode tools only with devMode');
  assert.deepEqual(/** @type {any} */ (await rpc('tools/call', { name: 'nope' })).result, errorResult('Unknown tool: nope'));
  assert.equal(/** @type {any} */ (await rpc('tools/call', { name: 'get_node', arguments: [] })).error.code, -32602);

  assert.equal(/** @type {any} */ (await rpc('prompts/list')).result.prompts.length, 12);
  assert.match(/** @type {any} */ (await rpc('prompts/get', { name: 'design_strategy' })).result.messages[0].content.text, /\S/);
  assert.equal(/** @type {any} */ (await rpc('prompts/get', { name: 'nope' })).error.code, -32602);
  assert.deepEqual(/** @type {any} */ (await rpc('resources/list')).result, { resources: [] });
  assert.equal(/** @type {any} */ (await rpc('nope')).error.code, -32601);
  assert.equal(await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx), null);
  assert.equal(/** @type {any} */ (await dispatch({ id: 1, method: 'ping' }, ctx)).error.code, -32600);
});

test("dispatch with devMode: Figma's own tools under dev_mode_, keeping a tool's own fileKey", async () => {
  const { engine, calls } = fakeEngine();
  const ctx = { devMode: true, engine: async () => engine, clientInfo: () => ({ name: 'c' }) };
  const rpc = (/** @type {string} */ method, /** @type {any} */ params = {}) => dispatch({ jsonrpc: '2.0', id: 1, method, params }, ctx);
  const list = /** @type {any} */ (await rpc('tools/list')).result.tools;
  const dev = list.filter((/** @type {any} */ t) => t.name.startsWith('dev_mode_'));
  assert.deepEqual(dev.map((/** @type {any} */ t) => t.name), ['dev_mode_get_metadata', 'dev_mode_get_motion_context']);
  assert.deepEqual(Object.keys(dev[0].inputSchema.properties), ['fileKey', 'nodeId']);
  assert.equal(dev[1].inputSchema.properties.fileKey.description, "Figma's");
  await rpc('tools/call', { name: 'dev_mode_get_metadata', arguments: { fileKey: 'k' } });
  assert.deepEqual(calls.at(-1), ['call', 'get_metadata', { fileKey: 'k' }, { name: 'c' }, 'get_metadata']);
});

test('dispatch: a sign-out is thrown for the transport, other failures are JSON-RPC errors', async () => {
  const failing = (/** @type {any} */ err) => ({ engine: async () => /** @type {any} */ ({ plugin: async () => Promise.reject(err) }), clientInfo: () => ({ name: 'x' }) });
  const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_pages', arguments: {} } };
  await assert.rejects(dispatch(call, failing(Object.assign(new Error('ended'), { code: 'auth' }))), /ended/);
  assert.deepEqual(/** @type {any} */ (await dispatch(call, failing(new Error('boom')))).error, { code: -32603, message: 'boom' });
  assert.equal(withFileKey([{ name: 't', inputSchema: /** @type {any} */ (undefined) }])[0].inputSchema.properties?.fileKey?.type, 'string');
});

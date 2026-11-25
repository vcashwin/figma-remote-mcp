// MCP over JSON-RPC, shared by the stdio and HTTP transports: Figma's own catalog, prompts and resources from the
// page, as Figma Desktop's local server serves them, plus one argument the desktop doesn't need: `fileKey`. (The
// desktop acts on its active tab; a headless editor has none, so calls name their file.)
import { readFileSync } from 'node:fs';
import { errorResult } from './engine.js';
import { isSignedOut } from './figma.js';
import { isPluginTool, pluginPrompt, pluginPrompts, pluginTools } from './plugin-tools.js';

/** Figma's own Dev Mode tools, when enabled, are listed under this prefix (their names clash with the plugin's). */
export const DEV_MODE_PREFIX = 'dev_mode_';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const SERVER_INFO = { name: 'figma-remote-mcp', title: 'Figma (remote)', version: VERSION };
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export const INSTRUCTIONS = `Figma tools run by figma.com's own editor, headless: read and write designs through Figma's Plugin API (no Dev Mode seat or MCP rate limit needed; files must be ones this account can edit and run plugins in).
There is no open tab or selection: name the file in every call with fileKey (the key from figma.com/design/<fileKey>/…, or the whole URL; a URL's node-id is used when nodeId is left out). Calls without fileKey use the file of the previous call. The first call on a file waits for Figma to load it (often 10–30 s); later calls are fast.
Node ids look like 123:456 (a URL's node-id=123-456 is the same node). Writes are live edits to the file, as a collaborator's would be, and can be undone in Figma's version history.`;

const FILE_KEY = {
  type: 'string',
  description:
    'The Figma file: its key (figma.com/design/<fileKey>/…), a branch key, or the whole figma.com URL. Defaults to the file of the previous call.',
};

/**
 * Figma's tools with `fileKey` added to each one's input (those that already take it keep Figma's own).
 * @param {import('./engine.js').Tool[]} tools
 */
export const withFileKey = (tools) =>
  tools.map((tool) => {
    const schema = tool.inputSchema ?? { type: 'object' };
    if (schema.properties?.fileKey) return tool;
    return { ...tool, inputSchema: { ...schema, properties: { fileKey: FILE_KEY, ...schema.properties } } };
  });

/**
 * Answers one JSON-RPC message; null for notifications. Errors with code 'auth' are thrown for the transport to turn
 * into a sign-in prompt (HTTP 401) or an exit (stdio).
 * @param {any} msg
 * @param {{ engine: () => Promise<Pick<import('./engine.js').Engine, 'tools' | 'call' | 'plugin'>>,
 *   clientInfo: () => import('./engine.js').ClientInfo, onInitialize?: (clientInfo: import('./engine.js').ClientInfo) => void,
 *   devMode?: boolean }} ctx
 * @returns {Promise<object | null>}
 */
export async function dispatch(msg, ctx) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }
  if (msg.id === undefined || msg.id === null) return null; // a notification (or a response to us): nothing to say
  const ok = (/** @type {object} */ result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (/** @type {number} */ code, /** @type {string} */ message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  const params = msg.params ?? {};
  /** Figma's Dev Mode tools under their prefix: from the page, so they need an editor */
  const devModeTools = async () =>
    (await (await ctx.engine()).tools()).map((t) => ({ ...t, name: `${DEV_MODE_PREFIX}${t.name}` }));

  try {
    switch (msg.method) {
      case 'initialize': {
        const asked = params.protocolVersion;
        ctx.onInitialize?.({ name: String(params.clientInfo?.name ?? 'unknown').slice(0, 100), version: params.clientInfo?.version });
        return ok({
          // a version we don't speak gets 2025-06-18, the one every current client speaks
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[1],
          capabilities: { tools: {}, prompts: {}, resources: {} },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: withFileKey([...pluginTools(), ...(ctx.devMode ? await devModeTools() : [])]) });
      case 'tools/call': {
        const { name, arguments: args = {} } = params;
        if (typeof name !== 'string') return fail(-32602, 'params.name is required');
        if (!args || typeof args !== 'object' || Array.isArray(args)) return fail(-32602, 'params.arguments must be an object');
        if (isPluginTool(name)) return ok(await (await ctx.engine()).plugin(name, args));
        if (ctx.devMode && name.startsWith(DEV_MODE_PREFIX)) {
          const engine = await ctx.engine();
          const figmaName = name.slice(DEV_MODE_PREFIX.length);
          const def = (await engine.tools()).find((t) => t.name === figmaName);
          if (def) return ok(await engine.call(figmaName, args, ctx.clientInfo(), def));
        }
        return ok(errorResult(`Unknown tool: ${name}`));
      }
      case 'prompts/list':
        return ok({ prompts: pluginPrompts() });
      case 'prompts/get': {
        const prompt = typeof params.name === 'string' ? pluginPrompt(params.name) : undefined;
        return prompt ? ok(prompt) : fail(-32602, `Unknown prompt: ${params.name}`);
      }
      case 'resources/list':
        return ok({ resources: [] });
      case 'resources/templates/list':
        return ok({ resourceTemplates: [] });
      default:
        return fail(-32601, `Method not found: ${msg.method}`);
    }
  } catch (err) {
    if (isSignedOut(err)) throw err;
    return fail(-32603, String(err instanceof Error ? err.message : err));
  }
}

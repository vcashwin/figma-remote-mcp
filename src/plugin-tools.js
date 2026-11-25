// The plugin tools: Figma's public Plugin API (figma.*), run by a plugin inside the headless editor, so they need no
// Dev Mode seat and count against no MCP limit, on any plan. The plugin, its 71 tools and 12 prompts are
// figma-mcp-rust's (MIT, src/plugin/LICENSE); this file turns MCP calls into its requests and its answers into MCP
// results. (figma-mcp-rust's two tools that write files to the server's disk are left out: get_screenshot returns
// the images.)
import { readFileSync } from 'node:fs';

/** @typedef {import('./engine.js').Tool & { nodeIds: 'None' | 'SingleField' | 'SingleOptional' | 'Multi' }} PluginTool */
/** @typedef {{ type: string, nodeIds: string[], params: Record<string, unknown> }} PluginRequest */

const catalog = JSON.parse(readFileSync(new URL('./plugin/catalog.json', import.meta.url), 'utf8'));
/** @type {PluginTool[]} */
const TOOLS = catalog.tools;
/** @type {{ name: string, description: string, body: string }[]} */
const PROMPTS = catalog.prompts;
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Tools that only read: safe to run again when the editor reloads or crashes under them @param {string} name */
export const isReadTool = (name) => /^(get|search|scan|export)_/.test(name);

/** The MCP catalog (without the routing rule), with read-only / destructive hints */
export const pluginTools = () =>
  TOOLS.map(({ nodeIds, ...tool }) => ({
    ...tool,
    annotations: isReadTool(tool.name)
      ? { readOnlyHint: true }
      : { readOnlyHint: false, destructiveHint: /^(delete|detach|ungroup|remove)_/.test(tool.name) },
  }));
/** @param {string} name */
export const isPluginTool = (name) => BY_NAME.has(name);

/** `12-34` → `12:34` (URLs spell node ids with a hyphen) @param {unknown} id */
const normalize = (id) => (typeof id === 'string' && /^I?\d+-\d+(;\d+-\d+)*$/.test(id) ? id.replace(/-/g, ':') : id);

/**
 * The plugin request for a call: node ids pulled out of the arguments by the tool's rule, the rest as params.
 * @param {string} name @param {Record<string, unknown>} args @returns {PluginRequest}
 */
export function pluginRequest(name, args) {
  const tool = BY_NAME.get(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  /** @type {Record<string, unknown>} */
  const params = { ...args };
  /** @type {string[]} */
  let ids = [];
  if (tool.nodeIds === 'SingleField' || tool.nodeIds === 'SingleOptional') {
    const id = params.nodeId;
    delete params.nodeId;
    if (typeof id === 'string' || typeof id === 'number') ids = [String(id)];
    if (tool.nodeIds === 'SingleOptional') ids = ids.filter(Boolean);
  } else if (tool.nodeIds === 'Multi') {
    const list = params.nodeIds;
    delete params.nodeIds;
    ids = Array.isArray(list) ? list.filter((i) => typeof i === 'string') : [];
  }
  for (const key of ['nodeId', 'parentId']) if (key in params) params[key] = normalize(params[key]);
  if (name === 'get_design_context' && 'dedupe_components' in params) {
    params.dedupeComponents = params.dedupe_components;
    delete params.dedupe_components;
  }
  return { type: name, nodeIds: ids.map((i) => String(normalize(i))), params };
}

const IMAGE_MIME = { PNG: 'image/png', JPG: 'image/jpeg' };

/**
 * The MCP result for the plugin's answer: its data as JSON text, and screenshots as image blocks.
 * @param {string} name @param {{ data?: unknown, error?: string }} response @returns {import('./engine.js').ToolResult}
 */
export function pluginResult(name, response) {
  if (response.error) return { content: [{ type: 'text', text: response.error }], isError: true };
  const data = /** @type {any} */ (response.data ?? null);
  if (name === 'get_screenshot' && Array.isArray(data?.exports)) {
    const content = [];
    for (const { base64, format, ...meta } of data.exports) {
      const mimeType = IMAGE_MIME[/** @type {keyof typeof IMAGE_MIME} */ (format)];
      content.push({ type: 'text', text: JSON.stringify({ ...meta, format }) });
      if (mimeType) content.push({ type: 'image', data: base64, mimeType });
      else content.push({ type: 'text', text: format === 'SVG' ? Buffer.from(base64, 'base64').toString('utf8') : base64 });
    }
    return { content };
  }
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

/** @param {string} name */
export const pluginPrompt = (name) => {
  const p = PROMPTS.find((x) => x.name === name);
  return p && { description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.body } }] };
};
export const pluginPrompts = () => PROMPTS.map(({ name, description }) => ({ name, description }));

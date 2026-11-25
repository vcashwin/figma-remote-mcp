// The plugin tools' catalog and the MCP ↔ plugin request mapping. `npm test`
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPluginTool, pluginPrompt, pluginPrompts, pluginRequest, pluginResult, pluginTools } from '../src/plugin-tools.js';

test('catalog: 72 tools with schemas, no disk-writing tools, 12 prompts', () => {
  const tools = pluginTools();
  assert.equal(tools.length, 72);
  assert.ok(tools.every((t) => t.inputSchema?.type === 'object' && !('nodeIds' in t && typeof t.nodeIds === 'string')));
  assert.ok(!isPluginTool('save_screenshots') && !isPluginTool('export_frames_to_pdf'));
  for (const name of ['get_design_context', 'get_screenshot', 'create_frame', 'set_text', 'get_variable_defs']) assert.ok(isPluginTool(name), name);
  assert.equal(pluginPrompts().length, 12);
  assert.match(/** @type {any} */ (pluginPrompt('read_design_strategy')).messages[0].content.text, /\S/);
  assert.equal(pluginPrompt('nope'), undefined);
});

test('requests: node ids by each tool’s rule, hyphen ids normalised, the rest as params', () => {
  assert.deepEqual(pluginRequest('get_node', { nodeId: '12-34' }), { type: 'get_node', nodeIds: ['12:34'], params: {} });
  assert.deepEqual(pluginRequest('get_nodes_info', { nodeIds: ['1:2', '3-4', 5] }), { type: 'get_nodes_info', nodeIds: ['1:2', '3:4'], params: {} });
  assert.deepEqual(pluginRequest('get_screenshot', { nodeIds: ['1:2'], scale: 1 }), { type: 'get_screenshot', nodeIds: ['1:2'], params: { scale: 1 } });
  assert.deepEqual(pluginRequest('get_design_context', { depth: 2, dedupe_components: true }), {
    type: 'get_design_context',
    nodeIds: [],
    params: { depth: 2, dedupeComponents: true },
  });
  assert.deepEqual(pluginRequest('find_replace_text', { find: 'a', replace: 'b' }).nodeIds, []);
  assert.deepEqual(pluginRequest('find_replace_text', { find: 'a', replace: 'b', nodeId: '7-8' }).nodeIds, ['7:8']);
  assert.equal(pluginRequest('create_frame', { parentId: '1-2', width: 10 }).params.parentId, '1:2');
  assert.throws(() => pluginRequest('nope', {}), /Unknown tool/);
});

test('results: data as JSON text, errors as tool errors, screenshots as image blocks', () => {
  assert.deepEqual(pluginResult('get_pages', { data: { pages: [{ id: '0:1' }] } }), { content: [{ type: 'text', text: '{"pages":[{"id":"0:1"}]}' }] });
  assert.deepEqual(pluginResult('get_node', { error: 'Node not found' }), { content: [{ type: 'text', text: 'Node not found' }], isError: true });
  const shot = pluginResult('get_screenshot', {
    data: {
      exports: [
        { nodeId: '1:2', nodeName: 'Card', format: 'PNG', base64: 'iVBOR', width: 10, height: 20 },
        { nodeId: '3:4', nodeName: 'Icon', format: 'SVG', base64: Buffer.from('<svg/>').toString('base64'), width: 1, height: 1 },
      ],
    },
  });
  assert.deepEqual(shot.content[1], { type: 'image', data: 'iVBOR', mimeType: 'image/png' });
  assert.deepEqual(JSON.parse(shot.content[0].text), { nodeId: '1:2', nodeName: 'Card', width: 10, height: 20, format: 'PNG' });
  assert.equal(shot.content[3].text, '<svg/>');
});

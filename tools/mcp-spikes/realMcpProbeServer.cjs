const path = require('node:path');
const fs = require('node:fs');
const { assertSafeDescendant, assertSafeTempRoot } = require('./spikeSafety.cjs');

const root = process.env.KAOYAN_C0_ROOT;
const sdkRoot = process.env.KAOYAN_C0_SDK_ROOT;
if (!root || !sdkRoot) throw new Error('KAOYAN_C0_ROOT and KAOYAN_C0_SDK_ROOT are required');
assertSafeTempRoot(root);
assertSafeTempRoot(sdkRoot);

const traceFile = process.env.KAOYAN_C0_TRACE_FILE;
if (traceFile) {
  assertSafeDescendant(root, traceFile, { allowMissing: true });
  fs.mkdirSync(path.dirname(traceFile), { recursive: true });
  assertSafeDescendant(root, path.dirname(traceFile));
}

function trace(message) {
  if (!traceFile) return;
  const entry = { method: message.method || 'response' };
  if (message.method === 'initialize') {
    entry.protocolVersion = message.params?.protocolVersion;
    entry.capabilityKeys = Object.keys(message.params?.capabilities || {}).sort();
  }
  if (message.method === 'tools/call') entry.toolName = message.params?.name;
  if (message.method === 'resources/read') entry.resourceRead = true;
  if (message.method === 'prompts/get') entry.promptGet = true;
  fs.appendFileSync(traceFile, `${JSON.stringify(entry)}\n`, 'utf8');
}

const sdk = require(path.join(sdkRoot, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'server', 'mcp.js'));
const { StdioServerTransport } = require(path.join(sdkRoot, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'server', 'stdio.js'));
const { ResourceTemplate } = sdk;
const { z } = require(path.join(sdkRoot, 'node_modules', 'zod'));

const server = new sdk.McpServer({ name: 'kaoyan-c0-real-probe', version: '0.0.0-c0' });
server.registerTool('kaoyan_c0_echo', {
  description: 'Returns bounded structured probe data.',
  inputSchema: z.object({ text: z.string().max(64) })
}, async ({ text }) => ({
  content: [{ type: 'text', text: `echo:${text}` }],
  structuredContent: { text, bounded: true }
}));
server.registerTool('kaoyan_c0_progress_cancel', {
  description: 'Reports bounded progress and observes standard cancellation.',
  inputSchema: z.object({ steps: z.number().int().min(1).max(3).default(1) })
}, async ({ steps }, extra) => {
  for (let step = 1; step <= steps; step += 1) {
    if (extra.signal?.aborted) return { content: [{ type: 'text', text: 'cancelled' }], structuredContent: { cancelled: true, steps: step - 1 } };
    if (extra.sendNotification && extra._meta?.progressToken !== undefined) {
      await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: extra._meta.progressToken, progress: step, total: steps } });
    }
  }
  return { content: [{ type: 'text', text: `completed:${steps}` }], structuredContent: { cancelled: false, steps } };
});
server.registerResource('kaoyan_c0_status', 'kaoyan-c0://status', {
  description: 'A stable bounded C0 probe resource.',
  mimeType: 'application/json'
}, async () => ({ contents: [{ uri: 'kaoyan-c0://status', mimeType: 'application/json', text: '{"status":"ready"}' }] }));
server.registerResource('kaoyan_c0_template', new ResourceTemplate('kaoyan-c0://items/{id}', { list: undefined }), {
  description: 'A bounded parameterized C0 probe resource.',
  mimeType: 'application/json'
}, async (uri, { id }) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ id }) }] }));
server.registerPrompt('kaoyan_c0_prompt', {
  description: 'A bounded C0 probe prompt.'
}, () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'Probe topic: default' } }] }));

const transport = new StdioServerTransport();
const connecting = server.connect(transport);
const receive = transport.onmessage;
transport.onmessage = (message) => {
  trace(message);
  receive(message);
};
connecting.catch((error) => {
  process.stderr.write(`kaoyan-c0 SDK probe startup failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});

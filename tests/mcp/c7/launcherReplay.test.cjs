'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../..');
const launcherModule = require(path.join(root, 'dist/launcher-build/packages/kaoyan-mcp-stdio/src/launcher.cjs'));
const mcp = require(path.join(root, 'dist/launcher-build/src/shared/mcp/v1/index.js'));
const agent = require(path.join(root, 'dist/launcher-build/src/shared/agent/index.js'));

const clientId = 'c7-replay-client';
const requestId = '123e4567-e89b-42d3-a456-426614174000';
const dataVersion = { dataEpoch: 'c7-replay-epoch', dataRevision: 0 };
const catalog = agent.operationCatalogIdentity;

function command(id) {
  return {
    jsonrpc: '2.0', id, method: 'tools/call', params: {
      name: 'questions.create',
      arguments: {
        apiVersion: 1, kind: 'mcp-tool-arguments', operation: 'questions.create', requestId,
        idempotencyKey: requestId, expectedVersion: dataVersion, payload: { input: { title: 'C7 replay' } }
      }
    }
  };
}

test('standard MCP result shape survives launcher restart replay', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-c7-replay-'));
  const commandResult = { changed: true, value: { id: 1, imageData: 'data:image/png;base64,SECRET' }, events: [], dataVersion };
  const terminal = { kind: 'command-result', result: commandResult };
  const outcome = { ...mcp.mapGatewayTerminalToMcpOutcome('questions.create', requestId, terminal), data: { id: 1, imageData: '[REDACTED]' } };
  const standardResult = { content: [{ type: 'text', text: JSON.stringify(outcome) }], structuredContent: outcome, isError: false };
  const receipt = {
    apiVersion: 1, kind: 'receipt-status', clientId, requestId, status: 'completed',
    receipt: {
      apiVersion: 1, receiptId: '123e4567-e89b-42d3-a456-426614174001', clientId, requestId,
      operation: 'questions.create', payloadHash: launcherModule.hash({ input: { title: 'C7 replay' } }), catalog,
      status: 'completed', dataVersion, outcomeHash: launcherModule.hash(commandResult),
      createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:01.000Z'
    },
    terminal
  };
  const bridge = {
    async forward(_record, message) { return { status: 200, body: { jsonrpc: '2.0', id: message.id, result: standardResult } }; },
    async lookup() { return { status: 200, body: { jsonrpc: '2.0', id: `receipt-${requestId}`, result: { kind: 'mcp-receipt-projection', receipt, publicOutcome: outcome } } }; }
  };
  const createLauncher = () => {
    const instance = new launcherModule.Launcher({
      clientId, keyName: 'c7-replay-key', discoveryRoot: temporaryRoot, journalRoot: temporaryRoot,
      bridge, startupTimeoutMs: 100, timeoutMs: 100, lockPollMs: 1, lockWaitMs: 500
    });
    instance.discovery = async () => ({ instanceId: '123e4567-e89b-42d3-a456-426614174002', port: 12345, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    return instance;
  };
  try {
    const first = await createLauncher().handle(command(1));
    const replay = await createLauncher().handle(command(2));
    assert.deepEqual(first.result, standardResult);
    assert.deepEqual(replay.result, standardResult);
    assert.doesNotMatch(JSON.stringify(replay), /SECRET/);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

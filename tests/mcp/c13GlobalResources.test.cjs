const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '../..');
const protocol = require(path.join(root, 'dist/main/main/mcp/protocol.js'));

function principal(scopes) {
  return { apiVersion: 1, kind: 'agent-principal', clientId: 'owner', subjectId: 'owner', displayName: 'Owner', scopes, trust: 'observer', credentialBinding: 'binding', authenticatedAt: '2026-07-20T00:00:00.000Z', renderer: false };
}

test('C13 backup resource and export template are owner-bound Gateway reads', async () => {
  const calls = [];
  const gateway = { async query(envelope) { calls.push(envelope); return { kind: 'completed', result: { value: { assetId: envelope.payload.exportId ?? 'backup-1', metadata: { filePath: 'D:\\private\\secret' } }, dataVersion: { dataEpoch: 'epoch', dataRevision: 1 } } }; } };
  const handler = protocol.createMcpProtocolHandler({ gateway, randomUUID: () => '123e4567-e89b-42d3-a456-426614174000' });
  const current = principal(['backups.read', 'exports.read']);
  const resources = await handler({ principal: current, request: { id: 1, method: 'resources/list', params: {} } });
  const templates = await handler({ principal: current, request: { id: 2, method: 'resources/templates/list', params: {} } });
  assert.equal(resources.body.result.resources.some(({ name }) => name === 'backups.view'), true);
  assert.equal(templates.body.result.resourceTemplates.some(({ name }) => name === 'exports.view'), true);
  const backupRead = await handler({ principal: current, request: { id: 3, method: 'resources/read', params: { uri: 'kaoyan://backups' } } });
  const exportRead = await handler({ principal: current, request: { id: 4, method: 'resources/read', params: { uri: 'kaoyan://exports/export-safe' } } });
  for (const response of [backupRead, exportRead]) {
    const serialized = response.body.result.contents[0].text;
    assert.doesNotMatch(serialized, /filePath|D:\\private\\secret/);
  }
  assert.deepEqual(calls.map(({ operation, payload }) => ({ operation, payload })), [
    { operation: 'backups.list', payload: { pageSize: 50 } },
    { operation: 'exports.get', payload: { exportId: 'export-safe' } }
  ]);
  const denied = await handler({ principal: principal(['backups.read']), request: { id: 5, method: 'resources/read', params: { uri: 'kaoyan://exports/export-safe' } } });
  assert.equal(denied.body.error.data.code, 'SCOPE_DENIED');
});

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '../..');
const registry = require(path.join(root, 'dist/main/main/mcp/registry.js'));
const resources = require(path.join(root, 'dist/main/main/mcp/resources/index.js'));
const protocol = require(path.join(root, 'dist/main/main/mcp/protocol.js'));

test('C11 MCP tools and owner-bound import resource are exact', async () => {
  const c11Operations = ['imports.create_draft', 'imports.add_draft_image', 'imports.validate_draft', 'imports.preview_draft', 'imports.apply_draft', 'imports.get', 'imports.cancel'];
  const names = registry.mcpV1BusinessRegistry.filter(({ operation }) => c11Operations.includes(operation)).map(({ name }) => name).sort();
  assert.deepEqual(names, ['imports.add_draft_image', 'imports.apply_draft', 'imports.cancel', 'imports.create_draft', 'imports.get', 'imports.preview_draft', 'imports.validate_draft']);
  assert.equal(names.includes('imports.delete_batch'), false);
  const resource = resources.mcpV1ResourceTemplates.find(({ descriptor }) => descriptor.name === 'imports.view');
  assert.equal(resource.descriptor.uriTemplate, 'kaoyan://imports/{draftId}');
  const calls = [];
  const gateway = { async query(envelope) { calls.push(envelope); return { kind: 'completed', result: { value: { draftId: envelope.payload.draftId }, dataVersion: { dataEpoch: 'epoch', dataRevision: 1 } } }; } };
  const principal = { apiVersion: 1, kind: 'agent-principal', clientId: 'client', subjectId: 'subject', displayName: 'Client', scopes: ['imports.read'], trust: 'observer', credentialBinding: 'binding', authenticatedAt: '2026-07-20T00:00:00.000Z', renderer: false };
  const handler = protocol.createMcpProtocolHandler({ gateway, randomUUID: () => '123e4567-e89b-42d3-a456-426614174000' });
  const listed = await handler({ principal, request: { id: 1, method: 'resources/templates/list', params: {} } });
  assert.deepEqual(listed.body.result.resourceTemplates.map(({ name }) => name), ['imports.view']);
  await handler({ principal, request: { id: 2, method: 'resources/read', params: { uri: 'kaoyan://imports/draft-safe' } } });
  assert.deepEqual(calls.map(({ operation, payload }) => ({ operation, payload })), [{ operation: 'imports.get', payload: { draftId: 'draft-safe' } }]);
});

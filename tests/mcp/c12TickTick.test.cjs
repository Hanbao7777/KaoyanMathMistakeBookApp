const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const protocol = require(path.join(root, 'dist/main/main/mcp/protocol.js'));

function principal(scopes) {
  return { apiVersion: 1, kind: 'agent-principal', clientId: 'c12', subjectId: 'c12', displayName: 'C12', scopes, trust: 'observer', credentialBinding: 'binding', authenticatedAt: '2026-07-20T00:00:00.000Z', renderer: false };
}

test('C12 stable resources use the same Gateway query handlers and scope boundary', async () => {
  const calls = [];
  const gateway = {
    async query(envelope) {
      calls.push({ operation: envelope.operation, payload: envelope.payload });
      return { kind: 'completed', result: { value: [], dataVersion: { dataEpoch: 'epoch', dataRevision: 1 } } };
    }
  };
  const handler = protocol.createMcpProtocolHandler({ gateway, randomUUID: () => '123e4567-e89b-42d3-a456-426614174000' });
  const scopes = ['ticktick.lists.read', 'ticktick.habits.read', 'ticktick.calendar.read', 'ticktick.bridges.read'];
  const current = principal(scopes);
  const resources = await handler({ principal: current, request: { id: 1, method: 'resources/list', params: {} } });
  assert.deepEqual(resources.body.result.resources.map(({ name }) => name).sort(), ['capabilities.summary', 'ticktick.habits.view', 'ticktick.lists.view'].sort());
  const templates = await handler({ principal: current, request: { id: 2, method: 'resources/templates/list', params: {} } });
  assert.deepEqual(templates.body.result.resourceTemplates.map(({ name }) => name).sort(), ['ticktick.bridges.view', 'ticktick.calendar.view'].sort());
  await handler({ principal: current, request: { id: 3, method: 'resources/read', params: { uri: 'kaoyan://ticktick/lists' } } });
  await handler({ principal: current, request: { id: 4, method: 'resources/read', params: { uri: 'kaoyan://ticktick/habits' } } });
  await handler({ principal: current, request: { id: 5, method: 'resources/read', params: { uri: 'kaoyan://ticktick/calendar/2026/7' } } });
  await handler({ principal: current, request: { id: 6, method: 'resources/read', params: { uri: 'kaoyan://ticktick/bridges/task-1' } } });
  assert.deepEqual(calls.map(({ operation, payload }) => ({ operation, payload })), [
    { operation: 'ticktick.lists.list', payload: {} },
    { operation: 'ticktick.habits.list', payload: {} },
    { operation: 'ticktick.calendar.list_events', payload: { year: 2026, month: 7 } },
    { operation: 'ticktick.bridges.get', payload: { taskId: 'task-1' } }
  ]);
  const denied = await handler({ principal: principal(['ticktick.lists.read']), request: { id: 7, method: 'resources/read', params: { uri: 'kaoyan://ticktick/calendar/2026/7' } } });
  assert.equal(denied.status, 200);
  assert.equal(denied.body.error.data.code, 'SCOPE_DENIED');
});

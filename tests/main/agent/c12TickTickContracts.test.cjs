const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../..');
const agent = require(path.join(root, 'dist/main/shared/agent/index.js'));
const ticktick = require(path.join(root, 'dist/main/main/application/ticktick/contracts.js'));
const exposure = require(path.join(root, 'dist/main/shared/mcp/v1/exposureManifest.js'));
const registry = require(path.join(root, 'dist/main/main/mcp/registry.js'));

const operations = [
  'ticktick.lists.list', 'ticktick.lists.create', 'ticktick.lists.update',
  'ticktick.habits.list', 'ticktick.habits.create', 'ticktick.habits.update',
  'ticktick.calendar.list_events', 'ticktick.bridges.get', 'ticktick.bridges.update'
];

test('C12 exposes exactly nine bounded TickTick operations with domain scopes', () => {
  assert.deepEqual(exposure.mcpExternalBusinessOperations.filter((name) => name.startsWith('ticktick.')).sort(), [...operations].sort());
  assert.deepEqual(registry.mcpV1BusinessRegistry.filter(({ operation }) => operation.startsWith('ticktick.')).map(({ operation }) => operation).sort(), [...operations].sort());
  for (const operation of operations) {
    const descriptor = agent.resolveOperationDescriptor(operation);
    assert.equal(descriptor.domain, 'ticktick');
    assert.deepEqual(descriptor.sideEffects, descriptor.kind === 'command' ? ['database'] : []);
    assert.equal(descriptor.recovery, descriptor.kind === 'command' ? 'inverse' : 'none');
    assert.equal(descriptor.idempotency, descriptor.kind === 'command' ? 'required' : 'none');
  }
  assert.equal(registry.mcpV1Registry.some(({ name }) => /generic|execute|query/i.test(name)), false);
});

test('C12 contracts are exact, bounded, and reject secret or arbitrary remote fields', () => {
  assert.doesNotThrow(() => ticktick.validateTickTickCommand({ type: 'ticktick.lists.create', payload: { input: { name: 'List' } } }));
  assert.doesNotThrow(() => ticktick.validateTickTickCommand({ type: 'ticktick.lists.update', payload: { listId: 'list-1', input: { color: '#fff' } } }));
  assert.doesNotThrow(() => ticktick.validateTickTickCommand({ type: 'ticktick.habits.create', payload: { input: { name: 'Habit' } } }));
  assert.doesNotThrow(() => ticktick.validateTickTickCommand({ type: 'ticktick.bridges.update', payload: { input: { ticktick_task_id: 'task-1', linked_type: 'knowledge_point', linked_id: 'node-1' } } }));
  assert.doesNotThrow(() => ticktick.validateTickTickQuery({ type: 'ticktick.calendar.list_events', payload: { year: 2026, month: 7 } }));
  assert.throws(() => ticktick.validateTickTickCommand({ type: 'ticktick.lists.create', payload: { input: { name: 'List', token: 'secret' } } }), /invalid/i);
  assert.throws(() => ticktick.validateTickTickCommand({ type: 'ticktick.bridges.update', payload: { input: { ticktick_task_id: 'task-1', linked_type: 'knowledge_node', linked_id: 'node-1' } } }), /invalid/i);
  assert.throws(() => ticktick.validateTickTickQuery({ type: 'ticktick.calendar.list_events', payload: { year: 2026, month: 13 } }), /invalid/i);
  assert.throws(() => ticktick.validateTickTickQuery({ type: 'ticktick.calendar.list_events', payload: { year: 2026, month: 7, url: 'https://example.invalid' } }), /invalid/i);
});

test('C12 inventory and Renderer adapter prove the bounded writer boundary', () => {
  const inventory = fs.readFileSync(path.join(root, 'docs/tasks/2026-07-20-agent-control-plane-c12-write-entry-inventory.md'), 'utf8');
  const adapter = fs.readFileSync(path.join(root, 'src/main/ipc/adapters/ticktickIpc.ts'), 'utf8');
  assert.match(inventory, /Renderer|Timer|Startup|Network|Cross-domain bridge sync|remoteOutcome/);
  assert.match(inventory, /ticktick\.lists\.list[\s\S]*ticktick\.bridges\.update/);
  assert.match(adapter, /controlPlane\.gateway\.execute/);
  assert.doesNotMatch(adapter, /ticktickService|getDatabase\(|\.run\(|\.exec\(|\.prepare\(|fetch\(/);
});

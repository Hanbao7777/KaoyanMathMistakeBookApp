const assert = require('node:assert/strict');
const test = require('node:test');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const application = environment.requireMain('application/index.js');
const coordinatorModule = environment.requireMain('persistence/databaseCoordinator.js');
const { AuditLedger } = environment.requireMain('agent/auditLedger.js');
const { WorkflowStore } = environment.requireMain('agent/workflows.js');
const { IdempotencyStore } = environment.requireMain('agent/idempotencyStore.js');
const { ExecutionReceipts } = environment.requireMain('agent/executionReceipts.js');
const agent = require(`${environment.projectRoot}/dist/main/shared/agent/index.js`);

const now = '2026-07-16T12:00:00.000Z';
let currentTime = now;
let sequence = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;

async function composition() {
  const coordinator = await environment.databaseService.getDatabaseCoordinator();
  const control = coordinatorModule.createDatabaseCoordinatorControlCapability(coordinator);
  const executeControlWrite = (request) => coordinator.executeControlWrite(control, request);
  const dependencies = { executeControlWrite, catalog: agent.operationCatalogIdentity, now: () => currentTime, randomUUID: uuid };
  const audit = new AuditLedger(dependencies);
  const workflows = new WorkflowStore({ executeControlWrite, audit, now: () => currentTime, randomUUID: uuid });
  const idempotency = new IdempotencyStore({ executeControlWrite, audit, workflows, now: () => currentTime, randomUUID: uuid });
  const receipts = new ExecutionReceipts({ audit, workflows, now: () => currentTime });
  return { coordinator, audit, workflows, idempotency, receipts };
}

function request(requestId, overrides = {}) {
  return {
    clientId: 'client-one', requestId, operation: 'questions.mark_mastery',
    payload: { mastery: '一般', questionId: 1 }, affectedEntities: [{ entityType: 'question', entityId: '1' }],
    baseVersion: { dataEpoch: 'ignored-by-none', dataRevision: 0 }, catalog: agent.operationCatalogIdentity,
    risk: 'R2', policyVersion: 'policy-v1', ...overrides
  };
}

test.beforeEach(async () => { sequence = 0; currentTime = now; await environment.resetControlPlaneEnvironment(); });
test.after(() => environment.cleanupControlPlaneRoot());

test('admits once, conflicts on changed bindings, and replays the exact terminal result', async () => {
  const current = await composition();
  const requestId = uuid();
  const admitted = await current.idempotency.admit(request(requestId));
  assert.equal(admitted.kind, 'admitted');
  assert.equal((await current.idempotency.admit(request(requestId))).kind, 'pending');
  await assert.rejects(
    current.idempotency.admit(request(requestId, { payload: { mastery: '较强', questionId: 1 } })),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT'
  );

  let executions = 0;
  const eventBus = new application.DomainEventBus({ randomUUID: uuid, now: () => now });
  const commandBus = new application.CommandBus(current.coordinator, eventBus);
  const capability = application.createCommandBusExecutionReceiptCapability(commandBus);
  commandBus.register('questions.mark_mastery', {
    handler() {
      executions += 1;
      return { changed: false, value: { durable: true } };
    }
  });
  const envelope = {
    apiVersion: 1, kind: 'command',
    context: application.createInternalExecutionContext({ requestId, traceId: uuid(), concurrency: 'none' }, { now: () => now, randomUUID: uuid }),
    command: { type: 'questions.mark_mastery', payload: { questionId: 1, mastery: '一般' } }
  };
  const result = await commandBus.executeWithExecutionReceipt(capability, envelope, current.receipts.createTerminalHook(admitted.prepared));
  const replay = await current.idempotency.admit(request(requestId));

  assert.equal(replay.kind, 'replayed');
  assert.deepEqual(replay.outcome, result);
  assert.equal(executions, 1);
  const database = await environment.databaseService.getDatabase();
  const row = database.exec('SELECT status, terminal_outcome_json, terminal_outcome_hash, retain_until FROM agent_idempotency')[0].values[0];
  assert.equal(row[0], 'completed');
  assert.equal(row[1], agent.canonicalizeJson(result));
  assert.equal(row[2], agent.hashCanonicalJson(result));
  assert.equal(row[3], '2026-08-15T12:00:00.000Z');
  assert.equal((await current.audit.verify()).valid, true);
});

test('audit construction failure rolls back admission and returns no unaudited receipt', async () => {
  const current = await composition();
  current.audit.appendAdmissionInTransaction = () => { throw new Error('ledger unavailable'); };
  const requestId = uuid();
  await assert.rejects(current.idempotency.admit(request(requestId)), (error) => error.code === 'AUDIT_UNAVAILABLE');
  const database = await environment.databaseService.getDatabase();
  assert.deepEqual(database.exec('SELECT receipt_id FROM agent_idempotency'), []);
});

test('ordinary terminal receipts prune only after the durable thirty-day boundary', async () => {
  const current = await composition();
  const requestId = uuid();
  const admitted = await current.idempotency.admit(request(requestId));
  await current.idempotency.terminalizeKnownFailure(admitted.prepared, new Error('known precommit'));
  await assert.rejects(
    current.idempotency.pruneExpiredTerminalReceipts('2030-01-01T00:00:00.000Z'),
    (error) => error.code === 'VALIDATION_ERROR' && error.details.field === 'before'
  );
  assert.equal((await current.idempotency.get('client-one', requestId)).receipt.status, 'failed');
  currentTime = '2026-08-15T12:00:00.000Z';
  assert.equal(await current.idempotency.pruneExpiredTerminalReceipts('2026-08-15T11:59:59.999Z'), 0);
  assert.equal(await current.idempotency.pruneExpiredTerminalReceipts('2026-08-15T12:00:00.000Z'), 1);
  assert.equal(await current.idempotency.get('client-one', requestId), undefined);
});

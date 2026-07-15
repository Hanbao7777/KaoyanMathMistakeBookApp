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
let sequence = 0;
const uuid = () => `10000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
const hash = (value) => agent.hashCanonicalJson(value);

async function composition() {
  const coordinator = await environment.databaseService.getDatabaseCoordinator();
  const control = coordinatorModule.createDatabaseCoordinatorControlCapability(coordinator);
  const executeControlWrite = (request) => coordinator.executeControlWrite(control, request);
  const audit = new AuditLedger({ executeControlWrite, catalog: agent.operationCatalogIdentity, now: () => now, randomUUID: uuid });
  const workflows = new WorkflowStore({ executeControlWrite, audit, now: () => now, randomUUID: uuid });
  const idempotency = new IdempotencyStore({ executeControlWrite, audit, workflows, now: () => now, randomUUID: uuid });
  return { coordinator, audit, workflows, idempotency, receipts: new ExecutionReceipts({ audit, workflows, now: () => now }) };
}

function grant(grantId) {
  return {
    apiVersion: 1, grantId, clientId: 'client-r4', operation: 'questions.clear_all',
    payloadHash: hash({ deleteImages: true, maxQuestions: 500 }), targetHash: hash({ target: 'all-questions' }),
    catalog: agent.operationCatalogIdentity, recovery: 'consistency_bundle', maxAffectedEntities: 500,
    maxUses: 1, status: 'active', issuedAt: now, expiresAt: '2026-07-16T12:15:00.000Z'
  };
}

function admission(requestId, grantId, r4Overrides = {}) {
  return {
    clientId: 'client-r4', requestId, operation: 'questions.clear_all', payload: { deleteImages: true, maxQuestions: 500 },
    affectedEntities: [{ entityType: 'question-set', entityId: 'all' }],
    baseVersion: { dataEpoch: 'epoch-r4', dataRevision: 7 }, catalog: agent.operationCatalogIdentity,
    risk: 'R4', policyVersion: 'policy-v1', r4: {
      grantId, targetHash: hash({ target: 'all-questions' }), recovery: 'consistency_bundle',
      maxAffectedEntities: 500, expiresAt: '2026-07-16T12:10:00.000Z', ...r4Overrides
    }
  };
}

test.beforeEach(async () => { sequence = 0; await environment.resetControlPlaneEnvironment(); });
test.after(() => environment.cleanupControlPlaneRoot());

test('two concurrent R4 admissions produce exactly one reservation and executor path', async () => {
  const current = await composition();
  const grantId = uuid();
  await current.workflows.createR4Grant(grant(grantId));
  const firstId = uuid();
  const secondId = uuid();
  const outcomes = await Promise.allSettled([
    current.idempotency.admit(admission(firstId, grantId)),
    current.idempotency.admit(admission(secondId, grantId))
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected' && outcome.reason.code === 'R4_GRANT_RESERVED').length, 1);
  const admitted = outcomes.find((outcome) => outcome.status === 'fulfilled').value;
  assert.equal(admitted.kind, 'admitted');

  let executions = 0;
  const commandBus = new application.CommandBus(current.coordinator, new application.DomainEventBus());
  const capability = application.createCommandBusExecutionReceiptCapability(commandBus);
  commandBus.register('questions.clear_all', { handler: () => { executions += 1; return { changed: false, value: { deleted: 0 } }; } });
  const result = await commandBus.executeWithExecutionReceipt(capability, {
    apiVersion: 1, kind: 'command',
    context: application.createInternalExecutionContext({ requestId: admitted.prepared.requestId, traceId: uuid(), concurrency: 'none' }, { now: () => now, randomUUID: uuid }),
    command: { type: 'questions.clear_all', payload: { deleteImages: true, maxQuestions: 500 } }
  }, current.receipts.createTerminalHook(admitted.prepared));
  assert.equal(result.changed, false);
  assert.equal(executions, 1);
  assert.equal((await current.workflows.getR4Grant(grantId)).status, 'consumed');
  const database = await environment.databaseService.getDatabase();
  assert.deepEqual(database.exec("SELECT status FROM agent_idempotency ORDER BY status")[0].values, [['completed']]);
});

test('known precommit failure releases, while indeterminate publication remains reserved', async () => {
  const current = await composition();
  const firstGrant = uuid();
  await current.workflows.createR4Grant(grant(firstGrant));
  const failed = await current.idempotency.admit(admission(uuid(), firstGrant));
  await current.idempotency.terminalizeKnownFailure(failed.prepared, new Error('before commit'));
  assert.equal((await current.workflows.getR4Grant(firstGrant)).status, 'active');
  await current.workflows.revokeR4Grant(firstGrant, 'client-r4');

  const secondGrant = uuid();
  await current.workflows.createR4Grant(grant(secondGrant));
  const ambiguous = await current.idempotency.admit(admission(uuid(), secondGrant));
  await current.idempotency.terminalizeIndeterminate(ambiguous.prepared, { selectedCandidate: true, ledgerVerified: true });
  assert.equal((await current.workflows.getR4Grant(secondGrant)).status, 'reserved');
});

test('pending and terminal R4 receipts conflict on every authority-defining binding', async () => {
  const current = await composition();
  const grantId = uuid();
  await current.workflows.createR4Grant(grant(grantId));
  const requestId = uuid();
  const admitted = await current.idempotency.admit(admission(requestId, grantId));
  let executions = 0;
  const variants = [
    { targetHash: hash({ target: 'different' }) },
    { recovery: 'quarantine' },
    { maxAffectedEntities: 499 },
    { expiresAt: '2026-07-16T12:09:00.000Z' }
  ];
  for (const variant of variants) {
    await assert.rejects(current.idempotency.admit(admission(requestId, grantId, variant)), (error) => error.code === 'IDEMPOTENCY_CONFLICT');
    assert.equal(executions, 0);
  }
  const commandBus = new application.CommandBus(current.coordinator, new application.DomainEventBus());
  const capability = application.createCommandBusExecutionReceiptCapability(commandBus);
  commandBus.register('questions.clear_all', { handler: () => { executions += 1; return { changed: false, value: { deleted: 0 } }; } });
  await commandBus.executeWithExecutionReceipt(capability, {
    apiVersion: 1, kind: 'command',
    context: application.createInternalExecutionContext({ requestId, traceId: uuid(), concurrency: 'none' }, { now: () => now, randomUUID: uuid }),
    command: { type: 'questions.clear_all', payload: { deleteImages: true, maxQuestions: 500 } }
  }, current.receipts.createTerminalHook(admitted.prepared));
  assert.equal(executions, 1);
  for (const variant of variants) {
    await assert.rejects(current.idempotency.admit(admission(requestId, grantId, variant)), (error) => error.code === 'IDEMPOTENCY_CONFLICT');
    assert.equal(executions, 1);
  }
});

test('approval and change-set bindings remain immutable and bounded', async () => {
  const current = await composition();
  const approvalId = uuid();
  const payloadHash = hash({ x: 1 });
  const affectedSetHash = hash([{ entityType: 'question', entityId: '1' }]);
  const approval = await current.workflows.createApproval({
    apiVersion: 1, approvalId, nonce: 'n'.repeat(32), clientId: 'client-r4', credentialBinding: 'sha256-v1:' + 'a'.repeat(64),
    operation: 'questions.clear_all', payloadHash, affectedSetHash, baseVersion: { dataEpoch: 'epoch-r4', dataRevision: 7 },
    catalog: agent.operationCatalogIdentity, policyVersion: 'policy-v1', risk: 'R4', requiredScopes: ['operations.batch', 'questions.archive'],
    recovery: 'consistency_bundle', status: 'pending', createdAt: now, expiresAt: '2026-07-16T12:15:00.000Z'
  });
  assert.equal(approval.status, 'pending');
  assert.equal((await current.workflows.decideApproval(approvalId, 'approved', 'user')).status, 'approved');
  await assert.rejects(current.workflows.consumeApproval(approvalId, {
    clientId: 'client-r4', operation: 'questions.clear_all', payloadHash: hash({ x: 2 }), affectedSetHash,
    baseVersion: { dataEpoch: 'epoch-r4', dataRevision: 7 }, catalog: agent.operationCatalogIdentity
  }), (error) => error.code === 'APPROVAL_INVALID');

  const changeSetId = uuid();
  const operation = { operation: 'questions.clear_all', payload: { deleteImages: true, maxQuestions: 500 }, payloadHash: hash({ deleteImages: true, maxQuestions: 500 }), affectedEntities: [{ entityType: 'question-set', entityId: 'all' }] };
  await assert.rejects(current.workflows.createChangeSet({
    apiVersion: 1, changeSetId: uuid(), clientId: 'client-r4', status: 'draft', catalog: agent.operationCatalogIdentity,
    baseVersion: { dataEpoch: 'epoch-r4', dataRevision: 7 }, risk: 'R4', summary: 'Bad payload hash',
    operations: [{ ...operation, payloadHash: hash({ wrong: true }) }], affectedSetHash: hash(operation.affectedEntities),
    recovery: 'consistency_bundle', createdAt: now, expiresAt: '2026-07-16T12:15:00.000Z'
  }), (error) => error.code === 'APPROVAL_INVALID');
  await assert.rejects(current.workflows.createChangeSet({
    apiVersion: 1, changeSetId: uuid(), clientId: 'client-r4', status: 'draft', catalog: agent.operationCatalogIdentity,
    baseVersion: { dataEpoch: 'epoch-r4', dataRevision: 7 }, risk: 'R4', summary: 'Bad aggregate hash',
    operations: [operation], affectedSetHash: hash([{ entityType: 'question-set', entityId: 'different' }]),
    recovery: 'consistency_bundle', createdAt: now, expiresAt: '2026-07-16T12:15:00.000Z'
  }), (error) => error.code === 'APPROVAL_INVALID');
  const changeSet = await current.workflows.createChangeSet({
    apiVersion: 1, changeSetId, clientId: 'client-r4', status: 'waiting_approval', catalog: agent.operationCatalogIdentity,
    baseVersion: { dataEpoch: 'epoch-r4', dataRevision: 7 }, risk: 'R4', summary: 'Clear all questions', operations: [operation],
    affectedSetHash: hash(operation.affectedEntities), recovery: 'consistency_bundle', createdAt: now, expiresAt: '2026-07-16T12:15:00.000Z'
  });
  assert.deepEqual((await current.workflows.getChangeSet(changeSetId)).operations, changeSet.operations);
  const database = await environment.databaseService.getDatabase();
  assert.throws(() => database.run("UPDATE agent_changeset_operations SET operation_json = '{}'"), /immutable/i);
  database.run('DROP TRIGGER agent_changeset_operations_immutable_update');
  database.run(`UPDATE agent_changeset_operations SET affected_entities_hash = ? WHERE change_set_id = ?`, [hash([]), changeSetId]);
  await assert.rejects(current.workflows.getChangeSet(changeSetId), (error) => error.code === 'RECOVERY_FENCE');
});

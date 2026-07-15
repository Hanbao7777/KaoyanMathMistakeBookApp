const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const initSqlJs = require('sql.js');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const application = environment.requireMain('application/index.js');
const atomic = environment.requireMain('persistence/atomicPersist.js');
const candidates = environment.requireMain('persistence/databaseCandidate.js');
const coordinatorModule = environment.requireMain('persistence/databaseCoordinator.js');
const { schemaSql } = environment.requireMain('database/schema.js');
const { AuditLedger } = environment.requireMain('agent/auditLedger.js');
const { WorkflowStore } = environment.requireMain('agent/workflows.js');
const { IdempotencyStore } = environment.requireMain('agent/idempotencyStore.js');
const agent = require(`${environment.projectRoot}/dist/main/shared/agent/index.js`);

const now = '2026-07-16T12:00:00.000Z';
let sequence = 0;
const uuid = () => `30000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
const recoveryEvidence = { selectedCandidate: true, ledgerVerified: true };

async function composition(coordinator) {
  coordinator ??= await environment.databaseService.getDatabaseCoordinator();
  const capability = coordinatorModule.createDatabaseCoordinatorControlCapability(coordinator);
  const executeControlWrite = (request) => coordinator.executeControlWrite(capability, request);
  const audit = new AuditLedger({ executeControlWrite, catalog: agent.operationCatalogIdentity, now: () => now, randomUUID: uuid });
  const workflows = new WorkflowStore({ executeControlWrite, audit, now: () => now, randomUUID: uuid });
  return { audit, workflows, idempotency: new IdempotencyStore({ executeControlWrite, audit, workflows, now: () => now, randomUUID: uuid }) };
}

async function isolatedCoordinator(livePath, failAfterPublish) {
  const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
  const opener = candidates.createSqlJsCandidateOpener(SQL);
  let database;
  if (fs.existsSync(livePath)) database = new SQL.Database(fs.readFileSync(livePath));
  else {
    database = new SQL.Database();
    database.exec(schemaSql);
    database.run('INSERT INTO control_metadata VALUES (1, ?, 0, 0, 1, ?)', ['epoch-crash', now]);
    fs.mkdirSync(path.dirname(livePath), { recursive: true });
    fs.writeFileSync(livePath, database.export());
  }
  let nonce = 0;
  return new coordinatorModule.DatabaseCoordinator({
    database, livePath, opener, openDatabase: (bytes) => new SQL.Database(bytes),
    files: atomic.defaultAtomicFileDependencies,
    persistDependencies: {
      opener, files: atomic.defaultAtomicFileDependencies, randomId: () => `b4-crash-${++nonce}`,
      hook(context) { if (failAfterPublish() && context.stage === 'afterLivePublish') throw new Error('lost response'); }
    },
    now: () => now
  });
}

function request(requestId) {
  return {
    clientId: 'client-recovery', requestId, operation: 'questions.mark_mastery', payload: { questionId: 1, mastery: '一般' },
    affectedEntities: [{ entityType: 'question', entityId: '1' }], baseVersion: { dataEpoch: 'epoch-recovery', dataRevision: 4 },
    catalog: agent.operationCatalogIdentity, risk: 'R2'
  };
}

test.beforeEach(async () => { sequence = 0; await environment.resetControlPlaneEnvironment(); });
test.after(() => environment.cleanupControlPlaneRoot());

test('restart reconciliation terminalizes only orphan admissions and is idempotent', async () => {
  const first = await composition();
  const requestId = uuid();
  await first.idempotency.admit(request(requestId));
  assert.equal(await first.idempotency.reconcileInterruptedPrecommit(recoveryEvidence), 1);
  assert.equal(await first.idempotency.reconcileInterruptedPrecommit(recoveryEvidence), 0);
  const recovered = await first.idempotency.get('client-recovery', requestId);
  assert.equal(recovered.receipt.status, 'interrupted_precommit');
  assert.equal(recovered.outcome.code, 'RECOVERY_FENCE');
  const records = (await first.audit.exportVerified()).records;
  assert.equal(records.filter((record) => record.kind === 'reconciliation').length, 1);
});

test('known rollback terminalizes failure, while a terminal durable candidate remains authoritative', async () => {
  const current = await composition();
  const failedId = uuid();
  const failed = await current.idempotency.admit(request(failedId));
  await current.idempotency.terminalizeKnownFailure(failed.prepared, new Error('handler failed before commit'));
  assert.equal((await current.idempotency.get('client-recovery', failedId)).receipt.status, 'failed');
  assert.equal(await current.idempotency.reconcileInterruptedPrecommit(recoveryEvidence), 0);

  const indeterminateId = uuid();
  const indeterminate = await current.idempotency.admit(request(indeterminateId));
  await current.idempotency.terminalizeIndeterminate(indeterminate.prepared, recoveryEvidence);
  assert.equal((await current.idempotency.get('client-recovery', indeterminateId)).receipt.status, 'indeterminate');
  assert.equal(await current.idempotency.reconcileInterruptedPrecommit(recoveryEvidence), 0);
});

test('before-admission crash leaves no receipt or audit evidence', async () => {
  const current = await composition();
  assert.equal(await current.idempotency.reconcileInterruptedPrecommit(recoveryEvidence), 0);
  assert.deepEqual((await current.audit.exportVerified()).records, []);
});

test('lost response after durable publication replays the selected terminal candidate without re-execution', async () => {
  const root = environment.assertOwnedPath(path.join(environment.dataRoot, 'b4-lost-response'));
  const livePath = path.join(root, 'mistakes.db');
  let failPublication = false;
  const firstCoordinator = await isolatedCoordinator(livePath, () => failPublication);
  const first = await composition(firstCoordinator);
  const requestId = uuid();
  const admitted = await first.idempotency.admit(request(requestId));
  let executions = 0;
  const commandBus = new application.CommandBus(firstCoordinator, new application.DomainEventBus({ randomUUID: uuid, now: () => now }));
  const receiptCapability = application.createCommandBusExecutionReceiptCapability(commandBus);
  commandBus.register('questions.mark_mastery', { handler: () => { executions += 1; return { changed: false, value: { exact: 'terminal' } }; } });
  failPublication = true;
  await assert.rejects(commandBus.executeWithExecutionReceipt(receiptCapability, {
    apiVersion: 1, kind: 'command',
    context: application.createInternalExecutionContext({ requestId, traceId: uuid(), concurrency: 'none' }, { now: () => now, randomUUID: uuid }),
    command: { type: 'questions.mark_mastery', payload: { questionId: 1, mastery: '一般' } }
  }, new (environment.requireMain('agent/executionReceipts.js').ExecutionReceipts)({ audit: first.audit, workflows: first.workflows, now: () => now }).createTerminalHook(admitted.prepared)),
  (error) => error.code === 'PERSISTENCE_INDETERMINATE');
  assert.equal(executions, 1);

  failPublication = false;
  const recoveredCoordinator = await isolatedCoordinator(livePath, () => false);
  const recovered = await composition(recoveredCoordinator);
  const replay = await recovered.idempotency.admit(request(requestId));
  assert.equal(replay.kind, 'replayed');
  assert.deepEqual(replay.outcome, { changed: false, value: { exact: 'terminal' }, events: [], dataVersion: { dataEpoch: 'epoch-crash', dataRevision: 0 } });
  assert.equal(executions, 1);
  assert.equal((await recovered.audit.verify()).valid, true);
});

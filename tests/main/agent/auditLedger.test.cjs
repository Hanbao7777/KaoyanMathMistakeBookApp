const assert = require('node:assert/strict');
const test = require('node:test');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const coordinatorModule = environment.requireMain('persistence/databaseCoordinator.js');
const { AuditLedger } = environment.requireMain('agent/auditLedger.js');
const agent = require(`${environment.projectRoot}/dist/main/shared/agent/index.js`);

let currentTime = '2026-01-01T00:00:00.000Z';
let sequence = 0;
const uuid = () => `20000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;

async function ledger() {
  const coordinator = await environment.databaseService.getDatabaseCoordinator();
  const capability = coordinatorModule.createDatabaseCoordinatorControlCapability(coordinator);
  return new AuditLedger({
    executeControlWrite: (request) => coordinator.executeControlWrite(capability, request),
    catalog: agent.operationCatalogIdentity, now: () => currentTime, randomUUID: uuid
  });
}

test.beforeEach(async () => { sequence = 0; currentTime = '2026-01-01T00:00:00.000Z'; await environment.resetControlPlaneEnvironment(); });
test.after(() => environment.cleanupControlPlaneRoot());

test('writes canonical redacted records and verifies the append-only chain', async () => {
  const audit = await ledger();
  await audit.recordDenial({
    clientId: 'client-one', requestId: uuid(), operation: 'questions.create', risk: 'R2',
    summary: { reason: 'scope', accessToken: 'must-not-persist', absolutePath: 'D:\\private\\file.txt' }
  });
  await audit.recordQuery({ clientId: 'client-one', requestId: uuid(), operation: 'questions.list', risk: 'R1', summary: { count: 2 } });
  const exported = await audit.exportVerified();
  assert.equal(exported.valid, true);
  assert.equal(exported.records.length, 2);
  assert.deepEqual(exported.records[0].summary, { reason: 'scope' });
  assert.equal(exported.records[1].previousHash, exported.records[0].recordHash);
  const database = await environment.databaseService.getDatabase();
  const bytes = Buffer.from(database.export()).toString('utf8');
  assert.equal(bytes.includes('must-not-persist'), false);
  assert.equal(bytes.includes('D:\\private'), false);
});

test('detects mutation, deletion, and sequence reorder including active-tail deletion', async () => {
  const audit = await ledger();
  for (let index = 0; index < 3; index += 1) {
    await audit.recordQuery({ clientId: 'client-one', requestId: uuid(), operation: 'questions.list', risk: 'R1', summary: { index } });
  }
  const database = await environment.databaseService.getDatabase();
  database.run("UPDATE agent_audit_events SET summary_json = '{\"index\":99}' WHERE sequence = 1");
  await assert.rejects(audit.verify(), (error) => error.code === 'AUDIT_INTEGRITY_FAILURE');
  const restoredDatabase = await environment.databaseService.getDatabase();
  restoredDatabase.run('DELETE FROM agent_audit_events WHERE sequence = 2');
  await assert.rejects(audit.verify(), (error) => error.code === 'AUDIT_INTEGRITY_FAILURE');

  await environment.resetControlPlaneEnvironment();
  sequence = 0;
  const reordered = await ledger();
  for (let index = 0; index < 3; index += 1) await reordered.recordQuery({ clientId: 'client-one', requestId: uuid(), operation: 'questions.list', risk: 'R1', summary: { index } });
  const reorderedDatabase = await environment.databaseService.getDatabase();
  reorderedDatabase.run('UPDATE agent_audit_events SET sequence = 10 WHERE sequence = 1');
  await assert.rejects(reordered.verify(), (error) => error.code === 'AUDIT_INTEGRITY_FAILURE');
});

test('rotation closes and anchors a successor while protected records retain at least one year', async () => {
  const audit = await ledger();
  await audit.recordQuery({ clientId: 'client-one', requestId: uuid(), operation: 'questions.list', risk: 'R1', summary: { class: 'ordinary' } });
  await audit.recordAuthentication({ clientId: 'client-one', summary: { class: 'protected' } });
  currentTime = '2026-07-16T00:00:00.000Z';
  await audit.rotateAndApplyRetention({
    before: currentTime, clientId: 'renderer', requestId: uuid(), operation: 'agent.audit.cleanup', risk: 'R4', summary: { action: 'cleanup' }
  });
  const verification = await audit.verify();
  assert.equal(verification.segments, 2);
  const database = await environment.databaseService.getDatabase();
  const segments = database.exec('SELECT segment_number, previous_closing_hash, closing_hash, closed_at FROM agent_audit_segments ORDER BY segment_number')[0].values;
  assert.equal(segments[0][3] !== null, true);
  assert.equal(segments[1][1], segments[0][2]);
  const retention = database.exec('SELECT retention_class, retain_until FROM agent_audit_events WHERE kind = ? ORDER BY sequence', ['authentication'])[0].values[0];
  assert.deepEqual(retention, ['protected_1y', '2027-01-01T00:00:00.000Z']);
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(audit));
  assert.equal(methods.some((name) => /update|delete|append$/i.test(name)), false);
});

test('future retention cutoff is rejected before rotation or pruning commits', async () => {
  const audit = await ledger();
  await audit.recordQuery({ clientId: 'client-one', requestId: uuid(), operation: 'questions.list', risk: 'R1', summary: { fresh: true } });
  await assert.rejects(audit.rotateAndApplyRetention({
    before: '2030-01-01T00:00:00.000Z', clientId: 'renderer', requestId: uuid(),
    operation: 'agent.audit.cleanup', risk: 'R4', summary: { action: 'unsafe-future-cleanup' }
  }), (error) => error.code === 'VALIDATION_ERROR' && error.details.field === 'before');
  const database = await environment.databaseService.getDatabase();
  assert.deepEqual(database.exec('SELECT closed_at, pruned_at FROM agent_audit_segments')[0].values, [[null, null]]);
  assert.equal(database.exec('SELECT COUNT(*) FROM agent_audit_events')[0].values[0][0], 1);
});

test('corrupted or deleted current head blocks audited append without extending the chain', async () => {
  const audit = await ledger();
  await audit.recordQuery({ clientId: 'client-one', requestId: uuid(), operation: 'questions.list', risk: 'R1', summary: { index: 0 } });
  await audit.recordQuery({ clientId: 'client-one', requestId: uuid(), operation: 'questions.list', risk: 'R1', summary: { index: 1 } });
  let database = await environment.databaseService.getDatabase();
  database.run("UPDATE agent_audit_events SET summary_json = '{\"index\":99}' WHERE sequence = 1");
  await assert.rejects(
    audit.recordQuery({ clientId: 'client-one', requestId: uuid(), operation: 'questions.list', risk: 'R1', summary: { index: 2 } }),
    (error) => error.code === 'AUDIT_INTEGRITY_FAILURE'
  );
  database = await environment.databaseService.getDatabase();
  assert.equal(database.exec('SELECT COUNT(*) FROM agent_audit_events')[0].values[0][0], 2);
  database.run('DELETE FROM agent_audit_events WHERE sequence = 1');
  await assert.rejects(
    audit.recordQuery({ clientId: 'client-one', requestId: uuid(), operation: 'questions.list', risk: 'R1', summary: { index: 3 } }),
    (error) => error.code === 'AUDIT_INTEGRITY_FAILURE'
  );
  database = await environment.databaseService.getDatabase();
  assert.equal(database.exec('SELECT COUNT(*) FROM agent_audit_events')[0].values[0][0], 2);
});

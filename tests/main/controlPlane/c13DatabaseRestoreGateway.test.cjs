const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const initSqlJs = require('sql.js');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const { databaseService, cleanupControlPlaneRoot, resetControlPlaneEnvironment } = environment;
const global = environment.requireMain('application/global/index.js');
const bootstrap = environment.requireMain('agent/bootstrap.js');
const authentication = environment.requireMain('agent/clientAuthenticator.js');
const { AuditLedger } = environment.requireMain('agent/auditLedger.js');
const { WorkflowStore } = environment.requireMain('agent/workflows.js');
const { createDatabaseCoordinatorControlCapability } = environment.requireMain('persistence/databaseCoordinator.js');
const pathService = environment.requireMain('services/pathService.js');
const agent = require(`${environment.projectRoot}/dist/main/shared/agent/index.js`);

const restoreOwner = 'c13-restore-client';
const otherOwner = 'c13-restore-other';
const fixedNow = '2026-07-20T00:00:00.000Z';
const strictMaterializationDurability = Object.freeze({
  directoryDurability: Object.freeze({ async openDirectory() { return Object.freeze({ async sync() {}, async close() {} }); } }),
  files: Object.freeze({
    async mkdir(directoryPath) { await fs.promises.mkdir(directoryPath, { recursive: true }); },
    async openExclusive(filePath) { const handle = await fs.promises.open(filePath, 'wx'); return Object.freeze({ async writeFile(value) { await handle.writeFile(value); }, async sync() {}, async close() { await handle.close(); } }); },
    async openRead(filePath) { const handle = await fs.promises.open(filePath, 'r'); return Object.freeze({ async sync() {}, async close() { await handle.close(); } }); },
    async rename(from, to) { await fs.promises.rename(from, to); },
    async unlink(filePath) { await fs.promises.unlink(filePath); }
  })
});

test.beforeEach(resetControlPlaneEnvironment);
test.after(() => cleanupControlPlaneRoot());

function managedPaths() {
  const paths = pathService.getPaths();
  return Object.freeze({
    backups: path.normalize(path.join(paths.backups, 'agent-materialized')),
    exports: path.normalize(path.join(paths.exports, 'agent-materialized')),
    temp: path.normalize(path.join(paths.temp, 'agent-global')),
    journal: path.normalize(path.join(paths.data, 'operation-journal', 'global-materialization')),
    quarantine: path.normalize(path.join(paths.temp, 'agent-global-quarantine'))
  });
}

function assertRedactedRestoreOutcome(outcome, runtime, backup) {
  assert.deepEqual(outcome.result.value, { backupId: backup.assetId, restored: true });
  const serialized = JSON.stringify(outcome);
  const privateRoots = [
    backup.backupPath,
    ...Object.values(runtime.managedPaths),
    ...Object.values(pathService.getPaths()).filter((value) => typeof value === 'string' && path.isAbsolute(value)),
    path.join(pathService.getPaths().data, 'agent-recovery'),
    path.join(pathService.getPaths().data, 'operation-journal')
  ];
  for (const privateRoot of privateRoots) assert.equal(serialized.includes(path.normalize(privateRoot)), false, privateRoot);
  assert.deepEqual(Object.keys(outcome.result.value).sort(), ['backupId', 'restored']);
}

function managementCommand(operation, payload, requestId = crypto.randomUUID()) {
  return Object.freeze({ apiVersion: 1, kind: 'agent-command', operation, payload, requestId, catalog: agent.operationCatalogIdentity });
}

function gatewayCommand(operation, payload, expectedVersion, requestId = crypto.randomUUID(), workflow) {
  return Object.freeze({
    apiVersion: 1, kind: 'agent-command', operation, payload, requestId, catalog: agent.operationCatalogIdentity,
    ...(expectedVersion ? { expectedVersion } : {}),
    ...(workflow ? { workflow } : {})
  });
}

async function workflowStore(now = fixedNow) {
  const coordinator = await databaseService.getDatabaseCoordinator();
  const capability = createDatabaseCoordinatorControlCapability(coordinator);
  const executeControlWrite = (request) => coordinator.executeControlWrite(capability, request);
  const audit = new AuditLedger({ executeControlWrite, catalog: agent.operationCatalogIdentity, now: () => now, randomUUID: crypto.randomUUID });
  return new WorkflowStore({ executeControlWrite, audit, now: () => now, randomUUID: crypto.randomUUID });
}

async function verifiedAudit(now = fixedNow) {
  const coordinator = await databaseService.getDatabaseCoordinator();
  const capability = createDatabaseCoordinatorControlCapability(coordinator);
  const executeControlWrite = (request) => coordinator.executeControlWrite(capability, request);
  const audit = new AuditLedger({ executeControlWrite, catalog: agent.operationCatalogIdentity, now: () => now, randomUUID: crypto.randomUUID });
  const verification = await audit.verify();
  assert.equal(verification.valid, true);
  return verification;
}

async function mutateLiveDatabaseFile(mutator) {
  const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
  const databasePath = pathService.getPaths().database;
  const database = new SQL.Database(fs.readFileSync(databasePath));
  try {
    mutator(database);
    fs.writeFileSync(databasePath, Buffer.from(database.export()));
  } finally {
    database.close();
  }
}

async function restoreGateway(options = {}) {
  const coordinator = await databaseService.getDatabaseCoordinator();
  const questions = await databaseService.getQuestionsApplication();
  const readOnlyDatabase = await databaseService.getReadOnlyDatabase();
  const paths = options.managedPaths ?? managedPaths();
  let replacements = 0;
  let livePublications = 0;
  let composition;
  const globalApplication = global.registerGlobalApplication({
    coordinator,
    readOnlyDatabase,
    getJobs: () => composition.jobs,
    currentVersion: () => coordinator.currentVersion(),
    cursorSecret: Buffer.alloc(32, 7),
    now: () => options.now ?? fixedNow,
    managedPaths: paths,
    materializationDurability: options.materializationDurability ?? strictMaterializationDurability,
    databaseRestore: async (input) => {
      replacements += 1;
      return (options.databaseRestore ?? databaseService.restoreManagedDatabaseBackup)({
        ...input,
        atomicHook(context) {
          if (context.stage === 'afterLivePublish') livePublications += 1;
          return options.atomicHook?.(context);
        }
      });
    }
  });
  const appInstanceId = options.appInstanceId ?? 'c13-restore-gateway';
  const verifier = { verify(raw) { return {
    credentialFingerprint: authentication.fingerprintCredential(raw.credential),
    sessionFingerprint: authentication.fingerprintCredential(raw.session)
  }; } };
  composition = await bootstrap.bootstrapAgentGateway({
    coordinator,
    commandBus: questions.gateway.commandBus,
    queryBus: questions.gateway.queryBus,
    selectedCandidateEvidence: true,
    appInstanceId,
    credentialVerifier: verifier,
    cursorSecret: 'r'.repeat(32),
    jobResultRoot: environment.resultRoot,
    now: () => options.now ?? fixedNow,
    globalApplication,
    resolveState: (envelope, descriptor) => questions.gateway.resolveState(envelope, descriptor),
    executeBusinessCommand: (command, executionContext, dispatch) => questions.gateway.execute(command, executionContext, dispatch)
  });
  const registry = await bootstrap.bootstrapAgentB3({
    coordinator,
    appInstanceId,
    credentialVerifier: verifier,
    cursorSecret: 'r'.repeat(32),
    now: () => options.now ?? fixedNow
  });
  return { coordinator, composition, globalApplication, registry, managedPaths: paths, verifier, appInstanceId, replacements: () => replacements, livePublications: () => livePublications };
}

async function registerRestoreClient(runtime, clientId, rawCredential, rawSession) {
  const credentialFingerprint = authentication.fingerprintCredential(rawCredential);
  const sessionFingerprint = authentication.fingerprintCredential(rawSession);
  await runtime.registry.registry.registerClient({
    clientId,
    subjectId: clientId,
    displayName: clientId,
    credentialFingerprint,
    scopes: ['database.restore', 'changesets.manage'],
    trust: 'full_control'
  });
  await runtime.registry.registry.setExternalControlEnabled(true);
  await runtime.registry.registry.createSession(clientId, credentialFingerprint, sessionFingerprint, '2026-07-20T01:00:00.000Z');
  return runtime.composition.authenticator.authenticate({ credential: rawCredential, session: rawSession });
}

async function seedQuestion(title) {
  return databaseService.createQuestion({
    title,
    content: `${title} content`,
    wrong_thinking: '',
    wrong_solution: '',
    correct_solution: '',
    answer: '',
    subject: '高等数学',
    category: '函数',
    question_type: '解答题',
    error_reason: '',
    source: 'c13-restore-test',
    difficulty: '中等',
    mastery_level: '较弱',
    note: '',
    tags: [],
    questionImageSources: [],
    solutionImageSources: []
  });
}

async function seedPublishedBackupAsset(runtime, assetId, ownerClientId) {
  for (const directory of Object.values(runtime.managedPaths)) fs.mkdirSync(directory, { recursive: true });
  const paths = pathService.getPaths();
  const backupPath = path.join(runtime.managedPaths.backups, `${assetId}.db`);
  fs.copyFileSync(paths.database, backupPath);
  const evidence = global.materializationEvidence(backupPath);
  const coordinator = await databaseService.getDatabaseCoordinator();
  const capability = createDatabaseCoordinatorControlCapability(coordinator);
  await coordinator.executeControlWrite(capability, {
    requestId: `c13-seed-backup-${assetId}`,
    execute(database, scope) {
      global.createGlobalAsset(database, {
        assetId,
        ownerClientId,
        kind: 'backup',
        metadata: { backupKind: 'manual' },
        internalPath: backupPath,
        now: fixedNow
      }, scope);
      database.run("UPDATE agent_global_assets SET status='published', content_hash=?, content_size=? WHERE asset_id=?", [evidence.hash, evidence.size, assetId]);
      return { changed: true, value: undefined };
    }
  });
  return Object.freeze({ assetId, backupPath, evidence });
}

async function createApprovedRestoreChangeSet(clientId, backupId, baseVersion) {
  const store = await workflowStore();
  const changeSetId = crypto.randomUUID();
  const payload = Object.freeze({ backupId });
  const affectedEntities = Object.freeze([Object.freeze({ entityType: 'backup', entityId: backupId })]);
  await store.createChangeSet(Object.freeze({
    apiVersion: 1,
    changeSetId,
    clientId,
    status: 'draft',
    catalog: agent.operationCatalogIdentity,
    baseVersion,
    risk: 'R4',
    summary: `Restore managed backup ${backupId}`,
    operations: Object.freeze([Object.freeze({ operation: 'database.restore', payload, payloadHash: agent.hashCanonicalJson(payload), affectedEntities })]),
    affectedSetHash: agent.hashCanonicalJson(affectedEntities),
    recovery: 'consistency_bundle',
    createdAt: fixedNow,
    expiresAt: '2026-07-20T00:30:00.000Z'
  }));
  await store.transitionChangeSet(changeSetId, 'approved');
  return { changeSetId, payload };
}

async function createRestoreGrant(runtime, clientId, payload, targetHash) {
  const granted = await runtime.composition.gateway.execute(managementCommand('agent.r4_grants.create', {
    grant: {
      clientId,
      operation: 'database.restore',
      payloadHash: agent.hashCanonicalJson(payload),
      targetHash,
      maxAffectedEntities: 500,
      expiresAt: '2026-07-20T00:10:00.000Z'
    }
  }), runtime.composition.renderer.principal());
  assert.equal(granted.kind, 'completed', JSON.stringify(granted));
  return granted.result.value.grantId;
}

async function prepareApprovedRestore(runtime, label = crypto.randomUUID()) {
  const credential = `restore-${label}-credential`;
  const session = `restore-${label}-session`;
  const principal = await registerRestoreClient(runtime, restoreOwner, credential, session);
  await seedQuestion(`kept ${label}`);
  const backup = await seedPublishedBackupAsset(runtime, `backup-restore-${label}`.replace(/[^A-Za-z0-9_-]/g, '-'), restoreOwner);
  await seedQuestion(`after ${label}`);
  const baseVersion = runtime.coordinator.currentVersion();
  const planned = gatewayCommand('database.restore', { backupId: backup.assetId }, baseVersion);
  const state = runtime.globalApplication.resolveState(planned, agent.resolveOperationDescriptor('database.restore'), principal);
  const grantId = await createRestoreGrant(runtime, restoreOwner, planned.payload, state.targetHash);
  const { changeSetId } = await createApprovedRestoreChangeSet(restoreOwner, backup.assetId, baseVersion);
  const request = gatewayCommand('agent.changesets.apply', { changeSetId }, undefined, crypto.randomUUID(), { kind: 'r4-grant', id: grantId });
  return { credential, session, principal, backup, baseVersion, grantId, changeSetId, request, keptTitle: `kept ${label}`, afterTitle: `after ${label}` };
}

async function restartWithRuntime(runtime, now = fixedNow) {
  await databaseService.resetDatabaseConnectionAsync();
  return databaseService.initializeDatabase({
    now: () => now,
    agent: { appInstanceId: runtime.appInstanceId, credentialVerifier: runtime.verifier, cursorSecret: 'r'.repeat(32), jobResultRoot: environment.resultRoot }
  });
}

test('database.restore consumes a local Renderer R4 grant through one approved change set and replays without a second replacement', async () => {
  const runtime = await restoreGateway();
  const credential = 'restore-owner-credential';
  const session = 'restore-owner-session';
  const principal = await registerRestoreClient(runtime, restoreOwner, credential, session);
  await seedQuestion('kept by backup');
  const backup = await seedPublishedBackupAsset(runtime, 'backup-restore-gateway', restoreOwner);
  await seedQuestion('created after backup');
  assert.deepEqual((await databaseService.listQuestions()).map((question) => question.title).sort(), ['created after backup', 'kept by backup']);

  const baseVersion = runtime.coordinator.currentVersion();
  const planned = gatewayCommand('database.restore', { backupId: backup.assetId }, baseVersion);
  const state = runtime.globalApplication.resolveState(planned, agent.resolveOperationDescriptor('database.restore'), principal);
  const grantId = await createRestoreGrant(runtime, restoreOwner, planned.payload, state.targetHash);
  const { changeSetId } = await createApprovedRestoreChangeSet(restoreOwner, backup.assetId, baseVersion);
  const request = gatewayCommand('agent.changesets.apply', { changeSetId }, undefined, crypto.randomUUID(), { kind: 'r4-grant', id: grantId });

  const first = await runtime.composition.gateway.execute(request, principal);
  assert.equal(first.kind, 'completed', JSON.stringify(first));
  assertRedactedRestoreOutcome(first, runtime, backup);
  assert.deepEqual((await databaseService.listQuestions()).map((question) => question.title), ['kept by backup']);

  const terminalOutcome = (await databaseService.getDatabase()).exec(
    'SELECT terminal_outcome_json FROM agent_idempotency WHERE client_id=? AND request_id=?',
    [restoreOwner, request.requestId]
  )[0].values[0][0];
  assert.deepEqual(JSON.parse(terminalOutcome), first.result);
  assertRedactedRestoreOutcome({ kind: 'completed', result: JSON.parse(terminalOutcome) }, runtime, backup);

  await databaseService.resetDatabaseConnectionAsync();
  await databaseService.initializeDatabase({
    now: () => fixedNow,
    agent: { appInstanceId: runtime.appInstanceId, credentialVerifier: runtime.verifier, cursorSecret: 'r'.repeat(32), jobResultRoot: environment.resultRoot }
  });
  const replayGateway = await databaseService.getAgentControlPlane();
  const replayRegistry = await bootstrap.bootstrapAgentB3({
    coordinator: await databaseService.getDatabaseCoordinator(),
    appInstanceId: runtime.appInstanceId,
    credentialVerifier: runtime.verifier,
    cursorSecret: 'r'.repeat(32),
    now: () => fixedNow
  });
  const replaySession = 'restore-owner-session-restart';
  await replayRegistry.registry.createSession(restoreOwner, authentication.fingerprintCredential(credential), authentication.fingerprintCredential(replaySession), '2026-07-20T01:00:00.000Z');
  const replayPrincipal = await replayGateway.authenticator.authenticate({ credential, session: replaySession });
  const replay = await replayGateway.gateway.execute(request, replayPrincipal);
  assert.equal(replay.kind, 'replayed', JSON.stringify(replay));
  assert.deepEqual(replay.result, first.result);
  assertRedactedRestoreOutcome(replay, runtime, backup);
  assert.equal(runtime.replacements(), 1);

  await seedQuestion('normal write after restore');
  await databaseService.resetDatabaseConnectionAsync();
  await databaseService.initializeDatabase({
    now: () => fixedNow,
    agent: { appInstanceId: runtime.appInstanceId, credentialVerifier: runtime.verifier, cursorSecret: 'r'.repeat(32), jobResultRoot: environment.resultRoot }
  });
  const advancedGateway = await databaseService.getAgentControlPlane();
  const advancedRegistry = await bootstrap.bootstrapAgentB3({
    coordinator: await databaseService.getDatabaseCoordinator(),
    appInstanceId: runtime.appInstanceId,
    credentialVerifier: runtime.verifier,
    cursorSecret: 'r'.repeat(32),
    now: () => fixedNow
  });
  const advancedSession = 'restore-owner-session-advanced';
  await advancedRegistry.registry.createSession(restoreOwner, authentication.fingerprintCredential(credential), authentication.fingerprintCredential(advancedSession), '2026-07-20T01:00:00.000Z');
  const advancedPrincipal = await advancedGateway.authenticator.authenticate({ credential, session: advancedSession });
  const advancedReplay = await advancedGateway.gateway.execute(request, advancedPrincipal);
  assert.equal(advancedReplay.kind, 'replayed', JSON.stringify(advancedReplay));
  assert.deepEqual(advancedReplay.result, first.result);
  assert.deepEqual((await databaseService.listQuestions()).map((question) => question.title).sort(), ['kept by backup', 'normal write after restore'].sort());

  const database = await databaseService.getDatabase();
  const grantRows = database.exec('SELECT status,reservation_id,consumed_at,operation,reserved_payload_hash FROM agent_r4_grants WHERE grant_id=?', [grantId])[0].values;
  assert.equal(grantRows.length, 1);
  assert.equal(grantRows[0][0], 'consumed');
  assert.match(grantRows[0][1], /^[0-9a-f-]{36}$/);
  assert.equal(typeof grantRows[0][2], 'string');
  assert.equal(grantRows[0][3], 'database.restore');
  assert.equal(grantRows[0][4], agent.hashCanonicalJson({ backupId: backup.assetId }));
  assert.deepEqual(database.exec('SELECT status FROM agent_changesets WHERE change_set_id=?', [changeSetId])[0].values, [['applied']]);
  assert.deepEqual(database.exec('SELECT status,operation,reservation_id,grant_id FROM agent_idempotency WHERE client_id=? AND request_id=?', [restoreOwner, request.requestId])[0].values,
    [['completed', 'agent.changesets.apply', grantRows[0][1], grantId]]);
  assert.deepEqual(database.exec('SELECT status,asset_id FROM agent_database_restore_journals WHERE owner_client_id=? AND request_id=?', [restoreOwner, request.requestId])[0].values,
    [['completed', backup.assetId]]);
  assert.equal(database.exec("SELECT COUNT(*) FROM agent_audit_events WHERE kind='success' AND client_id=? AND request_id=? AND operation='agent.changesets.apply'", [restoreOwner, request.requestId])[0].values[0][0], 1);
  await verifiedAudit();
});

test('database.restore preserves current control-plane state instead of resurrecting backup control rows', async () => {
  const runtime = await restoreGateway();
  runtime.composition.jobExecutor.stop();
  const credential = 'restore-control-credential';
  const session = 'restore-control-session';
  const principal = await registerRestoreClient(runtime, restoreOwner, credential, session);
  const staleClient = 'c13-restore-stale-control';
  const staleCredential = authentication.fingerprintCredential('stale-control-credential');
  const staleSession = authentication.fingerprintCredential('stale-control-session');
  await runtime.registry.registry.registerClient({
    clientId: staleClient,
    subjectId: staleClient,
    displayName: staleClient,
    credentialFingerprint: staleCredential,
    scopes: ['database.restore', 'jobs.read'],
    trust: 'full_control'
  });
  const staleSessionRecord = await runtime.registry.registry.createSession(staleClient, staleCredential, staleSession, '2026-07-20T01:00:00.000Z');
  await seedQuestion('control kept by backup');
  const backup = await seedPublishedBackupAsset(runtime, 'backup-restore-control-plane', restoreOwner);

  await runtime.registry.registry.updateClientAccess(staleClient, ['audit.read'], 'observer');
  await runtime.registry.registry.terminateSession(staleSessionRecord.sessionId);
  await runtime.registry.registry.revokeClient(staleClient);
  const capability = createDatabaseCoordinatorControlCapability(runtime.coordinator);
  const job = await runtime.coordinator.executeControlWrite(capability, {
    requestId: crypto.randomUUID(),
    execute: (activeDatabase, scope) => {
      const created = runtime.composition.jobs.createInTransaction(activeDatabase, scope, {
        target: { operation: 'backups.materialize', kind: 'command', payload: { assetId: 'post-backup-job' }, expectedVersion: runtime.coordinator.currentVersion() }
      }, runtime.composition.renderer.principal());
      activeDatabase.run("UPDATE agent_jobs SET status='failed', progress=100, error_code='TEST_TERMINAL', error_message='post-backup terminal job', terminal_at=?, updated_at=? WHERE job_id=?", [fixedNow, fixedNow, created.value.jobId]);
      return created;
    }
  });
  await runtime.registry.registry.updatePolicy('post-restore-policy', []);
  const beforeRestoreSequence = Number((await databaseService.getDatabase()).exec('SELECT MAX(sequence) FROM agent_audit_events')[0].values[0][0]);
  await seedQuestion('control created after backup');

  const baseVersion = runtime.coordinator.currentVersion();
  const planned = gatewayCommand('database.restore', { backupId: backup.assetId }, baseVersion);
  const state = runtime.globalApplication.resolveState(planned, agent.resolveOperationDescriptor('database.restore'), principal);
  const grantId = await createRestoreGrant(runtime, restoreOwner, planned.payload, state.targetHash);
  const { changeSetId } = await createApprovedRestoreChangeSet(restoreOwner, backup.assetId, baseVersion);
  const request = gatewayCommand('agent.changesets.apply', { changeSetId }, undefined, crypto.randomUUID(), { kind: 'r4-grant', id: grantId });
  const restored = await runtime.composition.gateway.execute(request, principal);
  assert.equal(restored.kind, 'completed', JSON.stringify(restored));
  (await databaseService.getAgentControlPlane()).jobExecutor.stop();
  assert.deepEqual((await databaseService.listQuestions()).map((question) => question.title), ['control kept by backup']);

  const database = await databaseService.getDatabase();
  assert.equal(database.exec('SELECT trust,revoked_at FROM agent_clients WHERE client_id=?', [staleClient])[0].values[0][0], 'observer');
  assert.equal(typeof database.exec('SELECT trust,revoked_at FROM agent_clients WHERE client_id=?', [staleClient])[0].values[0][1], 'string');
  assert.deepEqual(database.exec('SELECT scope FROM agent_client_scopes WHERE client_id=? ORDER BY scope', [staleClient])[0].values, [['audit.read']]);
  assert.equal(typeof database.exec('SELECT terminated_at FROM agent_sessions WHERE session_id=?', [staleSessionRecord.sessionId])[0].values[0][0], 'string');
  assert.equal(database.exec('SELECT policy_version FROM agent_control_settings WHERE id=1')[0].values[0][0], 'post-restore-policy');
  assert.equal(database.exec('SELECT COUNT(*) FROM agent_jobs WHERE job_id=?', [job.value.jobId])[0].values[0][0], 1);
  assert.ok(Number(database.exec('SELECT MAX(sequence) FROM agent_audit_events')[0].values[0][0]) > beforeRestoreSequence);
  assert.deepEqual(database.exec('SELECT status FROM agent_database_restore_journals WHERE owner_client_id=? AND request_id=?', [restoreOwner, request.requestId])[0].values, [['completed']]);
});

test('database.restore rejects foreign unpublished legacy and tampered backups before mutation', async () => {
  const runtime = await restoreGateway();
  const principal = await registerRestoreClient(runtime, restoreOwner, 'restore-reject-credential', 'restore-reject-session');
  await seedQuestion('live row');
  const foreign = await seedPublishedBackupAsset(runtime, 'backup-restore-foreign', otherOwner);
  const unpublished = await seedPublishedBackupAsset(runtime, 'backup-restore-unpublished', restoreOwner);
  (await databaseService.getDatabase()).run("UPDATE agent_global_assets SET status='staged' WHERE asset_id=?", [unpublished.assetId]);
  const tampered = await seedPublishedBackupAsset(runtime, 'backup-restore-tampered', restoreOwner);
  fs.writeFileSync(tampered.backupPath, Buffer.from('not sqlite'));
  const corrupt = await seedPublishedBackupAsset(runtime, 'backup-restore-corrupt', restoreOwner);
  fs.writeFileSync(corrupt.backupPath, Buffer.from('also not sqlite'));
  const corruptEvidence = global.materializationEvidence(corrupt.backupPath);
  (await databaseService.getDatabase()).run('UPDATE agent_global_assets SET content_hash=?, content_size=? WHERE asset_id=?', [corruptEvidence.hash, corruptEvidence.size, corrupt.assetId]);
  const baseVersion = runtime.coordinator.currentVersion();

  for (const backupId of ['mistakes_manual_2026.db']) {
    const planned = gatewayCommand('database.restore', { backupId }, baseVersion);
    assert.throws(() => runtime.globalApplication.resolveState(planned, agent.resolveOperationDescriptor('database.restore'), principal), (error) => error.code === 'VALIDATION_ERROR');
  }
  for (const backupId of [foreign.assetId, unpublished.assetId]) {
    const planned = gatewayCommand('database.restore', { backupId }, baseVersion);
    assert.throws(() => runtime.globalApplication.resolveState(planned, agent.resolveOperationDescriptor('database.restore'), principal), (error) => error.code === 'HANDLER_NOT_FOUND');
  }
  assert.throws(() => runtime.globalApplication.resolveState(gatewayCommand('database.restore', { backupId: tampered.assetId }, baseVersion), agent.resolveOperationDescriptor('database.restore'), principal),
    (error) => error.code === 'RECOVERY_FENCE');

  const planned = gatewayCommand('database.restore', { backupId: corrupt.assetId }, baseVersion);
  const state = runtime.globalApplication.resolveState(planned, agent.resolveOperationDescriptor('database.restore'), principal);
  const grantId = await createRestoreGrant(runtime, restoreOwner, planned.payload, state.targetHash);
  const { changeSetId } = await createApprovedRestoreChangeSet(restoreOwner, corrupt.assetId, baseVersion);
  const failed = await runtime.composition.gateway.execute(gatewayCommand('agent.changesets.apply', { changeSetId }, undefined, crypto.randomUUID(), { kind: 'r4-grant', id: grantId }), principal);
  assert.equal(failed.kind, 'rejected');
  assert.equal(failed.error.code, 'HANDLER_NOT_FOUND');
  assert.equal(runtime.replacements(), 1);
  assert.deepEqual((await databaseService.listQuestions()).map((question) => question.title), ['live row']);
});

test('database.restore direct global execution without admitted R4 receipt has no side effects', async () => {
  const runtime = await restoreGateway();
  await seedQuestion('direct live row');
  const backup = await seedPublishedBackupAsset(runtime, 'backup-restore-direct', restoreOwner);
  const database = await databaseService.getDatabase();
  const beforeAssets = database.exec('SELECT COUNT(*) FROM agent_global_assets')[0].values[0][0];
  await assert.rejects(runtime.globalApplication.execute({ type: 'database.restore', payload: { backupId: backup.assetId } },
    { trust: 'trusted', requestId: crypto.randomUUID(), traceId: crypto.randomUUID(), source: 'renderer', actor: { actorId: restoreOwner, actorType: 'user' }, client: { clientId: restoreOwner, clientName: restoreOwner }, timestamp: fixedNow, concurrency: 'none' },
    undefined,
    { clientId: restoreOwner, subjectId: restoreOwner, displayName: restoreOwner, scopes: ['database.restore'], trust: 'full_control' }), (error) => error.code === 'SCOPE_DENIED');
  assert.equal(database.exec('SELECT COUNT(*) FROM agent_global_assets')[0].values[0][0], beforeAssets);
  assert.equal(fs.existsSync(path.join(runtime.managedPaths.journal, 'database-restores')), false);
  assert.deepEqual((await databaseService.listQuestions()).map((question) => question.title), ['direct live row']);
});

test('database.restore crash/restart matrix fences pre-live boundaries and reconstructs post-live receipts at most once', async () => {
  for (const boundary of ['backup_validated', 'recovery_package_staged']) {
    await resetControlPlaneEnvironment();
    let recoveryStageCount = 0;
    const runtime = await restoreGateway({
      appInstanceId: `c13-restore-crash-${boundary}`,
      databaseRestore: (input) => databaseService.restoreManagedDatabaseBackup({
        ...input,
        async onStage(stage, evidence) {
          await input.onStage(stage, evidence);
          if (stage === 'recovery_package_staged') recoveryStageCount += 1;
          if (stage === boundary) throw new agent.AgentError('RECOVERY_FENCE');
        }
      })
    });
    const scenario = await prepareApprovedRestore(runtime, boundary);
    const failed = await runtime.composition.gateway.execute(scenario.request, scenario.principal);
    assert.equal(failed.kind, 'rejected', boundary);
    assert.equal(failed.error.code, 'RECOVERY_FENCE', boundary);
    assert.equal(runtime.livePublications(), 0, boundary);
    assert.deepEqual((await databaseService.listQuestions()).map((question) => question.title).sort(), [scenario.afterTitle, scenario.keptTitle].sort(), boundary);
    await assert.rejects(restartWithRuntime(runtime), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)));
    assert.equal(runtime.livePublications(), 0, boundary);
    assert.equal(recoveryStageCount, boundary === 'recovery_package_staged' ? 1 : 0, boundary);
  }

  for (const atomicStage of ['afterPreviousPublish', 'afterLivePublish']) {
    await resetControlPlaneEnvironment();
    const runtime = await restoreGateway({
      appInstanceId: `c13-restore-atomic-${atomicStage}`,
      atomicHook(context) {
        if (context.stage === atomicStage) throw new agent.AgentError('RECOVERY_FENCE');
      }
    });
    const scenario = await prepareApprovedRestore(runtime, atomicStage);
    const failed = await runtime.composition.gateway.execute(scenario.request, scenario.principal);
    assert.equal(failed.kind, 'rejected', atomicStage);
    if (atomicStage === 'afterPreviousPublish') {
      assert.notEqual(failed.error.code, undefined, atomicStage);
      assert.equal(runtime.livePublications(), 0, atomicStage);
      assert.deepEqual((await databaseService.listQuestions()).map((question) => question.title).sort(), [scenario.afterTitle, scenario.keptTitle].sort(), atomicStage);
      await assert.rejects(restartWithRuntime(runtime), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)));
      continue;
    }
    assert.equal(failed.error.code, 'RECOVERY_FENCE', atomicStage);
    assert.equal(runtime.livePublications(), 1, atomicStage);
    await assert.rejects(restartWithRuntime(runtime), (error) => /candidate_set_unsafe|RECOVERY_FENCE/.test(String(error?.message ?? error)), atomicStage);
  }

  await resetControlPlaneEnvironment();
  const postLiveRuntime = await restoreGateway({
    appInstanceId: 'c13-restore-post-live-terminal',
    databaseRestore: (input) => databaseService.restoreManagedDatabaseBackup({
      ...input,
      async onStage(stage, evidence) {
        await input.onStage(stage, evidence);
        if (stage === 'database_published') throw new agent.AgentError('RECOVERY_FENCE');
      }
    })
  });
  const scenario = await prepareApprovedRestore(postLiveRuntime, 'post-live-terminal');
  const failed = await postLiveRuntime.composition.gateway.execute(scenario.request, scenario.principal);
  assert.equal(failed.kind, 'rejected');
  assert.equal(failed.error.code, 'RECOVERY_FENCE');
  assert.equal(postLiveRuntime.livePublications(), 1);
  await restartWithRuntime(postLiveRuntime);
  assert.deepEqual((await databaseService.listQuestions()).map((question) => question.title), [scenario.keptTitle]);
  const database = await databaseService.getDatabase();
  assert.deepEqual(database.exec('SELECT status FROM agent_idempotency WHERE client_id=? AND request_id=?', [restoreOwner, scenario.request.requestId])[0].values, [['completed']]);
  assert.deepEqual(database.exec('SELECT status FROM agent_r4_grants WHERE grant_id=?', [scenario.grantId])[0].values, [['consumed']]);
  assert.deepEqual(database.exec('SELECT status FROM agent_changesets WHERE change_set_id=?', [scenario.changeSetId])[0].values, [['applied']]);
  const replayGateway = await databaseService.getAgentControlPlane();
  const replayRegistry = await bootstrap.bootstrapAgentB3({
    coordinator: await databaseService.getDatabaseCoordinator(),
    appInstanceId: postLiveRuntime.appInstanceId,
    credentialVerifier: postLiveRuntime.verifier,
    cursorSecret: 'r'.repeat(32),
    now: () => fixedNow
  });
  const replaySession = 'restore-post-live-terminal-restart';
  await replayRegistry.registry.createSession(restoreOwner, authentication.fingerprintCredential(scenario.credential), authentication.fingerprintCredential(replaySession), '2026-07-20T01:00:00.000Z');
  const replayPrincipal = await replayGateway.authenticator.authenticate({ credential: scenario.credential, session: replaySession });
  const replay = await replayGateway.gateway.execute(scenario.request, replayPrincipal);
  assert.equal(replay.kind, 'replayed');
  assertRedactedRestoreOutcome(replay, postLiveRuntime, scenario.backup);
  const terminalOutcome = (await databaseService.getDatabase()).exec(
    'SELECT terminal_outcome_json FROM agent_idempotency WHERE client_id=? AND request_id=?',
    [restoreOwner, scenario.request.requestId]
  )[0].values[0][0];
  assert.deepEqual(JSON.parse(terminalOutcome), replay.result);
  assert.equal(postLiveRuntime.replacements(), 1);
  assert.equal(postLiveRuntime.livePublications(), 1);
});

test('database.restore live_published recovery fences valid SQLite semantic tampering with the same epoch', async () => {
  const runtime = await restoreGateway({
    appInstanceId: 'c13-restore-live-semantic-tamper',
    databaseRestore: (input) => databaseService.restoreManagedDatabaseBackup({
      ...input,
      async onStage(stage, evidence) {
        await input.onStage(stage, evidence);
        if (stage === 'database_published') throw new agent.AgentError('RECOVERY_FENCE');
      }
    })
  });
  const scenario = await prepareApprovedRestore(runtime, 'live-semantic-tamper');
  const failed = await runtime.composition.gateway.execute(scenario.request, scenario.principal);
  assert.equal(failed.kind, 'rejected');
  assert.equal(failed.error.code, 'RECOVERY_FENCE');
  const operationId = `database-restore-${crypto.createHash('sha256').update(`${scenario.backup.assetId}\0${scenario.request.requestId}`).digest('hex').slice(0, 40)}`;
  const restoreJournalPath = path.join(runtime.managedPaths.journal, 'database-restores', `${operationId}.database-restore.json`);
  const beforeManifest = fs.readFileSync(restoreJournalPath, 'utf8');
  await mutateLiveDatabaseFile((database) => {
    database.run('UPDATE questions SET title=? WHERE title=?', ['tampered same epoch', scenario.keptTitle]);
  });
  await assert.rejects(restartWithRuntime(runtime), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)));
  assert.equal(fs.readFileSync(restoreJournalPath, 'utf8'), beforeManifest);
});

test('database.restore restart fences tampered restore journal recovery package and restored live evidence before further mutation', async () => {
  async function completedRestore(label) {
    const runtime = await restoreGateway({ appInstanceId: `c13-restore-tamper-${label}` });
    const scenario = await prepareApprovedRestore(runtime, label);
    const first = await runtime.composition.gateway.execute(scenario.request, scenario.principal);
    assert.equal(first.kind, 'completed', label);
    const operationId = `database-restore-${crypto.createHash('sha256').update(`${scenario.backup.assetId}\0${scenario.request.requestId}`).digest('hex').slice(0, 40)}`;
    const restoreJournalPath = path.join(runtime.managedPaths.journal, 'database-restores', `${operationId}.database-restore.json`);
    return { runtime, scenario, restoreJournalPath, operationId };
  }

  await resetControlPlaneEnvironment();
  let current = await completedRestore('journal');
  fs.writeFileSync(current.restoreJournalPath, '{"schemaVersion":1,"phase":"completed"}\n');
  await assert.rejects(restartWithRuntime(current.runtime), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)));
  assert.equal(current.runtime.livePublications(), 1);

  for (const [label, mutate] of [
    ['target-hash', (manifest) => ({ ...manifest, targetHash: `sha256-v1:${'1'.repeat(64)}` })],
    ['grant-id', (manifest) => ({ ...manifest, grantId: crypto.randomUUID() })],
    ['receipt-payload', (manifest) => ({ ...manifest, receiptPayloadHash: `sha256-v1:${'2'.repeat(64)}` })],
    ['phase', (manifest) => ({ ...manifest, phase: 'live_published' })],
    ['unknown-field', (manifest) => ({ ...manifest, unexpected: true })]
  ]) {
    await resetControlPlaneEnvironment();
    current = await completedRestore(`manifest-${label}`);
    const manifest = JSON.parse(fs.readFileSync(current.restoreJournalPath, 'utf8'));
    fs.writeFileSync(current.restoreJournalPath, `${JSON.stringify(mutate(manifest))}\n`);
    await assert.rejects(restartWithRuntime(current.runtime), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)), label);
    assert.equal(current.runtime.livePublications(), 1);
  }

  await resetControlPlaneEnvironment();
  current = await completedRestore('recovery-package');
  const recoveryPackage = path.join(environment.userDataRoot, 'agent-recovery', 'consistency-packages', `${current.operationId}.before.db`);
  fs.rmSync(recoveryPackage, { force: true });
  await assert.rejects(restartWithRuntime(current.runtime), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)));
  assert.equal(current.runtime.livePublications(), 1);

  await resetControlPlaneEnvironment();
  current = await completedRestore('recovery-package-bytes');
  const modifiedRecoveryPackage = path.join(environment.userDataRoot, 'agent-recovery', 'consistency-packages', `${current.operationId}.before.db`);
  fs.appendFileSync(modifiedRecoveryPackage, Buffer.from([0]));
  await assert.rejects(restartWithRuntime(current.runtime), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)));
  assert.equal(current.runtime.livePublications(), 1);

  await resetControlPlaneEnvironment();
  current = await completedRestore('live');
  fs.writeFileSync(pathService.getPaths().database, Buffer.from('tampered live database'));
  await assert.rejects(restartWithRuntime(current.runtime), (error) => /Database candidate recovery failed|RECOVERY_FENCE/.test(String(error?.message ?? error)));
  assert.equal(current.runtime.livePublications(), 1);
});

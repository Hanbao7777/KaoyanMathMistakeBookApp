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

const owner = 'c13-import-client';
const otherOwner = 'c13-import-other';
const fixedNow = '2026-07-20T00:00:00.000Z';

test.beforeEach(resetControlPlaneEnvironment);
test.after(() => cleanupControlPlaneRoot());

function managedPaths() {
  const paths = pathService.getPaths();
  return Object.freeze({
    backups: path.normalize(path.join(paths.backups, 'agent-materialized')),
    exports: path.normalize(path.join(paths.exports, 'agent-materialized')),
    imports: path.normalize(path.join(paths.data, 'managed-database-imports')),
    temp: path.normalize(path.join(paths.temp, 'agent-global')),
    journal: path.normalize(path.join(paths.data, 'operation-journal', 'global-materialization')),
    quarantine: path.normalize(path.join(paths.temp, 'agent-global-quarantine'))
  });
}

function managementCommand(operation, payload, requestId = crypto.randomUUID()) {
  return Object.freeze({ apiVersion: 1, kind: 'agent-command', operation, payload, requestId, catalog: agent.operationCatalogIdentity });
}

function gatewayCommand(operation, payload, expectedVersion, requestId = crypto.randomUUID(), workflow) {
  return Object.freeze({
    apiVersion: 1, kind: 'agent-command', operation, payload, requestId, catalog: agent.operationCatalogIdentity,
    ...(expectedVersion ? { expectedVersion } : {}), ...(workflow ? { workflow } : {})
  });
}

function rendererContext(clientId, expectedVersion, requestId = crypto.randomUUID()) {
  return Object.freeze({
    trust: 'trusted', requestId, traceId: crypto.randomUUID(), source: 'renderer',
    actor: Object.freeze({ actorId: clientId, actorType: 'user' }),
    client: Object.freeze({ clientId, clientName: clientId }), timestamp: fixedNow, concurrency: 'none', expectedVersion
  });
}

async function workflowStore() {
  const coordinator = await databaseService.getDatabaseCoordinator();
  const capability = createDatabaseCoordinatorControlCapability(coordinator);
  const executeControlWrite = (request) => coordinator.executeControlWrite(capability, request);
  const audit = new AuditLedger({ executeControlWrite, catalog: agent.operationCatalogIdentity, now: () => fixedNow, randomUUID: crypto.randomUUID });
  return new WorkflowStore({ executeControlWrite, audit, now: () => fixedNow, randomUUID: crypto.randomUUID });
}

async function importGateway(options = {}) {
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
    cursorSecret: Buffer.alloc(32, 9),
    now: () => fixedNow,
    managedPaths: paths,
    databaseImport: Object.freeze({
      inspect: (bytes) => databaseService.inspectDatabaseImportPackage(bytes),
      replace: async (input) => {
        replacements += 1;
        return databaseService.replaceManagedDatabaseFromImport({
          ...input,
          atomicHook(context) {
            if (context.stage === 'afterLivePublish') livePublications += 1;
            return options.atomicHook?.(context);
          },
          async onStage(stage, evidence) {
            await input.onStage(stage, evidence);
            await options.stageHook?.(stage, evidence);
          }
        });
      }
    })
  });
  const appInstanceId = options.appInstanceId ?? 'c13-import-gateway';
  const verifier = { verify(raw) { return { credentialFingerprint: authentication.fingerprintCredential(raw.credential), sessionFingerprint: authentication.fingerprintCredential(raw.session) }; } };
  composition = await bootstrap.bootstrapAgentGateway({
    coordinator,
    commandBus: questions.gateway.commandBus,
    queryBus: questions.gateway.queryBus,
    selectedCandidateEvidence: true,
    appInstanceId,
    credentialVerifier: verifier,
    cursorSecret: 'i'.repeat(32),
    jobResultRoot: environment.resultRoot,
    now: () => fixedNow,
    globalApplication,
    resolveState: (envelope, descriptor) => questions.gateway.resolveState(envelope, descriptor),
    executeBusinessCommand: (command, executionContext, dispatch) => questions.gateway.execute(command, executionContext, dispatch)
  });
  const registry = await bootstrap.bootstrapAgentB3({ coordinator, appInstanceId, credentialVerifier: verifier, cursorSecret: 'i'.repeat(32), now: () => fixedNow });
  return { coordinator, composition, globalApplication, registry, managedPaths: paths, verifier, appInstanceId, replacements: () => replacements, livePublications: () => livePublications };
}

async function registerClient(runtime, clientId, credential, session) {
  const credentialFingerprint = authentication.fingerprintCredential(credential);
  const sessionFingerprint = authentication.fingerprintCredential(session);
  await runtime.registry.registry.registerClient({
    clientId, subjectId: clientId, displayName: clientId, credentialFingerprint,
    scopes: ['database.replace', 'changesets.manage'], trust: 'full_control'
  });
  await runtime.registry.registry.setExternalControlEnabled(true);
  await runtime.registry.registry.createSession(clientId, credentialFingerprint, sessionFingerprint, '2026-07-20T01:00:00.000Z');
  return runtime.composition.authenticator.authenticate({ credential, session });
}

async function seedQuestion(title) {
  return databaseService.createQuestion({
    title, content: `${title} content`, wrong_thinking: '', wrong_solution: '', correct_solution: '', answer: '',
    subject: '高等数学', category: '函数', question_type: '解答题', error_reason: '', source: 'c13-import-test',
    difficulty: '中等', mastery_level: '较弱', note: '', tags: [], questionImageSources: [], solutionImageSources: []
  });
}

async function createPackage(runtime, label) {
  await seedQuestion(`package ${label}`);
  const selectedPath = await databaseService.exportData();
  await seedQuestion(`later ${label}`);
  const context = rendererContext(owner, runtime.coordinator.currentVersion());
  const staged = await runtime.globalApplication.stageSelectedDatabaseImport(selectedPath, context, { kind: 'main_process_selection' });
  return { selectedPath, staged, packageTitle: `package ${label}`, laterTitle: `later ${label}` };
}

async function approveImport(runtime, staged, label = crypto.randomUUID()) {
  const credential = `import-${label}-credential`;
  const session = `import-${label}-session`;
  const principal = await registerClient(runtime, owner, credential, session);
  const baseVersion = runtime.coordinator.currentVersion();
  const payload = Object.freeze({ importAssetId: staged.importAssetId });
  const planned = gatewayCommand('database.replace_from_import', payload, baseVersion);
  const state = runtime.globalApplication.resolveState(planned, agent.resolveOperationDescriptor('database.replace_from_import'), principal);
  const grant = await runtime.composition.gateway.execute(managementCommand('agent.r4_grants.create', {
    grant: { clientId: owner, operation: 'database.replace_from_import', payloadHash: agent.hashCanonicalJson(payload), targetHash: state.targetHash, maxAffectedEntities: 500, expiresAt: '2026-07-20T00:10:00.000Z' }
  }), runtime.composition.renderer.principal());
  assert.equal(grant.kind, 'completed', JSON.stringify(grant));
  const grantId = grant.result.value.grantId;
  const changeSetId = crypto.randomUUID();
  const affectedEntities = Object.freeze([Object.freeze({ entityType: 'import_asset', entityId: staged.importAssetId })]);
  const store = await workflowStore();
  await store.createChangeSet(Object.freeze({
    apiVersion: 1, changeSetId, clientId: owner, status: 'draft', catalog: agent.operationCatalogIdentity, baseVersion, risk: 'R4',
    summary: `Replace database from managed import ${staged.importAssetId}`,
    operations: Object.freeze([Object.freeze({ operation: 'database.replace_from_import', payload, payloadHash: agent.hashCanonicalJson(payload), affectedEntities })]),
    affectedSetHash: agent.hashCanonicalJson(affectedEntities), recovery: 'consistency_bundle', createdAt: fixedNow, expiresAt: '2026-07-20T00:30:00.000Z'
  }));
  await store.transitionChangeSet(changeSetId, 'approved');
  const request = gatewayCommand('agent.changesets.apply', { changeSetId }, undefined, crypto.randomUUID(), { kind: 'r4-grant', id: grantId });
  return { credential, session, principal, baseVersion, grantId, changeSetId, request };
}

async function restart(runtime) {
  await databaseService.resetDatabaseConnectionAsync();
  return databaseService.initializeDatabase({ now: () => fixedNow, agent: { appInstanceId: runtime.appInstanceId, credentialVerifier: runtime.verifier, cursorSecret: 'i'.repeat(32), jobResultRoot: environment.resultRoot } });
}

async function mutateLiveDatabaseFile(mutator) {
  const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
  const databasePath = pathService.getPaths().database;
  const database = new SQL.Database(fs.readFileSync(databasePath));
  try { mutator(database); fs.writeFileSync(databasePath, Buffer.from(database.export())); } finally { database.close(); }
}

function assertRedactedImportOutcome(outcome, packageState, runtime) {
  assert.deepEqual(outcome.result.value, { importAssetId: packageState.staged.importAssetId, replaced: true });
  assert.equal(Object.keys(outcome.result.value).some((key) => /path|root|backup/i.test(key)), false);
  const serialized = JSON.stringify(outcome.result);
  assert.doesNotMatch(serialized, /beforeImportBackup|recoveryDatabasePath|internalPath|selectedPath/i);
  for (const forbidden of [
    packageState.selectedPath,
    ...Object.values(runtime.managedPaths),
    path.join(environment.userDataRoot, 'agent-recovery')
  ]) assert.equal(serialized.includes(forbidden), false, `Gateway result leaked ${forbidden}`);
}

test('database import packages enter through the real local selection boundary and remain opaque owner-bound assets', async () => {
  const runtime = await importGateway();
  await seedQuestion('staging package row');
  const selectedPath = await databaseService.exportData();
  const context = rendererContext(owner, runtime.coordinator.currentVersion());
  await assert.rejects(runtime.globalApplication.stageSelectedDatabaseImport(selectedPath, context), (error) => error.code === 'SCOPE_DENIED');
  const staged = await runtime.globalApplication.stageSelectedDatabaseImport(selectedPath, context, { kind: 'main_process_selection' });
  assert.match(staged.importAssetId, /^asset-[0-9a-f-]+$/);
  const database = await databaseService.getDatabase();
  const row = database.exec('SELECT owner_client_id,kind,status,internal_path,content_hash,content_size FROM agent_global_assets WHERE asset_id=?', [staged.importAssetId])[0].values[0];
  assert.deepEqual(row.slice(0, 3), [owner, 'database_import', 'published']);
  assert.equal(path.dirname(row[3]), runtime.managedPaths.imports);
  assert.equal(row[4], staged.contentHash);
  assert.equal(row[5], staged.contentSize);
  assert.throws(() => runtime.globalApplication.resolveState(gatewayCommand('database.replace_from_import', { importAssetId: staged.importAssetId }, runtime.coordinator.currentVersion()), agent.resolveOperationDescriptor('database.replace_from_import'), { clientId: otherOwner }), (error) => error.code === 'HANDLER_NOT_FOUND');
  const invalidPackage = path.join(path.dirname(selectedPath), 'invalid-full-data.json');
  fs.writeFileSync(invalidPackage, '{"format":"kaoyan-full-data-v1","version":1,"exportedAt":"2026-07-20T00:00:00.000Z","unexpected":[]}');
  const beforeCount = database.exec('SELECT COUNT(*) FROM agent_global_assets')[0].values[0][0];
  await assert.rejects(runtime.globalApplication.stageSelectedDatabaseImport(invalidPackage, rendererContext(owner, runtime.coordinator.currentVersion()), { kind: 'main_process_selection' }), (error) => error.code === 'IMPORT_PACKAGE_INVALID');
  assert.equal(database.exec('SELECT COUNT(*) FROM agent_global_assets')[0].values[0][0], beforeCount);
});

test('database.replace_from_import consumes one R4 grant/change set, preserves control state, and lost-response replay never replaces twice', async () => {
  const runtime = await importGateway({ appInstanceId: 'c13-import-replay' });
  const packageState = await createPackage(runtime, 'replay');
  const approved = await approveImport(runtime, packageState.staged, 'replay');
  const first = await runtime.composition.gateway.execute(approved.request, approved.principal);
  assert.equal(first.kind, 'completed', JSON.stringify(first));
  assertRedactedImportOutcome(first, packageState, runtime);
  assert.deepEqual((await databaseService.listQuestions()).map((question) => question.title), [packageState.packageTitle]);
  const database = await databaseService.getDatabase();
  assert.deepEqual(database.exec('SELECT status FROM agent_global_assets WHERE asset_id=?', [packageState.staged.importAssetId])[0].values, [['consumed']]);
  assert.deepEqual(database.exec('SELECT status FROM agent_r4_grants WHERE grant_id=?', [approved.grantId])[0].values, [['consumed']]);
  assert.deepEqual(database.exec('SELECT status FROM agent_changesets WHERE change_set_id=?', [approved.changeSetId])[0].values, [['applied']]);
  assert.deepEqual(database.exec('SELECT status FROM agent_database_import_journals WHERE asset_id=?', [packageState.staged.importAssetId])[0].values, [['completed']]);
  assert.equal(database.exec("SELECT COUNT(*) FROM agent_audit_events WHERE kind='success' AND client_id=? AND request_id=? AND operation='agent.changesets.apply'", [owner, approved.request.requestId])[0].values[0][0], 1);
  const currentVersion = (await databaseService.getDatabaseCoordinator()).currentVersion();
  assert.throws(() => runtime.globalApplication.resolveState(gatewayCommand('database.replace_from_import', { importAssetId: packageState.staged.importAssetId }, currentVersion), agent.resolveOperationDescriptor('database.replace_from_import'), approved.principal), (error) => error.code === 'HANDLER_NOT_FOUND');
  await restart(runtime);
  const gateway = await databaseService.getAgentControlPlane();
  const registry = await bootstrap.bootstrapAgentB3({ coordinator: await databaseService.getDatabaseCoordinator(), appInstanceId: runtime.appInstanceId, credentialVerifier: runtime.verifier, cursorSecret: 'i'.repeat(32), now: () => fixedNow });
  const replaySession = 'c13-import-replay-session-2';
  await registry.registry.createSession(owner, authentication.fingerprintCredential(approved.credential), authentication.fingerprintCredential(replaySession), '2026-07-20T01:00:00.000Z');
  const replayPrincipal = await gateway.authenticator.authenticate({ credential: approved.credential, session: replaySession });
  const replay = await gateway.gateway.execute(approved.request, replayPrincipal);
  assert.equal(replay.kind, 'replayed', JSON.stringify(replay));
  assertRedactedImportOutcome(replay, packageState, runtime);
  assert.deepEqual(replay.result, first.result);
  assert.equal(runtime.replacements(), 1);
  assert.equal(runtime.livePublications(), 1);

  await seedQuestion('normal write after import');
  await restart(runtime);
  const advancedGateway = await databaseService.getAgentControlPlane();
  const advancedRegistry = await bootstrap.bootstrapAgentB3({ coordinator: await databaseService.getDatabaseCoordinator(), appInstanceId: runtime.appInstanceId, credentialVerifier: runtime.verifier, cursorSecret: 'i'.repeat(32), now: () => fixedNow });
  const advancedSession = 'c13-import-replay-session-3';
  await advancedRegistry.registry.createSession(owner, authentication.fingerprintCredential(approved.credential), authentication.fingerprintCredential(advancedSession), '2026-07-20T01:00:00.000Z');
  const advancedPrincipal = await advancedGateway.authenticator.authenticate({ credential: approved.credential, session: advancedSession });
  const advancedReplay = await advancedGateway.gateway.execute(approved.request, advancedPrincipal);
  assert.equal(advancedReplay.kind, 'replayed', JSON.stringify(advancedReplay));
  assert.equal(runtime.replacements(), 1);
  assert.deepEqual((await databaseService.listQuestions()).map((question) => question.title).sort(), [packageState.packageTitle, 'normal write after import'].sort());
});

test('database.replace_from_import rejects direct, wrong-state, consumed, and corrupt packages before live mutation', async () => {
  const runtime = await importGateway();
  const packageState = await createPackage(runtime, 'reject');
  const principal = { clientId: owner, subjectId: owner, displayName: owner, scopes: ['database.replace'], trust: 'full_control' };
  await assert.rejects(runtime.globalApplication.execute({ type: 'database.replace_from_import', payload: { importAssetId: packageState.staged.importAssetId } }, rendererContext(owner, runtime.coordinator.currentVersion()), undefined, principal), (error) => error.code === 'SCOPE_DENIED');
  assert.equal(runtime.replacements(), 0);
  const database = await databaseService.getDatabase();
  database.run("UPDATE agent_global_assets SET kind='backup' WHERE asset_id=?", [packageState.staged.importAssetId]);
  assert.throws(() => runtime.globalApplication.resolveState(gatewayCommand('database.replace_from_import', { importAssetId: packageState.staged.importAssetId }, runtime.coordinator.currentVersion()), agent.resolveOperationDescriptor('database.replace_from_import'), principal), (error) => error.code === 'HANDLER_NOT_FOUND');
  database.run("UPDATE agent_global_assets SET kind='database_import' WHERE asset_id=?", [packageState.staged.importAssetId]);
  database.run("UPDATE agent_global_assets SET status='staged' WHERE asset_id=?", [packageState.staged.importAssetId]);
  assert.throws(() => runtime.globalApplication.resolveState(gatewayCommand('database.replace_from_import', { importAssetId: packageState.staged.importAssetId }, runtime.coordinator.currentVersion()), agent.resolveOperationDescriptor('database.replace_from_import'), principal), (error) => error.code === 'HANDLER_NOT_FOUND');
  database.run("UPDATE agent_global_assets SET status='published' WHERE asset_id=?", [packageState.staged.importAssetId]);
  const internalPath = database.exec('SELECT internal_path FROM agent_global_assets WHERE asset_id=?', [packageState.staged.importAssetId])[0].values[0][0];
  const originalBytes = fs.readFileSync(internalPath);
  fs.appendFileSync(internalPath, '\n');
  assert.throws(() => runtime.globalApplication.resolveState(gatewayCommand('database.replace_from_import', { importAssetId: packageState.staged.importAssetId }, runtime.coordinator.currentVersion()), agent.resolveOperationDescriptor('database.replace_from_import'), principal), (error) => error.code === 'RECOVERY_FENCE');
  fs.writeFileSync(internalPath, originalBytes);
  fs.writeFileSync(internalPath, '{"format":"kaoyan-full-data-v1","version":1}');
  const evidence = global.materializationEvidence(internalPath);
  database.run('UPDATE agent_global_assets SET content_hash=?,content_size=? WHERE asset_id=?', [evidence.hash, evidence.size, packageState.staged.importAssetId]);
  const approved = await approveImport(runtime, packageState.staged, 'corrupt');
  const before = runtime.coordinator.currentVersion();
  const failed = await runtime.composition.gateway.execute(approved.request, approved.principal);
  assert.equal(failed.kind, 'rejected');
  assert.equal(failed.error.code, 'HANDLER_NOT_FOUND');
  assert.deepEqual(runtime.coordinator.currentVersion(), before);
  assert.equal(runtime.livePublications(), 0);
  assert.deepEqual((await databaseService.listQuestions()).map((question) => question.title).sort(), [packageState.laterTitle, packageState.packageTitle].sort());
});

test('database.replace_from_import crash/restart boundaries fence pre-live ambiguity and reconstruct post-live terminal state once', async () => {
  for (const boundary of ['package_validated', 'recovery_package_staged']) {
    await resetControlPlaneEnvironment();
    const runtime = await importGateway({ appInstanceId: `c13-import-${boundary}`, stageHook(stage) { if (stage === boundary) throw new agent.AgentError('RECOVERY_FENCE'); } });
    const packageState = await createPackage(runtime, boundary);
    const approved = await approveImport(runtime, packageState.staged, boundary);
    const failed = await runtime.composition.gateway.execute(approved.request, approved.principal);
    assert.equal(failed.kind, 'rejected', boundary);
    assert.equal(runtime.livePublications(), 0, boundary);
    await assert.rejects(restart(runtime), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)), boundary);
  }

  for (const atomicStage of ['afterPreviousPublish', 'afterLivePublish']) {
    await resetControlPlaneEnvironment();
    const runtime = await importGateway({ appInstanceId: `c13-import-${atomicStage}`, atomicHook(context) { if (context.stage === atomicStage) throw new agent.AgentError('RECOVERY_FENCE'); } });
    const packageState = await createPackage(runtime, atomicStage);
    const approved = await approveImport(runtime, packageState.staged, atomicStage);
    const failed = await runtime.composition.gateway.execute(approved.request, approved.principal);
    assert.equal(failed.kind, 'rejected', atomicStage);
    assert.equal(runtime.livePublications(), atomicStage === 'afterLivePublish' ? 1 : 0, atomicStage);
    await assert.rejects(restart(runtime), (error) => error?.code === 'RECOVERY_FENCE' || /candidate_set_unsafe|RECOVERY_FENCE/.test(String(error?.message ?? error)), atomicStage);
  }

  await resetControlPlaneEnvironment();
  const runtime = await importGateway({ appInstanceId: 'c13-import-post-live', stageHook(stage) { if (stage === 'database_published') throw new agent.AgentError('RECOVERY_FENCE'); } });
  const packageState = await createPackage(runtime, 'post-live');
  const approved = await approveImport(runtime, packageState.staged, 'post-live');
  const failed = await runtime.composition.gateway.execute(approved.request, approved.principal);
  assert.equal(failed.kind, 'rejected');
  assert.equal(runtime.livePublications(), 1);
  await restart(runtime);
  assert.deepEqual((await databaseService.listQuestions()).map((question) => question.title), [packageState.packageTitle]);
  const database = await databaseService.getDatabase();
  assert.deepEqual(database.exec('SELECT status FROM agent_idempotency WHERE request_id=?', [approved.request.requestId])[0].values, [['completed']]);
  assert.deepEqual(database.exec('SELECT status FROM agent_global_assets WHERE asset_id=?', [packageState.staged.importAssetId])[0].values, [['consumed']]);
  assert.equal(runtime.replacements(), 1);
});

test('data_root.migrate stays non-executing and imports.delete_batch requires its admitted backend', async () => {
  const runtime = await importGateway();
  await seedQuestion('placeholder sentinel');
  const version = runtime.coordinator.currentVersion();
  const { expectedVersion: _expectedVersion, ...context } = rendererContext(owner, version);
  await assert.rejects(runtime.globalApplication.execute(
    { type: 'imports.delete_batch', payload: { batchId: 'batch-placeholder', deleteManagedAssets: true } },
    { ...context, requestId: crypto.randomUUID() }
  ), (error) => error.code === 'SCOPE_DENIED');
  for (const command of [{ type: 'data_root.migrate', payload: { rootSelectionId: 'root-placeholder' } }]) {
    const result = await runtime.globalApplication.execute(command, { ...context, requestId: crypto.randomUUID() });
    assert.equal(result.changed, false, command.type);
  }
  assert.deepEqual(runtime.coordinator.currentVersion(), version);
  assert.deepEqual((await databaseService.listQuestions()).map((question) => question.title), ['placeholder sentinel']);
});

test('database import restart fences private journal, package, terminal journal, and same-version live semantic tampering', async () => {
  async function completed(label) {
    const runtime = await importGateway({ appInstanceId: `c13-import-tamper-${label}` });
    const packageState = await createPackage(runtime, label);
    const approved = await approveImport(runtime, packageState.staged, label);
    const result = await runtime.composition.gateway.execute(approved.request, approved.principal);
    assert.equal(result.kind, 'completed', label);
    const operationId = `database-import-${crypto.createHash('sha256').update(`${packageState.staged.importAssetId}\0${approved.request.requestId}`).digest('hex').slice(0, 40)}`;
    const journalPath = path.join(runtime.managedPaths.journal, 'database-imports', `${operationId}.database-import.json`);
    const packagePath = (await databaseService.getDatabase()).exec('SELECT internal_path FROM agent_global_assets WHERE asset_id=?', [packageState.staged.importAssetId])[0].values[0][0];
    return { runtime, packageState, approved, operationId, journalPath, packagePath };
  }

  let current = await completed('private-journal');
  fs.writeFileSync(current.journalPath, '{"schemaVersion":1,"phase":"completed"}\n');
  await assert.rejects(restart(current.runtime), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)));

  await resetControlPlaneEnvironment();
  current = await completed('package');
  fs.appendFileSync(current.packagePath, '\n');
  await assert.rejects(restart(current.runtime), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)));

  await resetControlPlaneEnvironment();
  current = await completed('terminal-journal');
  await mutateLiveDatabaseFile((database) => database.run("UPDATE agent_database_import_journals SET live_semantic_hash=? WHERE operation_id=?", [`sha256-v1:${'1'.repeat(64)}`, current.operationId]));
  await assert.rejects(restart(current.runtime), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)));

  await resetControlPlaneEnvironment();
  current = await completed('live-semantic');
  await mutateLiveDatabaseFile((database) => database.run('UPDATE questions SET title=?', ['same-version tamper']));
  await assert.rejects(restart(current.runtime), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)));
});

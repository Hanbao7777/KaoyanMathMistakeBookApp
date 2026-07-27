const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const { databaseService, cleanupControlPlaneRoot, getControlPlanePaths, resetControlPlaneEnvironment } = environment;
const global = environment.requireMain('application/global/index.js');
const bootstrap = environment.requireMain('agent/bootstrap.js');
const authentication = environment.requireMain('agent/clientAuthenticator.js');
const { AuditLedger } = environment.requireMain('agent/auditLedger.js');
const { WorkflowStore } = environment.requireMain('agent/workflows.js');
const { createDatabaseCoordinatorControlCapability } = environment.requireMain('persistence/databaseCoordinator.js');
const pathService = environment.requireMain('services/pathService.js');
const agent = require(`${environment.projectRoot}/dist/main/shared/agent/index.js`);

const owner = '123e4567-e89b-42d3-a456-426614174000';
const otherOwner = '123e4567-e89b-42d3-a456-426614174099';
const sessionId = '123e4567-e89b-42d3-a456-426614174001';
const otherSessionId = '123e4567-e89b-42d3-a456-426614174002';
const externalOwner = 'c13-client';
const deleteOwner = 'c13-delete-client';
const otherDeleteOwner = 'c13-delete-other';
const credential = `sha256-v1:${'a'.repeat(64)}`;
const sessionFingerprint = `sha256-v1:${'b'.repeat(64)}`;
const fixedNow = '2026-07-20T00:00:00.000Z';
const auxiliaryExecutors = new Set();
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

function credentialFor(clientId) {
  return clientId === owner ? credential : `sha256-v1:${'c'.repeat(63)}${clientId.slice(-1)}`;
}

function sessionFingerprintFor(clientId) {
  return clientId === owner ? sessionFingerprint : `sha256-v1:${'d'.repeat(63)}${clientId.slice(-1)}`;
}

async function drainAuxiliaryExecutors() {
  const executors = [...auxiliaryExecutors];
  await Promise.all(executors.map((executor) => executor.stopAndDrain()));
  for (const executor of executors) {
    assert.equal(executor.isStopped(), true);
    assert.equal(executor.isIdle(), true);
    auxiliaryExecutors.delete(executor);
  }
}

async function resetControlPlaneLifecycle() {
  await drainAuxiliaryExecutors();
  assert.equal(auxiliaryExecutors.size, 0);
  await resetControlPlaneEnvironment();
}

async function settleControlPlaneLifecycle() {
  const plane = await databaseService.getAgentControlPlane().catch(() => undefined);
  await plane?.jobExecutor.stopAndDrain();
  await drainAuxiliaryExecutors();
  const coordinator = await databaseService.getDatabaseCoordinator().catch(() => undefined);
  await coordinator?.whenWritesIdle();
  if (coordinator) assert.equal(coordinator.pendingWrites, 0);
}

test.beforeEach(async () => {
  await resetControlPlaneLifecycle();
  fs.rmSync(path.join(getControlPlanePaths().testRoot, 'c13-materialization'), { recursive: true, force: true });
  fs.rmSync(path.join(getControlPlanePaths().testRoot, 'c13-journal-phases'), { recursive: true, force: true });
});
test.afterEach(async () => {
  await settleControlPlaneLifecycle();
});
test.after(async () => {
  await drainAuxiliaryExecutors();
  await databaseService.resetDatabaseConnectionAsync();
  cleanupControlPlaneRoot();
});

function context(requestId = crypto.randomUUID(), clientId = owner, expectedVersion) {
  return Object.freeze({ trust: 'trusted', requestId, traceId: crypto.randomUUID(), source: 'mcp',
    actor: { actorId: clientId, actorType: 'agent' }, client: { clientId }, timestamp: '2026-07-20T00:00:00.000Z',
    concurrency: expectedVersion ? 'strict' : 'none', ...(expectedVersion ? { expectedVersion } : {}) });
}

async function application() {
  const coordinator = await databaseService.getDatabaseCoordinator();
  const plane = await databaseService.getAgentControlPlane();
  const readOnlyDatabase = await databaseService.getReadOnlyDatabase();
  return global.registerGlobalApplication({
    coordinator,
    readOnlyDatabase,
    getJobs: () => plane.jobs,
    currentVersion: () => coordinator.currentVersion(),
    cursorSecret: Buffer.alloc(32, 9),
    now: () => '2026-07-20T00:00:00.000Z'
  });
}

async function activeDatabase() {
  const plane = await databaseService.getAgentControlPlane().catch(() => undefined);
  await plane?.jobExecutor.whenIdle();
  await Promise.all([...auxiliaryExecutors].map((executor) => executor.whenIdle()));
  const coordinator = await databaseService.getDatabaseCoordinator();
  await coordinator.whenWritesIdle();
  assert.equal(coordinator.pendingWrites, 0);
  return databaseService.getDatabase();
}

async function executeFixtureControlWrite(coordinator, requestId, execute, executors = []) {
  await Promise.all(executors.map((executor) => executor.stopAndDrain()));
  for (const executor of executors) {
    assert.equal(executor.isStopped(), true);
    assert.equal(executor.isIdle(), true);
  }
  await coordinator.whenWritesIdle();
  assert.equal(coordinator.pendingWrites, 0);
  const capability = createDatabaseCoordinatorControlCapability(coordinator);
  const result = await coordinator.executeControlWrite(capability, { requestId, execute });
  await coordinator.whenWritesIdle();
  assert.equal(coordinator.pendingWrites, 0);
  return result.value;
}

async function setFixtureJobState(coordinator, executor, requestId, statement, parameters) {
  await executeFixtureControlWrite(coordinator, requestId, (database) => {
    database.run(statement, parameters);
    assert.equal(database.getRowsModified(), 1);
    return { changed: true, value: undefined };
  }, [executor]);
}

async function externalGateway(materialize = false, materializationHook, materializationFaultHook, materializationNow) {
  const coordinator = await databaseService.getDatabaseCoordinator();
  const questions = await databaseService.getQuestionsApplication();
  const readOnlyDatabase = await databaseService.getReadOnlyDatabase();
  const verifier = { verify(raw) { return {
    credentialFingerprint: authentication.fingerprintCredential(raw.credential),
    sessionFingerprint: authentication.fingerprintCredential(raw.session)
  }; } };
  const jobErrors = [];
  let composition;
  const materializationRoot = path.join(getControlPlanePaths().testRoot, 'c13-materialization');
  const globalApplication = global.registerGlobalApplication({
    coordinator,
    readOnlyDatabase,
    getJobs: () => composition.jobs,
    currentVersion: () => coordinator.currentVersion(),
    cursorSecret: Buffer.alloc(32, 7),
    ...(materialize ? {
      managedPaths: { backups: path.join(materializationRoot, 'backups'), exports: path.join(materializationRoot, 'exports'), temp: path.join(materializationRoot, 'temp') },
      materializer: { async stage({ stagedPath }) { fs.mkdirSync(path.dirname(stagedPath), { recursive: true }); fs.writeFileSync(stagedPath, Buffer.from('C13 managed materialization')); return {}; } },
      materializationDurability: strictMaterializationDurability,
      ...(materializationNow ? { now: materializationNow } : {}),
      ...(materializationHook ? { materializationHook } : {})
      , ...(materializationFaultHook ? { materializationFaultHook } : {})
    } : {})
  });
  composition = await bootstrap.bootstrapAgentGateway({
    coordinator,
    commandBus: questions.gateway.commandBus,
    queryBus: questions.gateway.queryBus,
    selectedCandidateEvidence: true,
    appInstanceId: 'c13-external',
    credentialVerifier: verifier,
    cursorSecret: 'c13'.repeat(16),
    jobResultRoot: environment.resultRoot,
    resolveState: (envelope, descriptor) => questions.gateway.resolveState(envelope, descriptor),
    executeBusinessCommand: (command, executionContext, dispatch) => questions.gateway.execute(command, executionContext, dispatch),
    globalApplication,
    jobExecutorOnError: (error) => jobErrors.push(error)
  });
  auxiliaryExecutors.add(composition.jobExecutor);
  const registry = await bootstrap.bootstrapAgentB3({
    coordinator,
    appInstanceId: 'c13-external',
    credentialVerifier: verifier,
    cursorSecret: 'c13'.repeat(16)
  });
  const rawCredential = 'c13-credential';
  const rawSession = 'c13-session';
  const credentialFingerprint = authentication.fingerprintCredential(rawCredential);
  const sessionFingerprint = authentication.fingerprintCredential(rawSession);
  await registry.registry.registerClient({
    clientId: externalOwner,
    subjectId: externalOwner,
    displayName: 'C13 Client',
    credentialFingerprint,
    scopes: ['backups.create', 'exports.create'],
    trust: 'full_control'
  });
  await registry.registry.setExternalControlEnabled(true);
  await registry.registry.createSession(externalOwner, credentialFingerprint, sessionFingerprint, new Date(Date.now() + 60 * 60_000).toISOString());
  return { coordinator, composition, globalApplication, principal: await composition.authenticator.authenticate({ credential: rawCredential, session: rawSession }), jobErrors };
}

function defaultManagedPaths() {
  const paths = pathService.getPaths();
  return Object.freeze({
    backups: path.normalize(path.join(paths.backups, 'agent-materialized')),
    exports: path.normalize(path.join(paths.exports, 'agent-materialized')),
    temp: path.normalize(path.join(paths.temp, 'agent-global')),
    journal: path.normalize(path.join(paths.data, 'operation-journal', 'global-materialization')),
    quarantine: path.normalize(path.join(paths.temp, 'agent-global-quarantine'))
  });
}

function countedDeletionDurability(counter) {
  return Object.freeze({
    ...strictMaterializationDurability,
    files: Object.freeze({
      ...strictMaterializationDurability.files,
      async rename(from, to) {
        counter.renames.push(Object.freeze({ from, to }));
        await strictMaterializationDurability.files.rename(from, to);
      }
    })
  });
}

function managementCommand(operation, payload, requestId = crypto.randomUUID()) {
  return Object.freeze({ apiVersion: 1, kind: 'agent-command', operation, payload, requestId, catalog: agent.operationCatalogIdentity });
}

function gatewayCommand(operation, payload, expectedVersion, requestId = crypto.randomUUID(), workflow) {
  return Object.freeze({
    apiVersion: 1, kind: 'agent-command', operation, payload, requestId,
    catalog: agent.operationCatalogIdentity,
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

async function deleteGateway(options = {}) {
  const coordinator = await databaseService.getDatabaseCoordinator();
  const questions = await databaseService.getQuestionsApplication();
  const readOnlyDatabase = await databaseService.getReadOnlyDatabase();
  const managedPaths = options.managedPaths ?? defaultManagedPaths();
  let composition;
  const globalApplication = global.registerGlobalApplication({
    coordinator,
    readOnlyDatabase,
    getJobs: () => composition.jobs,
    currentVersion: () => coordinator.currentVersion(),
    cursorSecret: Buffer.alloc(32, 6),
    now: () => options.now ?? fixedNow,
    managedPaths,
    materializationDurability: options.materializationDurability ?? strictMaterializationDurability,
    ...(options.backupDeletionFaultHook ? { backupDeletionFaultHook: options.backupDeletionFaultHook } : {})
  });
  const verifier = { verify(raw) { return {
    credentialFingerprint: authentication.fingerprintCredential(raw.credential),
    sessionFingerprint: authentication.fingerprintCredential(raw.session)
  }; } };
  composition = await bootstrap.bootstrapAgentGateway({
    coordinator,
    commandBus: questions.gateway.commandBus,
    queryBus: questions.gateway.queryBus,
    selectedCandidateEvidence: true,
    appInstanceId: options.appInstanceId ?? 'c13-delete-gateway',
    credentialVerifier: verifier,
    cursorSecret: 'd'.repeat(32),
    jobResultRoot: environment.resultRoot,
    now: () => options.now ?? fixedNow,
    globalApplication,
    resolveState: (envelope, descriptor) => questions.gateway.resolveState(envelope, descriptor),
    executeBusinessCommand: (command, executionContext, dispatch) => questions.gateway.execute(command, executionContext, dispatch)
  });
  auxiliaryExecutors.add(composition.jobExecutor);
  const registry = await bootstrap.bootstrapAgentB3({
    coordinator,
    appInstanceId: options.appInstanceId ?? 'c13-delete-gateway',
    credentialVerifier: verifier,
    cursorSecret: 'd'.repeat(32),
    now: () => options.now ?? fixedNow
  });
  return { coordinator, composition, globalApplication, registry, managedPaths };
}

async function registerDeleteClient(runtime, clientId, rawCredential, rawSession) {
  const credentialFingerprint = authentication.fingerprintCredential(rawCredential);
  const sessionFingerprint = authentication.fingerprintCredential(rawSession);
  await runtime.registry.registry.registerClient({
    clientId,
    subjectId: clientId,
    displayName: clientId,
    credentialFingerprint,
    scopes: ['backups.delete', 'changesets.manage'],
    trust: 'full_control'
  });
  await runtime.registry.registry.setExternalControlEnabled(true);
  await runtime.registry.registry.createSession(clientId, credentialFingerprint, sessionFingerprint, '2026-07-20T01:00:00.000Z');
  return runtime.composition.authenticator.authenticate({ credential: rawCredential, session: rawSession });
}

async function seedPublishedBackupAsset(runtime, assetId, ownerClientId, bytes = Buffer.from(`delete evidence:${assetId}`)) {
  for (const directory of Object.values(runtime.managedPaths)) fs.mkdirSync(directory, { recursive: true });
  const backupPath = path.join(runtime.managedPaths.backups, `${assetId}.db`);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.writeFileSync(backupPath, bytes);
  const evidence = global.materializationEvidence(backupPath);
  await executeFixtureControlWrite(runtime.coordinator, `c13-seed-backup-${assetId}`, (database, scope) => {
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
  }, [runtime.composition.jobExecutor]);
  return Object.freeze({ assetId, backupPath, evidence });
}

async function createApprovedDeleteChangeSet(clientId, backupId, baseVersion) {
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
    summary: `Delete managed backup ${backupId}`,
    operations: Object.freeze([Object.freeze({
      operation: 'backups.delete',
      payload,
      payloadHash: agent.hashCanonicalJson(payload),
      affectedEntities
    })]),
    affectedSetHash: agent.hashCanonicalJson(affectedEntities),
    recovery: 'consistency_bundle',
    createdAt: fixedNow,
    expiresAt: '2026-07-20T00:30:00.000Z'
  }));
  await store.transitionChangeSet(changeSetId, 'approved');
  return { changeSetId, payload, affectedEntities };
}

async function createDeleteGrant(runtime, clientId, payload, targetHash) {
  const granted = await runtime.composition.gateway.execute(managementCommand('agent.r4_grants.create', {
    grant: {
      clientId,
      operation: 'backups.delete',
      payloadHash: agent.hashCanonicalJson(payload),
      targetHash,
      maxAffectedEntities: 500,
      expiresAt: '2026-07-20T00:10:00.000Z'
    }
  }), runtime.composition.renderer.principal());
  assert.equal(granted.kind, 'completed', JSON.stringify(granted));
  assert.equal(granted.result.value.status, 'active');
  assert.equal(granted.result.value.clientId, clientId);
  assert.equal(granted.result.value.operation, 'backups.delete');
  return granted.result.value.grantId;
}

function deletionJournalIdFor(assetId) {
  return `backup-delete-${crypto.createHash('sha256').update(assetId).digest('hex').slice(0, 40)}`;
}

async function waitForJob(composition, jobId, principal) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await composition.jobs.get(jobId, principal);
    if (job.status === 'completed' || job.status === 'failed') {
      await composition.jobExecutor.whenIdle();
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`job ${jobId} did not become terminal`);
}

function principal(clientId = owner, creatingSessionId = sessionId) {
  return Object.freeze({ apiVersion: 1, kind: 'agent-principal', clientId, subjectId: clientId, displayName: clientId,
    scopes: Object.freeze(['backups.create', 'exports.create']), trust: 'full_control', credentialBinding: credential,
    sessionId: creatingSessionId, authenticatedAt: '2026-07-20T00:00:00.000Z', renderer: false });
}

async function seedPrincipal(clientId = owner, creatingSessionId = sessionId) {
  const coordinator = await databaseService.getDatabaseCoordinator();
  const clientCredential = credentialFor(clientId);
  const clientSessionFingerprint = sessionFingerprintFor(clientId);
  await executeFixtureControlWrite(coordinator, `c13-seed-principal-${clientId}-${creatingSessionId}`, (database) => {
    database.run('INSERT OR IGNORE INTO agent_clients (client_id,subject_id,display_name,credential_fingerprint,trust,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      [clientId, clientId, clientId, clientCredential, 'full_control', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z']);
    for (const scope of ['backups.create', 'exports.create']) {
      database.run('INSERT OR IGNORE INTO agent_client_scopes (client_id,scope,catalog_version,created_at) VALUES (?,?,?,?)',
        [clientId, scope, agent.operationCatalogIdentity.version, '2026-07-20T00:00:00.000Z']);
    }
    database.run('INSERT OR IGNORE INTO agent_sessions (session_id,client_id,app_instance_id,session_fingerprint,credential_fingerprint,created_at,expires_at,last_active_at) VALUES (?,?,?,?,?,?,?,?)',
      [creatingSessionId, clientId, 'c13-app', clientSessionFingerprint, clientCredential, '2026-07-20T00:00:00.000Z', '2026-07-21T00:00:00.000Z', '2026-07-20T00:00:00.000Z']);
    database.run('UPDATE agent_control_settings SET external_control_enabled = 1 WHERE id = 1');
    return { changed: true, value: undefined };
  });
}

function capturedError(callback) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  assert.fail('Expected operation to throw');
}

test('asset metadata accepts UUID owners, redacts paths, and denies another owner', async () => {
  const store = global;
  const coordinator = await databaseService.getDatabaseCoordinator();
  const plane = await databaseService.getAgentControlPlane();
  const asset = await executeFixtureControlWrite(coordinator, 'c13-fixture-asset-metadata', (database, scope) => ({
    changed: true,
    value: store.createGlobalAsset(database, { assetId: 'backup-uuid-owner', ownerClientId: owner, kind: 'backup',
      metadata: { filePath: 'C:\\private\\mistakes.db', label: 'manual' }, internalPath: 'C:\\private\\mistakes.db',
      jobId: '123e4567-e89b-42d3-a456-426614174010', now: '2026-07-20T00:00:00.000Z' }, scope)
  }), [plane.jobExecutor]);
  const database = await activeDatabase();
  assert.equal(asset.ownerClientId, owner);
  assert.equal(Object.hasOwn(asset.metadata, 'filePath'), false);
  assert.equal(Object.hasOwn(asset, 'jobId'), false);
  assert.equal(Object.hasOwn(asset, 'internalPath'), false);
  assert.equal(store.getGlobalAsset(database, 'backup-uuid-owner', owner).assetId, 'backup-uuid-owner');
  assert.throws(() => store.getGlobalAsset(database, 'backup-uuid-owner', otherOwner), (error) => error.code === 'SCOPE_DENIED');
  assert.throws(() => store.getGlobalAsset(database, 'backup-uuid-owner', '../other'), (error) => error.code === 'VALIDATION_ERROR');
});

test('asset recovery scan fences malformed metadata hashes and transitions are monotonic', async () => {
  const coordinator = await databaseService.getDatabaseCoordinator();
  const plane = await databaseService.getAgentControlPlane();
  await executeFixtureControlWrite(coordinator, 'c13-fixture-asset-recovery', (database, scope) => {
    global.createGlobalAsset(database, { assetId: 'backup-fenced', ownerClientId: owner, kind: 'backup', metadata: { label: 'x' }, now: '2026-07-20T00:00:00.000Z' }, scope);
    assert.throws(() => global.transitionGlobalAsset(database, 'backup-fenced', 'published', '2026-07-20T00:00:01.000Z', {}, scope), (error) => error.code === 'RECOVERY_FENCE');
    const staged = global.transitionGlobalAsset(database, 'backup-fenced', 'staged', '2026-07-20T00:00:01.000Z', {}, scope);
    assert.equal(staged.status, 'staged');
    assert.throws(() => global.transitionGlobalAsset(database, 'backup-fenced', 'published', '2026-07-19T00:00:00.000Z', {}, scope), (error) => error.code === 'RECOVERY_FENCE');
    return { changed: true, value: undefined };
  }, [plane.jobExecutor]);
  const database = await activeDatabase();
  // This raw mutation intentionally bypasses coordinator invariants to model on-disk tampering.
  database.run('UPDATE agent_global_assets SET metadata_hash = ? WHERE asset_id = ?', ['sha256-v1:' + '0'.repeat(64), 'backup-fenced']);
  assert.equal(plane.jobExecutor.isStopped(), true);
  assert.equal(plane.jobExecutor.isIdle(), true);
  assert.equal(coordinator.pendingWrites, 0);
  assert.throws(() => global.scanGlobalAssets(database), (error) => error.code === 'RECOVERY_FENCE');
});

test('backups.delete refuses direct execution without an admitted R4 receipt before moving managed evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-c13-delete-'));
  const managed = { backups: path.join(root, 'backups'), exports: path.join(root, 'exports'), temp: path.join(root, 'temp'), journal: path.join(root, 'journal'), quarantine: path.join(root, 'quarantine') };
  for (const directory of Object.values(managed)) fs.mkdirSync(directory, { recursive: true });
  const backupId = 'backup-delete-managed';
  const backupPath = path.join(managed.backups, `${backupId}.db`);
  fs.writeFileSync(backupPath, Buffer.from('C13 delete evidence'));
  const evidence = global.materializationEvidence(backupPath);
  const coordinator = await databaseService.getDatabaseCoordinator();
  const plane = await databaseService.getAgentControlPlane();
  await executeFixtureControlWrite(coordinator, 'c13-fixture-direct-delete-asset', (database, scope) => {
    global.createGlobalAsset(database, { assetId: backupId, ownerClientId: owner, kind: 'backup', metadata: { backupKind: 'manual' }, internalPath: backupPath, now: '2026-07-20T00:00:00.000Z' }, scope);
    database.run("UPDATE agent_global_assets SET status='published', content_hash=?, content_size=? WHERE asset_id=?", [evidence.hash, evidence.size, backupId]);
    return { changed: true, value: undefined };
  }, [plane.jobExecutor]);
  const app = global.registerGlobalApplication({ coordinator, readOnlyDatabase: await databaseService.getReadOnlyDatabase(), getJobs: () => ({ }), currentVersion: () => coordinator.currentVersion(), now: () => '2026-07-20T00:00:00.000Z', managedPaths: managed, materializationDurability: strictMaterializationDurability });
  const requestId = crypto.randomUUID();
  const executionContext = context(requestId, owner, coordinator.currentVersion());
  const state = app.resolveState({ kind: 'agent-command', requestId, operation: 'backups.delete', payload: { backupId } }, agent.resolveOperationDescriptor('backups.delete'), principal());
  assert.equal(state.affectedEntityCount, 1);
  assert.throws(() => app.resolveState({ kind: 'agent-command', requestId, operation: 'backups.delete', payload: { backupId } }, agent.resolveOperationDescriptor('backups.delete'), principal(otherOwner)), (error) => error.code === 'HANDLER_NOT_FOUND');
  await assert.rejects(app.execute({ type: 'backups.delete', payload: { backupId } }, executionContext, undefined, principal()), (error) => error.code === 'SCOPE_DENIED');
  assert.equal(fs.existsSync(backupPath), true);
  assert.equal(fs.existsSync(path.join(managed.quarantine, 'backups')), false);
  assert.equal(global.getGlobalAsset(await activeDatabase(), backupId, owner).status, 'published');
  assert.equal((await activeDatabase()).exec('SELECT COUNT(*) FROM agent_backup_deletion_journals')[0].values[0][0], 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('backup and export materialization journals retain every durable phase and reject fabricated transitions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-c13-journal-'));
  for (const kind of ['backup', 'export']) {
    const base = path.join(root, kind);
    const managed = { backups: path.join(base, 'backups'), exports: path.join(base, 'exports'), temp: path.join(base, 'temp'), quarantine: path.join(base, 'quarantine') };
    for (const directory of Object.values(managed)) fs.mkdirSync(directory, { recursive: true });
    const store = new global.MaterializationJournalStore(path.join(base, 'journal'), Object.values(managed), strictMaterializationDurability);
    const assetId = `${kind}-phase-asset`;
    const jobId = kind === 'backup' ? '123e4567-e89b-42d3-a456-426614174021' : '123e4567-e89b-42d3-a456-426614174022';
    const requestId = kind === 'backup' ? '123e4567-e89b-52d3-a456-426614174021' : '123e4567-e89b-52d3-a456-426614174022';
    const stagedPath = path.join(managed.temp, `${assetId}.stage`);
    const finalPath = path.join(kind === 'backup' ? managed.backups : managed.exports, `${assetId}.artifact`);
    let manifest = await store.ensureIntent({ operationId: assetId, assetId, jobId, requestId, ownerClientId: owner, sessionId,
      kind, expectedVersion: { dataEpoch: 'epoch', dataRevision: 1 }, metadataHash: `sha256-v1:${'1'.repeat(64)}`,
      stagedPath, finalPath, quarantinePath: path.join(managed.quarantine, `${assetId}.quarantine`) }, '2026-07-20T00:00:00.000Z');
    fs.writeFileSync(stagedPath, Buffer.from(`${kind} durable bytes`));
    const evidence = global.materializationEvidence(stagedPath);
    manifest = await store.advance(manifest, 'staged_file_written', '2026-07-20T00:00:01.000Z', evidence);
    manifest = await store.advance(manifest, 'staged_evidence_persisted', '2026-07-20T00:00:02.000Z', evidence);
    fs.renameSync(stagedPath, finalPath);
    manifest = await store.advance(manifest, 'final_file_published', '2026-07-20T00:00:03.000Z', evidence);
    manifest = await store.advance(manifest, 'published_evidence_persisted', '2026-07-20T00:00:04.000Z', evidence);
    manifest = await store.advance(manifest, 'terminal_receipt_persisted', '2026-07-20T00:00:05.000Z', evidence);
    manifest = await store.advance(manifest, 'job_terminalized', '2026-07-20T00:00:06.000Z', evidence);
    assert.equal(store.read(assetId).phase, 'job_terminalized');
    await assert.rejects(store.advance(manifest, 'needs_recovery', '2026-07-20T00:00:07.000Z'), (error) => error.code === 'RECOVERY_FENCE');
    fs.writeFileSync(finalPath, Buffer.from('tampered'));
    assert.notDeepEqual(global.materializationEvidence(finalPath), evidence);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('materialization journal fences failed file or directory durability and never overwrites quarantine evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-c13-durability-'));
  const managed = [path.join(root, 'backups'), path.join(root, 'temp'), path.join(root, 'quarantine')];
  for (const directory of managed) fs.mkdirSync(directory, { recursive: true });
  const manifestInput = { operationId: 'durability-asset', assetId: 'durability-asset', jobId: '123e4567-e89b-42d3-a456-426614174031', requestId: '123e4567-e89b-52d3-a456-426614174031', ownerClientId: owner, sessionId,
    kind: 'backup', expectedVersion: { dataEpoch: 'epoch', dataRevision: 1 }, metadataHash: `sha256-v1:${'2'.repeat(64)}`,
    stagedPath: path.join(managed[1], 'stage'), finalPath: path.join(managed[0], 'final'), quarantinePath: path.join(managed[2], 'quarantine') };
  const flushFailure = Object.freeze({ ...strictMaterializationDurability, files: Object.freeze({ ...strictMaterializationDurability.files,
    async openExclusive(filePath) { const handle = await fs.promises.open(filePath, 'wx'); return Object.freeze({ async writeFile(value) { await handle.writeFile(value); }, async sync() { const error = new Error('flush failed'); error.code = 'EIO'; throw error; }, async close() { await handle.close(); } }); }
  }) });
  const failedStore = new global.MaterializationJournalStore(path.join(root, 'failed-journal'), managed, flushFailure);
  await assert.rejects(failedStore.ensureIntent(manifestInput, '2026-07-20T00:00:00.000Z'), (error) => error.code === 'RECOVERY_FENCE');
  assert.equal(failedStore.read(manifestInput.operationId), undefined);
  const directoryFailure = Object.freeze({ ...strictMaterializationDurability, directoryDurability: Object.freeze({ async openDirectory() { const error = new Error('directory unsupported'); error.code = 'EPERM'; throw error; } }) });
  const directoryStore = new global.MaterializationJournalStore(path.join(root, 'directory-journal'), managed, directoryFailure);
  await assert.rejects(directoryStore.ensureIntent(manifestInput, '2026-07-20T00:00:00.000Z'), (error) => error.code === 'RECOVERY_FENCE');
  const source = path.join(managed[1], 'source'); const target = path.join(managed[2], 'evidence');
  fs.writeFileSync(source, 'new'); fs.writeFileSync(target, 'prior-evidence');
  await assert.rejects(global.quarantineMaterializationFile(source, target, strictMaterializationDurability), (error) => error.code === 'RECOVERY_FENCE');
  assert.equal(fs.readFileSync(target, 'utf8'), 'prior-evidence');
  assert.equal(fs.readFileSync(source, 'utf8'), 'new');
  let directoryFlushes = 0;
  const postRenameFailure = Object.freeze({ ...strictMaterializationDurability, directoryDurability: Object.freeze({ async openDirectory() {
    directoryFlushes += 1;
    return Object.freeze({ async sync() { if (directoryFlushes > 1) { const error = new Error('post-rename directory flush'); error.code = 'EIO'; throw error; } }, async close() {} });
  } }) });
  const staged = path.join(managed[1], 'post-rename-stage'); const final = path.join(managed[0], 'post-rename-final');
  fs.writeFileSync(staged, 'publish evidence');
  await assert.rejects(global.publishMaterializationFile(staged, final, postRenameFailure), (error) => error.code === 'RECOVERY_FENCE');
  assert.equal(fs.existsSync(staged), false);
  assert.equal(fs.readFileSync(final, 'utf8'), 'publish evidence');
  fs.rmSync(root, { recursive: true, force: true });
});

test('backup and export crash checkpoints retain only the last durable journal and file evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-c13-checkpoints-'));
  const checkpoints = [
    ['intent_persisted', 'intent', 'none'],
    ['staged_file_before_journal', 'intent', 'staged'],
    ['staged_evidence_before_final_rename', 'staged_evidence_persisted', 'staged'],
    ['final_renamed_before_phase', 'staged_evidence_persisted', 'final'],
    ['final_phase_before_asset_receipt', 'final_file_published', 'final'],
    ['published_evidence_before_terminal_receipt', 'published_evidence_persisted', 'final'],
    ['terminal_receipt_before_job_terminal', 'terminal_receipt_persisted', 'final'],
    ['job_completed_before_journal_terminal', 'terminal_receipt_persisted', 'final']
  ];
  for (const kind of ['backup', 'export']) for (const [checkpoint, phase, fileState] of checkpoints) {
    const base = path.join(root, `${kind}-${checkpoint}`);
    const roots = { backups: path.join(base, 'backups'), exports: path.join(base, 'exports'), temp: path.join(base, 'temp'), quarantine: path.join(base, 'quarantine') };
    for (const directory of Object.values(roots)) fs.mkdirSync(directory, { recursive: true });
    const assetId = `${kind}-${checkpoint}`;
    const stagedPath = path.join(roots.temp, `${assetId}.stage`);
    const finalPath = path.join(kind === 'backup' ? roots.backups : roots.exports, `${assetId}.artifact`);
    const store = new global.MaterializationJournalStore(path.join(base, 'journal'), Object.values(roots), strictMaterializationDurability);
    let manifest = await store.ensureIntent({ operationId: assetId, assetId, jobId: kind === 'backup' ? '123e4567-e89b-42d3-a456-426614174041' : '123e4567-e89b-42d3-a456-426614174042', requestId: kind === 'backup' ? '123e4567-e89b-52d3-a456-426614174041' : '123e4567-e89b-52d3-a456-426614174042', ownerClientId: owner, sessionId,
      kind, expectedVersion: { dataEpoch: 'epoch', dataRevision: 1 }, metadataHash: `sha256-v1:${'4'.repeat(64)}`, stagedPath, finalPath, quarantinePath: path.join(roots.quarantine, `${assetId}.quarantine`) }, '2026-07-20T00:00:00.000Z');
    if (fileState !== 'none') {
      const file = fileState === 'staged' ? stagedPath : finalPath;
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${kind}:${checkpoint}`);
      const evidence = global.materializationEvidence(file);
      if (phase !== 'intent') {
        manifest = await store.advance(manifest, 'staged_file_written', '2026-07-20T00:00:01.000Z', evidence);
        manifest = await store.advance(manifest, 'staged_evidence_persisted', '2026-07-20T00:00:02.000Z', evidence);
        if (phase !== 'staged_evidence_persisted') {
          manifest = await store.advance(manifest, 'final_file_published', '2026-07-20T00:00:03.000Z', evidence);
          if (phase !== 'final_file_published') {
            manifest = await store.advance(manifest, 'published_evidence_persisted', '2026-07-20T00:00:04.000Z', evidence);
            if (phase === 'terminal_receipt_persisted') manifest = await store.advance(manifest, 'terminal_receipt_persisted', '2026-07-20T00:00:05.000Z', evidence);
          }
        }
      }
    }
    assert.equal(store.read(assetId).phase, phase, `${kind}:${checkpoint}`);
    assert.equal(fs.existsSync(stagedPath), fileState === 'staged', `${kind}:${checkpoint}:staged`);
    assert.equal(fs.existsSync(finalPath), fileState === 'final', `${kind}:${checkpoint}:final`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('backup and export restart checkpoints converge through recovery without duplicate assets, jobs, or finals', async () => {
  const checkpoints = ['intent_persisted', 'staged_file_before_journal', 'staged_evidence_persisted', 'final_renamed_before_phase', 'final_phase_before_asset_receipt', 'published_evidence_before_terminal_receipt'];
  for (const kind of ['backup', 'export']) for (const checkpoint of checkpoints) {
    await resetControlPlaneLifecycle();
    fs.rmSync(path.join(getControlPlanePaths().testRoot, 'c13-materialization'), { recursive: true, force: true });
    let clock = Date.parse('2026-07-20T00:00:00.000Z');
    const materializationNow = () => new Date(clock += 1_000).toISOString();
    const { coordinator, composition, globalApplication, principal: externalPrincipal } = await externalGateway(true, undefined, undefined, materializationNow);
    await composition.jobExecutor.stopAndDrain();
    const requestId = crypto.randomUUID();
    const operation = kind === 'backup' ? 'backups.create' : 'exports.create';
    const payload = kind === 'backup' ? { kind: 'manual' } : { specification: { scope: 'all', mode: 'full' } };
    const first = await composition.gateway.execute({ apiVersion: 1, kind: 'agent-command', operation, requestId,
      catalog: agent.operationCatalogIdentity, expectedVersion: coordinator.currentVersion(), payload }, externalPrincipal);
    assert.equal(first.kind, 'completed', `${kind}:${checkpoint}:${JSON.stringify(first)}`);
    const root = path.join(getControlPlanePaths().testRoot, 'c13-materialization');
    const paths = { backups: path.join(root, 'backups'), exports: path.join(root, 'exports'), temp: path.join(root, 'temp'), quarantine: path.join(root, 'temp', 'quarantine') };
    const journal = new global.MaterializationJournalStore(path.join(paths.temp, 'journal'), Object.values(paths), strictMaterializationDurability);
    let manifest = journal.read(first.result.value.assetId);
    const advance = async (phase, evidence) => {
      manifest = await journal.advance(manifest, phase, materializationNow(), evidence);
    };
    const write = (filePath) => { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, Buffer.from(`${kind}:${checkpoint}`)); return global.materializationEvidence(filePath); };
    let evidence;
    if (checkpoint === 'staged_file_before_journal') evidence = write(manifest.stagedPath);
    if (checkpoint !== 'intent_persisted' && checkpoint !== 'staged_file_before_journal') {
      const filePath = checkpoint === 'staged_evidence_persisted' ? manifest.stagedPath : manifest.finalPath;
      evidence = write(filePath);
      await advance('staged_file_written', evidence);
      await advance('staged_evidence_persisted', evidence);
      if (checkpoint !== 'staged_evidence_persisted' && checkpoint !== 'final_renamed_before_phase') {
        await advance('final_file_published', evidence);
        if (checkpoint === 'published_evidence_before_terminal_receipt') await advance('published_evidence_persisted', evidence);
      }
    }
    await setFixtureJobState(
      coordinator,
      composition.jobExecutor,
      `c13-fixture-restart-${first.result.value.jobId}`,
      "UPDATE agent_jobs SET status='running', lease_token='123e4567-e89b-42d3-a456-426614174095', lease_expires_at='2026-07-20T01:00:00.000Z' WHERE job_id=?",
      [first.result.value.jobId]
    );
    await globalApplication.recoverMaterializations();
    await globalApplication.recoverMaterializations();
    assert.equal((await activeDatabase()).exec('SELECT status FROM agent_jobs WHERE job_id=?', [first.result.value.jobId])[0].values[0][0], 'queued', `${kind}:${checkpoint}:requeued`);
    composition.jobExecutor.start();
    const terminal = await waitForJob(composition, first.result.value.jobId, externalPrincipal);
    assert.equal(terminal.status, 'completed', `${kind}:${checkpoint}:${JSON.stringify(terminal)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const asset = (await activeDatabase()).exec('SELECT status,content_hash,content_size,internal_path,staged_path FROM agent_global_assets WHERE asset_id=?', [first.result.value.assetId])[0].values[0];
    assert.equal(asset[0], 'published');
    assert.equal(fs.existsSync(asset[3]), true);
    assert.equal(fs.existsSync(asset[4]), false);
    assert.deepEqual(global.materializationEvidence(asset[3]), { hash: asset[1], size: asset[2] });
    assert.equal(fs.readdirSync(path.dirname(asset[3])).filter((entry) => entry === path.basename(asset[3])).length, 1);
    assert.equal(journal.read(first.result.value.assetId).phase, 'job_terminalized');
    const replay = await composition.gateway.execute({ apiVersion: 1, kind: 'agent-command', operation, requestId,
      catalog: agent.operationCatalogIdentity, expectedVersion: coordinator.currentVersion(), payload }, externalPrincipal);
    assert.equal(replay.kind, 'replayed');
    assert.equal((await activeDatabase()).exec('SELECT COUNT(*) FROM agent_global_assets')[0].values[0][0], 1);
    assert.equal((await activeDatabase()).exec('SELECT COUNT(*) FROM agent_jobs')[0].values[0][0], 1);
  }
});

test('completed backup and export jobs recover only the missing job_terminalized journal phase', async () => {
  for (const kind of ['backup', 'export']) {
    await resetControlPlaneLifecycle();
    fs.rmSync(path.join(getControlPlanePaths().testRoot, 'c13-materialization'), { recursive: true, force: true });
    let crash = true;
    const phases = [];
    const { coordinator, composition, globalApplication, principal: externalPrincipal } = await externalGateway(true, (phase) => phases.push(phase), async () => {
      if (crash) throw new Error('simulated process loss before journal terminalization');
    });
    const operation = kind === 'backup' ? 'backups.create' : 'exports.create';
    const payload = kind === 'backup' ? { kind: 'manual' } : { specification: { scope: 'all', mode: 'full' } };
    const first = await composition.gateway.execute({ apiVersion: 1, kind: 'agent-command', operation, requestId: crypto.randomUUID(),
      catalog: agent.operationCatalogIdentity, expectedVersion: coordinator.currentVersion(), payload }, externalPrincipal);
    const completed = await waitForJob(composition, first.result.value.jobId, externalPrincipal);
    assert.equal(completed.status, 'completed');
    const before = (await activeDatabase()).exec('SELECT attempt FROM agent_jobs WHERE job_id=?', [first.result.value.jobId])[0].values[0][0];
    const root = path.join(getControlPlanePaths().testRoot, 'c13-materialization');
    const journal = new global.MaterializationJournalStore(path.join(root, 'temp', 'journal'), [path.join(root, 'backups'), path.join(root, 'exports'), path.join(root, 'temp'), path.join(root, 'temp', 'quarantine')], strictMaterializationDurability);
    const terminalManifest = journal.read(first.result.value.assetId);
    assert.equal(terminalManifest.phase, 'terminal_receipt_persisted');
    assert.equal(fs.existsSync(terminalManifest.finalPath), true, `${kind}:published final survives the terminal-journal fault`);
    const stagedWritesBeforeRecovery = phases.filter((phase) => phase === 'staged_file_written').length;
    crash = false;
    await globalApplication.recoverMaterializations();
    assert.equal(fs.existsSync(terminalManifest.finalPath), true, `${kind}:recovery terminalization does not move the final`);
    await globalApplication.recoverMaterializations();
    assert.equal(journal.read(first.result.value.assetId).phase, 'job_terminalized');
    assert.equal(phases.filter((phase) => phase === 'staged_file_written').length, stagedWritesBeforeRecovery, `${kind}:completed job recovery does not rerun materialization`);
    assert.equal((await activeDatabase()).exec('SELECT attempt FROM agent_jobs WHERE job_id=?', [first.result.value.jobId])[0].values[0][0], before);
    assert.equal((await activeDatabase()).exec('SELECT status FROM agent_jobs WHERE job_id=?', [first.result.value.jobId])[0].values[0][0], 'completed');
  }
});

test('backups list uses owner-bound signed pagination and redacted metadata', async () => {
  const app = await application();
  const coordinator = await databaseService.getDatabaseCoordinator();
  const plane = await databaseService.getAgentControlPlane();
  await executeFixtureControlWrite(coordinator, 'c13-fixture-backup-pagination', (database, scope) => {
    for (const id of ['backup-page-a', 'backup-page-b', 'backup-page-c']) {
      global.createGlobalAsset(database, { assetId: id, ownerClientId: owner, kind: 'backup', metadata: { filePath: 'D:\\secret\\db', id }, now: '2026-07-20T00:00:00.000Z' }, scope);
    }
    return { changed: true, value: undefined };
  }, [plane.jobExecutor]);
  const database = await activeDatabase();
  const first = app.query({ type: 'backups.list', payload: { pageSize: 2 } }, context(crypto.randomUUID())).value;
  assert.equal(first.items.length, 2);
  assert.equal(first.page.hasMore, true);
  assert.equal(Object.hasOwn(first.items[0].metadata, 'filePath'), false);
  const second = app.query({ type: 'backups.list', payload: { pageSize: 2, cursor: first.page.nextCursor } }, context(crypto.randomUUID())).value;
  assert.equal(second.items.length, 1);
  assert.throws(() => app.query({ type: 'backups.list', payload: { pageSize: 2, cursor: first.page.nextCursor } }, context(crypto.randomUUID(), otherOwner)), (error) => error.code === 'CURSOR_INVALID');
  assert.throws(() => app.query({ type: 'backups.list', payload: { pageSize: 2, cursor: 'cursor-v1.invalid.0'.padEnd(80, '0') } }, context(crypto.randomUUID())), (error) => error.code === 'CURSOR_INVALID');
});

test('exports get returns only the requesting owner metadata without internal bindings', async () => {
  const app = await application();
  const coordinator = await databaseService.getDatabaseCoordinator();
  const plane = await databaseService.getAgentControlPlane();
  await executeFixtureControlWrite(coordinator, 'c13-fixture-export-owner', (database, scope) => ({
    changed: true,
    value: global.createGlobalAsset(database, { assetId: 'export-owner-only', ownerClientId: owner, kind: 'export',
      metadata: { outputPath: 'D:\\private\\export.pdf', label: 'practice export' }, internalPath: 'D:\\private\\export.pdf',
      jobId: '123e4567-e89b-42d3-a456-426614174011', now: '2026-07-20T00:00:00.000Z' }, scope)
  }), [plane.jobExecutor]);
  const database = await activeDatabase();
  const found = app.query({ type: 'exports.get', payload: { exportId: 'export-owner-only' } }, context()).value;
  assert.equal(found.assetId, 'export-owner-only');
  assert.equal(Object.hasOwn(found.metadata, 'outputPath'), false);
  assert.equal(Object.hasOwn(found, 'jobId'), false);
  assert.equal(Object.hasOwn(found, 'internalPath'), false);
  const foreign = capturedError(() => app.query({ type: 'exports.get', payload: { exportId: 'export-owner-only' } }, context(crypto.randomUUID(), otherOwner)));
  const missing = capturedError(() => app.query({ type: 'exports.get', payload: { exportId: 'export-missing' } }, context()));
  assert.deepEqual({ code: foreign.code, details: foreign.details }, { code: missing.code, details: missing.details });
  assert.equal(foreign.code, 'HANDLER_NOT_FOUND');
});

test('backup intent creates one durable owner-bound job and Gateway receipt replays the exact result', async () => {
  const { coordinator, composition, principal: externalPrincipal } = await externalGateway();
  const requestId = crypto.randomUUID();
  const envelope = {
    apiVersion: 1, kind: 'agent-command', operation: 'backups.create', requestId,
    catalog: agent.operationCatalogIdentity, expectedVersion: coordinator.currentVersion(), payload: { kind: 'manual' }
  };
  const first = await composition.gateway.execute(envelope, externalPrincipal);
  const replay = await composition.gateway.execute(envelope, externalPrincipal);
  assert.equal(first.kind, 'completed', JSON.stringify(first));
  assert.equal(replay.kind, 'replayed', JSON.stringify(replay));
  assert.deepEqual(replay.result, first.result);
  assert.deepEqual(Object.keys(first.result.value).sort(), ['assetId', 'jobId', 'status']);
  assert.equal(first.result.value.status, 'intent');
  assert.equal(JSON.stringify(first.result.value).includes('path'), false);
  const database = await activeDatabase();
  const assetRow = database.exec('SELECT owner_client_id,status,job_id,internal_path FROM agent_global_assets')[0].values[0];
  const jobRow = database.exec('SELECT owner_client_id,creating_session_id,operation,gateway_request_id,status,expected_data_epoch,expected_data_revision FROM agent_jobs')[0].values[0];
  assert.deepEqual(assetRow, [externalOwner, 'intent', first.result.value.jobId, null]);
  assert.deepEqual(jobRow.slice(0, 3), [externalOwner, externalPrincipal.sessionId, 'backups.materialize']);
  assert.notEqual(jobRow[3], requestId);
  assert.match(jobRow[3], /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(jobRow[4], 'queued');
  assert.deepEqual(jobRow.slice(5), [first.result.dataVersion.dataEpoch, first.result.dataVersion.dataRevision]);
  assert.equal(database.exec('SELECT COUNT(*) FROM agent_global_assets')[0].values[0][0], 1);
  assert.equal(database.exec('SELECT COUNT(*) FROM agent_jobs')[0].values[0][0], 1);
});

test('materialization executes only the internal target and publishes bounded evidence', async () => {
  const { coordinator, composition, principal: externalPrincipal, jobErrors } = await externalGateway(true);
  const requestId = crypto.randomUUID();
  const outcome = await composition.gateway.execute({
    apiVersion: 1, kind: 'agent-command', operation: 'backups.create', requestId,
    catalog: agent.operationCatalogIdentity, expectedVersion: coordinator.currentVersion(), payload: { kind: 'manual' }
  }, externalPrincipal);
  assert.equal(outcome.kind, 'completed', JSON.stringify(outcome));
  const job = await waitForJob(composition, outcome.result.value.jobId, externalPrincipal);
  assert.equal(job.operation, 'backups.materialize');
  const failedResult = job.status === 'failed' ? await composition.jobs.result(job.jobId, externalPrincipal).catch((error) => error) : undefined;
  assert.equal(job.status, 'completed', `${JSON.stringify(job)} ${JSON.stringify(failedResult)} ${jobErrors.map((error) => String(error?.stack ?? error)).join('\n')}`);
  const database = await activeDatabase();
  const row = database.exec('SELECT status,content_hash,content_size,internal_path,staged_path FROM agent_global_assets WHERE asset_id=?', [outcome.result.value.assetId])[0].values[0];
  assert.equal(row[0], 'published');
  assert.match(row[1], /^sha256-v1:[0-9a-f]{64}$/);
  assert.ok(row[2] > 0);
  assert.equal(fs.existsSync(row[3]), true);
  assert.equal(fs.existsSync(row[4]), false);
});

test('export materialization uses the same internal-only durable path', async () => {
  const { coordinator, composition, principal: externalPrincipal } = await externalGateway(true);
  const outcome = await composition.gateway.execute({
    apiVersion: 1, kind: 'agent-command', operation: 'exports.create', requestId: crypto.randomUUID(),
    catalog: agent.operationCatalogIdentity, expectedVersion: coordinator.currentVersion(), payload: { specification: { scope: 'all', mode: 'full' } }
  }, externalPrincipal);
  assert.equal(outcome.kind, 'completed', JSON.stringify(outcome));
  const job = await waitForJob(composition, outcome.result.value.jobId, externalPrincipal);
  assert.equal(job.operation, 'exports.materialize');
  assert.equal(job.status, 'completed', JSON.stringify(job));
  const database = await activeDatabase();
  const row = database.exec('SELECT status,content_hash,content_size,internal_path FROM agent_global_assets WHERE asset_id=?', [outcome.result.value.assetId])[0].values[0];
  assert.deepEqual(row.slice(0, 1), ['published']);
  assert.match(row[1], /^sha256-v1:[0-9a-f]{64}$/);
  assert.ok(row[2] > 0);
  assert.equal(path.extname(row[3]), '.pdf');
});

test('both managed materializers persist every journal boundary before their job terminalizes', async () => {
  const phases = new Map();
  const { coordinator, composition, principal: externalPrincipal } = await externalGateway(true, (phase, manifest) => {
    const entries = phases.get(manifest.assetId) ?? [];
    entries.push(phase); phases.set(manifest.assetId, entries);
  });
  const backup = await composition.gateway.execute({ apiVersion: 1, kind: 'agent-command', operation: 'backups.create', requestId: crypto.randomUUID(),
    catalog: agent.operationCatalogIdentity, expectedVersion: coordinator.currentVersion(), payload: { kind: 'manual' } }, externalPrincipal);
  const exported = await composition.gateway.execute({ apiVersion: 1, kind: 'agent-command', operation: 'exports.create', requestId: crypto.randomUUID(),
    catalog: agent.operationCatalogIdentity, expectedVersion: coordinator.currentVersion(), payload: { specification: { scope: 'all', mode: 'full' } } }, externalPrincipal);
  await waitForJob(composition, backup.result.value.jobId, externalPrincipal);
  await waitForJob(composition, exported.result.value.jobId, externalPrincipal);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const expected = ['intent', 'staged_file_written', 'staged_evidence_persisted', 'final_file_published', 'published_evidence_persisted', 'terminal_receipt_persisted', 'job_terminalized'];
  assert.deepEqual(phases.get(backup.result.value.assetId), expected);
  assert.deepEqual(phases.get(exported.result.value.assetId), expected);
});

test('export intent replays stable identities and rejects payload, owner, and session changes', async () => {
  await seedPrincipal();
  await seedPrincipal(owner, otherSessionId);
  await seedPrincipal(otherOwner, '123e4567-e89b-42d3-a456-426614174003');
  const app = await application();
  const coordinator = await databaseService.getDatabaseCoordinator();
  const requestId = crypto.randomUUID();
  const command = { type: 'exports.create', payload: { specification: { scope: 'all', mode: 'full' } } };
  const first = await app.execute(command, context(requestId, owner, coordinator.currentVersion()), undefined, principal());
  const replay = await app.execute(command, context(requestId, owner, coordinator.currentVersion()), undefined, principal());
  assert.deepEqual(replay.value, first.value);
  assert.deepEqual(replay.dataVersion, first.dataVersion);
  assert.equal(replay.changed, false);
  await assert.rejects(
    app.execute({ type: 'exports.create', payload: { specification: { scope: 'all', mode: 'practice' } } }, context(requestId, owner, coordinator.currentVersion()), undefined, principal()),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT'
  );
  await assert.rejects(
    app.execute(command, context(requestId, owner, coordinator.currentVersion()), undefined, principal(owner, otherSessionId)),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT'
  );
  const otherSession = '123e4567-e89b-42d3-a456-426614174003';
  await assert.rejects(
    app.execute(command, context(requestId, otherOwner, coordinator.currentVersion()), undefined, principal(otherOwner, otherSession)),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT'
  );
  const database = await activeDatabase();
  assert.equal(database.exec('SELECT COUNT(*) FROM agent_global_assets')[0].values[0][0], 1);
  assert.equal(database.exec('SELECT COUNT(*) FROM agent_jobs')[0].values[0][0], 1);
});

test('materialization startup recovery requeues intent and verified staged work but fences dual-file ambiguity', async () => {
  await seedPrincipal();
  const coordinator = await databaseService.getDatabaseCoordinator();
  const plane = await databaseService.getAgentControlPlane();
  await plane.jobExecutor.stopAndDrain();
  assert.equal(plane.jobExecutor.isStopped(), true);
  assert.equal(plane.jobExecutor.isIdle(), true);
  const readOnlyDatabase = await databaseService.getReadOnlyDatabase();
  const root = path.join(getControlPlanePaths().testRoot, 'c13-recovery');
  fs.rmSync(root, { recursive: true, force: true });
  const paths = { backups: path.join(root, 'backups'), exports: path.join(root, 'exports'), temp: path.join(root, 'temp'), journal: path.join(root, 'journal'), quarantine: path.join(root, 'quarantine') };
  let materializationNow = '2026-07-20T00:00:10.000Z';
  const app = global.registerGlobalApplication({ coordinator, readOnlyDatabase, getJobs: () => plane.jobs,
    currentVersion: () => coordinator.currentVersion(), managedPaths: paths, now: () => materializationNow, materializationDurability: strictMaterializationDurability,
    materializer: { async stage({ stagedPath }) { fs.mkdirSync(path.dirname(stagedPath), { recursive: true }); fs.writeFileSync(stagedPath, Buffer.from('recovered')); return {}; } }
  });
  const makeIntent = async (type) => app.execute(type === 'backups.create'
    ? { type, payload: { kind: 'manual' } }
    : { type, payload: { specification: { scope: 'all', mode: 'full' } } }, context(crypto.randomUUID(), owner, coordinator.currentVersion()), undefined, principal());
  const journal = new global.MaterializationJournalStore(paths.journal, Object.values(paths), strictMaterializationDurability);
  const intent = await makeIntent('backups.create');
  const intentManifest = journal.read(intent.value.assetId);
  await setFixtureJobState(
    coordinator,
    plane.jobExecutor,
    `c13-fixture-recovery-intent-${intent.value.jobId}`,
    "UPDATE agent_jobs SET status='running', lease_token='123e4567-e89b-42d3-a456-426614174099', lease_expires_at='2026-07-20T01:00:00.000Z' WHERE job_id=?",
    [intent.value.jobId]
  );
  await app.recoverMaterializations();
  assert.equal((await activeDatabase()).exec('SELECT status FROM agent_jobs WHERE job_id=?', [intent.value.jobId])[0].values[0][0], 'queued');
  assert.equal(fs.existsSync(intentManifest.stagedPath), false);

  const staged = await makeIntent('exports.create');
  let stagedManifest = journal.read(staged.value.assetId);
  fs.mkdirSync(path.dirname(stagedManifest.stagedPath), { recursive: true });
  fs.writeFileSync(stagedManifest.stagedPath, Buffer.from('verified staged export'));
  const evidence = global.materializationEvidence(stagedManifest.stagedPath);
  stagedManifest = await journal.advance(stagedManifest, 'staged_file_written', '2026-07-20T00:00:11.000Z', evidence);
  await setFixtureJobState(
    coordinator,
    plane.jobExecutor,
    `c13-fixture-recovery-staged-${staged.value.jobId}`,
    "UPDATE agent_jobs SET status='running', lease_token='123e4567-e89b-42d3-a456-426614174098', lease_expires_at='2026-07-20T01:00:00.000Z' WHERE job_id=?",
    [staged.value.jobId]
  );
  materializationNow = '2026-07-20T00:00:12.000Z';
  await app.recoverMaterializations();
  assert.equal((await activeDatabase()).exec('SELECT status FROM agent_jobs WHERE job_id=?', [staged.value.jobId])[0].values[0][0], 'queued');
  assert.equal(fs.existsSync(stagedManifest.stagedPath), true);
  assert.equal(fs.existsSync(stagedManifest.finalPath), false);

  const finalCrash = await makeIntent('exports.create');
  let finalManifest = journal.read(finalCrash.value.assetId);
  fs.mkdirSync(path.dirname(finalManifest.finalPath), { recursive: true });
  fs.writeFileSync(finalManifest.finalPath, Buffer.from('published before phase'));
  const finalEvidence = global.materializationEvidence(finalManifest.finalPath);
  finalManifest = await journal.advance(finalManifest, 'staged_file_written', '2026-07-20T00:00:13.000Z', finalEvidence);
  finalManifest = await journal.advance(finalManifest, 'staged_evidence_persisted', '2026-07-20T00:00:14.000Z', finalEvidence);
  finalManifest = await journal.advance(finalManifest, 'final_file_published', '2026-07-20T00:00:15.000Z', finalEvidence);
  await setFixtureJobState(
    coordinator,
    plane.jobExecutor,
    `c13-fixture-recovery-final-${finalCrash.value.jobId}`,
    "UPDATE agent_jobs SET status='running', lease_token='123e4567-e89b-42d3-a456-426614174096', lease_expires_at='2026-07-20T01:00:00.000Z' WHERE job_id=?",
    [finalCrash.value.jobId]
  );
  materializationNow = '2026-07-20T00:00:16.000Z';
  await app.recoverMaterializations();
  assert.equal((await activeDatabase()).exec('SELECT status FROM agent_global_assets WHERE asset_id=?', [finalCrash.value.assetId])[0].values[0][0], 'published');
  assert.equal(journal.read(finalCrash.value.assetId).phase, 'published_evidence_persisted');
  assert.equal((await activeDatabase()).exec('SELECT status FROM agent_jobs WHERE job_id=?', [finalCrash.value.jobId])[0].values[0][0], 'queued');

  const terminalCrash = await makeIntent('backups.create');
  let terminalManifest = journal.read(terminalCrash.value.assetId);
  fs.mkdirSync(path.dirname(terminalManifest.finalPath), { recursive: true });
  fs.writeFileSync(terminalManifest.finalPath, Buffer.from('terminal receipt durable'));
  const terminalEvidence = global.materializationEvidence(terminalManifest.finalPath);
  terminalManifest = await journal.advance(terminalManifest, 'staged_file_written', '2026-07-20T00:00:17.000Z', terminalEvidence);
  terminalManifest = await journal.advance(terminalManifest, 'staged_evidence_persisted', '2026-07-20T00:00:18.000Z', terminalEvidence);
  terminalManifest = await journal.advance(terminalManifest, 'final_file_published', '2026-07-20T00:00:19.000Z', terminalEvidence);
  terminalManifest = await journal.advance(terminalManifest, 'published_evidence_persisted', '2026-07-20T00:00:20.000Z', terminalEvidence);
  terminalManifest = await journal.advance(terminalManifest, 'terminal_receipt_persisted', '2026-07-20T00:00:21.000Z', terminalEvidence);
  await setFixtureJobState(
    coordinator,
    plane.jobExecutor,
    `c13-fixture-recovery-terminal-${terminalCrash.value.jobId}`,
    "UPDATE agent_jobs SET status='completed', progress=100, lease_token=NULL, lease_expires_at=NULL, terminal_at='2026-07-20T00:00:21.000Z', result_ref='complete.result', result_hash=?, result_size=1 WHERE job_id=?",
    [`sha256-v1:${'3'.repeat(64)}`, terminalCrash.value.jobId]
  );
  materializationNow = '2026-07-20T00:00:22.000Z';
  await app.recoverMaterializations();
  assert.equal(journal.read(terminalCrash.value.assetId).phase, 'job_terminalized');

  const ambiguous = await makeIntent('backups.create');
  let ambiguousManifest = journal.read(ambiguous.value.assetId);
  fs.mkdirSync(path.dirname(ambiguousManifest.stagedPath), { recursive: true });
  fs.mkdirSync(path.dirname(ambiguousManifest.finalPath), { recursive: true });
  fs.writeFileSync(ambiguousManifest.stagedPath, Buffer.from('same evidence'));
  fs.writeFileSync(ambiguousManifest.finalPath, Buffer.from('same evidence'));
  ambiguousManifest = await journal.advance(ambiguousManifest, 'staged_file_written', '2026-07-20T00:00:23.000Z', global.materializationEvidence(ambiguousManifest.stagedPath));
  await setFixtureJobState(
    coordinator,
    plane.jobExecutor,
    `c13-fixture-recovery-ambiguous-${ambiguous.value.jobId}`,
    "UPDATE agent_jobs SET status='running', lease_token='123e4567-e89b-42d3-a456-426614174097', lease_expires_at='2026-07-20T01:00:00.000Z' WHERE job_id=?",
    [ambiguous.value.jobId]
  );
  materializationNow = '2026-07-20T00:00:24.000Z';
  await assert.rejects(app.recoverMaterializations(), (error) => error.code === 'RECOVERY_FENCE');
  assert.equal((await activeDatabase()).exec('SELECT status FROM agent_global_assets WHERE asset_id=?', [ambiguous.value.assetId])[0].values[0][0], 'needs_recovery');
  assert.equal(journal.read(ambiguous.value.assetId).phase, 'needs_recovery');
  assert.equal(fs.existsSync(ambiguousManifest.finalPath), false);
});

test('backups.delete consumes one R4 grant through an approved change set and terminal replay never moves twice', async () => {
  const counter = { renames: [] };
  const runtime = await deleteGateway({ materializationDurability: countedDeletionDurability(counter) });
  const executeAndDrain = async (request, principal) => {
    const outcome = await runtime.composition.gateway.execute(request, principal);
    await runtime.composition.jobExecutor.whenIdle();
    await runtime.coordinator.whenWritesIdle();
    return outcome;
  };
  const principal = await registerDeleteClient(runtime, deleteOwner, 'delete-owner-credential', 'delete-owner-session');
  const otherPrincipal = await registerDeleteClient(runtime, otherDeleteOwner, 'delete-other-credential', 'delete-other-session');
  const backup = await seedPublishedBackupAsset(runtime, 'backup-delete-gateway', deleteOwner);
  const baseVersion = runtime.coordinator.currentVersion();
  const planned = gatewayCommand('backups.delete', { backupId: backup.assetId }, baseVersion);
  const state = runtime.globalApplication.resolveState(planned, agent.resolveOperationDescriptor('backups.delete'), principal);
  const grantId = await createDeleteGrant(runtime, deleteOwner, planned.payload, state.targetHash);
  const { changeSetId } = await createApprovedDeleteChangeSet(deleteOwner, backup.assetId, baseVersion);
  const request = gatewayCommand('agent.changesets.apply', { changeSetId }, undefined, crypto.randomUUID(), { kind: 'r4-grant', id: grantId });

  const first = await executeAndDrain(request, principal);
  assert.equal(first.kind, 'completed', JSON.stringify(first));
  assert.deepEqual(first.result.value, { backupId: backup.assetId, status: 'quarantined' });
  const replay = await executeAndDrain(request, principal);
  assert.equal(replay.kind, 'replayed', JSON.stringify(replay));
  assert.deepEqual(replay.result, first.result);
  const journalId = deletionJournalIdFor(backup.assetId);
  const quarantinePath = path.join(runtime.managedPaths.quarantine, 'backups', `${journalId}.quarantine`);

  const changedRequest = await executeAndDrain({ ...request, requestId: crypto.randomUUID() }, principal);
  assert.equal(changedRequest.kind, 'rejected');
  assert.equal(changedRequest.error.code, 'HANDLER_NOT_FOUND');
  const changedOwner = await executeAndDrain(request, otherPrincipal);
  assert.equal(changedOwner.kind, 'rejected');
  assert.equal(changedOwner.error.code, 'APPROVAL_INVALID');
  const secondBackup = await seedPublishedBackupAsset(runtime, 'backup-delete-reuse-target', deleteOwner, Buffer.from('second delete target'));
  const secondBaseVersion = runtime.coordinator.currentVersion();
  const secondChangeSet = await createApprovedDeleteChangeSet(deleteOwner, secondBackup.assetId, secondBaseVersion);
  const changedTarget = await executeAndDrain(
    gatewayCommand('agent.changesets.apply', { changeSetId: secondChangeSet.changeSetId }, undefined, crypto.randomUUID(), { kind: 'r4-grant', id: grantId }),
    principal
  );
  assert.equal(changedTarget.kind, 'rejected');
  assert.equal(changedTarget.error.code, 'R4_GRANT_INVALID');

  assert.equal(counter.renames.length, 1);
  assert.equal(fs.existsSync(backup.backupPath), false);
  assert.equal(fs.existsSync(quarantinePath), true);
  assert.deepEqual(global.materializationEvidence(quarantinePath), backup.evidence);
  const database = await activeDatabase();
  const grantRows = database.exec('SELECT status,reservation_id,consumed_at,operation,reserved_payload_hash FROM agent_r4_grants WHERE grant_id=?', [grantId])[0].values;
  assert.equal(grantRows.length, 1);
  assert.equal(grantRows[0][0], 'consumed');
  assert.match(grantRows[0][1], /^[0-9a-f-]{36}$/);
  assert.equal(typeof grantRows[0][2], 'string');
  assert.equal(grantRows[0][3], 'backups.delete');
  assert.equal(grantRows[0][4], agent.hashCanonicalJson({ backupId: backup.assetId }));
  assert.deepEqual(database.exec('SELECT status FROM agent_changesets WHERE change_set_id=?', [changeSetId])[0].values, [['applied']]);
  const journalRows = database.exec('SELECT status,request_id,reservation_id,grant_id FROM agent_backup_deletion_journals WHERE journal_id=?', [journalId])[0].values;
  assert.deepEqual(journalRows, [['completed', request.requestId, grantRows[0][1], grantId]]);
  assert.deepEqual(database.exec('SELECT status,operation,reservation_id,grant_id FROM agent_idempotency WHERE client_id=? AND request_id=?', [deleteOwner, request.requestId])[0].values,
    [['completed', 'agent.changesets.apply', grantRows[0][1], grantId]]);
  assert.deepEqual(database.exec('SELECT status FROM agent_global_assets WHERE asset_id=?', [backup.assetId])[0].values, [['quarantined']]);
  assert.equal(fs.existsSync(secondBackup.backupPath), true);
});

test('data_root.migrate remains non-executing while imports.delete_batch rejects missing admission', async () => {
  const app = await application();
  const coordinator = await databaseService.getDatabaseCoordinator();
  const database = await activeDatabase();
  const before = database.exec('SELECT COUNT(*) FROM agent_global_assets')[0].values[0][0];
  await assert.rejects(app.execute(
    { type: 'imports.delete_batch', payload: { batchId: 'batch-1', deleteManagedAssets: false } },
    context(crypto.randomUUID(), owner, coordinator.currentVersion())
  ), (error) => error.code === 'SCOPE_DENIED');
  const commands = [{ type: 'data_root.migrate', payload: { rootSelectionId: 'root-1' } }];
  for (const command of commands) {
    const result = await app.execute(command, context(crypto.randomUUID(), owner, coordinator.currentVersion()));
    assert.equal(result.changed, false, command.type);
  }
  assert.equal(database.exec('SELECT COUNT(*) FROM agent_global_assets')[0].values[0][0], before);
  assert.equal(database.exec('SELECT COUNT(*) FROM agent_jobs')[0].values[0][0], 0);
});

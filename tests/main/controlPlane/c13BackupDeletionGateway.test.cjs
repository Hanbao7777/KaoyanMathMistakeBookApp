const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
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

const deleteOwner = 'c13-delete-client';
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

async function activeDatabase() { return databaseService.getDatabase(); }

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
    operations: Object.freeze([Object.freeze({ operation: 'backups.delete', payload, payloadHash: agent.hashCanonicalJson(payload), affectedEntities })]),
    affectedSetHash: agent.hashCanonicalJson(affectedEntities),
    recovery: 'consistency_bundle',
    createdAt: fixedNow,
    expiresAt: '2026-07-20T00:30:00.000Z'
  }));
  await store.transitionChangeSet(changeSetId, 'approved');
  return { changeSetId, payload };
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
  return granted.result.value.grantId;
}

function deletionJournalIdFor(assetId) {
  return `backup-delete-${crypto.createHash('sha256').update(assetId).digest('hex').slice(0, 40)}`;
}

test('backups.delete startup recovery fences intent ambiguity after post-rename faults without a second rename', async () => {
  async function runScenario(name, prepareAfterCrash, verifyFiles) {
    await resetControlPlaneEnvironment();
    const managedPaths = defaultManagedPaths();
    const counter = { renames: [] };
    let faultedJournalId;
    const runtime = await deleteGateway({
      managedPaths,
      materializationDurability: countedDeletionDurability(counter),
      backupDeletionFaultHook(boundary, journalId) {
        assert.equal(boundary, 'after_quarantine_rename');
        faultedJournalId = journalId;
        throw new agent.AgentError('RECOVERY_FENCE', { scenario: name });
      },
      appInstanceId: `c13-delete-fault-${name}`
    });
    const principal = await registerDeleteClient(runtime, deleteOwner, `delete-${name}-credential`, `delete-${name}-session`);
    const backup = await seedPublishedBackupAsset(runtime, `backup-delete-${name}`, deleteOwner, Buffer.from(`delete ${name}`));
    const baseVersion = runtime.coordinator.currentVersion();
    const planned = gatewayCommand('backups.delete', { backupId: backup.assetId }, baseVersion);
    const state = runtime.globalApplication.resolveState(planned, agent.resolveOperationDescriptor('backups.delete'), principal);
    const grantId = await createDeleteGrant(runtime, deleteOwner, planned.payload, state.targetHash);
    const { changeSetId } = await createApprovedDeleteChangeSet(deleteOwner, backup.assetId, baseVersion);
    const request = gatewayCommand('agent.changesets.apply', { changeSetId }, undefined, crypto.randomUUID(), { kind: 'r4-grant', id: grantId });
    const failed = await runtime.composition.gateway.execute(request, principal);
    assert.equal(failed.kind, 'rejected', JSON.stringify(failed));
    assert.equal(failed.error.code, 'RECOVERY_FENCE');
    assert.equal(counter.renames.length, 1);
    assert.equal(faultedJournalId, deletionJournalIdFor(backup.assetId));
    const quarantinePath = path.join(managedPaths.quarantine, 'backups', `${faultedJournalId}.quarantine`);
    assert.equal(fs.existsSync(backup.backupPath), false);
    assert.equal(fs.existsSync(quarantinePath), true);
    assert.deepEqual((await activeDatabase()).exec('SELECT status FROM agent_backup_deletion_journals WHERE journal_id=?', [faultedJournalId])[0].values, [['intent']]);

    await prepareAfterCrash({ sourcePath: backup.backupPath, quarantinePath, evidence: backup.evidence });
    await databaseService.resetDatabaseConnectionAsync();
    const stages = [];
    await assert.rejects(databaseService.initializeDatabase({
      now: () => fixedNow,
      randomId: crypto.randomUUID,
      onStage: (stage) => stages.push(stage),
      agent: { appInstanceId: `c13-delete-restart-${name}`, cursorSecret: 'r'.repeat(32), jobResultRoot: environment.resultRoot }
    }), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)));
    assert.equal(stages.includes('needs_recovery'), true);
    const readOnly = await databaseService.getReadOnlyDatabase();
    assert.deepEqual(readOnly.select('SELECT status FROM agent_backup_deletion_journals WHERE journal_id=?', [faultedJournalId]).map((row) => [row.status]), [['needs_recovery']]);
    assert.deepEqual(readOnly.select('SELECT status,operation_journal_id AS operationJournalId FROM agent_global_assets WHERE asset_id=?', [backup.assetId]).map((row) => [row.status, row.operationJournalId]), [['needs_recovery', faultedJournalId]]);
    verifyFiles({ sourcePath: backup.backupPath, quarantinePath, evidence: backup.evidence });
    await databaseService.resetDatabaseConnectionAsync();
  }

  await runScenario('rename-only', async () => undefined, ({ sourcePath, quarantinePath, evidence }) => {
    assert.equal(fs.existsSync(sourcePath), false);
    assert.equal(fs.existsSync(quarantinePath), true);
    assert.deepEqual(global.materializationEvidence(quarantinePath), evidence);
  });
  await runScenario('source-quarantine', async ({ sourcePath, quarantinePath }) => {
    fs.copyFileSync(quarantinePath, sourcePath);
  }, ({ sourcePath, quarantinePath, evidence }) => {
    assert.equal(fs.existsSync(sourcePath), true);
    assert.equal(fs.existsSync(quarantinePath), true);
    assert.deepEqual(global.materializationEvidence(sourcePath), evidence);
    assert.deepEqual(global.materializationEvidence(quarantinePath), evidence);
  });
  await runScenario('neither-file', async ({ quarantinePath }) => {
    fs.rmSync(quarantinePath, { force: true });
  }, ({ sourcePath, quarantinePath }) => {
    assert.equal(fs.existsSync(sourcePath), false);
    assert.equal(fs.existsSync(quarantinePath), false);
  });
  await runScenario('tampered-quarantine', async ({ quarantinePath }) => {
    fs.writeFileSync(quarantinePath, Buffer.from('tampered quarantine'));
  }, ({ sourcePath, quarantinePath, evidence }) => {
    assert.equal(fs.existsSync(sourcePath), false);
    assert.equal(fs.existsSync(quarantinePath), true);
    assert.notDeepEqual(global.materializationEvidence(quarantinePath), evidence);
  });
});

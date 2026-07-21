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

const owner = 'c13-clear-client';
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

function executionContext(clientId, expectedVersion, requestId = crypto.randomUUID()) {
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

async function clearGateway(options = {}) {
  const coordinator = await databaseService.getDatabaseCoordinator();
  const questions = await databaseService.getQuestionsApplication();
  const readOnlyDatabase = await databaseService.getReadOnlyDatabase();
  const paths = managedPaths();
  let replacements = 0;
  let livePublications = 0;
  let composition;
  const globalApplication = global.registerGlobalApplication({
    coordinator,
    readOnlyDatabase,
    getJobs: () => composition.jobs,
    currentVersion: () => coordinator.currentVersion(),
    cursorSecret: Buffer.alloc(32, 7),
    now: () => fixedNow,
    managedPaths: paths,
    databaseClear: Object.freeze({
      resolve: (deleteManagedImages) => databaseService.resolveDatabaseClearInventory(deleteManagedImages),
      replace: async (input) => {
        replacements += 1;
        return databaseService.replaceManagedDatabaseClear({
          ...input,
          ...(options.recoveryHook ? { recoveryHook: options.recoveryHook } : {}),
          ...(options.journalHook ? { journal: { hook: options.journalHook } } : {}),
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
  const appInstanceId = options.appInstanceId ?? 'c13-clear-gateway';
  const verifier = { verify(raw) { return { credentialFingerprint: authentication.fingerprintCredential(raw.credential), sessionFingerprint: authentication.fingerprintCredential(raw.session) }; } };
  composition = await bootstrap.bootstrapAgentGateway({
    coordinator,
    commandBus: questions.gateway.commandBus,
    queryBus: questions.gateway.queryBus,
    selectedCandidateEvidence: true,
    appInstanceId,
    credentialVerifier: verifier,
    cursorSecret: 'c'.repeat(32),
    jobResultRoot: environment.resultRoot,
    now: () => fixedNow,
    globalApplication,
    resolveState: (envelope, descriptor) => questions.gateway.resolveState(envelope, descriptor),
    executeBusinessCommand: (command, context, dispatch) => questions.gateway.execute(command, context, dispatch)
  });
  const registry = await bootstrap.bootstrapAgentB3({ coordinator, appInstanceId, credentialVerifier: verifier, cursorSecret: 'c'.repeat(32), now: () => fixedNow });
  return { coordinator, composition, globalApplication, registry, managedPaths: paths, verifier, appInstanceId, replacements: () => replacements, livePublications: () => livePublications };
}

async function registerClient(runtime, label = crypto.randomUUID()) {
  const credential = `clear-${label}-credential`;
  const session = `clear-${label}-session`;
  const credentialFingerprint = authentication.fingerprintCredential(credential);
  const sessionFingerprint = authentication.fingerprintCredential(session);
  await runtime.registry.registry.registerClient({
    clientId: owner, subjectId: owner, displayName: owner, credentialFingerprint,
    scopes: ['database.clear', 'changesets.manage'], trust: 'full_control'
  });
  await runtime.registry.registry.setExternalControlEnabled(true);
  await runtime.registry.registry.createSession(owner, credentialFingerprint, sessionFingerprint, '2026-07-20T01:00:00.000Z');
  return { credential, session, principal: await runtime.composition.authenticator.authenticate({ credential, session }) };
}

async function seedQuestion(label, withImage = false) {
  let source;
  if (withImage) {
    source = path.join(environment.getControlPlanePaths().testRoot, `${label.replace(/[^A-Za-z0-9_-]/g, '-')}.png`);
    fs.writeFileSync(source, Buffer.from(`managed-image-${label}`));
  }
  const question = await databaseService.createQuestion({
    title: label, content: `${label} content`, wrong_thinking: '', wrong_solution: '', correct_solution: '', answer: '',
    subject: '高等数学', category: '函数', question_type: '解答题', error_reason: '', source: 'c13-clear-test',
    difficulty: '中等', mastery_level: '较弱', note: '', tags: ['c13-clear'],
    questionImageSources: source ? [source] : [], solutionImageSources: []
  });
  const managedImage = question.question_images[0]
    ? path.normalize(path.join(pathService.getPaths().root, question.question_images[0].file_path.replaceAll('/', path.sep)))
    : undefined;
  return { question, source, managedImage };
}

async function approveClear(runtime, deleteManagedImages, label = crypto.randomUUID()) {
  const registered = await registerClient(runtime, label);
  const baseVersion = runtime.coordinator.currentVersion();
  const payload = Object.freeze({ deleteManagedImages });
  const planned = gatewayCommand('database.clear_all', payload, baseVersion);
  const state = runtime.globalApplication.resolveState(planned, agent.resolveOperationDescriptor('database.clear_all'), registered.principal);
  assert.equal(state.affectedEntityCount, state.affectedEntities.length);
  const granted = await runtime.composition.gateway.execute(managementCommand('agent.r4_grants.create', {
    grant: { clientId: owner, operation: 'database.clear_all', payloadHash: agent.hashCanonicalJson(payload), targetHash: state.targetHash, maxAffectedEntities: 500, expiresAt: '2026-07-20T00:10:00.000Z' }
  }), runtime.composition.renderer.principal());
  assert.equal(granted.kind, 'completed', JSON.stringify(granted));
  const grantId = granted.result.value.grantId;
  const changeSetId = crypto.randomUUID();
  const store = await workflowStore();
  await store.createChangeSet(Object.freeze({
    apiVersion: 1, changeSetId, clientId: owner, status: 'draft', catalog: agent.operationCatalogIdentity, baseVersion, risk: 'R4',
    summary: `Clear ${state.affectedEntityCount} bounded entities`,
    operations: Object.freeze([Object.freeze({ operation: 'database.clear_all', payload, payloadHash: agent.hashCanonicalJson(payload), affectedEntities: state.affectedEntities })]),
    affectedSetHash: state.affectedSetHash, recovery: 'consistency_bundle', createdAt: fixedNow, expiresAt: '2026-07-20T00:30:00.000Z'
  }));
  await store.transitionChangeSet(changeSetId, 'approved');
  const request = gatewayCommand('agent.changesets.apply', { changeSetId }, undefined, crypto.randomUUID(), { kind: 'r4-grant', id: grantId });
  return { ...registered, baseVersion, payload, state, grantId, changeSetId, request };
}

async function restart(runtime, dependencies = {}) {
  await databaseService.resetDatabaseConnectionAsync();
  return databaseService.initializeDatabase({
    now: () => fixedNow,
    ...dependencies,
    agent: { appInstanceId: runtime.appInstanceId, credentialVerifier: runtime.verifier, cursorSecret: 'c'.repeat(32), jobResultRoot: environment.resultRoot }
  });
}

async function replayPrincipal(runtime, approved, suffix) {
  const gateway = await databaseService.getAgentControlPlane();
  const registry = await bootstrap.bootstrapAgentB3({ coordinator: await databaseService.getDatabaseCoordinator(), appInstanceId: runtime.appInstanceId, credentialVerifier: runtime.verifier, cursorSecret: 'c'.repeat(32), now: () => fixedNow });
  const session = `clear-replay-${suffix}`;
  await registry.registry.createSession(owner, authentication.fingerprintCredential(approved.credential), authentication.fingerprintCredential(session), '2026-07-20T01:00:00.000Z');
  return { gateway, principal: await gateway.authenticator.authenticate({ credential: approved.credential, session }) };
}

async function mutateLiveDatabaseFile(mutator) {
  const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
  const databasePath = pathService.getPaths().database;
  const database = new SQL.Database(fs.readFileSync(databasePath));
  try { mutator(database); fs.writeFileSync(databasePath, Buffer.from(database.export())); } finally { database.close(); }
}

function operationId(requestId) {
  return `database-clear-${crypto.createHash('sha256').update(requestId).digest('hex').slice(0, 40)}`;
}

function assertRedacted(result, runtime) {
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /recovery|quarantine|internalPath|filePath|before\.db|managed-files/i);
  for (const forbidden of [...Object.values(runtime.managedPaths), path.join(environment.userDataRoot, 'agent-recovery')]) {
    assert.equal(serialized.includes(forbidden), false, `Clear result leaked ${forbidden}`);
  }
}

test('database.clear_all direct GlobalApplication execution and catalog overflow have zero effects', async () => {
  const runtime = await clearGateway();
  const seeded = await seedQuestion('direct clear sentinel', true);
  const beforeVersion = runtime.coordinator.currentVersion();
  const beforeDatabase = crypto.createHash('sha256').update(fs.readFileSync(pathService.getPaths().database)).digest('hex');
  await assert.rejects(runtime.globalApplication.execute(
    { type: 'database.clear_all', payload: { deleteManagedImages: true } },
    executionContext(owner, beforeVersion), undefined,
    { clientId: owner, subjectId: owner, displayName: owner, scopes: ['database.clear'], trust: 'full_control' }
  ), (error) => error.code === 'SCOPE_DENIED');
  assert.deepEqual(runtime.coordinator.currentVersion(), beforeVersion);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(pathService.getPaths().database)).digest('hex'), beforeDatabase);
  assert.equal(fs.existsSync(seeded.managedImage), true);
  assert.equal(runtime.replacements(), 0);

  const database = await databaseService.getDatabase();
  const statement = database.prepare(`INSERT INTO questions (title,content,category,question_type,error_reason,source,difficulty,mastery_level,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  try {
    for (let index = 0; index < 500; index += 1) statement.run([`overflow-${index}`, '', '函数', '解答题', '', 'test', '中等', '一般', fixedNow, fixedNow]);
  } finally { statement.free(); }
  assert.throws(() => databaseService.resolveDatabaseClearInventory(false), (error) => error.code === 'POLICY_DENIED');
  assert.equal(runtime.replacements(), 0);
});

test('database.clear_all preserves managed images and control state when deletion is false, then replays exactly once after later writes', async () => {
  const runtime = await clearGateway({ appInstanceId: 'c13-clear-preserve-replay' });
  const seeded = await seedQuestion('preserved clear image', true);
  const approved = await approveClear(runtime, false, 'preserve');
  const first = await runtime.composition.gateway.execute(approved.request, approved.principal);
  assert.equal(first.kind, 'completed', JSON.stringify(first));
  assert.deepEqual(first.result.value, { cleared: true, deleteManagedImages: false, businessRowCount: approved.state.affectedEntityCount - approved.state.affectedEntities.filter((entry) => entry.entityType === 'managed_image').length, managedImageCount: 1 });
  assertRedacted(first.result, runtime);
  assert.equal(fs.existsSync(seeded.managedImage), true);
  const database = await databaseService.getDatabase();
  for (const table of databaseService.databaseClearTableAllowlist) assert.equal(database.exec(`SELECT COUNT(*) FROM "${table}"`)[0].values[0][0], 0, table);
  assert.deepEqual(database.exec('SELECT revoked_at FROM agent_clients WHERE client_id=?', [owner])[0].values, [[null]]);
  assert.deepEqual(database.exec('SELECT status FROM agent_r4_grants WHERE grant_id=?', [approved.grantId])[0].values, [['consumed']]);
  assert.deepEqual(database.exec('SELECT status FROM agent_changesets WHERE change_set_id=?', [approved.changeSetId])[0].values, [['applied']]);
  assert.deepEqual(database.exec('SELECT status FROM agent_database_clear_journals WHERE request_id=?', [approved.request.requestId])[0].values, [['completed']]);
  assert.equal(database.exec("SELECT COUNT(*) FROM agent_audit_events WHERE kind='success' AND client_id=? AND request_id=? AND operation='agent.changesets.apply'", [owner, approved.request.requestId])[0].values[0][0], 1);

  await restart(runtime);
  let replayRuntime = await replayPrincipal(runtime, approved, 'preserve-1');
  const replay = await replayRuntime.gateway.gateway.execute(approved.request, replayRuntime.principal);
  assert.equal(replay.kind, 'replayed', JSON.stringify(replay));
  assert.deepEqual(replay.result, first.result);
  assert.equal(runtime.replacements(), 1);
  await seedQuestion('normal write after clear');
  await restart(runtime);
  replayRuntime = await replayPrincipal(runtime, approved, 'preserve-2');
  const advancedReplay = await replayRuntime.gateway.gateway.execute(approved.request, replayRuntime.principal);
  assert.equal(advancedReplay.kind, 'replayed', JSON.stringify(advancedReplay));
  assert.deepEqual((await databaseService.listQuestions()).map((entry) => entry.title), ['normal write after clear']);
  assert.equal(runtime.replacements(), 1);
});

test('database.clear_all quarantines only bound App-owned images when deletion is true and never moves twice', async () => {
  const runtime = await clearGateway({ appInstanceId: 'c13-clear-quarantine' });
  const seeded = await seedQuestion('quarantined clear image', true);
  const unrelated = path.join(pathService.getPaths().images, 'unrelated-user-file.png');
  fs.mkdirSync(path.dirname(unrelated), { recursive: true });
  fs.writeFileSync(unrelated, Buffer.from('unrelated-file'));
  const approved = await approveClear(runtime, true, 'quarantine');
  const first = await runtime.composition.gateway.execute(approved.request, approved.principal);
  assert.equal(first.kind, 'completed', JSON.stringify(first));
  assert.equal(fs.existsSync(seeded.managedImage), false);
  assert.equal(fs.existsSync(unrelated), true);
  const quarantineRoot = path.join(pathService.getPaths().temp, 'a11-quarantine');
  const matching = fs.readdirSync(quarantineRoot).filter((name) => name.startsWith(operationId(approved.request.requestId)));
  assert.equal(matching.length, 1);
  const quarantinePath = path.join(quarantineRoot, matching[0]);
  assert.equal(fs.readFileSync(quarantinePath, 'utf8'), 'managed-image-quarantined clear image');
  await restart(runtime);
  const replayRuntime = await replayPrincipal(runtime, approved, 'quarantine');
  const replay = await replayRuntime.gateway.gateway.execute(approved.request, replayRuntime.principal);
  assert.equal(replay.kind, 'replayed');
  assert.equal(fs.readdirSync(quarantineRoot).filter((name) => name.startsWith(operationId(approved.request.requestId))).length, 1);
  assert.equal(runtime.replacements(), 1);
});

test('database.clear_all repeats exact bindings and rejects changed rows or files before replacement', async () => {
  const runtime = await clearGateway();
  const seeded = await seedQuestion('binding clear image', true);
  const approved = await approveClear(runtime, true, 'binding');
  await seedQuestion('changed after approval');
  const changedRows = await runtime.composition.gateway.execute(approved.request, approved.principal);
  assert.equal(changedRows.kind, 'rejected');
  assert.equal(runtime.replacements(), 0);
  assert.equal(fs.existsSync(seeded.managedImage), true);

  await resetControlPlaneEnvironment();
  const fileRuntime = await clearGateway();
  const fileSeed = await seedQuestion('file binding clear image', true);
  const fileApproved = await approveClear(fileRuntime, true, 'file-binding');
  fs.appendFileSync(fileSeed.managedImage, '-tampered');
  const changedFile = await fileRuntime.composition.gateway.execute(fileApproved.request, fileApproved.principal);
  assert.equal(changedFile.kind, 'rejected');
  assert.equal(fileRuntime.replacements(), 0);
  assert.deepEqual((await databaseService.listQuestions()).map((entry) => entry.title), ['file binding clear image']);
});

test('database.clear_all crash matrix fences pre-live ambiguity and reconstructs post-live terminal state', async () => {
  for (const boundary of ['inventory_validated', 'recovery_package_staged', 'files_quarantined']) {
    await resetControlPlaneEnvironment();
    const runtime = await clearGateway({ appInstanceId: `c13-clear-${boundary}`, stageHook(stage) { if (stage === boundary) throw new agent.AgentError('RECOVERY_FENCE'); } });
    await seedQuestion(`clear ${boundary}`, true);
    const approved = await approveClear(runtime, true, boundary);
    const failed = await runtime.composition.gateway.execute(approved.request, approved.principal);
    assert.equal(failed.kind, 'rejected', boundary);
    assert.equal(runtime.livePublications(), 0, boundary);
    await assert.rejects(restart(runtime), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)), boundary);
  }

  for (const atomicStage of ['afterPreviousPublish', 'afterLivePublish']) {
    await resetControlPlaneEnvironment();
    const runtime = await clearGateway({ appInstanceId: `c13-clear-${atomicStage}`, atomicHook(context) { if (context.stage === atomicStage) throw new agent.AgentError('RECOVERY_FENCE'); } });
    await seedQuestion(`clear ${atomicStage}`, true);
    const approved = await approveClear(runtime, true, atomicStage);
    const failed = await runtime.composition.gateway.execute(approved.request, approved.principal);
    assert.equal(failed.kind, 'rejected', atomicStage);
    await assert.rejects(restart(runtime), (error) => error.code === 'RECOVERY_FENCE' || /candidate_set_unsafe|RECOVERY_FENCE/.test(String(error?.message ?? error)), atomicStage);
  }

  for (const boundary of ['database_published', 'cleanup_reconciled']) {
    await resetControlPlaneEnvironment();
    const runtime = await clearGateway({ appInstanceId: `c13-clear-post-${boundary}`, stageHook(stage) { if (stage === boundary) throw new agent.AgentError('RECOVERY_FENCE'); } });
    await seedQuestion(`clear post ${boundary}`, true);
    const approved = await approveClear(runtime, true, boundary);
    const failed = await runtime.composition.gateway.execute(approved.request, approved.principal);
    assert.equal(failed.kind, 'rejected', boundary);
    await restart(runtime);
    assert.deepEqual(await databaseService.listQuestions(), [], boundary);
    assert.deepEqual((await databaseService.getDatabase()).exec('SELECT status FROM agent_idempotency WHERE request_id=?', [approved.request.requestId])[0].values, [['completed']], boundary);
    assert.equal(runtime.replacements(), 1, boundary);
  }

  await resetControlPlaneEnvironment();
  let terminalFaulted = false;
  const runtime = await clearGateway({
    appInstanceId: 'c13-clear-terminal-boundary',
    recoveryHook(stage) { if (stage === 'after_terminalization' && !terminalFaulted) { terminalFaulted = true; throw new agent.AgentError('RECOVERY_FENCE'); } }
  });
  await seedQuestion('clear terminal boundary', false);
  const approved = await approveClear(runtime, false, 'terminal-boundary');
  const failed = await runtime.composition.gateway.execute(approved.request, approved.principal);
  assert.equal(failed.kind, 'rejected');
  await restart(runtime);
  assert.deepEqual((await databaseService.getDatabase()).exec('SELECT status FROM agent_idempotency WHERE request_id=?', [approved.request.requestId])[0].values, [['completed']]);
});

test('database clear restart fences private journal, recovery package, terminal journal, live semantics, file evidence, and ambiguous file states', async () => {
  async function completed(label, deleteManagedImages = true) {
    const runtime = await clearGateway({ appInstanceId: `c13-clear-tamper-${label}` });
    const seeded = await seedQuestion(`clear tamper ${label}`, true);
    const approved = await approveClear(runtime, deleteManagedImages, label);
    const result = await runtime.composition.gateway.execute(approved.request, approved.principal);
    assert.equal(result.kind, 'completed', label);
    const id = operationId(approved.request.requestId);
    const journalPath = path.join(runtime.managedPaths.journal, 'database-clears', `${id}.database-clear.json`);
    const manifest = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    const quarantinePath = path.join(pathService.getPaths().temp, 'a11-quarantine', `${id}-0.quarantine`);
    return { runtime, seeded, approved, id, journalPath, manifest, quarantinePath };
  }

  let current = await completed('private');
  fs.writeFileSync(current.journalPath, '{"schemaVersion":1,"phase":"completed"}\n');
  await assert.rejects(restart(current.runtime), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)));

  await resetControlPlaneEnvironment();
  current = await completed('recovery-database');
  fs.appendFileSync(current.manifest.recoveryDatabasePath, 'tamper');
  await assert.rejects(restart(current.runtime), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)));

  await resetControlPlaneEnvironment();
  current = await completed('recovery-inventory');
  fs.appendFileSync(current.manifest.recoveryInventoryPath, 'tamper');
  await assert.rejects(restart(current.runtime), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)));

  await resetControlPlaneEnvironment();
  current = await completed('terminal-journal');
  await mutateLiveDatabaseFile((database) => database.run('UPDATE agent_database_clear_journals SET live_semantic_hash=? WHERE operation_id=?', [`sha256-v1:${'1'.repeat(64)}`, current.id]));
  await assert.rejects(restart(current.runtime), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)));

  await resetControlPlaneEnvironment();
  current = await completed('live-semantic', false);
  await mutateLiveDatabaseFile((database) => database.run(`INSERT INTO questions (title,content,category,question_type,error_reason,source,difficulty,mastery_level,created_at,updated_at) VALUES ('tampered','','函数','解答题','','test','中等','一般',?,?)`, [fixedNow, fixedNow]));
  await assert.rejects(restart(current.runtime), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)));

  await resetControlPlaneEnvironment();
  current = await completed('file-evidence');
  fs.appendFileSync(current.quarantinePath, 'tamper');
  await assert.rejects(restart(current.runtime), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)));

  await resetControlPlaneEnvironment();
  current = await completed('both-state');
  fs.mkdirSync(path.dirname(current.seeded.managedImage), { recursive: true });
  fs.copyFileSync(current.quarantinePath, current.seeded.managedImage);
  await assert.rejects(restart(current.runtime), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)));

  await resetControlPlaneEnvironment();
  current = await completed('neither-state');
  fs.unlinkSync(current.quarantinePath);
  await assert.rejects(restart(current.runtime), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)));
});

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

const owner = 'c13-import-batch-owner';
const fixedNow = '2026-07-21T00:00:00.000Z';

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

async function importBatchGateway(options = {}) {
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
    cursorSecret: Buffer.alloc(32, 17),
    now: () => fixedNow,
    managedPaths: paths,
    importBatchDelete: Object.freeze({
      resolve: (batchId, deleteManagedAssets, identity) => databaseService.resolveImportBatchDeletionInventory(batchId, deleteManagedAssets, identity),
      replace: async (input) => {
        replacements += 1;
        return databaseService.replaceManagedImportBatchDeletion({
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
  const appInstanceId = options.appInstanceId ?? 'c13-import-batch-gateway';
  const verifier = { verify(raw) { return { credentialFingerprint: authentication.fingerprintCredential(raw.credential), sessionFingerprint: authentication.fingerprintCredential(raw.session) }; } };
  composition = await bootstrap.bootstrapAgentGateway({
    coordinator,
    commandBus: questions.gateway.commandBus,
    queryBus: questions.gateway.queryBus,
    selectedCandidateEvidence: true,
    appInstanceId,
    credentialVerifier: verifier,
    cursorSecret: 'b'.repeat(32),
    jobResultRoot: environment.resultRoot,
    now: () => fixedNow,
    globalApplication,
    resolveState: (envelope, descriptor) => questions.gateway.resolveState(envelope, descriptor),
    executeBusinessCommand: (command, context, dispatch) => questions.gateway.execute(command, context, dispatch)
  });
  const registry = await bootstrap.bootstrapAgentB3({ coordinator, appInstanceId, credentialVerifier: verifier, cursorSecret: 'b'.repeat(32), now: () => fixedNow });
  return { coordinator, composition, globalApplication, registry, managedPaths: paths, verifier, appInstanceId, replacements: () => replacements, livePublications: () => livePublications };
}

async function registerClient(runtime, clientId = owner, label = crypto.randomUUID()) {
  const credential = `batch-${label}-credential`;
  const session = `batch-${label}-session`;
  const credentialFingerprint = authentication.fingerprintCredential(credential);
  const sessionFingerprint = authentication.fingerprintCredential(session);
  await runtime.registry.registry.registerClient({
    clientId, subjectId: clientId, displayName: clientId, credentialFingerprint,
    scopes: ['imports.delete', 'changesets.manage'], trust: 'full_control'
  });
  await runtime.registry.registry.setExternalControlEnabled(true);
  await runtime.registry.registry.createSession(clientId, credentialFingerprint, sessionFingerprint, '2026-07-21T01:00:00.000Z');
  return { credential, session, principal: await runtime.composition.authenticator.authenticate({ credential, session }) };
}

async function seedBatch(label, ownerClientId = owner, withImage = true) {
  let source;
  if (withImage) {
    source = path.join(environment.getControlPlanePaths().testRoot, `${label.replace(/[^A-Za-z0-9_-]/g, '-')}.png`);
    fs.writeFileSync(source, Buffer.from(`batch-image-${label}`));
  }
  const question = await databaseService.createQuestion({
    title: label, content: `${label} content`, wrong_thinking: '', wrong_solution: '', correct_solution: '', answer: '',
    subject: '高等数学', category: '函数', question_type: '解答题', error_reason: '', source: 'c13-import-batch-test',
    difficulty: '中等', mastery_level: '较弱', note: '', tags: ['c13-import-batch'],
    questionImageSources: source ? [source] : [], solutionImageSources: []
  });
  const batchId = `wrong_questions-${crypto.randomUUID().toLowerCase()}`;
  const managedImage = question.question_images[0]
    ? path.normalize(path.join(pathService.getPaths().root, question.question_images[0].file_path.replaceAll('/', path.sep)))
    : undefined;
  const coordinator = await databaseService.getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: crypto.randomUUID(), concurrency: 'none',
    execute(database) {
      database.run(`INSERT INTO import_batches (id,owner_client_id,type,name,source_file_name,source,imported_at,item_count,asset_count,status,metadata_json,deleted_at)
        VALUES (?,?,'wrong_questions',?,'','test',?,1,?,'active','',NULL)`, [batchId, ownerClientId, label, fixedNow, managedImage ? 1 : 0]);
      database.run('UPDATE questions SET import_batch_id=? WHERE id=?', [batchId, question.id]);
      database.run("INSERT INTO import_batch_items (batch_id,target_table,target_id,action,created_at) VALUES (?,'questions',?,'created',?)", [batchId, String(question.id), fixedNow]);
      if (managedImage) database.run("INSERT INTO import_assets (batch_id,asset_type,file_path,created_at,deleted_at) VALUES (?,'question_image',?,?,NULL)", [batchId, managedImage, fixedNow]);
      return { changed: true, value: undefined };
    }
  });
  return { batchId, question, managedImage, source };
}

async function seedQuestionBankBatch(label) {
  const batchId = `question_bank-${crypto.randomUUID().toLowerCase()}`;
  const batchRoot = path.join(pathService.getPaths().root, 'assets', 'question_bank', batchId);
  const assetPath = path.join(batchRoot, 'images', 'asset.png');
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  fs.writeFileSync(assetPath, Buffer.from(`question-bank-${label}`));
  let externalQuestionId;
  const coordinator = await databaseService.getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: crypto.randomUUID(), concurrency: 'none',
    execute(database) {
      database.run(`INSERT INTO import_batches (id,owner_client_id,type,name,source_file_name,source,imported_at,item_count,asset_count,status,metadata_json,deleted_at)
        VALUES (?,?,'question_bank',?,'bank.zip','test',?,1,1,'active','',NULL)`, [batchId, owner, label, fixedNow]);
      database.run(`INSERT INTO external_questions (title,content,import_batch_id,asset_base_path,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
        [label, '![asset](assets/images/asset.png)', batchId, batchRoot, fixedNow, fixedNow]);
      externalQuestionId = database.exec('SELECT last_insert_rowid()')[0].values[0][0];
      database.run("INSERT INTO external_question_attempts (external_question_id,result,attempted_at,note,added_to_mistakes,created_question_id) VALUES (?,'wrong',?,'',0,NULL)", [externalQuestionId, fixedNow]);
      database.run("INSERT INTO import_batch_items (batch_id,target_table,target_id,action,created_at) VALUES (?,'external_questions',?,'created',?)", [batchId, String(externalQuestionId), fixedNow]);
      database.run("INSERT INTO import_assets (batch_id,asset_type,file_path,created_at,deleted_at) VALUES (?,'question_bank_image',?,?,NULL)", [batchId, assetPath, fixedNow]);
      return { changed: true, value: undefined };
    }
  });
  return { batchId, externalQuestionId, assetPath };
}

async function seedKnowledgeBatch(label) {
  const batchId = `knowledge_map-${crypto.randomUUID().toLowerCase()}`;
  const assetPath = path.join(pathService.getPaths().textbooks, `${label.replace(/[^A-Za-z0-9_-]/g, '-')}.pdf`);
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  fs.writeFileSync(assetPath, Buffer.from(`textbook-${label}`));
  const nodeId = `node-${crypto.randomUUID().toLowerCase()}`;
  let textbookId;
  const coordinator = await databaseService.getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: crypto.randomUUID(), concurrency: 'none',
    execute(database) {
      database.run(`INSERT INTO import_batches (id,owner_client_id,type,name,source_file_name,source,imported_at,item_count,asset_count,status,metadata_json,deleted_at)
        VALUES (?,?,'knowledge_map',?,'map.zip','test',?,2,1,'active','',NULL)`, [batchId, owner, label, fixedNow]);
      database.run("INSERT INTO textbooks (title,subject,edition,file_name,file_path,note,created_at,updated_at) VALUES (?,'高等数学','',?,?,'',?,?)",
        [label, path.basename(assetPath), assetPath, fixedNow, fixedNow]);
      textbookId = database.exec('SELECT last_insert_rowid()')[0].values[0][0];
      database.run(`INSERT INTO knowledge_points (textbook_id,node_id,title,import_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
        [textbookId, nodeId, label, batchId, fixedNow, fixedNow]);
      database.run("INSERT INTO import_batch_items (batch_id,target_table,target_id,action,created_at) VALUES (?,'textbooks',?,'created',?)", [batchId, String(textbookId), fixedNow]);
      database.run("INSERT INTO import_batch_items (batch_id,target_table,target_id,action,created_at) VALUES (?,'knowledge_points',?,'created',?)", [batchId, nodeId, fixedNow]);
      database.run("INSERT INTO import_assets (batch_id,asset_type,file_path,created_at,deleted_at) VALUES (?,'textbook_pdf',?,?,NULL)", [batchId, assetPath, fixedNow]);
      return { changed: true, value: undefined };
    }
  });
  return { batchId, nodeId, textbookId, assetPath };
}

async function seedPreservedOnlyBatch(label, itemCount) {
  const batchId = `wrong_questions-${crypto.randomUUID().toLowerCase()}`;
  const coordinator = await databaseService.getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: crypto.randomUUID(), concurrency: 'none',
    execute(database) {
      database.run(`INSERT INTO import_batches (id,owner_client_id,type,name,source_file_name,source,imported_at,item_count,asset_count,status,metadata_json,deleted_at)
        VALUES (?,?,'wrong_questions',?,'','test',?,?,0,'active','',NULL)`, [batchId, owner, label, fixedNow, itemCount]);
      const statement = database.prepare("INSERT INTO import_batch_items (batch_id,target_table,target_id,action,created_at) VALUES (?,'questions',?,'created',?)");
      try {
        for (let index = 0; index < itemCount; index += 1) statement.run([batchId, `missing-${index}`, fixedNow]);
      } finally { statement.free(); }
      return { changed: true, value: undefined };
    }
  });
  return { batchId };
}

async function approveDelete(runtime, seeded, deleteManagedAssets, label = crypto.randomUUID()) {
  const registered = await registerClient(runtime, owner, label);
  const baseVersion = runtime.coordinator.currentVersion();
  const payload = Object.freeze({ batchId: seeded.batchId, deleteManagedAssets });
  const planned = gatewayCommand('imports.delete_batch', payload, baseVersion);
  const state = runtime.globalApplication.resolveState(planned, agent.resolveOperationDescriptor('imports.delete_batch'), registered.principal);
  const granted = await runtime.composition.gateway.execute(managementCommand('agent.r4_grants.create', {
    grant: { clientId: owner, operation: 'imports.delete_batch', payloadHash: agent.hashCanonicalJson(payload), targetHash: state.targetHash, maxAffectedEntities: 500, expiresAt: '2026-07-21T00:10:00.000Z' }
  }), runtime.composition.renderer.principal());
  assert.equal(granted.kind, 'completed', JSON.stringify(granted));
  const grantId = granted.result.value.grantId;
  const changeSetId = crypto.randomUUID();
  const store = await workflowStore();
  await store.createChangeSet(Object.freeze({
    apiVersion: 1, changeSetId, clientId: owner, status: 'draft', catalog: agent.operationCatalogIdentity, baseVersion, risk: 'R4',
    summary: `Delete import batch ${seeded.batchId}`,
    operations: Object.freeze([Object.freeze({ operation: 'imports.delete_batch', payload, payloadHash: agent.hashCanonicalJson(payload), affectedEntities: state.affectedEntities })]),
    affectedSetHash: state.affectedSetHash, recovery: 'consistency_bundle', createdAt: fixedNow, expiresAt: '2026-07-21T00:30:00.000Z'
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
    agent: { appInstanceId: runtime.appInstanceId, credentialVerifier: runtime.verifier, cursorSecret: 'b'.repeat(32), jobResultRoot: environment.resultRoot }
  });
}

async function replayPrincipal(runtime, approved, suffix) {
  const gateway = await databaseService.getAgentControlPlane();
  const registry = await bootstrap.bootstrapAgentB3({ coordinator: await databaseService.getDatabaseCoordinator(), appInstanceId: runtime.appInstanceId, credentialVerifier: runtime.verifier, cursorSecret: 'b'.repeat(32), now: () => fixedNow });
  const session = `batch-replay-${suffix}`;
  await registry.registry.createSession(owner, authentication.fingerprintCredential(approved.credential), authentication.fingerprintCredential(session), '2026-07-21T01:00:00.000Z');
  return { gateway, principal: await gateway.authenticator.authenticate({ credential: approved.credential, session }) };
}

function operationId(batchId, requestId) {
  return `import-batch-delete-${crypto.createHash('sha256').update(`${batchId}\0${requestId}`).digest('hex').slice(0, 40)}`;
}

async function mutateLiveDatabaseFile(mutator) {
  const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
  const databasePath = pathService.getPaths().database;
  const database = new SQL.Database(fs.readFileSync(databasePath));
  try { mutator(database); fs.writeFileSync(databasePath, Buffer.from(database.export())); } finally { database.close(); }
}

function assertPathFree(result, runtime) {
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /recoveryPath|quarantinePath|internalPath|filePath|before\.db|managed-files/i);
  for (const forbidden of [...Object.values(runtime.managedPaths), path.join(environment.userDataRoot, 'agent-recovery')]) {
    assert.equal(serialized.includes(forbidden), false, `Result leaked ${forbidden}`);
  }
}

test('imports.delete_batch requires terminal admission and enforces owner plus conservative legacy visibility', async () => {
  const runtime = await importBatchGateway();
  const seeded = await seedBatch('direct admission sentinel');
  const before = runtime.coordinator.currentVersion();
  await assert.rejects(runtime.globalApplication.execute(
    { type: 'imports.delete_batch', payload: { batchId: seeded.batchId, deleteManagedAssets: true } },
    executionContext(owner, before), undefined,
    { clientId: owner, subjectId: owner, displayName: owner, scopes: ['imports.delete'], trust: 'full_control' }
  ), (error) => error.code === 'SCOPE_DENIED');
  assert.deepEqual(runtime.coordinator.currentVersion(), before);
  assert.equal(fs.existsSync(seeded.managedImage), true);
  assert.equal((await databaseService.getDatabase()).exec('SELECT status FROM import_batches WHERE id=?', [seeded.batchId])[0].values[0][0], 'active');

  const other = await registerClient(runtime, 'c13-other-owner', 'other-owner');
  const planned = gatewayCommand('imports.delete_batch', { batchId: seeded.batchId, deleteManagedAssets: false }, before);
  assert.throws(() => runtime.globalApplication.resolveState(planned, agent.resolveOperationDescriptor('imports.delete_batch'), other.principal), (error) => error.code === 'HANDLER_NOT_FOUND');

  const legacy = await seedBatch('legacy local batch', null, false);
  assert.throws(() => runtime.globalApplication.resolveState(
    gatewayCommand('imports.delete_batch', { batchId: legacy.batchId, deleteManagedAssets: false }, runtime.coordinator.currentVersion()),
    agent.resolveOperationDescriptor('imports.delete_batch'), other.principal
  ), (error) => error.code === 'HANDLER_NOT_FOUND');
  const localState = runtime.globalApplication.resolveState(
    gatewayCommand('imports.delete_batch', { batchId: legacy.batchId, deleteManagedAssets: false }, runtime.coordinator.currentVersion()),
    agent.resolveOperationDescriptor('imports.delete_batch'), runtime.composition.renderer.principal()
  );
  assert.ok(localState.affectedEntityCount > 0);
});

test('imports.delete_batch preserves files when false, mutates once, replays exactly, and remains writable', async () => {
  const runtime = await importBatchGateway({ appInstanceId: 'c13-import-batch-preserve' });
  const seeded = await seedBatch('preserved import batch');
  const approved = await approveDelete(runtime, seeded, false, 'preserve');
  const first = await runtime.composition.gateway.execute(approved.request, approved.principal);
  assert.equal(first.kind, 'completed', JSON.stringify(first));
  assert.deepEqual(first.result.value, {
    batchId: seeded.batchId, status: 'deleted', deleteManagedAssets: false, deletedQuestions: 1,
    deletedExternalQuestions: 0, deletedAttempts: 0, softDeletedKnowledgePoints: 0, quarantinedManagedAssets: 0
  });
  assertPathFree(first.result, runtime);
  assert.equal(fs.existsSync(seeded.managedImage), true);
  const database = await databaseService.getDatabase();
  assert.equal(database.exec('SELECT COUNT(*) FROM questions WHERE id=?', [seeded.question.id])[0].values[0][0], 0);
  assert.deepEqual(database.exec('SELECT status FROM import_batches WHERE id=?', [seeded.batchId])[0].values, [['deleted']]);
  assert.deepEqual(database.exec('SELECT status FROM agent_r4_grants WHERE grant_id=?', [approved.grantId])[0].values, [['consumed']]);
  assert.deepEqual(database.exec('SELECT status FROM agent_changesets WHERE change_set_id=?', [approved.changeSetId])[0].values, [['applied']]);
  assert.deepEqual(database.exec('SELECT status FROM agent_import_batch_deletion_journals WHERE request_id=?', [approved.request.requestId])[0].values, [['completed']]);
  assert.equal(runtime.replacements(), 1);

  await restart(runtime);
  let replayRuntime = await replayPrincipal(runtime, approved, 'preserve-1');
  const replay = await replayRuntime.gateway.gateway.execute(approved.request, replayRuntime.principal);
  assert.equal(replay.kind, 'replayed', JSON.stringify(replay));
  assert.deepEqual(replay.result, first.result);
  assert.equal(runtime.replacements(), 1);
  await databaseService.createQuestion({
    title: 'normal write after batch delete', content: '', wrong_thinking: '', wrong_solution: '', correct_solution: '', answer: '',
    subject: '高等数学', category: '函数', question_type: '解答题', error_reason: '', source: 'test', difficulty: '中等', mastery_level: '一般', note: '', tags: [],
    questionImageSources: [], solutionImageSources: []
  });
  await restart(runtime);
  replayRuntime = await replayPrincipal(runtime, approved, 'preserve-2');
  const advancedReplay = await replayRuntime.gateway.gateway.execute(approved.request, replayRuntime.principal);
  assert.equal(advancedReplay.kind, 'replayed');
  assert.deepEqual((await databaseService.listQuestions()).map((question) => question.title), ['normal write after batch delete']);
});

test('imports.delete_batch quarantines only the exact verified batch file and rejects binding changes', async () => {
  const runtime = await importBatchGateway({ appInstanceId: 'c13-import-batch-quarantine' });
  const seeded = await seedBatch('quarantined import batch');
  const unrelated = path.join(pathService.getPaths().images, 'unrelated-user-file.png');
  fs.writeFileSync(unrelated, Buffer.from('unrelated-file'));
  const inbox = path.join(pathService.getPaths().data, 'import-inbox', 'assets', 'unrelated-c11.png');
  fs.mkdirSync(path.dirname(inbox), { recursive: true });
  fs.writeFileSync(inbox, Buffer.from('unrelated-c11-file'));
  const approved = await approveDelete(runtime, seeded, true, 'quarantine');
  const first = await runtime.composition.gateway.execute(approved.request, approved.principal);
  assert.equal(first.kind, 'completed', JSON.stringify(first));
  assert.equal(first.result.value.quarantinedManagedAssets, 1);
  assert.equal(fs.existsSync(seeded.managedImage), false);
  assert.equal(fs.existsSync(unrelated), true);
  assert.equal(fs.existsSync(inbox), true);
  const id = operationId(seeded.batchId, approved.request.requestId);
  const quarantinePath = path.join(pathService.getPaths().temp, 'a11-quarantine', `${id}-0.quarantine`);
  assert.equal(fs.readFileSync(quarantinePath, 'utf8'), 'batch-image-quarantined import batch');
  await restart(runtime);
  assert.equal(fs.existsSync(quarantinePath), true);

  await resetControlPlaneEnvironment();
  const changedRuntime = await importBatchGateway();
  const changedSeed = await seedBatch('changed import batch');
  const changedApproval = await approveDelete(changedRuntime, changedSeed, true, 'changed');
  fs.appendFileSync(changedSeed.managedImage, '-tampered');
  const changed = await changedRuntime.composition.gateway.execute(changedApproval.request, changedApproval.principal);
  assert.equal(changed.kind, 'rejected');
  assert.equal(changedRuntime.replacements(), 0);
  assert.equal((await databaseService.getDatabase()).exec('SELECT status FROM import_batches WHERE id=?', [changedSeed.batchId])[0].values[0][0], 'active');
});

test('imports.delete_batch bounds preserved and oversized direct rows before admission or cascade SQL', async () => {
  let runtime = await importBatchGateway();
  const exact = await seedPreservedOnlyBatch('exact preserved inventory', 499);
  let registered = await registerClient(runtime, owner, 'preserved-exact');
  const exactEnvelope = gatewayCommand('imports.delete_batch', { batchId: exact.batchId, deleteManagedAssets: false }, runtime.coordinator.currentVersion());
  const exactState = runtime.globalApplication.resolveState(exactEnvelope, agent.resolveOperationDescriptor('imports.delete_batch'), registered.principal);
  assert.equal(exactState.affectedEntityCount, 500);
  assert.equal(exactState.affectedEntities.length, 500);

  await resetControlPlaneEnvironment();
  runtime = await importBatchGateway();
  const overflow = await seedPreservedOnlyBatch('overflow preserved inventory', 501);
  registered = await registerClient(runtime, owner, 'preserved-overflow');
  const rejected = await runtime.composition.gateway.execute(
    gatewayCommand('imports.delete_batch', { batchId: overflow.batchId, deleteManagedAssets: false }, runtime.coordinator.currentVersion()),
    registered.principal
  );
  assert.equal(rejected.kind, 'rejected');
  assert.equal(rejected.error.code, 'POLICY_DENIED');
  const database = await databaseService.getDatabase();
  assert.equal(database.exec('SELECT COUNT(*) FROM agent_idempotency')[0].values[0][0], 0);
  const journalRoot = path.join(runtime.managedPaths.journal, 'import-batch-deletions');
  assert.equal(fs.existsSync(journalRoot) ? fs.readdirSync(journalRoot).length : 0, 0);
  assert.deepEqual(database.exec('SELECT status FROM import_batches WHERE id=?', [overflow.batchId])[0].values, [['active']]);

  await resetControlPlaneEnvironment();
  runtime = await importBatchGateway();
  const directOverflow = await seedPreservedOnlyBatch('oversized direct inventory', 0);
  const coordinator = await databaseService.getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: crypto.randomUUID(), concurrency: 'none',
    execute(active) {
      const statement = active.prepare(`INSERT INTO questions (title,content,category,question_type,error_reason,source,difficulty,mastery_level,import_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      try {
        for (let index = 0; index < 1_200; index += 1) statement.run([`direct-overflow-${index}`, '', '函数', '解答题', '', 'test', '中等', '一般', directOverflow.batchId, fixedNow, fixedNow]);
      } finally { statement.free(); }
      return { changed: true, value: undefined };
    }
  });
  registered = await registerClient(runtime, owner, 'direct-overflow');
  const directRejected = await runtime.composition.gateway.execute(
    gatewayCommand('imports.delete_batch', { batchId: directOverflow.batchId, deleteManagedAssets: false }, runtime.coordinator.currentVersion()),
    registered.principal
  );
  assert.equal(directRejected.kind, 'rejected');
  assert.equal(directRejected.error.code, 'POLICY_DENIED');
  const directDatabase = await databaseService.getDatabase();
  assert.equal(directDatabase.exec('SELECT COUNT(*) FROM agent_idempotency')[0].values[0][0], 0);
  assert.deepEqual(directDatabase.exec('SELECT status FROM import_batches WHERE id=?', [directOverflow.batchId])[0].values, [['active']]);
});

test('imports.delete_batch binds shared file references into the bounded authorization surface', async () => {
  let runtime = await importBatchGateway({ appInstanceId: 'c13-import-batch-shared-boundary' });
  const exact = await seedBatch('shared reference exact boundary');
  const sharedQuestion = await databaseService.createQuestion({
    title: 'shared reference holder', content: '', wrong_thinking: '', wrong_solution: '', correct_solution: '', answer: '',
    subject: '高等数学', category: '函数', question_type: '解答题', error_reason: '', source: 'test', difficulty: '中等', mastery_level: '一般', note: '', tags: [],
    questionImageSources: [], solutionImageSources: []
  });
  const coordinator = await databaseService.getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: crypto.randomUUID(), concurrency: 'none',
    execute(database) {
      const statement = database.prepare("INSERT INTO question_images (question_id,image_type,file_path,created_at) VALUES (?,'original',?,?)");
      try {
        for (let index = 0; index < 493; index += 1) statement.run([sharedQuestion.id, exact.managedImage, fixedNow]);
      } finally { statement.free(); }
      return { changed: true, value: undefined };
    }
  });
  const exactInventory = databaseService.resolveImportBatchDeletionInventory(exact.batchId, true, { clientId: owner, renderer: false });
  assert.equal(exactInventory.affectedEntityCount, 500);
  assert.equal(exactInventory.inventoryRows.filter((row) => row.table === 'question_images' && row.mutation === 'preserve').length, 493);
  assert.deepEqual(exactInventory.managedFiles.map((file) => file.action), ['preserve']);
  const approved = await approveDelete(runtime, exact, true, 'shared-boundary');
  const completed = await runtime.composition.gateway.execute(approved.request, approved.principal);
  assert.equal(completed.kind, 'completed', JSON.stringify(completed));
  assert.equal(fs.existsSync(exact.managedImage), true);

  await resetControlPlaneEnvironment();
  runtime = await importBatchGateway({ appInstanceId: 'c13-import-batch-shared-overflow' });
  const overflowOwner = 'c13-import-batch-shared-overflow-owner';
  const overflow = await seedBatch('shared reference overflow', overflowOwner);
  const overflowHolder = await databaseService.createQuestion({
    title: 'shared overflow holder', content: '', wrong_thinking: '', wrong_solution: '', correct_solution: '', answer: '',
    subject: '高等数学', category: '函数', question_type: '解答题', error_reason: '', source: 'test', difficulty: '中等', mastery_level: '一般', note: '', tags: [],
    questionImageSources: [], solutionImageSources: []
  });
  await (await databaseService.getDatabaseCoordinator()).executeWrite({
    requestId: crypto.randomUUID(), concurrency: 'none',
    execute(database) {
      const statement = database.prepare("INSERT INTO question_images (question_id,image_type,file_path,created_at) VALUES (?,'original',?,?)");
      try {
        for (let index = 0; index < 494; index += 1) statement.run([overflowHolder.id, overflow.managedImage, fixedNow]);
      } finally { statement.free(); }
      return { changed: true, value: undefined };
    }
  });
  const registered = await registerClient(runtime, overflowOwner, 'shared-overflow');
  const rejected = await runtime.composition.gateway.execute(
    gatewayCommand('imports.delete_batch', { batchId: overflow.batchId, deleteManagedAssets: true }, runtime.coordinator.currentVersion()),
    registered.principal
  );
  assert.equal(rejected.kind, 'rejected');
  assert.equal(rejected.error.code, 'POLICY_DENIED');
  const database = await databaseService.getDatabase();
  assert.equal(database.exec('SELECT COUNT(*) FROM agent_idempotency')[0].values[0][0], 0);
  assert.deepEqual(database.exec('SELECT status FROM import_batches WHERE id=?', [overflow.batchId])[0].values, [['active']]);
});

test('imports.delete_batch hashes the exact shared-reference row identity and evidence', async () => {
  const runtime = await importBatchGateway({ appInstanceId: 'c13-import-batch-shared-hash' });
  const seeded = await seedBatch('shared reference hash');
  const holder = await databaseService.createQuestion({
    title: 'shared hash holder', content: '', wrong_thinking: '', wrong_solution: '', correct_solution: '', answer: '',
    subject: '高等数学', category: '函数', question_type: '解答题', error_reason: '', source: 'test', difficulty: '中等', mastery_level: '一般', note: '', tags: [],
    questionImageSources: [], solutionImageSources: []
  });
  const coordinator = await databaseService.getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: crypto.randomUUID(), concurrency: 'none',
    execute(database) {
      database.run("INSERT INTO question_images (question_id,image_type,file_path,created_at) VALUES (?,'original',?,?)", [holder.id, seeded.managedImage, fixedNow]);
      return { changed: true, value: undefined };
    }
  });
  const registered = await registerClient(runtime, owner, 'shared-hash');
  const before = databaseService.resolveImportBatchDeletionInventory(seeded.batchId, true, { clientId: registered.principal.clientId, renderer: false });
  const beforePreserved = before.inventoryRows.find((row) => row.table === 'question_images' && row.mutation === 'preserve');
  assert.ok(beforePreserved);
  assert.deepEqual(before.managedFiles.map((file) => file.action), ['preserve']);
  await coordinator.executeWrite({
    requestId: crypto.randomUUID(), concurrency: 'none',
    execute(database) {
      database.run('DELETE FROM question_images WHERE id=?', [Number(beforePreserved.rowKey)]);
      database.run("INSERT INTO question_images (question_id,image_type,file_path,created_at) VALUES (?,'solution',?,?)", [holder.id, seeded.managedImage, fixedNow]);
      return { changed: true, value: undefined };
    }
  });
  const after = databaseService.resolveImportBatchDeletionInventory(seeded.batchId, true, { clientId: registered.principal.clientId, renderer: false });
  const afterPreserved = after.inventoryRows.find((row) => row.table === 'question_images' && row.mutation === 'preserve');
  assert.ok(afterPreserved);
  assert.notEqual(afterPreserved.rowKey, beforePreserved.rowKey);
  assert.notEqual(afterPreserved.rowHash, beforePreserved.rowHash);
  assert.notEqual(after.inventoryHash, before.inventoryHash);
  assert.notEqual(after.affectedSetHash, before.affectedSetHash);
  assert.notEqual(after.targetHash, before.targetHash);
  assert.notEqual(after.managedFiles[0].sourceBindingsHash, before.managedFiles[0].sourceBindingsHash);
  assert.deepEqual(after.managedFiles.map((file) => file.action), ['preserve']);
});

test('imports.delete_batch maps question-bank attempts, preserves live textbook assets, rejects overflow, and fences junction escapes', async () => {
  let runtime = await importBatchGateway({ appInstanceId: 'c13-import-batch-question-bank' });
  const bank = await seedQuestionBankBatch('question bank batch');
  let approved = await approveDelete(runtime, bank, true, 'question-bank');
  let result = await runtime.composition.gateway.execute(approved.request, approved.principal);
  assert.equal(result.kind, 'completed', JSON.stringify(result));
  assert.equal(result.result.value.deletedExternalQuestions, 1);
  assert.equal(result.result.value.deletedAttempts, 1);
  assert.equal(result.result.value.quarantinedManagedAssets, 1);
  assert.equal(fs.existsSync(bank.assetPath), false);

  await resetControlPlaneEnvironment();
  runtime = await importBatchGateway({ appInstanceId: 'c13-import-batch-knowledge' });
  const knowledge = await seedKnowledgeBatch('knowledge batch');
  approved = await approveDelete(runtime, knowledge, true, 'knowledge');
  result = await runtime.composition.gateway.execute(approved.request, approved.principal);
  assert.equal(result.kind, 'completed', JSON.stringify(result));
  assert.equal(result.result.value.softDeletedKnowledgePoints, 1);
  assert.equal(result.result.value.quarantinedManagedAssets, 0);
  assert.equal(fs.existsSync(knowledge.assetPath), true);
  let database = await databaseService.getDatabase();
  assert.equal(database.exec('SELECT COUNT(*) FROM textbooks WHERE id=?', [knowledge.textbookId])[0].values[0][0], 1);
  assert.deepEqual(database.exec('SELECT deleted_at FROM knowledge_points WHERE node_id=?', [knowledge.nodeId])[0].values, [[fixedNow]]);

  await resetControlPlaneEnvironment();
  runtime = await importBatchGateway();
  const overflow = await seedBatch('overflow batch', owner, false);
  const coordinator = await databaseService.getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: crypto.randomUUID(), concurrency: 'none',
    execute(active) {
      const statement = active.prepare(`INSERT INTO questions (title,content,category,question_type,error_reason,source,difficulty,mastery_level,import_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      try {
        for (let index = 0; index < 500; index += 1) statement.run([`overflow-${index}`, '', '函数', '解答题', '', 'test', '中等', '一般', overflow.batchId, fixedNow, fixedNow]);
      } finally { statement.free(); }
      return { changed: true, value: undefined };
    }
  });
  const registered = await registerClient(runtime, owner, 'overflow');
  assert.throws(() => runtime.globalApplication.resolveState(
    gatewayCommand('imports.delete_batch', { batchId: overflow.batchId, deleteManagedAssets: false }, runtime.coordinator.currentVersion()),
    agent.resolveOperationDescriptor('imports.delete_batch'), registered.principal
  ), (error) => error.code === 'POLICY_DENIED');

  await resetControlPlaneEnvironment();
  runtime = await importBatchGateway();
  const escaped = await seedBatch('junction batch', owner, false);
  const outside = path.join(environment.getControlPlanePaths().testRoot, 'outside-junction');
  const junction = path.join(pathService.getPaths().images, 'batch-junction');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'escape.png'), Buffer.from('escape'));
  fs.symlinkSync(outside, junction, 'junction');
  database = await databaseService.getDatabase();
  await (await databaseService.getDatabaseCoordinator()).executeWrite({
    requestId: crypto.randomUUID(), concurrency: 'none',
    execute(active) {
      const storedPath = path.relative(pathService.getPaths().root, path.join(junction, 'escape.png')).replaceAll(path.sep, '/');
      active.run("INSERT INTO question_images (question_id,image_type,file_path,created_at) VALUES (?,'original',?,?)", [escaped.question.id, storedPath, fixedNow]);
      active.run("INSERT INTO import_assets (batch_id,asset_type,file_path,created_at,deleted_at) VALUES (?,'question_image',?,?,NULL)", [escaped.batchId, path.join(junction, 'escape.png'), fixedNow]);
      return { changed: true, value: undefined };
    }
  });
  const junctionOwner = await registerClient(runtime, owner, 'junction');
  assert.throws(() => runtime.globalApplication.resolveState(
    gatewayCommand('imports.delete_batch', { batchId: escaped.batchId, deleteManagedAssets: true }, runtime.coordinator.currentVersion()),
    agent.resolveOperationDescriptor('imports.delete_batch'), junctionOwner.principal
  ), (error) => error.code === 'RECOVERY_FENCE');
});

test('imports.delete_batch crash boundaries fence pre-live ambiguity and reconstruct post-live terminal state', async () => {
  for (const boundary of ['inventory_validated', 'recovery_package_staged', 'files_quarantined']) {
    await resetControlPlaneEnvironment();
    const runtime = await importBatchGateway({ appInstanceId: `c13-batch-${boundary}`, stageHook(stage) { if (stage === boundary) throw new agent.AgentError('RECOVERY_FENCE'); } });
    const seeded = await seedBatch(`batch ${boundary}`);
    const approved = await approveDelete(runtime, seeded, true, boundary);
    const failed = await runtime.composition.gateway.execute(approved.request, approved.principal);
    assert.equal(failed.kind, 'rejected', boundary);
    assert.equal(runtime.livePublications(), 0, boundary);
    await assert.rejects(restart(runtime), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)), boundary);
  }

  await resetControlPlaneEnvironment();
  const runtime = await importBatchGateway({ appInstanceId: 'c13-batch-post-live', stageHook(stage) { if (stage === 'database_published') throw new agent.AgentError('RECOVERY_FENCE'); } });
  const seeded = await seedBatch('batch post live');
  const approved = await approveDelete(runtime, seeded, true, 'post-live');
  const failed = await runtime.composition.gateway.execute(approved.request, approved.principal);
  assert.equal(failed.kind, 'rejected');
  assert.equal(runtime.livePublications(), 1);
  await restart(runtime);
  const database = await databaseService.getDatabase();
  assert.deepEqual(database.exec('SELECT status FROM agent_idempotency WHERE request_id=?', [approved.request.requestId])[0].values, [['completed']]);
  assert.deepEqual(database.exec('SELECT status FROM import_batches WHERE id=?', [seeded.batchId])[0].values, [['deleted']]);
});

test('imports.delete_batch restart fences private, recovery, terminal, live, and both/neither file tampering', async () => {
  async function completed(label, deleteManagedAssets = true) {
    const runtime = await importBatchGateway({ appInstanceId: `c13-batch-tamper-${label}` });
    const seeded = await seedBatch(`batch tamper ${label}`);
    const approved = await approveDelete(runtime, seeded, deleteManagedAssets, label);
    const result = await runtime.composition.gateway.execute(approved.request, approved.principal);
    assert.equal(result.kind, 'completed', label);
    const id = operationId(seeded.batchId, approved.request.requestId);
    const journalPath = path.join(runtime.managedPaths.journal, 'import-batch-deletions', `${id}.import-batch-delete.json`);
    const manifest = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    const quarantinePath = path.join(pathService.getPaths().temp, 'a11-quarantine', `${id}-0.quarantine`);
    return { runtime, seeded, approved, id, journalPath, manifest, quarantinePath };
  }

  let current = await completed('private');
  fs.writeFileSync(current.journalPath, '{"schemaVersion":1,"phase":"completed"}\n');
  await assert.rejects(restart(current.runtime), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)));

  await resetControlPlaneEnvironment();
  current = await completed('recovery');
  fs.appendFileSync(current.manifest.recoveryDatabasePath, 'tamper');
  await assert.rejects(restart(current.runtime), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)));

  await resetControlPlaneEnvironment();
  current = await completed('oversized-manifest');
  const oversized = current.manifest;
  const missingRows = 501 - oversized.inventoryRows.length - oversized.managedFiles.length;
  assert.ok(missingRows > 0);
  for (let index = 0; index < missingRows; index += 1) {
    oversized.inventoryRows.push({
      table: 'import_batch_items',
      rowKey: `oversized-${index}`,
      rowHash: agent.hashCanonicalJson({ oversized: index }),
      mutation: 'preserve'
    });
  }
  oversized.inventoryRows.sort((left, right) => `${left.table}\0${left.rowKey}\0${left.mutation}`.localeCompare(`${right.table}\0${right.rowKey}\0${right.mutation}`));
  const fileBindings = oversized.managedFiles.map(({ fileId, rootKind, pathHash, contentHash, contentSize, sourceBindingsHash, action }) =>
    ({ fileId, rootKind, pathHash, contentHash, contentSize, sourceBindingsHash, action }));
  oversized.affectedEntities = [
    ...oversized.inventoryRows.map((row) => ({ entityType: `database_row_${row.table}`, entityId: row.rowHash })),
    ...fileBindings.map((file) => ({ entityType: 'managed_import_batch_asset', entityId: agent.hashCanonicalJson(file) }))
  ].sort((left, right) => `${left.entityType}\0${left.entityId}`.localeCompare(`${right.entityType}\0${right.entityId}`));
  oversized.affectedEntityCount = oversized.affectedEntities.length;
  oversized.inventoryHash = agent.hashCanonicalJson({ schemaVersion: 1, batchId: oversized.batchId, ownershipPolicy: oversized.ownershipPolicy, inventoryRows: oversized.inventoryRows, fileBindings });
  oversized.affectedSetHash = agent.hashCanonicalJson(oversized.affectedEntities);
  oversized.targetHash = agent.hashCanonicalJson({
    operation: 'imports.delete_batch', batchId: oversized.batchId, deleteManagedAssets: oversized.deleteManagedAssets,
    inventoryHash: oversized.inventoryHash, affectedSetHash: oversized.affectedSetHash, affectedEntityCount: oversized.affectedEntityCount
  });
  fs.writeFileSync(current.journalPath, `${JSON.stringify(oversized)}\n`);
  await assert.rejects(restart(current.runtime), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)));

  await resetControlPlaneEnvironment();
  current = await completed('terminal');
  await mutateLiveDatabaseFile((database) => database.run('UPDATE agent_import_batch_deletion_journals SET live_semantic_hash=? WHERE operation_id=?', [`sha256-v1:${'1'.repeat(64)}`, current.id]));
  await assert.rejects(restart(current.runtime), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)));

  await resetControlPlaneEnvironment();
  current = await completed('both');
  fs.mkdirSync(path.dirname(current.seeded.managedImage), { recursive: true });
  fs.copyFileSync(current.quarantinePath, current.seeded.managedImage);
  await assert.rejects(restart(current.runtime), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)));

  await resetControlPlaneEnvironment();
  current = await completed('neither');
  fs.unlinkSync(current.quarantinePath);
  await assert.rejects(restart(current.runtime), (error) => error.code === 'RECOVERY_FENCE' || /RECOVERY_FENCE/.test(String(error?.message ?? error)));
});

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const { databaseService, cleanupControlPlaneRoot, getControlPlanePaths, resetControlPlaneEnvironment } = environment;
const contexts = environment.requireMain('application/executionContext.js');
const bootstrap = environment.requireMain('agent/bootstrap.js');
const authentication = environment.requireMain('agent/clientAuthenticator.js');
const agent = require(`${environment.projectRoot}/dist/main/shared/agent/index.js`);

test.after(() => cleanupControlPlaneRoot());
test.beforeEach(resetControlPlaneEnvironment);

function item(overrides = {}) { return { itemId: 'item-1', title: 'C11 极限题', content: 'lim x = 1', wrongThinking: '误判', correctSolution: '等价无穷小', answer: '1', subject: '高等数学', category: '极限', questionType: '解答题', errorReason: '概念不清', difficulty: '中等', masteryLevel: '未掌握', source: 'C11 test', tags: ['c11'], knowledgePoints: [], ...overrides }; }
async function context() { const coordinator = await databaseService.getDatabaseCoordinator(); return contexts.createRendererExecutionContext({ expectedVersion: coordinator.currentVersion() }); }

test('C11 state machine stages only selected managed images and applies one deterministic journaled change set', async () => {
  const application = await databaseService.getImportsApplication();
  const selected = path.join(getControlPlanePaths().testRoot, 'selected.png');
  fs.writeFileSync(selected, Buffer.from('c11-image'));
  await assert.rejects(application.stageSelectedImages([selected], await context()), /scope/i);
  const [asset] = await application.stageSelectedImages([selected], await context(), { kind: 'main_process_selection' });
  assert.equal('filePath' in asset, false);
  await assert.rejects(application.stageSelectedImages(['\\\\server\\share\\secret.png'], await context(), { kind: 'main_process_selection' }), /invalid/i);
  const wrongType = path.join(getControlPlanePaths().testRoot, 'secret.txt'); fs.writeFileSync(wrongType, 'secret');
  await assert.rejects(application.stageSelectedImages([wrongType], await context(), { kind: 'main_process_selection' }), /invalid/i);

  const created = await application.execute({ type: 'imports.create_draft', payload: { source: 'app_ocr_deepseek', networkDisclosure: 'deepseek_text_only', items: [item()] } }, await context());
  const draftId = created.value.draftId;
  await application.execute({ type: 'imports.add_draft_image', payload: { draftId, itemId: 'item-1', assetId: asset.assetId, role: 'question' } }, await context());
  const validation = await application.execute({ type: 'imports.validate_draft', payload: { draftId } }, await context());
  assert.equal(validation.value.valid, true);
  const preview = application.query({ type: 'imports.preview_draft', payload: { draftId } }, await context()).value;
  assert.equal(preview.previewHash, validation.value.previewHash);
  const applied = await application.execute({ type: 'imports.apply_draft', payload: { draftId, previewHash: preview.previewHash } }, await context());
  assert.equal(applied.value.createdQuestionIds.length, 1);
  const stored = application.query({ type: 'imports.get', payload: { draftId } }, await context()).value;
  assert.equal(stored.state, 'applied');
  assert.deepEqual(stored.appliedQuestionIds, applied.value.createdQuestionIds);
  const question = await databaseService.getQuestion(applied.value.createdQuestionIds[0]);
  assert.equal(question.title, 'C11 极限题');
  assert.equal(question.question_images.length, 1);
  const manifests = fs.readdirSync(path.join(getControlPlanePaths().dataRoot, 'data', 'operation-journal')).filter((name) => name.endsWith('.operation.json')).map((name) => JSON.parse(fs.readFileSync(path.join(getControlPlanePaths().dataRoot, 'data', 'operation-journal', name), 'utf8')));
  const applyManifest = manifests.find((entry) => entry.commandType === 'imports.apply_draft');
  assert.equal(applyManifest?.state, 'completed');
  const duplicate = await application.execute({ type: 'imports.create_draft', payload: { source: 'structured_file', networkDisclosure: 'none', items: [item({ itemId: 'duplicate-item' })] } }, await context());
  const duplicateValidation = await application.execute({ type: 'imports.validate_draft', payload: { draftId: duplicate.value.draftId } }, await context());
  assert.deepEqual(duplicateValidation.value.changes.map(({ action }) => action), ['skip_duplicate']);
});

test('C11 staging crash after journal preparation compensates without an orphan inbox asset', async () => {
  const application = await databaseService.getImportsApplication();
  const selected = path.join(getControlPlanePaths().testRoot, 'stage-crash.png');
  fs.writeFileSync(selected, Buffer.from('stage-crash'));
  const originalRename = fs.promises.rename;
  fs.promises.rename = async (source, target) => {
    if (String(source).endsWith('.stage') && String(target).includes(path.sep + 'import-inbox' + path.sep + 'assets' + path.sep)) throw new Error('injected staging publication crash');
    return originalRename.call(fs.promises, source, target);
  };
  try {
    await assert.rejects(application.stageSelectedImages([selected], await context(), { kind: 'main_process_selection' }), /injected staging publication crash/);
  } finally { fs.promises.rename = originalRename; }
  const inbox = path.join(getControlPlanePaths().dataRoot, 'data', 'import-inbox', 'assets');
  assert.equal(fs.existsSync(inbox) ? fs.readdirSync(inbox).filter((name) => !name.startsWith('.')).length : 0, 0);
  const manifests = fs.readdirSync(path.join(getControlPlanePaths().dataRoot, 'data', 'operation-journal')).filter((name) => name.endsWith('.operation.json')).map((name) => JSON.parse(fs.readFileSync(path.join(getControlPlanePaths().dataRoot, 'data', 'operation-journal', name), 'utf8')));
  const manifest = manifests.find((entry) => entry.commandType === 'imports.stage_selected_images');
  assert.equal(manifest.state, 'needs_recovery');
  databaseService.resetDatabaseConnection();
  assert.equal((await databaseService.initializeDatabase()).state, 'needs_recovery');
});

test('C11 validation is deterministic and Gateway replay executes once', async () => {
  const plane = await databaseService.getAgentControlPlane();
  const coordinator = await databaseService.getDatabaseCoordinator();
  const requestId = crypto.randomUUID();
  const envelope = { apiVersion: 1, kind: 'agent-command', operation: 'imports.create_draft', payload: { source: 'external_multimodal', networkDisclosure: 'none', items: [item({ itemId: 'gateway-item' })] }, requestId, expectedVersion: coordinator.currentVersion(), catalog: agent.operationCatalogIdentity };
  const first = await plane.gateway.execute(envelope, plane.renderer.principal());
  const replay = await plane.gateway.execute(envelope, plane.renderer.principal());
  assert.equal(first.kind, 'completed'); assert.equal(replay.kind, 'replayed'); assert.equal(first.result.value.draftId, replay.result.value.draftId);
  const database = await databaseService.getDatabase();
  assert.equal(database.exec('SELECT COUNT(*) FROM import_drafts')[0].values[0][0], 1);

  const application = await databaseService.getImportsApplication();
  await application.execute({ type: 'imports.validate_draft', payload: { draftId: first.result.value.draftId } }, await context());
  const before = application.query({ type: 'imports.preview_draft', payload: { draftId: first.result.value.draftId } }, await context()).value;
  const after = application.query({ type: 'imports.preview_draft', payload: { draftId: first.result.value.draftId } }, await context()).value;
  assert.deepEqual(after, before);
});

test('C11 post-commit image publication failure fences apply and remains explicit after restart', async () => {
  const application = await databaseService.getImportsApplication();
  const selected = path.join(getControlPlanePaths().testRoot, 'crash-phase.png');
  fs.writeFileSync(selected, Buffer.from('c11-crash-image'));
  const [asset] = await application.stageSelectedImages([selected], await context(), { kind: 'main_process_selection' });
  const draft = await application.execute({ type: 'imports.create_draft', payload: { source: 'external_multimodal', networkDisclosure: 'none', items: [item({ itemId: 'crash-item', title: 'Crash phase question' })] } }, await context());
  await application.execute({ type: 'imports.add_draft_image', payload: { draftId: draft.value.draftId, itemId: 'crash-item', assetId: asset.assetId, role: 'question' } }, await context());
  const validation = await application.execute({ type: 'imports.validate_draft', payload: { draftId: draft.value.draftId } }, await context());
  const originalRename = fs.promises.rename;
  fs.promises.rename = async (source, target) => {
    if (String(source).endsWith('.stage') && String(target).includes(`${path.sep}images${path.sep}`)) throw new Error('injected C11 file commit failure');
    return originalRename.call(fs.promises, source, target);
  };
  try {
    await assert.rejects(application.execute({ type: 'imports.apply_draft', payload: { draftId: draft.value.draftId, previewHash: validation.value.previewHash } }, await context()), /injected C11 file commit failure/);
  } finally { fs.promises.rename = originalRename; }
  assert.equal((await databaseService.getDatabaseCoordinator()).state, 'needs_recovery');
  const journalRoot = path.join(getControlPlanePaths().dataRoot, 'data', 'operation-journal');
  const manifest = fs.readdirSync(journalRoot).filter((name) => name.endsWith('.operation.json')).map((name) => JSON.parse(fs.readFileSync(path.join(journalRoot, name), 'utf8'))).find((entry) => entry.commandType === 'imports.apply_draft');
  assert.equal(manifest.state, 'needs_recovery');
  assert.equal(manifest.lastError.phase, 'file_finalization');
  databaseService.resetDatabaseConnection();
  const restarted = await databaseService.initializeDatabase();
  assert.equal(restarted.state, 'needs_recovery');
});

test('C11 Renderer and authenticated external principals share schemas, ownership, receipts, and apply semantics', async () => {
  const coordinator = await databaseService.getDatabaseCoordinator();
  const questions = await databaseService.getQuestionsApplication();
  const imports = await databaseService.getImportsApplication();
  const verifier = { verify(raw) { return { credentialFingerprint: authentication.fingerprintCredential(raw.credential), sessionFingerprint: authentication.fingerprintCredential(raw.session) }; } };
  const composition = await bootstrap.bootstrapAgentGateway({ coordinator, commandBus: questions.gateway.commandBus, queryBus: questions.gateway.queryBus, selectedCandidateEvidence: true, appInstanceId: 'c11-external', credentialVerifier: verifier, cursorSecret: 'c11'.repeat(16), jobResultRoot: environment.resultRoot, resolveState: (envelope, descriptor) => descriptor.domain === 'imports' ? imports.resolveState(envelope, descriptor) : questions.gateway.resolveState(envelope, descriptor), executeBusinessCommand: (command, executionContext, dispatch) => questions.gateway.execute(command, executionContext, dispatch), importsApplication: imports });
  const registryComposition = await bootstrap.bootstrapAgentB3({ coordinator, appInstanceId: 'c11-external', credentialVerifier: verifier, cursorSecret: 'c11'.repeat(16) });
  const credential = authentication.fingerprintCredential('c11-credential'); const session = authentication.fingerprintCredential('c11-session');
  await registryComposition.registry.registerClient({ clientId: 'c11-client', subjectId: 'c11-subject', displayName: 'C11 Client', credentialFingerprint: credential, scopes: ['imports.read', 'imports.write', 'operations.batch', 'questions.write'], trust: 'full_control' });
  await registryComposition.registry.setExternalControlEnabled(true);
  await registryComposition.registry.createSession('c11-client', credential, session, new Date(Date.now() + 60 * 60_000).toISOString());
  const principal = await composition.authenticator.authenticate({ credential: 'c11-credential', session: 'c11-session' });
  const requestId = crypto.randomUUID();
  const createEnvelope = { apiVersion: 1, kind: 'agent-command', operation: 'imports.create_draft', payload: { source: 'external_multimodal', networkDisclosure: 'none', items: [item({ itemId: 'external-item', title: 'External parity' })] }, requestId, expectedVersion: coordinator.currentVersion(), catalog: agent.operationCatalogIdentity };
  const created = await composition.gateway.execute(createEnvelope, principal);
  assert.equal(created.kind, 'completed');
  const replay = await composition.gateway.execute(createEnvelope, principal);
  assert.equal(replay.kind, 'replayed');
  const read = await composition.gateway.query({ apiVersion: 1, kind: 'agent-query', operation: 'imports.get', payload: { draftId: created.result.value.draftId }, requestId: crypto.randomUUID(), catalog: agent.operationCatalogIdentity }, principal);
  assert.equal(read.kind, 'completed');
  assert.deepEqual(read.result.value.items, created.result.value.items);
  const denied = await composition.gateway.query({ apiVersion: 1, kind: 'agent-query', operation: 'imports.get', payload: { draftId: created.result.value.draftId }, requestId: crypto.randomUUID(), catalog: agent.operationCatalogIdentity }, composition.renderer.principal());
  assert.equal(denied.kind, 'completed', JSON.stringify(denied));
  assert.equal(denied.result.value.draftId, created.result.value.draftId);
  const receipts = (await databaseService.getDatabase()).exec("SELECT COUNT(*) FROM agent_idempotency WHERE client_id='c11-client' AND request_id=?", [requestId])[0].values[0][0];
  assert.equal(receipts, 1);
});

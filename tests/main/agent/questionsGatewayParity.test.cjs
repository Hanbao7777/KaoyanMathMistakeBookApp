const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const adapter = environment.requireMain('ipc/adapters/questionsIpc.js');
const bootstrap = environment.requireMain('agent/bootstrap.js');
const authentication = environment.requireMain('agent/clientAuthenticator.js');
const { createInternalExecutionContext } = environment.requireMain('application/executionContext.js');
const { registerQuestions } = environment.requireMain('application/questions/registerQuestions.js');
const agent = require(`${environment.projectRoot}/dist/main/shared/agent/index.js`);

function input(title, imageSources = []) {
  return {
    title, content: 'content', wrong_thinking: 'wrong', wrong_solution: '', correct_solution: 'correct', answer: '1',
    subject: '高等数学', category: '函数、极限、连续', question_type: '解答题', error_reason: '概念不清',
    source: 'b6-parity', difficulty: '中等', mastery_level: '一般', note: '', tags: ['b6'],
    questionImageSources: imageSources, solutionImageSources: []
  };
}

async function externalRuntime(application = undefined) {
  const coordinator = await environment.databaseService.getDatabaseCoordinator();
  const questions = application ?? await environment.databaseService.getQuestionsApplication();
  const appInstanceId = `b6-instance-${crypto.randomUUID()}`;
  const verifier = {
    verify(raw) {
      return {
        credentialFingerprint: authentication.fingerprintCredential(raw.credential),
        sessionFingerprint: authentication.fingerprintCredential(raw.session)
      };
    }
  };
  const gateway = await bootstrap.bootstrapAgentGateway({
    coordinator,
    commandBus: questions.gateway.commandBus,
    queryBus: questions.gateway.queryBus,
    selectedCandidateEvidence: true,
    appInstanceId,
    credentialVerifier: verifier,
    cursorSecret: crypto.randomBytes(32),
    randomUUID: crypto.randomUUID,
    resolveState: (envelope, descriptor) => questions.gateway.resolveState(envelope, descriptor),
    executeBusinessCommand: (command, context, dispatch) => questions.gateway.execute(command, context, dispatch)
  });
  const registry = await bootstrap.bootstrapAgentB3({
    coordinator,
    appInstanceId,
    credentialVerifier: verifier,
    cursorSecret: crypto.randomBytes(32),
    randomUUID: crypto.randomUUID
  });
  const clientId = `b6-client-${crypto.randomUUID()}`;
  const credential = crypto.randomUUID();
  const session = crypto.randomUUID();
  const credentialFingerprint = authentication.fingerprintCredential(credential);
  await registry.registry.registerClient({
    clientId,
    subjectId: clientId,
    displayName: 'B6 external client',
    credentialFingerprint,
    scopes: ['audit.read', 'questions.read', 'questions.write', 'questions.archive', 'reviews.read', 'reviews.submit', 'knowledge.write', 'operations.batch'],
    trust: 'full_control'
  });
  await registry.registry.setExternalControlEnabled(true);
  await registry.registry.createSession(
    clientId,
    credentialFingerprint,
    authentication.fingerprintCredential(session),
    new Date(Date.now() + 60_000).toISOString()
  );
  return {
    coordinator,
    gateway: gateway.gateway,
    renderer: gateway.renderer.principal(),
    principal: await gateway.authenticator.authenticate({ credential, session })
  };
}

function command(runtime, operation, payload, overrides = {}) {
  return runtime.gateway.execute({
    apiVersion: 1,
    kind: 'agent-command',
    operation,
    payload,
    requestId: crypto.randomUUID(),
    expectedVersion: runtime.coordinator.currentVersion(),
    catalog: agent.operationCatalogIdentity,
    ...overrides
  }, runtime.principal);
}

test.beforeEach(environment.resetControlPlaneEnvironment);
test.after(() => environment.cleanupControlPlaneRoot());

test('Renderer and external Gateway preserve question, review, image, retry, version, and audit parity', async () => {
  const runtime = await externalRuntime();
  const root = environment.getControlPlanePaths().testRoot;
  const rendererSource = path.join(root, 'renderer-parity.png');
  const externalSource = path.join(root, 'external-parity.png');
  fs.writeFileSync(rendererSource, Buffer.from('renderer-parity'));
  fs.writeFileSync(externalSource, Buffer.from('external-parity'));

  const rendererCreated = await adapter.createQuestionFromRenderer(input('Renderer parity', [rendererSource]));
  const externalCreatedOutcome = await command(runtime, 'questions.create', { input: input('External parity', [externalSource]) });
  assert.equal(externalCreatedOutcome.kind, 'completed');
  const externalCreated = externalCreatedOutcome.result.value;
  assert.deepEqual(Object.keys(externalCreated).sort(), Object.keys(rendererCreated).sort());
  assert.equal(externalCreated.question_images.length, rendererCreated.question_images.length);
  const application = await environment.databaseService.getQuestionsApplication();
  const resolvedDelete = application.gateway.resolveState({
    apiVersion: 1,
    kind: 'agent-command',
    operation: 'questions.delete',
    payload: { questionId: rendererCreated.id, deleteImages: true },
    requestId: crypto.randomUUID(),
    expectedVersion: runtime.coordinator.currentVersion(),
    catalog: agent.operationCatalogIdentity
  }, agent.resolveOperationDescriptor('questions.delete'));
  assert.equal(resolvedDelete.managedFileCount, 1);
  assert.deepEqual(resolvedDelete.affectedEntities, [
    { entityType: 'question_image', entityId: String(rendererCreated.question_images[0].id) },
    { entityType: 'question', entityId: String(rendererCreated.id) }
  ]);

  const rendererUpdated = await adapter.updateQuestionFromRenderer(rendererCreated.id, input('Renderer updated'));
  const externalUpdated = await command(runtime, 'questions.update', {
    questionId: externalCreated.id,
    input: input('External updated')
  });
  assert.equal(externalUpdated.kind, 'completed');
  assert.equal(rendererUpdated.title, 'Renderer updated');
  assert.equal(externalUpdated.result.value.title, 'External updated');

  const rendererReview = await adapter.submitReviewResultFromRenderer({ questionId: rendererCreated.id, result: 'correct', note: 'renderer' });
  const externalReview = await command(runtime, 'questions.submit_review', { questionId: externalCreated.id, result: 'correct', note: 'external' });
  assert.equal(externalReview.kind, 'completed');
  assert.deepEqual(Object.keys(externalReview.result.value).sort(), Object.keys(rendererReview).sort());
  assert.equal(externalReview.result.value.question.review_count, rendererReview.question.review_count);

  assert.equal(await adapter.removeImageFromRenderer(rendererCreated.question_images[0].id, false), true);
  const externalImage = await command(runtime, 'questions.remove_image', { imageId: externalCreated.question_images[0].id, deleteFile: false });
  assert.equal(externalImage.kind, 'completed');
  assert.equal(externalImage.result.value, true);

  const retryRequest = {
    apiVersion: 1,
    kind: 'agent-command',
    operation: 'questions.create',
    payload: { input: input('External exact retry') },
    requestId: crypto.randomUUID(),
    expectedVersion: runtime.coordinator.currentVersion(),
    catalog: agent.operationCatalogIdentity
  };
  const first = await runtime.gateway.execute(retryRequest, runtime.principal);
  const replay = await runtime.gateway.execute(retryRequest, runtime.principal);
  assert.equal(first.kind, 'completed');
  assert.equal(replay.kind, 'replayed');
  assert.deepEqual(replay.result, first.result);
  const mismatch = await runtime.gateway.execute({ ...retryRequest, payload: { input: input('External mismatch') } }, runtime.principal);
  assert.equal(mismatch.error.code, 'IDEMPOTENCY_CONFLICT');

  const staleVersion = runtime.coordinator.currentVersion();
  await adapter.markMasteryFromRenderer(rendererCreated.id, '已掌握');
  const stale = await command(runtime, 'questions.mark_mastery', {
    questionId: externalCreated.id,
    mastery: '已掌握'
  }, { expectedVersion: staleVersion });
  assert.equal(stale.error.code, 'DATA_REVISION_CONFLICT');
  assert.deepEqual(stale.error.details.currentVersion, runtime.coordinator.currentVersion());

  assert.equal(await adapter.deleteQuestionFromRenderer(rendererCreated.id, false), true);
  const externalDelete = await command(runtime, 'questions.delete', { questionId: externalCreated.id, deleteImages: false });
  assert.equal(externalDelete.kind, 'completed');
  assert.equal(externalDelete.result.value, true);

  const controlPlane = await environment.databaseService.getAgentControlPlane();
  const audit = await controlPlane.gateway.query({
    apiVersion: 1,
    kind: 'agent-query',
    operation: 'agent.audit.search',
    payload: {
      pageSize: 200,
      redaction: { apiVersion: 1, kind: 'redaction-profile', detail: 'standard', includeUserContent: false, includeAffectedEntities: true, fields: [] }
    },
    requestId: crypto.randomUUID(),
    catalog: agent.operationCatalogIdentity
  }, controlPlane.renderer.principal());
  assert.equal(audit.kind, 'completed');
  const successful = new Set(audit.result.value.items.filter((record) => record.kind === 'success').map((record) => record.operation));
  for (const operation of ['questions.create', 'questions.update', 'questions.submit_review', 'questions.remove_image', 'questions.mark_mastery', 'questions.delete']) {
    assert.equal(successful.has(operation), true, `Missing successful audit for ${operation}`);
  }
});

test('image finalization failure fences Gateway and remains recoverable evidence after restart', async () => {
  const coordinator = await environment.databaseService.getDatabaseCoordinator();
  const readOnly = await environment.databaseService.getReadOnlyDatabase();
  const source = path.join(environment.getControlPlanePaths().testRoot, 'gateway-journal-failure.png');
  fs.writeFileSync(source, Buffer.from('gateway-journal-failure'));
  const created = await adapter.createQuestionFromRenderer(input('Journal failure', [source]));
  const requestId = crypto.randomUUID();
  const application = registerQuestions({
    coordinator,
    readOnlyDatabase: readOnly,
    commandDependencies: {
      journalHook({ boundary, phase }) {
        if (boundary === 'before' && phase === 'file_commit') throw new Error('injected file commit failure');
      }
    }
  });
  const runtime = await externalRuntime(application);
  const outcome = await runtime.gateway.execute({
    apiVersion: 1,
    kind: 'agent-command',
    operation: 'questions.remove_image',
    payload: { imageId: created.question_images[0].id, deleteFile: true },
    requestId,
    expectedVersion: coordinator.currentVersion(),
    catalog: agent.operationCatalogIdentity
  }, runtime.renderer);
  assert.equal(outcome.error.code, 'RECOVERY_FENCE');
  assert.equal(coordinator.state, 'needs_recovery');

  const manifestPath = path.join(environment.getControlPlanePaths().dataRoot, 'data', 'operation-journal', `${requestId}.operation.json`);
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).state, 'needs_recovery');
  environment.databaseService.resetDatabaseConnection();
  const restarted = await environment.databaseService.initializeDatabase();
  assert.equal(restarted.state, 'needs_recovery');
  assert.equal((await environment.databaseService.getDatabaseCoordinator()).state, 'needs_recovery');
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).state, 'needs_recovery');
});

test('removed Renderer operations remain functional through internal question application callers', async () => {
  const application = await environment.databaseService.getQuestionsApplication();
  const context = () => createInternalExecutionContext({ concurrency: 'none' });
  const created = await application.execute({ type: 'questions.create', payload: { input: input('Internal removed operations') } }, context());
  const reviewed = await application.execute({
    type: 'questions.submit_review', payload: { questionId: created.value.id, result: 'correct', note: 'internal' }
  }, context());
  const undone = await application.execute({
    type: 'questions.undo_review', payload: { questionId: created.value.id, reviewLogId: reviewed.value.log.id }
  }, context());
  assert.equal(undone.value.question.review_count, 0);
  const linked = await application.execute({
    type: 'questions.link_knowledge', payload: { questionId: created.value.id, knowledgeNodeIds: [], matchType: 'manual' }
  }, context());
  assert.equal(linked.value, 0);
  assert.deepEqual((await application.execute({ type: 'questions.migrate_categories', payload: { limit: 10 } }, context())).value, { migrated: 0 });
  assert.deepEqual((await application.execute({
    type: 'questions.rematch_knowledge', payload: { limit: 10, questionIds: [created.value.id] }
  }, context())).value, { scannedQuestions: 1, insertedCount: 0 });
});

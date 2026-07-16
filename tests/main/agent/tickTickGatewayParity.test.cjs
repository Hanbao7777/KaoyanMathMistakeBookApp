const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const adapter = environment.requireMain('ipc/adapters/ticktickIpc.js');
const bootstrap = environment.requireMain('agent/bootstrap.js');
const authentication = environment.requireMain('agent/clientAuthenticator.js');
const ticktickService = environment.requireMain('services/ticktickService.js');
const agent = require(`${environment.projectRoot}/dist/main/shared/agent/index.js`);

async function externalRuntime() {
  const coordinator = await environment.databaseService.getDatabaseCoordinator();
  const questions = await environment.databaseService.getQuestionsApplication();
  const tickTick = await environment.databaseService.getTickTickApplication();
  const appInstanceId = `b7-instance-${crypto.randomUUID()}`;
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
    resolveState: (envelope, descriptor) => descriptor.domain === 'questions'
      ? questions.gateway.resolveState(envelope, descriptor)
      : tickTick.resolveState(envelope, descriptor),
    executeBusinessCommand: (command, context, dispatch) => questions.gateway.execute(command, context, dispatch),
    tickTickApplication: tickTick
  });
  const registry = await bootstrap.bootstrapAgentB3({
    coordinator,
    appInstanceId,
    credentialVerifier: verifier,
    cursorSecret: crypto.randomBytes(32),
    randomUUID: crypto.randomUUID
  });
  const clientId = `b7-client-${crypto.randomUUID()}`;
  const credential = crypto.randomUUID();
  const session = crypto.randomUUID();
  const credentialFingerprint = authentication.fingerprintCredential(credential);
  await registry.registry.registerClient({
    clientId,
    subjectId: clientId,
    displayName: 'B7 external client',
    credentialFingerprint,
    scopes: ['audit.read', 'tasks.read', 'tasks.write', 'tasks.execute', 'focus.read', 'focus.control'],
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
    tickTick,
    gateway: gateway.gateway,
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

function query(runtime, operation, payload) {
  return runtime.gateway.query({
    apiVersion: 1,
    kind: 'agent-query',
    operation,
    payload,
    requestId: crypto.randomUUID(),
    catalog: agent.operationCatalogIdentity
  }, runtime.principal);
}

test.beforeEach(environment.resetControlPlaneEnvironment);
test.after(() => environment.cleanupControlPlaneRoot());

test('Renderer and external Gateway preserve task and focus shapes, replay, version, and audit parity', async () => {
  const runtime = await externalRuntime();
  const list = await ticktickService.createTickTickList({ name: 'B7 parity' });
  const rendererTask = await adapter.createTickTickTaskFromRenderer({ list_id: list.id, title: 'Renderer task', tags: ['b7'] });
  const externalCreated = await command(runtime, 'tasks.create', { input: { list_id: list.id, title: 'External task', tags: ['b7'] } });
  assert.equal(externalCreated.kind, 'completed');
  assert.deepEqual(Object.keys(externalCreated.result.value).sort(), Object.keys(rendererTask).sort());

  const rendererUpdated = await adapter.updateTickTickTaskFromRenderer(rendererTask.id, { title: 'Renderer updated' });
  const externalUpdated = await command(runtime, 'tasks.update', { taskId: externalCreated.result.value.id, input: { title: 'External updated' } });
  assert.equal(rendererUpdated.title, 'Renderer updated');
  assert.equal(externalUpdated.result.value.title, 'External updated');

  assert.equal((await adapter.completeTickTickTaskFromRenderer(rendererTask.id)).is_completed, 1);
  assert.equal((await command(runtime, 'tasks.complete', { taskId: externalCreated.result.value.id })).result.value.is_completed, 1);
  assert.equal((await adapter.uncompleteTickTickTaskFromRenderer(rendererTask.id)).is_completed, 0);
  assert.equal((await command(runtime, 'tasks.uncomplete', { taskId: externalCreated.result.value.id })).result.value.is_completed, 0);

  const rendererFocus = await adapter.createTickTickFocusSessionFromRenderer({ task_id: rendererTask.id, start_time: new Date().toISOString(), duration_minutes: 25 });
  const externalFocus = await command(runtime, 'focus.sessions.create', {
    input: { task_id: externalCreated.result.value.id, start_time: new Date().toISOString(), duration_minutes: 25 }
  });
  assert.equal(externalFocus.kind, 'completed');
  assert.deepEqual(Object.keys(externalFocus.result.value).sort(), Object.keys(rendererFocus).sort());
  assert.equal((await adapter.listTickTickFocusSessionsFromRenderer({ taskId: rendererTask.id })).length, 1);
  assert.equal((await query(runtime, 'focus.sessions.list', { filters: { taskId: externalCreated.result.value.id } })).result.value.length, 1);
  assert.equal((await adapter.getTickTickTaskFromRenderer(rendererTask.id)).id, rendererTask.id);
  assert.equal((await query(runtime, 'tasks.list', { filters: { includeCompleted: true } })).result.value.length, 2);

  const retry = {
    apiVersion: 1,
    kind: 'agent-command',
    operation: 'tasks.create',
    payload: { input: { list_id: list.id, title: 'Exactly once' } },
    requestId: crypto.randomUUID(),
    expectedVersion: runtime.coordinator.currentVersion(),
    catalog: agent.operationCatalogIdentity
  };
  const first = await runtime.gateway.execute(retry, runtime.principal);
  const replay = await runtime.gateway.execute(retry, runtime.principal);
  assert.equal(first.kind, 'completed');
  assert.equal(replay.kind, 'replayed');
  assert.deepEqual(replay.result, first.result);
  assert.equal((await ticktickService.listTickTickTasks({ includeCompleted: true })).filter((task) => task.title === 'Exactly once').length, 1);

  const staleVersion = runtime.coordinator.currentVersion();
  await adapter.updateTickTickTaskFromRenderer(rendererTask.id, { note: 'advance version' });
  const stale = await command(runtime, 'tasks.update', {
    taskId: externalCreated.result.value.id,
    input: { note: 'stale' }
  }, { expectedVersion: staleVersion });
  assert.equal(stale.error.code, 'DATA_REVISION_CONFLICT');

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
  const successful = new Set(audit.result.value.items.filter((record) => record.kind === 'success').map((record) => record.operation));
  for (const operation of ['tasks.create', 'tasks.update', 'tasks.complete', 'tasks.uncomplete', 'focus.sessions.create']) {
    assert.equal(successful.has(operation), true, `Missing successful audit for ${operation}`);
  }
});

test('semantic TickTick no-ops preserve the public data version while bridge side effects still change it', async () => {
  const runtime = await externalRuntime();
  const list = await ticktickService.createTickTickList({ name: 'B7 no-op' });
  const question = await environment.databaseService.createQuestion({
    title: 'B7 bridge no-op', content: '', wrong_thinking: '', wrong_solution: '', correct_solution: '', answer: '',
    subject: '高等数学', category: '函数、极限、连续', question_type: '解答题', error_reason: '概念不清',
    source: 'b7', difficulty: '中等', mastery_level: '一般', note: '', tags: [], questionImageSources: [], solutionImageSources: []
  });
  const task = await command(runtime, 'tasks.create', { input: { list_id: list.id, title: 'B7 no-op task' } });
  assert.equal(task.kind, 'completed');

  const identicalUpdate = await command(runtime, 'tasks.update', {
    taskId: task.result.value.id,
    input: { title: '  B7 no-op task  ' }
  });
  assert.equal(identicalUpdate.kind, 'completed');
  assert.equal(identicalUpdate.result.changed, false);
  assert.deepEqual(identicalUpdate.result.dataVersion, task.result.dataVersion);
  assert.equal(identicalUpdate.result.value.updated_at, task.result.value.updated_at);

  const bridged = await command(runtime, 'tasks.create', { input: { list_id: list.id, title: 'B7 bridged no-op' } });
  assert.equal(bridged.kind, 'completed');
  const initialComplete = await command(runtime, 'tasks.complete', { taskId: bridged.result.value.id });
  assert.equal(initialComplete.kind, 'completed');
  assert.equal(initialComplete.result.changed, true);
  await ticktickService.createTickTickBridge({
    ticktick_task_id: bridged.result.value.id,
    linked_type: 'question',
    linked_id: String(question.id),
    sync_review: 1,
    sync_mastery: 0
  });

  const completed = await command(runtime, 'tasks.complete', { taskId: bridged.result.value.id });
  assert.equal(completed.kind, 'completed');
  assert.equal(completed.result.changed, true);
  assert.equal((await environment.databaseService.listReviewLogs(question.id)).length, 1);

  const duplicateComplete = await command(runtime, 'tasks.complete', { taskId: bridged.result.value.id });
  assert.equal(duplicateComplete.kind, 'completed');
  assert.equal(duplicateComplete.result.changed, false);
  assert.deepEqual(duplicateComplete.result.dataVersion, completed.result.dataVersion);
  assert.equal((await environment.databaseService.listReviewLogs(question.id)).length, 1);

  const uncompleted = await command(runtime, 'tasks.uncomplete', { taskId: bridged.result.value.id });
  assert.equal(uncompleted.kind, 'completed');
  assert.equal(uncompleted.result.changed, true);
  assert.equal((await environment.databaseService.listReviewLogs(question.id)).length, 0);

  const duplicateUncomplete = await command(runtime, 'tasks.uncomplete', { taskId: bridged.result.value.id });
  assert.equal(duplicateUncomplete.kind, 'completed');
  assert.equal(duplicateUncomplete.result.changed, false);
  assert.deepEqual(duplicateUncomplete.result.dataVersion, uncompleted.result.dataVersion);
  assert.equal((await environment.databaseService.listReviewLogs(question.id)).length, 0);
});

test('task delete resolves descendants authoritatively and bridge completion rolls back atomically', async () => {
  const runtime = await externalRuntime();
  const list = await ticktickService.createTickTickList({ name: 'B7 risk' });
  const parent = await adapter.createTickTickTaskFromRenderer({ list_id: list.id, title: 'Parent' });
  const child = await adapter.createTickTickTaskFromRenderer({ list_id: list.id, title: 'Child', parent_id: parent.id });
  const resolved = runtime.tickTick.resolveState({
    apiVersion: 1,
    kind: 'agent-command',
    operation: 'tasks.delete',
    payload: { taskId: parent.id },
    requestId: crypto.randomUUID(),
    expectedVersion: runtime.coordinator.currentVersion(),
    catalog: agent.operationCatalogIdentity
  }, agent.resolveOperationDescriptor('tasks.delete'));
  assert.equal(resolved.affectedEntityCount, 1);
  assert.equal(resolved.recursiveAffectedEntityCount, 2);
  assert.deepEqual(resolved.affectedEntities, [
    { entityType: 'task', entityId: child.id },
    { entityType: 'task', entityId: parent.id }
  ].sort((left, right) => `${left.entityType}\0${left.entityId}`.localeCompare(`${right.entityType}\0${right.entityId}`)));
  const deleted = await command(runtime, 'tasks.delete', { taskId: parent.id });
  assert.equal(deleted.kind, 'completed');
  assert.equal(await ticktickService.getTickTickTask(parent.id), null);
  assert.equal(await ticktickService.getTickTickTask(child.id), null);

  const question = await environment.databaseService.createQuestion({
    title: 'Atomic bridge', content: '', wrong_thinking: '', wrong_solution: '', correct_solution: '', answer: '',
    subject: '高等数学', category: '函数、极限、连续', question_type: '解答题', error_reason: '概念不清',
    source: 'b7', difficulty: '中等', mastery_level: '一般', note: '', tags: [], questionImageSources: [], solutionImageSources: []
  });
  const bridged = await adapter.createTickTickTaskFromRenderer({ list_id: list.id, title: 'Atomic complete' });
  await ticktickService.createTickTickBridge({ ticktick_task_id: bridged.id, linked_type: 'question', linked_id: String(question.id), sync_review: 1, sync_mastery: 0 });
  const coordinator = await environment.databaseService.getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: crypto.randomUUID(), concurrency: 'none', execute(database) {
      database.run("CREATE TRIGGER fail_b7_review BEFORE INSERT ON review_logs BEGIN SELECT RAISE(ABORT, 'forced b7 review failure'); END");
      return { changed: true, value: null };
    }
  });
  await assert.rejects(adapter.completeTickTickTaskFromRenderer(bridged.id), (error) => error?.code === 'INTERNAL_ERROR');
  assert.equal((await ticktickService.getTickTickTask(bridged.id)).is_completed, 0);
  assert.equal((await environment.databaseService.listReviewLogs(question.id)).length, 0);
});

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const electron = require('electron');
const handlers = new Map();
electron.app.isPackaged = true;
electron.ipcMain = {
  handle(channel, listener) { handlers.set(channel, listener); },
  on() {}
};
electron.BrowserWindow = class BrowserWindowStub {
  static getAllWindows() { return []; }
};
electron.screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) };

const realSetInterval = global.setInterval;
global.setInterval = () => ({ unref() {} });
const registerIpc = environment.requireMain('ipc/registerIpc.js');
global.setInterval = realSetInterval;
registerIpc.registerIpc();

const { createRendererExecutionContext } = environment.requireMain('application/executionContext.js');

function invoke(channel, ...args) {
  const handler = handlers.get(channel);
  assert.equal(typeof handler, 'function', `Missing IPC handler ${channel}`);
  return handler({}, ...args);
}

function input(overrides = {}) {
  return {
    title: 'A12 renderer E2E', content: 'content', wrong_thinking: 'wrong', wrong_solution: '',
    correct_solution: 'correct', answer: '1', subject: '高等数学', category: '函数、极限、连续',
    question_type: '解答题', error_reason: '概念不清', source: 'a12-renderer', difficulty: '中等',
    mastery_level: '一般', note: '', tags: ['a12'], questionImageSources: [], solutionImageSources: [],
    ...overrides
  };
}

test.after(() => environment.cleanupControlPlaneRoot());
test.beforeEach(environment.resetControlPlaneEnvironment);

test('renderer IPC writes are versioned, evented, journaled, and durable after reopen', async () => {
  const databaseService = environment.databaseService;
  const application = await databaseService.getQuestionsApplication();
  const coordinator = await databaseService.getDatabaseCoordinator();
  const initialVersion = coordinator.currentVersion();
  const observed = [];
  application.eventBus.subscribe((event) => observed.push(event));

  const source = path.join(environment.getControlPlanePaths().testRoot, 'a12-renderer-image.png');
  fs.writeFileSync(source, Buffer.from('a12-managed-image'));
  const createInput = input({ questionImageSources: [source] });
  const createdResponse = await invoke('questions:create', createInput);
  assert.equal(createdResponse.ok, true);
  const created = createdResponse.data;
  assert.equal(created.question_images.length, 1);
  const managedImage = path.join(
    environment.getControlPlanePaths().dataRoot,
    created.question_images[0].file_path.replaceAll('/', path.sep)
  );
  assert.equal(fs.existsSync(managedImage), true);

  const updateInput = input({ title: 'A12 renderer updated' });
  const updatedResponse = await invoke('questions:update', created.id, updateInput);
  assert.equal(updatedResponse.ok, true);
  assert.equal(updatedResponse.data.title, 'A12 renderer updated');

  const versionAfterUpdate = coordinator.currentVersion();
  const eventsAfterUpdate = observed.length;
  const noOpResponse = await invoke('questions:update', created.id, updateInput);
  assert.equal(noOpResponse.ok, true);
  assert.deepEqual(coordinator.currentVersion(), versionAfterUpdate);
  assert.equal(observed.length, eventsAfterUpdate);

  await assert.rejects(
    application.execute(
      { type: 'questions.mark_mastery', payload: { questionId: created.id, mastery: '已掌握' } },
      createRendererExecutionContext({
        expectedVersion: initialVersion,
        requestId: crypto.randomUUID(),
        traceId: crypto.randomUUID()
      })
    ),
    (error) => error?.code === 'DATA_REVISION_CONFLICT'
  );
  assert.equal(observed.length, eventsAfterUpdate);

  const reviewResponse = await invoke('reviews:submitResult', {
    questionId: created.id,
    result: 'correct',
    note: 'A12 durable review'
  });
  assert.equal(reviewResponse.ok, true);
  assert.equal(reviewResponse.data.question.review_count, 1);

  const removeResponse = await invoke('images:remove', created.question_images[0].id, true);
  assert.deepEqual(removeResponse, { ok: true, data: true });
  assert.equal(fs.existsSync(managedImage), false);

  const deleteResponse = await invoke('questions:delete', created.id, false);
  assert.deepEqual(deleteResponse, { ok: true, data: true });
  const durableVersion = coordinator.currentVersion();
  assert.deepEqual(observed.map((event) => event.type), [
    'questions.question_created',
    'questions.question_updated',
    'questions.review_submitted',
    'questions.image_removed',
    'questions.question_deleted'
  ]);
  assert.deepEqual(observed.map((event) => event.versionAfter.dataRevision), [1, 2, 3, 4, 5]);
  for (const event of observed) {
    assert.equal(Object.isFrozen(event), true);
    assert.equal(Object.isFrozen(event.payload), true);
  }

  const journalRoot = path.join(environment.getControlPlanePaths().dataRoot, 'data', 'operation-journal');
  const manifests = fs.readdirSync(journalRoot)
    .filter((name) => name.endsWith('.operation.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(journalRoot, name), 'utf8')));
  assert.ok(manifests.length >= 2);
  assert.ok(manifests.every((manifest) => manifest.state === 'completed'));

  databaseService.resetDatabaseConnection();
  const reopened = await databaseService.initializeDatabase();
  assert.equal(reopened.state, 'writable');
  assert.deepEqual((await databaseService.getDatabaseCoordinator()).currentVersion(), durableVersion);
  assert.deepEqual(await invoke('questions:get', created.id), { ok: true, data: null });
  assert.equal(fs.existsSync(managedImage), false);
});

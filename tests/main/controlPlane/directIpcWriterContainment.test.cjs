const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  cleanupControlPlaneRoot,
  databaseService,
  getControlPlanePaths,
  projectRoot,
  requireMain,
  resetControlPlaneEnvironment
} = require('../helpers/controlPlaneTestEnv.cjs');

const electron = require('electron');
const ipcHandlers = new Map();
const ipcListeners = new Map();
let engineTick;

electron.app.isPackaged = true;
electron.ipcMain = {
  handle(channel, listener) { ipcHandlers.set(channel, listener); },
  on(channel, listener) { ipcListeners.set(channel, listener); }
};
electron.BrowserWindow = class BrowserWindowStub {
  static getAllWindows() { return []; }
};
electron.screen = {
  getPrimaryDisplay() { return { workAreaSize: { width: 1920, height: 1080 } }; }
};

const realSetInterval = global.setInterval;
global.setInterval = (callback) => {
  engineTick = callback;
  return { unref() {} };
};
const registerIpcModule = requireMain('ipc/registerIpc.js');
global.setInterval = realSetInterval;
registerIpcModule.registerIpc();

const { createInternalExecutionContext } = requireMain('application/executionContext.js');

function invoke(channel, ...args) {
  const handler = ipcHandlers.get(channel);
  assert.equal(typeof handler, 'function', `missing IPC handler: ${channel}`);
  return handler({}, ...args);
}

function questionInput(title = 'Direct IPC containment concurrent question') {
  return {
    title, content: 'content', wrong_thinking: 'wrong', wrong_solution: '', correct_solution: 'correct', answer: '1',
    subject: '高等数学', category: '函数、极限、连续', question_type: '解答题', error_reason: '概念不清',
    source: 'test', difficulty: '中等', mastery_level: '一般', note: '', tags: [],
    questionImageSources: [], solutionImageSources: []
  };
}

function importItem(title = 'AI import containment question') {
  return {
    itemId: 'ai-item-1', title, content: 'content', wrongThinking: 'wrong', correctSolution: 'correct', answer: '1',
    subject: '高等数学', category: '函数、极限、连续', questionType: '解答题', errorReason: '概念不清',
    source: 'AI 导入', difficulty: '中等', masteryLevel: '未掌握', tags: [], knowledgePoints: []
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for asynchronous callback');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test.after(() => cleanupControlPlaneRoot());
test.beforeEach(() => registerIpcModule.clearRendererImageSelectionProofs());

test('registerIpc contains no mutable database acquisition or raw persistence bypass', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'src/main/ipc/registerIpc.ts'), 'utf8');
  assert.doesNotMatch(source, /\bgetDatabase\s*\(/);
  assert.doesNotMatch(source, /\bpersistDatabase\s*\(/);
  assert.doesNotMatch(source, /\b(?:createImportBatch|recordImportBatchItem)\s*\(/);
  assert.doesNotMatch(source, /database\.run\(['"](?:BEGIN|COMMIT|ROLLBACK)/);
  assert.match(source, /async function executeLegacyMutation/);
  assert.match(source, /legacy\.operation_completed/);
  assert.match(source, /getReadOnlyDatabase/);
});

test('renderer import staging denies an arbitrary local path and accepts only a main-process selection', async () => {
  await resetControlPlaneEnvironment();
  const arbitrary = path.join(getControlPlanePaths().testRoot, 'arbitrary-renderer.png');
  fs.writeFileSync(arbitrary, Buffer.from('arbitrary'));
  const denied = await invoke('imports:stageSelectedImages', 'invalid-selection-token');
  assert.equal(denied.ok, false);
  assert.match(denied.error, /selection token is invalid or expired/);

  electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [arbitrary] });
  const selection = (await invoke('imports:selectImages')).data;
  assert.deepEqual(selection.filePaths, [path.normalize(arbitrary)]);
  const staged = (await invoke('imports:stageSelectedImages', selection.selectionToken)).data;
  assert.equal(staged.length, 1);
  assert.equal('filePath' in staged[0], false);
  const database = await databaseService.getDatabase();
  assert.equal(databaseService.oneSql(database, 'SELECT COUNT(*) AS count FROM import_managed_assets WHERE asset_id = ?', [staged[0].assetId]).count, 1);
});

test('C11 AI import metadata failure rolls back apply and preserves exact pre-apply revision', async () => {
  await resetControlPlaneEnvironment();
  const draft = (await invoke('imports:createDraft', { source: 'app_ocr_deepseek', networkDisclosure: 'deepseek_text_only', items: [importItem()] })).data;
  const validation = (await invoke('imports:validateDraft', draft.draftId)).data;
  const coordinator = await databaseService.getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: 'install-c11-ai-import-failure-trigger',
    concurrency: 'none',
    execute(database) {
      database.run(`CREATE TRIGGER fail_c11_ai_import_item BEFORE INSERT ON import_batch_items
        BEGIN SELECT RAISE(ABORT, 'forced C11 AI import failure'); END`);
      return { changed: true, value: null };
    }
  });
  const versionBefore = coordinator.currentVersion();

  const failed = await invoke('imports:applyDraft', draft.draftId, validation.previewHash);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /internal error/i);
  assert.deepEqual(coordinator.currentVersion(), versionBefore);
  const database = await databaseService.getDatabase();
  assert.equal(databaseService.oneSql(database, "SELECT COUNT(*) AS count FROM import_batches WHERE source = 'app_ocr_deepseek'").count, 0);
  assert.equal(databaseService.oneSql(database, "SELECT COUNT(*) AS count FROM import_batch_items WHERE target_table = 'questions'").count, 0);
  assert.equal(databaseService.oneSql(database, "SELECT state FROM import_drafts WHERE draft_id = ?", [draft.draftId]).state, 'validated');
});

test('C11 AI apply and a question command serialize into exact durable revisions', async () => {
  await resetControlPlaneEnvironment();
  const draft = (await invoke('imports:createDraft', { source: 'app_ocr_deepseek', networkDisclosure: 'deepseek_text_only', items: [importItem('AI durable import')] })).data;
  const validation = (await invoke('imports:validateDraft', draft.draftId)).data;
  const coordinator = await databaseService.getDatabaseCoordinator();
  const application = await databaseService.getQuestionsApplication();
  const versionBefore = coordinator.currentVersion();

  const question = await application.execute(
    { type: 'questions.create', payload: { input: questionInput() } },
    createInternalExecutionContext({ concurrency: 'none', requestId: crypto.randomUUID(), traceId: crypto.randomUUID() })
  );
  const applied = (await invoke('imports:applyDraft', draft.draftId, validation.previewHash)).data;
  assert.equal(applied.createdQuestionIds.length, 1);
  assert.equal(coordinator.currentVersion().dataRevision, versionBefore.dataRevision + 2);

  const durableVersion = coordinator.currentVersion();
  databaseService.resetDatabaseConnection();
  await databaseService.initializeDatabase();
  const database = await databaseService.getDatabase();
  assert.equal(databaseService.oneSql(database, 'SELECT COUNT(*) AS count FROM questions WHERE id = ?', [question.value.id]).count, 1);
  assert.equal(databaseService.oneSql(database, 'SELECT COUNT(*) AS count FROM questions WHERE id = ?', [applied.createdQuestionIds[0]]).count, 1);
  assert.equal(databaseService.oneSql(database, "SELECT state FROM import_drafts WHERE draft_id = ?", [draft.draftId]).state, 'applied');
  assert.deepEqual((await databaseService.getDatabaseCoordinator()).currentVersion(), durableVersion);
});

test('white-noise read is pure and identical writes preserve the revision and envelope', async () => {
  await resetControlPlaneEnvironment();
  const coordinator = await databaseService.getDatabaseCoordinator();
  const application = await databaseService.getQuestionsApplication();
  const events = [];
  application.eventBus.subscribe((event) => {
    if (event.type === 'legacy.operation_completed') events.push(event);
  });
  const versionBefore = coordinator.currentVersion();

  assert.deepEqual(await invoke('ticktick:whiteNoise:get'), {
    ok: true,
    data: { enabled: false, noise: 'none' }
  });
  assert.deepEqual(coordinator.currentVersion(), versionBefore);

  const state = { enabled: true, noise: 'rain' };
  assert.deepEqual(await invoke('ticktick:whiteNoise:set', state), { ok: true, data: undefined });
  const versionAfter = coordinator.currentVersion();
  assert.equal(versionAfter.dataRevision, versionBefore.dataRevision + 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.operation, 'ipc-white-noise-set');

  assert.deepEqual(await invoke('ticktick:whiteNoise:set', state), { ok: true, data: undefined });
  assert.deepEqual(coordinator.currentVersion(), versionAfter);
  assert.equal(events.length, 1);

  databaseService.resetDatabaseConnection();
  await databaseService.initializeDatabase();
  assert.deepEqual(await invoke('ticktick:whiteNoise:get'), { ok: true, data: state });
  assert.deepEqual((await databaseService.getDatabaseCoordinator()).currentVersion(), versionAfter);
});

test('white-noise publication failure restores durable state and does not report success', async () => {
  await resetControlPlaneEnvironment();
  const coordinator = await databaseService.getDatabaseCoordinator();
  const versionBefore = coordinator.currentVersion();
  coordinator.publisher = async () => {
    throw new Error('forced direct IPC publication failure');
  };

  const response = await invoke('ticktick:whiteNoise:set', { enabled: true, noise: 'cafe' });
  assert.equal(response.ok, false);
  assert.match(response.error, /forced direct IPC publication failure/);
  assert.deepEqual(coordinator.currentVersion(), versionBefore);
  assert.deepEqual(await invoke('ticktick:whiteNoise:get'), {
    ok: true,
    data: { enabled: false, noise: 'none' }
  });

  databaseService.resetDatabaseConnection();
  await databaseService.initializeDatabase();
  assert.deepEqual(await invoke('ticktick:whiteNoise:get'), {
    ok: true,
    data: { enabled: false, noise: 'none' }
  });
});

test('focus session-end publication failure is observed without false persistence', async () => {
  await resetControlPlaneEnvironment();
  assert.equal(typeof engineTick, 'function');
  await invoke('timer:reset');
  await invoke('timer:setConfig', { focusMinutes: 0 });
  const coordinator = await databaseService.getDatabaseCoordinator();
  const versionBefore = coordinator.currentVersion();
  coordinator.publisher = async () => {
    throw new Error('forced timer publication failure');
  };
  const errors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => { errors.push(args); };

  try {
    await invoke('timer:start');
    engineTick();
    await waitFor(() => errors.length > 0);
  } finally {
    console.error = originalConsoleError;
  }

  assert.match(String(errors[0][0]), /focusTimerEngine: saveSession failed/);
  assert.match(String(errors[0][1]), /forced timer publication failure/);
  assert.deepEqual(coordinator.currentVersion(), versionBefore);
  assert.equal(databaseService.oneSql(await databaseService.getDatabase(), 'SELECT COUNT(*) AS count FROM ticktick_focus_sessions').count, 0);
  const timerResponse = await invoke('timer:getState');
  assert.equal(timerResponse.ok, true);
  assert.equal(timerResponse.data.status, 'break');
  assert.equal(timerResponse.data.completedSessions, 1);
  assert.equal(fs.existsSync(path.join(getControlPlanePaths().dataRoot, 'data', 'mistakes.db')), true);
});

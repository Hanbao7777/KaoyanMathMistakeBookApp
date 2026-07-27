const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  cleanupControlPlaneRoot,
  databaseService,
  projectRoot,
  requireMain,
  resetControlPlaneEnvironment
} = require('../helpers/controlPlaneTestEnv.cjs');

const { createInternalExecutionContext } = requireMain('application/executionContext.js');
const deepseekService = requireMain('services/deepseekService.js');

const settings = Object.freeze({
  apiKey: 'isolated-test-key',
  model: 'deepseek-reasoner',
  baseUrl: 'https://example.invalid/v1'
});

function questionInput() {
  return {
    title: 'DeepSeek settings concurrent question', content: 'content', wrong_thinking: 'wrong', wrong_solution: '', correct_solution: 'correct', answer: '1',
    subject: '高等数学', category: '函数、极限、连续', question_type: '解答题', error_reason: '概念不清',
    source: 'test', difficulty: '中等', mastery_level: '一般', note: '', tags: [], questionImageSources: [], solutionImageSources: []
  };
}

test.after(() => cleanupControlPlaneRoot());

test('DeepSeek settings service has no raw persistence or mutable read acquisition', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'src/main/services/deepseekService.ts'), 'utf8');
  assert.doesNotMatch(source, /\b(?:persistDatabase|getDatabase)\b/);
  assert.doesNotMatch(source, /database\.run\(['"](?:BEGIN|COMMIT|ROLLBACK)/);
  assert.match(source, /async function executeLegacyMutation/);
  assert.match(source, /getReadOnlyDatabase/);
  assert.match(source, /legacy\.operation_completed/);
});

test('settings read is pure and does not seed the settings table', async () => {
  await resetControlPlaneEnvironment();
  const coordinator = await databaseService.getDatabaseCoordinator();
  const versionBefore = coordinator.currentVersion();

  assert.deepEqual(await deepseekService.getDeepSeekSettings(), {
    apiKey: '',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com/v1'
  });
  assert.deepEqual(coordinator.currentVersion(), versionBefore);
  const table = databaseService.oneSql(
    await databaseService.getDatabase(),
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'"
  );
  assert.equal(table, null);
});

test('settings save is durable before success and identical save is a no-op', async () => {
  await resetControlPlaneEnvironment();
  const coordinator = await databaseService.getDatabaseCoordinator();
  const application = await databaseService.getQuestionsApplication();
  const events = [];
  application.eventBus.subscribe((event) => {
    if (event.type === 'legacy.operation_completed') events.push(event);
  });
  const versionBefore = coordinator.currentVersion();

  assert.deepEqual(await deepseekService.saveDeepSeekSettings(settings), settings);
  const versionAfter = coordinator.currentVersion();
  assert.equal(versionAfter.dataRevision, versionBefore.dataRevision + 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.operation, 'deepseek-settings-save');

  assert.deepEqual(await deepseekService.saveDeepSeekSettings(settings), settings);
  assert.deepEqual(coordinator.currentVersion(), versionAfter);
  assert.equal(events.length, 1);

  databaseService.resetDatabaseConnection();
  await databaseService.initializeDatabase();
  assert.deepEqual(await deepseekService.getDeepSeekSettings(), settings);
  assert.deepEqual((await databaseService.getDatabaseCoordinator()).currentVersion(), versionAfter);
});

test('settings mutation failure propagates and rolls back value and revision', async () => {
  await resetControlPlaneEnvironment();
  await deepseekService.saveDeepSeekSettings(settings);
  const coordinator = await databaseService.getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: 'install-deepseek-failure-trigger',
    concurrency: 'none',
    execute(database) {
      database.run(`CREATE TRIGGER fail_deepseek_insert BEFORE INSERT ON app_settings
        WHEN NEW.key = 'deepseek'
        BEGIN SELECT RAISE(ABORT, 'forced DeepSeek settings failure'); END`);
      return { changed: true, value: null };
    }
  });
  const versionBefore = coordinator.currentVersion();
  const replacement = { ...settings, model: 'failed-model' };

  await assert.rejects(deepseekService.saveDeepSeekSettings(replacement), /forced DeepSeek settings failure/);
  assert.deepEqual(coordinator.currentVersion(), versionBefore);
  assert.deepEqual(await deepseekService.getDeepSeekSettings(), settings);

  databaseService.resetDatabaseConnection();
  await databaseService.initializeDatabase();
  assert.deepEqual(await deepseekService.getDeepSeekSettings(), settings);
});

test('settings publication failure rejects and restores the durable value', async () => {
  await resetControlPlaneEnvironment();
  await deepseekService.saveDeepSeekSettings(settings);
  const coordinator = await databaseService.getDatabaseCoordinator();
  const versionBefore = coordinator.currentVersion();
  coordinator.publisher = async () => {
    throw new Error('forced DeepSeek publication failure');
  };

  await assert.rejects(
    deepseekService.saveDeepSeekSettings({ ...settings, model: 'unpublished-model' }),
    /forced DeepSeek publication failure/
  );
  assert.deepEqual(coordinator.currentVersion(), versionBefore);
  assert.deepEqual(await deepseekService.getDeepSeekSettings(), settings);

  databaseService.resetDatabaseConnection();
  await databaseService.initializeDatabase();
  assert.deepEqual(await deepseekService.getDeepSeekSettings(), settings);
});

test('question command and settings save serialize into durable revisions', async () => {
  await resetControlPlaneEnvironment();
  const coordinator = await databaseService.getDatabaseCoordinator();
  const application = await databaseService.getQuestionsApplication();
  const versionBefore = coordinator.currentVersion();
  const questionPromise = application.execute(
    { type: 'questions.create', payload: { input: questionInput() } },
    createInternalExecutionContext({
      concurrency: 'none',
      requestId: crypto.randomUUID(),
      traceId: crypto.randomUUID()
    })
  );
  const settingsPromise = deepseekService.saveDeepSeekSettings(settings);

  const [question] = await Promise.all([questionPromise, settingsPromise]);
  assert.equal(coordinator.currentVersion().dataRevision, versionBefore.dataRevision + 2);
  const durableVersion = coordinator.currentVersion();

  databaseService.resetDatabaseConnection();
  await databaseService.initializeDatabase();
  assert.equal(databaseService.oneSql(
    await databaseService.getDatabase(),
    'SELECT COUNT(*) AS count FROM questions WHERE id = ?',
    [question.value.id]
  ).count, 1);
  assert.deepEqual(await deepseekService.getDeepSeekSettings(), settings);
  assert.deepEqual((await databaseService.getDatabaseCoordinator()).currentVersion(), durableVersion);
});

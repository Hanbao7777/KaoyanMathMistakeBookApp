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

const { createInternalExecutionContext } = requireMain('application/executionContext.js');
const ticktickService = requireMain('services/ticktickService.js');

function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function questionInput() {
  return {
    title: 'TickTick 并发问题', content: 'content', wrong_thinking: 'wrong', wrong_solution: '',
    correct_solution: 'correct', answer: '1', subject: '高等数学', category: '函数、极限、连续',
    question_type: '解答题', error_reason: '概念不清', source: 'test', difficulty: '中等',
    mastery_level: '一般', note: '', tags: [], questionImageSources: [], solutionImageSources: []
  };
}

async function initializeEnvironment() {
  await resetControlPlaneEnvironment();
  await ticktickService.initializeTickTickService();
}

test.after(() => cleanupControlPlaneRoot());

test('TickTick service has no raw persistence or local transaction ownership', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'src/main/services/ticktickService.ts'), 'utf8');
  assert.doesNotMatch(source, /\b(?:persistDatabase|getDatabase)\b/);
  assert.doesNotMatch(source, /database\.run\(['"](?:BEGIN|COMMIT|ROLLBACK)/);
  assert.match(source, /async function executeLegacyMutation/);
  assert.match(source, /export async function initializeTickTickService/);
  assert.match(source, /legacy\.operation_completed/);
});

test('TickTick reads are pure before explicit initialization', async () => {
  await resetControlPlaneEnvironment();
  const coordinator = await databaseService.getDatabaseCoordinator();
  const versionBefore = coordinator.currentVersion();

  assert.deepEqual(await ticktickService.listTickTickLists(), []);
  assert.deepEqual(await ticktickService.listTickTickTasks(), []);
  assert.deepEqual(await ticktickService.listTickTickTags(), []);
  assert.deepEqual(await ticktickService.listTickTickFocusSessions(), []);
  assert.deepEqual(await ticktickService.listTickTickHabits(), []);
  assert.equal((await ticktickService.getTickTickSettings()).pomodoro.focusMinutes, 25);
  assert.deepEqual(coordinator.currentVersion(), versionBefore);

  const database = await databaseService.getDatabase();
  assert.equal(databaseService.oneSql(database,
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'").count, 0);
});

test('explicit initialization creates durable defaults, cleans tags, and repeats as a no-op', async () => {
  await resetControlPlaneEnvironment();
  const coordinator = await databaseService.getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: 'seed-orphan-ticktick-tag',
    concurrency: 'none',
    execute(database) {
      database.run("INSERT INTO ticktick_tags (id, name, color) VALUES ('tag_orphan', 'orphan', '#999999')");
      return { changed: true, value: null };
    }
  });
  const versionBefore = coordinator.currentVersion();

  await ticktickService.initializeTickTickService();
  const versionAfter = coordinator.currentVersion();
  assert.equal(versionAfter.dataRevision, versionBefore.dataRevision + 1);
  assert.deepEqual(await ticktickService.listTickTickTags(), []);
  assert.equal((await ticktickService.getTickTickSettings()).pomodoro.focusMinutes, 25);

  await ticktickService.initializeTickTickService();
  assert.deepEqual(coordinator.currentVersion(), versionAfter);

  databaseService.resetDatabaseConnection();
  await databaseService.initializeDatabase();
  assert.equal((await ticktickService.getTickTickSettings()).pomodoro.focusMinutes, 25);
  assert.deepEqual((await databaseService.getDatabaseCoordinator()).currentVersion(), versionAfter);
});

test('question command and TickTick write serialize into two durable revisions', async () => {
  await initializeEnvironment();
  const coordinator = await databaseService.getDatabaseCoordinator();
  const application = await databaseService.getQuestionsApplication();
  const versionBefore = coordinator.currentVersion();
  const questionPromise = application.execute(
    { type: 'questions.create', payload: { input: questionInput() } },
    createInternalExecutionContext({ concurrency: 'none', requestId: crypto.randomUUID(), traceId: crypto.randomUUID() })
  );
  const listPromise = ticktickService.createTickTickList({ name: '并发清单' });

  const [question, list] = await Promise.all([questionPromise, listPromise]);
  assert.ok(question.value.id);
  assert.ok(list.id);
  assert.equal(coordinator.currentVersion().dataRevision, versionBefore.dataRevision + 2);

  const durableVersion = coordinator.currentVersion();
  databaseService.resetDatabaseConnection();
  await databaseService.initializeDatabase();
  const database = await databaseService.getDatabase();
  assert.equal(databaseService.oneSql(database, 'SELECT COUNT(*) AS count FROM questions WHERE id = ?', [question.value.id]).count, 1);
  assert.equal(databaseService.oneSql(database, 'SELECT COUNT(*) AS count FROM ticktick_lists WHERE id = ?', [list.id]).count, 1);
  assert.deepEqual((await databaseService.getDatabaseCoordinator()).currentVersion(), durableVersion);
});

test('focus, bridge, settings, and habit writers each publish one durable revision', async () => {
  await initializeEnvironment();
  const coordinator = await databaseService.getDatabaseCoordinator();
  const versionBefore = coordinator.currentVersion();
  const list = await ticktickService.createTickTickList({ name: '包含测试清单' });
  const task = await ticktickService.createTickTickTask({ list_id: list.id, title: '包含测试任务' });
  const focus = await ticktickService.createTickTickFocusSession({
    task_id: task.id,
    start_time: '2026-07-15T08:00:00.000Z',
    end_time: '2026-07-15T08:25:00.000Z',
    duration_minutes: 25
  });
  const bridge = await ticktickService.createTickTickBridge({
    ticktick_task_id: task.id,
    linked_type: 'question',
    linked_id: '999',
    sync_review: 1,
    sync_mastery: 0
  });
  const settings = await ticktickService.saveTickTickSettings({
    pomodoro: { focusMinutes: 30, shortBreakMinutes: 5, longBreakMinutes: 15, sessionsBeforeLongBreak: 4 },
    autoCreateReviewTasks: true,
    whiteNoise: 'rain',
    defaultListId: list.id
  });
  const habit = await ticktickService.createTickTickHabit({ name: '每日复盘' });
  const log = await ticktickService.toggleTickTickHabit(habit.id, localDate());

  assert.ok(focus.id);
  assert.ok(bridge.id);
  assert.equal(settings.pomodoro.focusMinutes, 30);
  assert.ok(log.id);
  assert.equal(coordinator.currentVersion().dataRevision, versionBefore.dataRevision + 7);
  assert.equal((await ticktickService.listTickTickHabits())[0].today_completed, 1);

  const durableVersion = coordinator.currentVersion();
  databaseService.resetDatabaseConnection();
  await databaseService.initializeDatabase();
  assert.equal((await ticktickService.listTickTickFocusSessions()).length, 1);
  assert.equal((await ticktickService.getTickTickTaskBridges(task.id)).length, 1);
  assert.equal((await ticktickService.getTickTickSettings()).pomodoro.focusMinutes, 30);
  assert.equal((await ticktickService.getTickTickHabitLogs(habit.id)).length, 1);
  assert.deepEqual((await databaseService.getDatabaseCoordinator()).currentVersion(), durableVersion);
});

test('TickTick mutation failure propagates and rolls back data and revision', async () => {
  await initializeEnvironment();
  const coordinator = await databaseService.getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: 'install-ticktick-failure-trigger',
    concurrency: 'none',
    execute(database) {
      database.run(`CREATE TRIGGER fail_ticktick_list_insert BEFORE INSERT ON ticktick_lists
        BEGIN SELECT RAISE(ABORT, 'forced TickTick failure'); END`);
      return { changed: true, value: null };
    }
  });
  const versionBefore = coordinator.currentVersion();

  await assert.rejects(ticktickService.createTickTickList({ name: '失败清单' }), /forced TickTick failure/);
  assert.deepEqual(coordinator.currentVersion(), versionBefore);
  assert.equal(databaseService.oneSql(await databaseService.getDatabase(), 'SELECT COUNT(*) AS count FROM ticktick_lists').count, 0);
});

test('validated TickTick no-ops do not publish or revise', async () => {
  await initializeEnvironment();
  const coordinator = await databaseService.getDatabaseCoordinator();
  const application = await databaseService.getQuestionsApplication();
  const events = [];
  application.eventBus.subscribe((event) => {
    if (event.type === 'legacy.operation_completed') events.push(event);
  });
  const versionBefore = coordinator.currentVersion();

  assert.equal(await ticktickService.updateTickTickTask('missing-task', { title: 'missing' }), null);
  assert.equal(await ticktickService.deleteTickTickBridge(-1), true);
  await ticktickService.reorderTickTickLists([]);
  await ticktickService.initializeTickTickService();

  assert.deepEqual(coordinator.currentVersion(), versionBefore);
  assert.equal(events.length, 0);
});

test('owned durability path stays inside the isolated control-plane root', () => {
  const databasePath = path.join(getControlPlanePaths().dataRoot, 'data', 'mistakes.db');
  assert.equal(fs.existsSync(databasePath), true);
});

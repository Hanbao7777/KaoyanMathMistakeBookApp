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
const studySupervisorService = requireMain('services/studySupervisorService.js');

function localDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00`);
  date.setDate(date.getDate() + days);
  return localDate(date);
}

function taskInput(overrides = {}) {
  return {
    task_date: localDate(),
    subject_id: 'math',
    title: '协调器包含测试任务',
    task_type: '刷题',
    estimated_minutes: 30,
    priority: '中',
    status: '未开始',
    ...overrides
  };
}

function questionInput() {
  return {
    title: '并发问题命令', content: 'content', wrong_thinking: 'wrong', wrong_solution: '', correct_solution: 'correct', answer: '1',
    subject: '高等数学', category: '函数、极限、连续', question_type: '解答题', error_reason: '概念不清',
    source: 'test', difficulty: '中等', mastery_level: '一般', note: '', tags: [], questionImageSources: [], solutionImageSources: []
  };
}

async function initializeEnvironment() {
  await resetControlPlaneEnvironment();
  await studySupervisorService.initializeStudySupervisor();
}

test.after(() => cleanupControlPlaneRoot());

test('study service has no raw persistence or local transaction ownership', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'src/main/services/studySupervisorService.ts'), 'utf8');
  assert.doesNotMatch(source, /\b(?:persistDatabase|getDatabase)\b/);
  assert.doesNotMatch(source, /database\.run\(['"](?:BEGIN|COMMIT|ROLLBACK)/);
  assert.match(source, /async function executeLegacyMutation/);
  assert.match(source, /export async function initializeStudySupervisor/);
  assert.match(source, /legacy\.operation_completed/);
});

test('reads do not seed defaults, roll tasks, or revise data', async () => {
  await resetControlPlaneEnvironment();
  const coordinator = await databaseService.getDatabaseCoordinator();
  const versionBefore = coordinator.currentVersion();

  assert.equal(await studySupervisorService.getStudySettings(), null);
  assert.deepEqual(await studySupervisorService.listStudySubjects(), []);
  assert.deepEqual(await studySupervisorService.listStudyMaterials(), []);
  assert.deepEqual(await studySupervisorService.listStudyTasks(), []);
  assert.deepEqual(await studySupervisorService.listTodayStudyTasks(), []);
  assert.deepEqual(await studySupervisorService.listStudySessions(), []);
  assert.equal(await studySupervisorService.getDailyReview(), null);
  await assert.rejects(studySupervisorService.getStudySupervisorDashboard(), /not initialized/);
  assert.deepEqual(coordinator.currentVersion(), versionBefore);

  await studySupervisorService.initializeStudySupervisor();
  const overdue = await studySupervisorService.createStudyTask(taskInput({ task_date: addDays(localDate(), -1) }));
  const versionAfterCreate = coordinator.currentVersion();
  await studySupervisorService.listTodayStudyTasks();
  await studySupervisorService.getStudySupervisorDashboard();
  assert.deepEqual(coordinator.currentVersion(), versionAfterCreate);
  const row = databaseService.oneSql(await databaseService.getDatabase(), 'SELECT task_date, defer_count FROM study_tasks WHERE id = ?', [overdue.id]);
  assert.equal(row.task_date, addDays(localDate(), -1));
  assert.equal(row.defer_count, 0);
});

test('initialization is durable and repeated initialization is a no-op', async () => {
  await resetControlPlaneEnvironment();
  const coordinator = await databaseService.getDatabaseCoordinator();
  const versionBefore = coordinator.currentVersion();
  await studySupervisorService.initializeStudySupervisor();
  const versionAfter = coordinator.currentVersion();
  assert.equal(versionAfter.dataRevision, versionBefore.dataRevision + 1);

  await studySupervisorService.initializeStudySupervisor();
  assert.deepEqual(coordinator.currentVersion(), versionAfter);

  databaseService.resetDatabaseConnection();
  await databaseService.initializeDatabase();
  assert.equal((await studySupervisorService.listStudySubjects()).length, 4);
  assert.deepEqual((await databaseService.getDatabaseCoordinator()).currentVersion(), versionAfter);
});

test('question command and legacy study write serialize into durable revisions', async () => {
  await initializeEnvironment();
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
  const taskPromise = studySupervisorService.createStudyTask(taskInput());

  const [question, task] = await Promise.all([questionPromise, taskPromise]);
  assert.ok(question.value.id);
  assert.ok(task.id);
  assert.equal(coordinator.currentVersion().dataRevision, versionBefore.dataRevision + 2);

  const durableVersion = coordinator.currentVersion();
  databaseService.resetDatabaseConnection();
  await databaseService.initializeDatabase();
  const database = await databaseService.getDatabase();
  assert.equal(databaseService.oneSql(database, 'SELECT COUNT(*) AS count FROM questions WHERE id = ?', [question.value.id]).count, 1);
  assert.equal(databaseService.oneSql(database, 'SELECT COUNT(*) AS count FROM study_tasks WHERE id = ?', [task.id]).count, 1);
  assert.deepEqual((await databaseService.getDatabaseCoordinator()).currentVersion(), durableVersion);
});

test('study mutation failure propagates and rolls back data and revision', async () => {
  await initializeEnvironment();
  const coordinator = await databaseService.getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: 'install-study-failure-trigger',
    concurrency: 'none',
    execute(database) {
      database.run(`CREATE TRIGGER fail_study_task_insert BEFORE INSERT ON study_tasks
        BEGIN SELECT RAISE(ABORT, 'forced study failure'); END`);
      return { changed: true, value: null };
    }
  });
  const versionBefore = coordinator.currentVersion();

  await assert.rejects(studySupervisorService.createStudyTask(taskInput()), /forced study failure/);
  assert.deepEqual(coordinator.currentVersion(), versionBefore);
  assert.equal(databaseService.oneSql(await databaseService.getDatabase(), 'SELECT COUNT(*) AS count FROM study_tasks').count, 0);
});

test('validated study no-op does not publish or revise', async () => {
  await initializeEnvironment();
  const coordinator = await databaseService.getDatabaseCoordinator();
  const application = await databaseService.getQuestionsApplication();
  const events = [];
  application.eventBus.subscribe((event) => {
    if (event.type === 'legacy.operation_completed') events.push(event);
  });
  const versionBefore = coordinator.currentVersion();

  assert.equal(await studySupervisorService.completeStudyTask('missing-task'), null);
  assert.equal(events.length, 0);
  assert.deepEqual(await studySupervisorService.rolloverStudyTasks(), { rolled: 0, skipped: false });
  const versionAfterRollover = coordinator.currentVersion();
  assert.equal(versionAfterRollover.dataRevision, versionBefore.dataRevision + 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.operation, 'study-task-rollover');
  assert.deepEqual(events[0].versionBefore, versionBefore);
  assert.deepEqual(events[0].versionAfter, versionAfterRollover);
  assert.deepEqual(await studySupervisorService.rolloverStudyTasks(), { rolled: 0, skipped: true });
  assert.deepEqual(coordinator.currentVersion(), versionAfterRollover);
  assert.equal(events.length, 1);
});

test('owned durability paths stay inside the isolated control-plane root', () => {
  const databasePath = path.join(getControlPlanePaths().dataRoot, 'data', 'mistakes.db');
  assert.equal(fs.existsSync(databasePath), true);
});

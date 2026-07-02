const assert = require('node:assert/strict');
const test = require('node:test');
const {
  cleanupTestRoot,
  databaseService,
  requireMain,
  resetTestDatabase
} = require('./helpers/mainTestEnv.cjs');

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

async function getTask(taskId) {
  const db = await databaseService.getDatabase();
  return databaseService.oneSql(db, 'SELECT * FROM study_tasks WHERE id = ?', [taskId]);
}

async function getSettings() {
  const db = await databaseService.getDatabase();
  return databaseService.oneSql(db, 'SELECT * FROM study_settings WHERE id = 1');
}

async function getDailyReview(reviewDate) {
  const db = await databaseService.getDatabase();
  return databaseService.oneSql(db, 'SELECT * FROM daily_reviews WHERE review_date = ?', [reviewDate]);
}

async function createTask(overrides = {}) {
  return studySupervisorService.createStudyTask({
    task_date: localDate(),
    subject_id: 'math',
    title: '监督闭环任务',
    task_type: '刷题',
    estimated_minutes: 30,
    priority: '中',
    status: '未开始',
    ...overrides
  });
}

test.after(cleanupTestRoot);

test.beforeEach(resetTestDatabase);

test('completeStudyTask marks task completed with minutes, quality, and completed_at', async () => {
  const task = await createTask({ title: '完成任务' });

  const updated = await studySupervisorService.completeStudyTask(task.id, {
    actual_minutes: 30,
    completion_quality: '良好',
    note: '完成备注'
  });

  assert.ok(updated);
  assert.equal(updated.status, '已完成');
  assert.equal(updated.actual_minutes, 30);
  assert.equal(updated.completion_quality, '良好');
  assert.ok(updated.completed_at);

  const row = await getTask(task.id);
  assert.equal(row.status, '已完成');
  assert.equal(row.actual_minutes, 30);
  assert.equal(row.completion_quality, '良好');
  assert.ok(row.completed_at);
});

test('skipStudyTask records skip reason and rejects blank reason', async () => {
  const task = await createTask({ title: '跳过任务' });
  const blankTask = await createTask({ title: '空原因跳过任务' });

  const skipped = await studySupervisorService.skipStudyTask(task.id, '  临时调整计划  ');

  assert.ok(skipped);
  assert.equal(skipped.status, '已跳过');
  assert.equal(skipped.skipped_reason, '临时调整计划');
  assert.ok(skipped.completed_at);

  const row = await getTask(task.id);
  assert.equal(row.status, '已跳过');
  assert.equal(row.skipped_reason, '临时调整计划');
  assert.ok(row.completed_at);

  await assert.rejects(
    () => studySupervisorService.skipStudyTask(blankTask.id, '   '),
    /必须填写原因/
  );
});

test('rolloverStudyTasks force-rolls overdue incomplete tasks to today', async () => {
  const today = localDate();
  const yesterday = addDays(today, -1);
  const task = await createTask({ title: '逾期任务', task_date: yesterday, status: '未开始' });

  const result = await studySupervisorService.rolloverStudyTasks(true);

  assert.equal(result.rolled, 1);
  assert.equal(result.skipped, false);

  const row = await getTask(task.id);
  assert.equal(row.task_date, today);
  assert.equal(row.defer_count, 1);
  assert.equal(row.original_date, yesterday);

  const settings = await getSettings();
  assert.equal(settings.last_rollover_date, today);

  const skipped = await studySupervisorService.rolloverStudyTasks();
  assert.deepEqual(skipped, { rolled: 0, skipped: true });
});

test('saveDailyReview persists same-day task and session summary fields', async () => {
  const today = localDate();
  await createTask({ title: '今日完成任务', task_date: today, status: '已完成', actual_minutes: 20, completion_quality: '良好' });
  await createTask({ title: '今日未完成任务', task_date: today, status: '未开始' });
  await createTask({ title: '昨日完成任务', task_date: addDays(today, -1), status: '已完成', actual_minutes: 99, completion_quality: '很好' });
  await studySupervisorService.createStudySession({
    session_date: today,
    subject_id: 'math',
    start_time: `${today}T08:00:00.000Z`,
    end_time: `${today}T08:45:00.000Z`,
    duration_minutes: 45,
    quality: '良好',
    note: '今日学习记录'
  });
  await studySupervisorService.createStudySession({
    session_date: addDays(today, -1),
    subject_id: 'math',
    start_time: `${addDays(today, -1)}T08:00:00.000Z`,
    duration_minutes: 90,
    quality: '很好'
  });

  const review = await studySupervisorService.saveDailyReview({
    review_date: today,
    mood: '一般',
    today_summary: '今日复盘'
  });

  assert.ok(review);
  assert.equal(review.completed_task_count, 1);
  assert.equal(review.total_task_count, 2);
  assert.equal(review.total_study_minutes, 45);
  assert.equal(review.completion_rate, 50);

  const row = await getDailyReview(today);
  assert.equal(row.completed_task_count, 1);
  assert.equal(row.total_task_count, 2);
  assert.equal(row.total_study_minutes, 45);
  assert.equal(row.completion_rate, 50);
});

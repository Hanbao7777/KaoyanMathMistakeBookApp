const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  cleanupTestRoot,
  databaseService,
  requireMain,
  resetTestDatabase
} = require('./helpers/mainTestEnv.cjs');

const bridgeService = requireMain('services/bridgeService.js');
const ticktickService = requireMain('services/ticktickService.js');

test.after(cleanupTestRoot);

test.beforeEach(resetTestDatabase);

async function createQuestion(overrides = {}) {
  return databaseService.createQuestion({
    title: '桥接复习题',
    content: '题目内容',
    wrong_thinking: '错误思路',
    wrong_solution: '',
    correct_solution: '正确解析',
    answer: '答案',
    subject: '高等数学',
    category: '函数、极限、连续',
    question_type: '解答题',
    error_reason: '概念不清',
    source: '测试',
    difficulty: '中等',
    mastery_level: '一般',
    note: '',
    tags: [],
    questionImageSources: [],
    solutionImageSources: [],
    ...overrides
  });
}

async function createTask(title = '完成桥接复习') {
  const list = await ticktickService.createTickTickList({ name: '桥接清单' });
  return ticktickService.createTickTickTask({
    list_id: list.id,
    title,
    priority: 'none'
  });
}

async function createQuestionBridge(taskId, questionId) {
  return ticktickService.createTickTickBridge({
    ticktick_task_id: taskId,
    linked_type: 'question',
    linked_id: String(questionId),
    sync_review: 1,
    sync_mastery: 0
  });
}

test('syncTaskCompletedToReview writes review log when sync_review is enabled', async () => {
  const question = await createQuestion();
  const task = await createTask('完成极限复习');
  await createQuestionBridge(task.id, question.id);

  await bridgeService.syncTaskCompletedToReview(task.id, task.title, 25);

  const logs = await databaseService.listReviewLogs(question.id);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].result, 'correct');
  assert.match(logs[0].note, /TickTick 任务完成: 完成极限复习/);

  const updated = await databaseService.getQuestion(question.id);
  assert.equal(updated.review_count, 1);
  assert.equal(updated.correct_count, 1);
  assert.equal(updated.consecutive_correct, 1);
});

test('syncTaskCompletedToReview does not duplicate same task sync on same day', async () => {
  const question = await createQuestion();
  const task = await createTask('重复同步复习');
  await createQuestionBridge(task.id, question.id);

  await bridgeService.syncTaskCompletedToReview(task.id, task.title, 25);
  await bridgeService.syncTaskCompletedToReview(task.id, task.title, 25);

  const logs = await databaseService.listReviewLogs(question.id);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].result, 'correct');

  const updated = await databaseService.getQuestion(question.id);
  assert.equal(updated.review_count, 1);
  assert.equal(updated.correct_count, 1);
});

test('completeTaskWithReviewSync writes review log for bridged task via unified entry', async () => {
  const question = await createQuestion();
  const task = await createTask('统一完成复习');
  await createQuestionBridge(task.id, question.id);

  const updated = await bridgeService.completeTaskWithReviewSync(task.id);

  assert.ok(updated);
  assert.equal(updated.is_completed, 1);

  const logs = await databaseService.listReviewLogs(question.id);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].result, 'correct');
  assert.match(logs[0].note, /TickTick 任务完成: 统一完成复习/);
});

test('completeTaskWithReviewSync does not write review log for task without bridge', async () => {
  const task = await createTask('无桥接任务');

  const updated = await bridgeService.completeTaskWithReviewSync(task.id);

  assert.ok(updated);
  assert.equal(updated.is_completed, 1);

  const db = await databaseService.getDatabase();
  const rows = databaseService.allSql(db, 'SELECT * FROM review_logs');
  assert.equal(rows.length, 0);
});

test('uncompleteTaskWithReviewSync removes the synced review log via unified entry', async () => {
  const question = await createQuestion();
  const task = await createTask('统一取消复习');
  await createQuestionBridge(task.id, question.id);

  await bridgeService.completeTaskWithReviewSync(task.id);
  const logsAfterComplete = await databaseService.listReviewLogs(question.id);
  assert.equal(logsAfterComplete.length, 1);

  const updated = await bridgeService.uncompleteTaskWithReviewSync(task.id);

  assert.ok(updated);
  assert.equal(updated.is_completed, 0);

  const logsAfterUndo = await databaseService.listReviewLogs(question.id);
  assert.equal(logsAfterUndo.length, 0);
  const restored = await databaseService.getQuestion(question.id);
  assert.equal(restored.review_count, 0);
  assert.equal(restored.correct_count, 0);
  assert.equal(restored.consecutive_correct, 0);
  assert.equal(restored.mastery_level, '一般');
  assert.equal(restored.last_reviewed_at, null);
  assert.equal(restored.next_review_at, null);
});

async function installFailureTrigger(sql) {
  const coordinator = await databaseService.getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: crypto.randomUUID(),
    concurrency: 'none',
    execute(database) {
      database.run(sql);
      return { changed: true, value: null };
    }
  });
}

test('completeTaskWithReviewSync restores TickTick state and rejects when review command fails', async () => {
  const question = await createQuestion();
  const task = await createTask('提交失败补偿');
  await createQuestionBridge(task.id, question.id);
  await installFailureTrigger(`CREATE TRIGGER fail_bridge_review_insert BEFORE INSERT ON review_logs
    BEGIN SELECT RAISE(ABORT, 'forced review command failure'); END`);

  await assert.rejects(
    bridgeService.completeTaskWithReviewSync(task.id),
    (error) => error?.code === 'INTERNAL_ERROR'
  );

  assert.equal((await ticktickService.getTickTickTask(task.id)).is_completed, 0);
  assert.equal((await databaseService.listReviewLogs(question.id)).length, 0);
  assert.equal((await databaseService.getQuestion(question.id)).review_count, 0);
});

test('uncompleteTaskWithReviewSync restores TickTick completion and rejects when undo command fails', async () => {
  const question = await createQuestion();
  const task = await createTask('撤销失败补偿');
  await createQuestionBridge(task.id, question.id);
  await bridgeService.completeTaskWithReviewSync(task.id);
  await installFailureTrigger(`CREATE TRIGGER fail_bridge_review_delete BEFORE DELETE ON review_logs
    BEGIN SELECT RAISE(ABORT, 'forced review undo failure'); END`);

  await assert.rejects(
    bridgeService.uncompleteTaskWithReviewSync(task.id),
    (error) => error?.code === 'INTERNAL_ERROR'
  );

  assert.equal((await ticktickService.getTickTickTask(task.id)).is_completed, 1);
  assert.equal((await databaseService.listReviewLogs(question.id)).length, 1);
  assert.equal((await databaseService.getQuestion(question.id)).review_count, 1);
});

test('completeTaskWithReviewSync reports compensation failure instead of false success', async () => {
  const question = await createQuestion();
  const task = await createTask('补偿失败显式结果');
  await createQuestionBridge(task.id, question.id);
  await installFailureTrigger(`CREATE TRIGGER fail_bridge_review_and_uncomplete BEFORE INSERT ON review_logs
    BEGIN SELECT RAISE(ABORT, 'forced review command failure'); END`);
  await installFailureTrigger(`CREATE TRIGGER fail_bridge_uncomplete BEFORE UPDATE OF is_completed ON ticktick_tasks
    WHEN NEW.is_completed = 0 BEGIN SELECT RAISE(ABORT, 'forced TickTick compensation failure'); END`);

  await assert.rejects(
    bridgeService.completeTaskWithReviewSync(task.id),
    /TickTick completion compensation failed/
  );

  assert.equal((await ticktickService.getTickTickTask(task.id)).is_completed, 1);
  assert.equal((await databaseService.listReviewLogs(question.id)).length, 0);
});

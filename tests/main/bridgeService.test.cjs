const assert = require('node:assert/strict');
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

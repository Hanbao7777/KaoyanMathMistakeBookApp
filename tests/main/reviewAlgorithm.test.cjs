const assert = require('node:assert/strict');
const test = require('node:test');
const {
  cleanupTestRoot,
  databaseService,
  requireMain,
  resetTestDatabase
} = require('./helpers/mainTestEnv.cjs');

test.after(cleanupTestRoot);

test.beforeEach(resetTestDatabase);

async function createQuestion(overrides = {}) {
  return databaseService.createQuestion({
    title: '极限计算题',
    content: '$\\lim_{x \\to 0} \\frac{\\sin x}{x}$',
    wrong_thinking: '直接代入 0',
    wrong_solution: '',
    correct_solution: '等价无穷小替换',
    answer: '1',
    subject: '高等数学',
    category: '函数、极限、连续',
    question_type: '解答题',
    error_reason: '概念不清',
    source: '测试',
    difficulty: '中等',
    mastery_level: '一般',
    note: '',
    tags: ['极限'],
    questionImageSources: [],
    solutionImageSources: [],
    ...overrides
  });
}

function daysBetween(fromIso, toIso) {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

test('first correct review sets next_review_at 2 days later and raises mastery', async () => {
  const q = await createQuestion();
  const result = await databaseService.submitReviewResult({
    questionId: q.id,
    result: 'correct'
  });

  assert.equal(result.question.consecutive_correct, 1);
  assert.equal(result.question.review_count, 1);
  assert.equal(result.question.correct_count, 1);
  assert.equal(result.question.mastery_level, '较好');
  const diff = daysBetween(result.log.reviewed_at, result.question.next_review_at);
  assert.equal(diff, 2);
});

test('wrong review resets consecutive_correct and lowers mastery', async () => {
  const q = await createQuestion({ mastery_level: '较好' });
  const result = await databaseService.submitReviewResult({
    questionId: q.id,
    result: 'wrong'
  });

  assert.equal(result.question.consecutive_correct, 0);
  assert.equal(result.question.wrong_count, 1);
  assert.equal(result.question.mastery_level, '一般');
  const diff = daysBetween(result.log.reviewed_at, result.question.next_review_at);
  assert.equal(diff, 1);
});

test('no_idea review resets consecutive_correct and lowers mastery', async () => {
  const q = await createQuestion({ mastery_level: '较好' });
  const result = await databaseService.submitReviewResult({
    questionId: q.id,
    result: 'no_idea'
  });

  assert.equal(result.question.consecutive_correct, 0);
  assert.equal(result.question.no_idea_count, 1);
  assert.equal(result.question.mastery_level, '较弱');
  const diff = daysBetween(result.log.reviewed_at, result.question.next_review_at);
  assert.equal(diff, 1);
});

test('consecutive correct reviews grow interval: 2, 4, 7 days', async () => {
  const q = await createQuestion({ mastery_level: '较弱' });
  const expectedDays = [2, 4, 7];

  for (const expected of expectedDays) {
    const result = await databaseService.submitReviewResult({
      questionId: q.id,
      result: 'correct'
    });
    const diff = daysBetween(result.log.reviewed_at, result.question.next_review_at);
    assert.equal(diff, expected, `consecutive_correct=${result.question.consecutive_correct} should give ${expected} days`);
  }

  const final = await databaseService.getQuestion(q.id);
  assert.equal(final.consecutive_correct, 3);
  assert.equal(final.mastery_level, '已掌握');
});

test('wrong after correct streak resets consecutive_correct to 0 then correct restarts at 2 days', async () => {
  const q = await createQuestion({ mastery_level: '一般' });

  await databaseService.submitReviewResult({ questionId: q.id, result: 'correct' });
  await databaseService.submitReviewResult({ questionId: q.id, result: 'correct' });

  let mid = await databaseService.getQuestion(q.id);
  assert.equal(mid.consecutive_correct, 2);

  const wrongResult = await databaseService.submitReviewResult({
    questionId: q.id,
    result: 'wrong'
  });
  assert.equal(wrongResult.question.consecutive_correct, 0);

  const restartResult = await databaseService.submitReviewResult({
    questionId: q.id,
    result: 'correct'
  });
  assert.equal(restartResult.question.consecutive_correct, 1);
  const diff = daysBetween(restartResult.log.reviewed_at, restartResult.question.next_review_at);
  assert.equal(diff, 2);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  cleanupControlPlaneRoot,
  getControlPlanePaths,
  requireMain,
  resetControlPlaneEnvironment
} = require('../main/helpers/controlPlaneTestEnv.cjs');

const adapterPath = path.resolve(__dirname, '../../src/main/ipc/adapters/questionsIpc.ts');
const registerPath = path.resolve(__dirname, '../../src/main/ipc/registerIpc.ts');
const adapterSource = fs.readFileSync(adapterPath, 'utf8');
const registerSource = fs.readFileSync(registerPath, 'utf8');

const adapter = requireMain('ipc/adapters/questionsIpc.js');

test.after(() => cleanupControlPlaneRoot());
test.beforeEach(resetControlPlaneEnvironment);

function input(overrides = {}) {
  return {
    title: 'Renderer adapter question', content: 'content', wrong_thinking: 'wrong', wrong_solution: '', correct_solution: 'correct', answer: '1',
    subject: '高等数学', category: '函数、极限、连续', question_type: '解答题', error_reason: '概念不清',
    source: 'renderer-test', difficulty: '中等', mastery_level: '一般', note: '', tags: ['adapter'],
    questionImageSources: [], solutionImageSources: [], ...overrides
  };
}

test('renderer adapter preserves CRUD, review, and image payloads', async () => {
  const sourcePath = path.join(getControlPlanePaths().testRoot, 'renderer-image.png');
  fs.writeFileSync(sourcePath, Buffer.from('renderer-image'));

  const created = await adapter.createQuestionFromRenderer(input({ questionImageSources: [sourcePath] }));
  assert.equal(created.title, 'Renderer adapter question');
  assert.equal(created.question_images.length, 1);

  const listed = await adapter.listQuestionsFromRenderer({});
  assert.equal(listed.length, 1);
  assert.equal((await adapter.getQuestionFromRenderer(created.id)).id, created.id);

  const updated = await adapter.updateQuestionFromRenderer(created.id, input({ title: 'Updated renderer question' }));
  assert.equal(updated.title, 'Updated renderer question');

  const mastered = await adapter.markMasteryFromRenderer(created.id, '已掌握');
  assert.equal(mastered.mastery_level, '已掌握');

  const reviewQuestion = await adapter.addReviewFromRenderer({
    questionId: created.id,
    review_date: '2026-07-15',
    result: '做错了',
    duration_minutes: 3,
    note: 'adapter review'
  });
  assert.equal(reviewQuestion.id, created.id);
  const submitted = await adapter.submitReviewResultFromRenderer({ questionId: created.id, result: 'correct', note: 'submitted' });
  assert.equal(submitted.question.id, created.id);
  assert.equal((await adapter.listReviewLogsFromRenderer(created.id)).length, 2);

  assert.equal(await adapter.removeImageFromRenderer(created.question_images[0].id, true), true);
  assert.equal((await adapter.getQuestionFromRenderer(created.id)).question_images.length, 0);
  const deletable = await adapter.createQuestionFromRenderer(input({ tags: [] }));
  assert.equal(await adapter.deleteQuestionFromRenderer(deletable.id, false), true);
  assert.equal(await adapter.getQuestionFromRenderer(deletable.id), null);
});

test('listed renderer writers dispatch through the question application', () => {
  for (const channel of ['questions:create', 'questions:update', 'questions:delete', 'questions:markMastery', 'images:remove', 'reviews:add', 'reviews:submitResult']) {
    assert.match(registerSource, new RegExp(`handle\\('${channel}'[^\\n]*FromRenderer`));
  }
  assert.match(adapterSource, /createRendererExecutionContext\(\{ expectedVersion: version \}\)/);
  assert.match(adapterSource, /coordinator\.currentVersion\(\)/);
  for (const forbidden of ['createQuestion(', 'updateQuestion(', 'deleteQuestion(', 'markMastery(', 'removeImage(', 'addReviewLog(', 'submitReviewResult(']) {
    assert.doesNotMatch(registerSource, new RegExp(`\\b${forbidden.replace('(', '\\(')}`));
  }
});

test('adapter does not accept renderer identity or source fields', () => {
  assert.doesNotMatch(adapterSource, /event\.sender|source\s*:/);
  assert.match(adapterSource, /createRendererExecutionContext/);
});

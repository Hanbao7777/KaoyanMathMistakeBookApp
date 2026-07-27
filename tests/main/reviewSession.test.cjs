const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '../..');
const reviewPageSource = fs.readFileSync(path.join(projectRoot, 'src/renderer/pages/ReviewPage.tsx'), 'utf8');
const {
  decrementReviewSessionStats,
  filterKnowledgeReviewStats,
  reviewSessionAccuracy
} = require(path.join(projectRoot, 'dist/main/shared/reviewSession.js'));

test('review session accuracy is zero-safe and counts every result', () => {
  assert.equal(reviewSessionAccuracy({ correct: 0, wrong: 0, no_idea: 0 }), 0);
  assert.equal(reviewSessionAccuracy({ correct: 2, wrong: 1, no_idea: 1 }), 50);
});

test('review session undo decrements only the submitted result without going negative', () => {
  assert.deepEqual(
    decrementReviewSessionStats({ correct: 2, wrong: 1, no_idea: 1 }, 'wrong'),
    { correct: 2, wrong: 0, no_idea: 1 }
  );
  assert.deepEqual(
    decrementReviewSessionStats({ correct: 0, wrong: 0, no_idea: 0 }, 'correct'),
    { correct: 0, wrong: 0, no_idea: 0 }
  );
});

test('knowledge review filtering applies text, due, weak, and nonempty constraints together', () => {
  const points = [
    { node_id: 'limit', title: '函数极限', category: '高数', tags: ['重点'], commonQuestionTypes: ['计算题'], total_questions: 3, due_questions: 2, weak_questions: 1 },
    { node_id: 'derivative', title: '导数', category: '高数', tags: [], commonQuestionTypes: ['证明题'], total_questions: 2, due_questions: 0, weak_questions: 2 },
    { node_id: 'empty', title: '空节点', category: '高数', tags: ['重点'], commonQuestionTypes: [], total_questions: 0, due_questions: 0, weak_questions: 0 }
  ];

  assert.deepEqual(
    filterKnowledgeReviewStats(points, { search: '重点', onlyDue: true, onlyWeak: true }).map((point) => point.node_id),
    ['limit']
  );
  assert.deepEqual(
    filterKnowledgeReviewStats(points, { search: '证明题', onlyDue: false, onlyWeak: true }).map((point) => point.node_id),
    ['derivative']
  );
});

test('review page undo uses the durable undo command instead of mastery-only compensation', () => {
  const start = reviewPageSource.indexOf('async function undoLastReview');
  assert.notEqual(start, -1, 'ReviewPage must define a durable undo handler');
  const block = reviewPageSource.slice(start, reviewPageSource.indexOf('\n  function ', start + 1));
  assert.match(block, /window\.api\.undoReviewResult/);
  assert.doesNotMatch(block, /window\.api\.markMastery/);
});

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { projectRoot } = require('./helpers/mainTestEnv.cjs');

const {
  isDue,
  isDueDate,
  isWeak,
  hasActiveFilters,
  activeFilterBadges,
  computeQuestionSummary,
  emptyFilters
} = require(path.join(projectRoot, 'dist/main/shared/questionFilters.js'));

test.after(() => {});

function makeQuestion(overrides = {}) {
  return {
    id: 1,
    title: '测试题',
    content: '',
    wrong_thinking: '',
    wrong_solution: '',
    correct_solution: '',
    answer: '',
    subject: '高等数学',
    category: '函数、极限、连续',
    question_type: '解答题',
    error_reason: '概念不清',
    source: '测试',
    difficulty: '中等',
    mastery_level: '一般',
    note: '',
    review_count: 0,
    correct_count: 0,
    wrong_count: 0,
    no_idea_count: 0,
    consecutive_correct: 0,
    last_reviewed_at: null,
    next_review_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    tags: [],
    question_images: [],
    solution_images: [],
    ...overrides
  };
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function futureDate(days = 7) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function pastDate(days = 7) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── isDue (question-level: null = due, StatsPage semantics) ──

test('isDue returns true when next_review_at is null (never reviewed = due)', () => {
  assert.equal(isDue(makeQuestion({ next_review_at: null })), true);
});

test('isDue returns true when next_review_at is today', () => {
  assert.equal(isDue(makeQuestion({ next_review_at: todayStr() })), true);
});

test('isDue returns true when next_review_at is in the past', () => {
  assert.equal(isDue(makeQuestion({ next_review_at: pastDate(7) })), true);
});

test('isDue returns false when next_review_at is in the future', () => {
  assert.equal(isDue(makeQuestion({ next_review_at: futureDate(7) })), false);
});

// ── isDueDate (date-string: null = NOT due, LibraryPage summary semantics) ──

test('isDueDate returns false for null/undefined/empty', () => {
  assert.equal(isDueDate(null), false);
  assert.equal(isDueDate(undefined), false);
  assert.equal(isDueDate(''), false);
});

test('isDueDate returns true when date is today', () => {
  assert.equal(isDueDate(todayStr()), true);
});

test('isDueDate returns true when date is in the past', () => {
  assert.equal(isDueDate(pastDate(7)), true);
});

test('isDueDate returns false when date is in the future', () => {
  assert.equal(isDueDate(futureDate(7)), false);
});

// ── isWeak ──

test('isWeak returns true for mastery 未掌握', () => {
  assert.equal(isWeak(makeQuestion({ mastery_level: '未掌握' })), true);
});

test('isWeak returns true for mastery 较弱', () => {
  assert.equal(isWeak(makeQuestion({ mastery_level: '较弱' })), true);
});

test('isWeak returns true when wrong_count > correct_count', () => {
  assert.equal(isWeak(makeQuestion({ mastery_level: '一般', wrong_count: 3, correct_count: 1 })), true);
});

test('isWeak returns true when no_idea_count > 0', () => {
  assert.equal(isWeak(makeQuestion({ mastery_level: '一般', no_idea_count: 1 })), true);
});

test('isWeak returns false for mastered question with no errors', () => {
  assert.equal(isWeak(makeQuestion({ mastery_level: '已掌握', correct_count: 5, wrong_count: 0, no_idea_count: 0 })), false);
});

test('isWeak handles undefined count fields safely', () => {
  assert.equal(isWeak(makeQuestion({ mastery_level: '一般', wrong_count: undefined, correct_count: undefined, no_idea_count: undefined })), false);
});

test('isWeak handles null count fields safely', () => {
  assert.equal(isWeak(makeQuestion({ mastery_level: '一般', wrong_count: null, correct_count: null, no_idea_count: null })), false);
});

// ── hasActiveFilters ──

test('hasActiveFilters returns false for empty filters', () => {
  assert.equal(hasActiveFilters(emptyFilters), false);
});

test('hasActiveFilters returns true when search is set', () => {
  assert.equal(hasActiveFilters({ ...emptyFilters, search: '极限' }), true);
});

test('hasActiveFilters returns true when weakOnly is set', () => {
  assert.equal(hasActiveFilters({ ...emptyFilters, weakOnly: true }), true);
});

test('hasActiveFilters returns true when all fields are set', () => {
  const filters = {
    search: 'x', subject: 's', category: 'c', questionType: 'q', errorReason: 'e',
    masteryLevel: 'm', difficulty: 'd', source: 'so', tag: 't', sortBy: 'created_at', sortOrder: 'desc', weakOnly: true
  };
  assert.equal(hasActiveFilters(filters), true);
});

// ── activeFilterBadges ──

test('activeFilterBadges returns empty array for empty filters', () => {
  assert.deepEqual(activeFilterBadges(emptyFilters), []);
});

test('activeFilterBadges preserves insertion order matching LibraryPage', () => {
  const filters = {
    search: '极限', subject: '高等数学', category: '函数', questionType: '选择题',
    errorReason: '计算错误', masteryLevel: '较弱', difficulty: '中等', source: '真题',
    tag: '极限', sortBy: 'created_at', sortOrder: 'desc', weakOnly: true
  };
  const badges = activeFilterBadges(filters);
  assert.equal(badges.length, 10);
  assert.deepEqual(badges.map(b => b.key), [
    'search', 'subject', 'category', 'questionType', 'errorReason',
    'masteryLevel', 'difficulty', 'source', 'tag', 'weakOnly'
  ]);
});

test('activeFilterBadges generates correct label text', () => {
  const filters = { ...emptyFilters, search: '极限', weakOnly: true };
  const badges = activeFilterBadges(filters);
  assert.equal(badges[0].label, '关键词：极限');
  assert.equal(badges[1].label, '薄弱错题');
});

// ── computeQuestionSummary ──

test('computeQuestionSummary returns zeros for empty array', () => {
  assert.deepEqual(computeQuestionSummary([]), { unmastered: 0, weak: 0, due: 0 });
});

test('computeQuestionSummary counts unmastered, weak, and due correctly', () => {
  const questions = [
    makeQuestion({ id: 1, mastery_level: '未掌握', next_review_at: null }),
    makeQuestion({ id: 2, mastery_level: '较弱', next_review_at: futureDate(7) }),
    makeQuestion({ id: 3, mastery_level: '已掌握', next_review_at: pastDate(1), correct_count: 5, wrong_count: 0, no_idea_count: 0 }),
    makeQuestion({ id: 4, mastery_level: '一般', next_review_at: futureDate(3), wrong_count: 3, correct_count: 1 }),
  ];
  const summary = computeQuestionSummary(questions);
  assert.equal(summary.unmastered, 1);
  assert.equal(summary.weak, 3);
  assert.equal(summary.due, 1);
});

test('computeQuestionSummary handles undefined count fields safely', () => {
  const questions = [
    makeQuestion({ id: 1, mastery_level: '一般', wrong_count: undefined, correct_count: undefined, no_idea_count: undefined, next_review_at: null }),
  ];
  const summary = computeQuestionSummary(questions);
  assert.equal(summary.weak, 0);
  assert.equal(summary.due, 0);
});

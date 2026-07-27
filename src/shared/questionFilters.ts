import type { Question, QuestionFilters } from './types';

export const emptyFilters: QuestionFilters = {
  search: '',
  subject: '',
  category: '',
  questionType: '',
  errorReason: '',
  masteryLevel: '',
  difficulty: '',
  source: '',
  tag: '',
  sortBy: 'created_at',
  sortOrder: 'desc',
  weakOnly: false
};

function todayLocalDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Determine if a date string is due (<= today).
 * Null/empty/undefined returns false — used for summary cards
 * where missing next_review_at should NOT count as due.
 * Preserves original LibraryPage summary behavior.
 */
export function isDueDate(value?: string | null): boolean {
  if (!value) return false;
  return value.slice(0, 10) <= todayLocalDate();
}

/**
 * Determine if a question is due for review.
 * A question with no next_review_at is considered due (never reviewed or no scheduled date).
 * Matches the main-process review-buckets semantics.
 * Used by StatsPage and other review-oriented UI.
 */
export function isDue(question: Question): boolean {
  if (!question.next_review_at) return true;
  return question.next_review_at.slice(0, 10) <= todayLocalDate();
}

/**
 * Determine if a question is "weak" — low mastery or error-prone.
 * Uses defensive `|| 0` guards for count fields to handle null/undefined safely.
 */
export function isWeak(question: Question): boolean {
  return (
    question.mastery_level === '未掌握' ||
    question.mastery_level === '较弱' ||
    (question.wrong_count || 0) > (question.correct_count || 0) ||
    (question.no_idea_count || 0) > 0
  );
}

/**
 * Check whether any filter field is active (non-empty / non-default).
 */
export function hasActiveFilters(filters: QuestionFilters): boolean {
  return Boolean(
    filters.search ||
    filters.subject ||
    filters.category ||
    filters.questionType ||
    filters.errorReason ||
    filters.masteryLevel ||
    filters.difficulty ||
    filters.source ||
    filters.tag ||
    filters.weakOnly
  );
}

/**
 * Build an ordered list of active filter badges for display.
 * Order: search, subject, category, questionType, errorReason,
 *        masteryLevel, difficulty, source, tag, weakOnly.
 */
export function activeFilterBadges(filters: QuestionFilters): Array<{ key: keyof QuestionFilters | 'weakOnly'; label: string }> {
  const badges: Array<{ key: keyof QuestionFilters | 'weakOnly'; label: string }> = [];
  if (filters.search) badges.push({ key: 'search', label: `关键词：${filters.search}` });
  if (filters.subject) badges.push({ key: 'subject', label: `学科：${filters.subject}` });
  if (filters.category) badges.push({ key: 'category', label: `章节：${filters.category}` });
  if (filters.questionType) badges.push({ key: 'questionType', label: `题型：${filters.questionType}` });
  if (filters.errorReason) badges.push({ key: 'errorReason', label: `错因：${filters.errorReason}` });
  if (filters.masteryLevel) badges.push({ key: 'masteryLevel', label: `掌握程度：${filters.masteryLevel}` });
  if (filters.difficulty) badges.push({ key: 'difficulty', label: `难度：${filters.difficulty}` });
  if (filters.source) badges.push({ key: 'source', label: `来源：${filters.source}` });
  if (filters.tag) badges.push({ key: 'tag', label: `标签：${filters.tag}` });
  if (filters.weakOnly) badges.push({ key: 'weakOnly', label: '薄弱错题' });
  return badges;
}

export interface QuestionSummary {
  unmastered: number;
  weak: number;
  due: number;
}

/**
 * Compute summary counts over a list of questions.
 * - unmastered: mastery_level === '未掌握'
 * - weak: isWeak(question)
 * - due: isDueDate(question.next_review_at) — null next_review_at does NOT count as due
 *   (preserves original LibraryPage summary behavior)
 */
export function computeQuestionSummary(questions: Question[]): QuestionSummary {
  return {
    unmastered: questions.filter((q) => q.mastery_level === '未掌握').length,
    weak: questions.filter(isWeak).length,
    due: questions.filter((q) => isDueDate(q.next_review_at)).length
  };
}

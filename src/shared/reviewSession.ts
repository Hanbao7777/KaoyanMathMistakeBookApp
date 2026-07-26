import type { KnowledgePointReviewStats, ReviewResultV2 } from './types';

export interface ReviewSessionStats {
  readonly correct: number;
  readonly wrong: number;
  readonly no_idea: number;
}

export interface KnowledgeReviewFilters {
  readonly search: string;
  readonly onlyDue: boolean;
  readonly onlyWeak: boolean;
}

type KnowledgeReviewFilterPoint = Pick<
  KnowledgePointReviewStats,
  'title' | 'category' | 'tags' | 'commonQuestionTypes' | 'total_questions' | 'due_questions' | 'weak_questions'
>;

export function reviewSessionAccuracy(stats: ReviewSessionStats): number {
  const total = stats.correct + stats.wrong + stats.no_idea;
  return total === 0 ? 0 : Math.round((stats.correct / total) * 100);
}

export function decrementReviewSessionStats(
  stats: ReviewSessionStats,
  result: ReviewResultV2
): ReviewSessionStats {
  return Object.freeze({
    ...stats,
    [result]: Math.max(0, stats[result] - 1)
  });
}

export function filterKnowledgeReviewStats<T extends KnowledgeReviewFilterPoint>(
  points: readonly T[],
  filters: KnowledgeReviewFilters
): T[] {
  const keyword = filters.search.trim().toLowerCase();
  return points.filter((point) => {
    const searchText = [
      point.title,
      point.category,
      ...point.tags,
      ...point.commonQuestionTypes
    ].join(' ').toLowerCase();
    if (keyword && !searchText.includes(keyword)) return false;
    if (filters.onlyDue && point.due_questions <= 0) return false;
    if (filters.onlyWeak && point.weak_questions <= 0) return false;
    return point.total_questions > 0;
  });
}

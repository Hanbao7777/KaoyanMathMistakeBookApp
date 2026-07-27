import type { SqlValue } from 'sql.js';
import type { QueryHandler, ReadOnlyDatabaseFacade } from '../queryBus';
import type { KnowledgePoint, Question, QuestionFilters, QuestionImage, ReviewBuckets, ReviewLog } from '../../../shared/types';

type QuestionRow = Omit<Question, 'tags' | 'question_images' | 'solution_images'>;

function select<T>(
  database: ReadOnlyDatabaseFacade,
  sql: string,
  parameters: readonly unknown[] = []
): readonly T[] {
  return database.select(sql, parameters as readonly SqlValue[]) as readonly T[];
}

function normalizeSubject(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value).trim();
  return ['高等数学', '线性代数', '概率论', '其他'].includes(text) ? text : '高等数学';
}

function hydrateQuestion(database: ReadOnlyDatabaseFacade, row: QuestionRow): Question {
  const images = select<QuestionImage>(database, 'SELECT * FROM question_images WHERE question_id = ? ORDER BY id ASC', [row.id]);
  const tags = select<{ name: string }>(database, `SELECT t.name FROM tags t
    INNER JOIN question_tags qt ON qt.tag_id = t.id WHERE qt.question_id = ? ORDER BY t.name ASC`, [row.id]).map((tag) => tag.name);
  const knowledgePoints = select<KnowledgePoint>(database, `SELECT kp.* FROM knowledge_points kp
    INNER JOIN question_knowledge_points qkp ON qkp.knowledge_node_id = kp.node_id
    WHERE qkp.question_id = ? ORDER BY kp.level ASC, kp.sort_order ASC, kp.title ASC`, [row.id]);
  return {
    ...row,
    subject: normalizeSubject(row.subject),
    tags: [...tags],
    question_images: images.filter((image) => image.image_type === 'original' || image.image_type === 'question').map((image) => ({ ...image })),
    solution_images: images.filter((image) => image.image_type === 'solution').map((image) => ({ ...image })),
    knowledge_points: knowledgePoints.map((point) => ({ ...point }))
  };
}

function hydrateQuestions(database: ReadOnlyDatabaseFacade, rows: readonly QuestionRow[]): Question[] {
  return rows.map((row) => hydrateQuestion(database, { ...row }));
}

function buildFilterSql(filters: QuestionFilters = {}): { whereSql: string; parameters: unknown[]; orderSql: string } {
  const where: string[] = [];
  const parameters: unknown[] = [];
  const filterValue = (value?: string) => {
    const text = value?.trim() || '';
    return text && text !== '全部' ? text : '';
  };
  if (filters.search?.trim()) {
    where.push('(title LIKE ? OR content LIKE ? OR correct_solution LIKE ? OR answer LIKE ?)');
    parameters.push(...Array(4).fill(`%${filters.search.trim()}%`));
  }
  if (filterValue(filters.category)) { where.push('category = ?'); parameters.push(filterValue(filters.category)); }
  if (filterValue(filters.subject)) { where.push("COALESCE(NULLIF(subject, ''), '高等数学') = ?"); parameters.push(normalizeSubject(filters.subject)); }
  if (filterValue(filters.questionType)) { where.push('question_type = ?'); parameters.push(filterValue(filters.questionType)); }
  if (filterValue(filters.errorReason)) { where.push('error_reason = ?'); parameters.push(filterValue(filters.errorReason)); }
  if (filterValue(filters.masteryLevel)) { where.push('mastery_level = ?'); parameters.push(filterValue(filters.masteryLevel)); }
  if (filters.weakOnly) where.push("(mastery_level IN ('未掌握', '较弱') OR COALESCE(wrong_count, 0) > COALESCE(correct_count, 0) OR COALESCE(no_idea_count, 0) > 0)");
  if (filterValue(filters.difficulty)) { where.push('difficulty = ?'); parameters.push(filterValue(filters.difficulty)); }
  if (filterValue(filters.source)) { where.push('source = ?'); parameters.push(filterValue(filters.source)); }
  if (filters.tag?.trim()) {
    where.push('id IN (SELECT qt.question_id FROM question_tags qt INNER JOIN tags t ON t.id = qt.tag_id WHERE t.name LIKE ?)');
    parameters.push(`%${filters.tag.trim()}%`);
  }
  const sortBy = ['created_at', 'last_reviewed_at', 'review_count'].includes(filters.sortBy || '') ? filters.sortBy : 'created_at';
  const sortOrder = filters.sortOrder === 'asc' ? 'ASC' : 'DESC';
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', parameters, orderSql: `ORDER BY ${sortBy} ${sortOrder}, id DESC` };
}

function dateOnly(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export const listQuestionsQuery: QueryHandler<Extract<import('../../../shared/agent').AppQuery, { type: 'questions.list' }>> = (query, _context, database) => {
  const filter = buildFilterSql(query.payload.filters);
  const rows = select<QuestionRow>(database, `SELECT * FROM questions ${filter.whereSql} ${filter.orderSql} LIMIT ?`, [...filter.parameters, query.payload.limit]);
  return hydrateQuestions(database, rows);
};

export const getQuestionQuery: QueryHandler<Extract<import('../../../shared/agent').AppQuery, { type: 'questions.get' }>> = (query, _context, database) => {
  const row = select<QuestionRow>(database, 'SELECT * FROM questions WHERE id = ?', [query.payload.questionId])[0];
  return row ? hydrateQuestion(database, { ...row }) : null;
};

export const reviewLogsQuery: QueryHandler<Extract<import('../../../shared/agent').AppQuery, { type: 'questions.review_logs' }>> = (query, _context, database) => {
  return select<ReviewLog>(database,
    'SELECT * FROM review_logs WHERE question_id = ? ORDER BY COALESCE(reviewed_at, review_date, created_at) DESC, id DESC LIMIT ?',
    [query.payload.questionId, query.payload.limit]).map((row) => ({ ...row }));
};

export const reviewBucketsQuery: QueryHandler<Extract<import('../../../shared/agent').AppQuery, { type: 'questions.review_buckets' }>> = (_query, _context, database): ReviewBuckets => {
  const today = dateOnly();
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 6);
  const due = hydrateQuestions(database, select<QuestionRow>(database, `SELECT * FROM questions
    WHERE mastery_level != '已掌握' AND ((next_review_at IS NOT NULL AND substr(next_review_at, 1, 10) <= ?)
      OR (next_review_at IS NULL AND COALESCE(review_count, 0) = 0))
    ORDER BY CASE mastery_level WHEN '未掌握' THEN 0 WHEN '较弱' THEN 1 WHEN '一般' THEN 2 WHEN '较好' THEN 3 ELSE 4 END ASC,
      COALESCE(wrong_count, 0) DESC, COALESCE(no_idea_count, 0) DESC, COALESCE(last_reviewed_at, created_at) ASC`, [today]));
  const unmastered = hydrateQuestions(database, select<QuestionRow>(database,
    "SELECT * FROM questions WHERE mastery_level = '未掌握' ORDER BY COALESCE(no_idea_count, 0) DESC, COALESCE(wrong_count, 0) DESC, created_at DESC"));
  const weak = hydrateQuestions(database, select<QuestionRow>(database, `SELECT * FROM questions
    WHERE mastery_level IN ('未掌握', '较弱') OR COALESCE(wrong_count, 0) >= 2 OR COALESCE(no_idea_count, 0) >= 1
    ORDER BY CASE mastery_level WHEN '未掌握' THEN 0 WHEN '较弱' THEN 1 ELSE 2 END ASC,
      COALESCE(no_idea_count, 0) DESC, COALESCE(wrong_count, 0) DESC, updated_at DESC`));
  const repeatedWrong = hydrateQuestions(database, select<QuestionRow>(database,
    'SELECT * FROM questions WHERE COALESCE(wrong_count, 0) >= 2 OR COALESCE(no_idea_count, 0) >= 1 ORDER BY COALESCE(no_idea_count, 0) DESC, COALESCE(wrong_count, 0) DESC, updated_at DESC'));
  const weekReviewedCount = Number(select<{ count: number }>(database,
    'SELECT COUNT(*) AS count FROM review_logs WHERE substr(COALESCE(reviewed_at, review_date, created_at), 1, 10) >= ?', [dateOnly(weekStart)])[0]?.count ?? 0);
  return {
    due, unmastered, repeatedWrong, weak, weekReviewedCount,
    counts: { due: due.length, unmastered: unmastered.length, weak: weak.length, weekReviewed: weekReviewedCount }
  };
};

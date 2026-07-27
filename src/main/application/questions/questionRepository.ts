import type { Database, SqlValue } from 'sql.js';
import { AgentError } from '../../../shared/agent/errors';
import type { DatabaseMutationScope } from '../../persistence/databaseCoordinator';
import { assertDatabaseMutationScope } from '../../persistence/databaseCoordinator';
import type {
  ImageType,
  KnowledgePoint,
  MasteryLevel,
  Question,
  QuestionImage,
  QuestionInput,
  ReviewLog,
  ReviewResultV2,
  ReviewSubmitInput,
  ReviewSubmitResult
} from '../../../shared/types';
import type { QuestionUndoReviewResult } from '../../../shared/agent/v1/contracts';

const DEFAULT_SUBJECT = '高等数学';
const SUBJECTS = new Set(['高等数学', '线性代数', '概率论', '其他']);
const MASTERY_ORDER: MasteryLevel[] = ['未掌握', '较弱', '一般', '较好', '已掌握'];
const OLD_MASTERY_MAP: Record<string, MasteryLevel> = {
  未掌握: '未掌握',
  有点懂: '较弱',
  基本掌握: '较好',
  已掌握: '已掌握',
  反复出错: '未掌握',
  较弱: '较弱',
  一般: '一般',
  较好: '较好'
};

export interface QuestionImageInsert {
  readonly imageType: ImageType;
  readonly filePath: string;
}

export interface LinkKnowledgeResult {
  readonly inserted: number;
  readonly warnings: string[];
}

type QuestionRow = Omit<Question, 'tags' | 'question_images' | 'solution_images'>;
type QuestionMatchRow = QuestionRow & { tag_text: string };

function run(database: Database, sql: string, parameters: readonly unknown[] = []): void {
  const statement = database.prepare(sql);
  try {
    statement.bind([...parameters] as SqlValue[]);
    statement.step();
  } finally {
    statement.free();
  }
}

function all<T>(database: Database, sql: string, parameters: readonly unknown[] = []): T[] {
  const statement = database.prepare(sql);
  const rows: T[] = [];
  try {
    statement.bind([...parameters] as SqlValue[]);
    while (statement.step()) rows.push(statement.getAsObject() as T);
  } finally {
    statement.free();
  }
  return rows;
}

function one<T>(database: Database, sql: string, parameters: readonly unknown[] = []): T | null {
  return all<T>(database, sql, parameters)[0] ?? null;
}

function lastInsertId(database: Database): number {
  return Number(one<{ id: number }>(database, 'SELECT last_insert_rowid() AS id')?.id);
}

function dateOnly(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(dateText: string, days: number): string {
  const date = new Date(`${dateText}T00:00:00`);
  date.setDate(date.getDate() + days);
  return dateOnly(date);
}

function addDaysIso(date: Date, days: number): string {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next.toISOString();
}

function normalizeSubject(value: unknown, fallback = DEFAULT_SUBJECT): string {
  const text = value === null || value === undefined ? '' : String(value).trim();
  return SUBJECTS.has(text) ? text : fallback;
}

function inferSubjectFromCategory(category: unknown): string {
  const text = category === null || category === undefined ? '' : String(category).trim();
  if (['线性代数', '行列式与矩阵', '线性方程组与向量', '特征值与二次型'].includes(text)) return '线性代数';
  if (text === '概率论') return '概率论';
  return DEFAULT_SUBJECT;
}

function normalizeMastery(value: string | null | undefined): MasteryLevel {
  return OLD_MASTERY_MAP[value || ''] ?? '一般';
}

function masteryAfterResult(current: MasteryLevel, result: ReviewResultV2): MasteryLevel {
  const index = MASTERY_ORDER.indexOf(normalizeMastery(current));
  if (result === 'correct') return MASTERY_ORDER[Math.min(index + 1, MASTERY_ORDER.length - 1)];
  if (result === 'wrong') return MASTERY_ORDER[Math.max(index - 1, 0)];
  if (current === '已掌握') return '一般';
  if (current === '较好' || current === '一般') return '较弱';
  return '未掌握';
}

function nextReviewForResult(reviewedAt: Date, result: ReviewResultV2, consecutiveCorrect: number): string {
  if (result !== 'correct') return addDaysIso(reviewedAt, 1);
  const days = consecutiveCorrect === 1 ? 2 : consecutiveCorrect === 2 ? 4 : consecutiveCorrect === 3 ? 7 : consecutiveCorrect === 4 ? 15 : 30;
  return addDaysIso(reviewedAt, days);
}

function resultLabel(result: ReviewResultV2): string {
  if (result === 'correct') return '做对了';
  if (result === 'wrong') return '做错了';
  return '没思路';
}

function normalizedReviewResult(result: ReviewLog['result']): ReviewResultV2 {
  if (result === 'correct' || result === '做对了') return 'correct';
  if (result === 'wrong' || result === '做错了') return 'wrong';
  return 'no_idea';
}

function parseList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).map((entry) => entry.trim()).filter(Boolean);
  } catch {
    return value.split(/[;,，；]/).map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function splitText(value: string): string[] {
  return value.split(/[;,，；\s]+/).map((entry) => entry.trim()).filter(Boolean);
}

function scoreQuestionPoint(question: QuestionMatchRow, point: KnowledgePoint): number {
  const pointTags = parseList(point.tags);
  const pointTagsSet = new Set(pointTags);
  const commonTypes = new Set(parseList(point.common_question_types));
  const commonReasons = new Set(parseList(point.common_error_reasons));
  const questionTags = splitText(question.tag_text || '');
  let score = 0;
  if (question.question_type === point.title) score += 8;
  if (commonTypes.has(question.question_type)) score += 7;
  for (const tag of questionTags) if (pointTagsSet.has(tag)) score += 3;
  for (const questionTag of questionTags) {
    for (const pointTag of pointTags) {
      if (questionTag.length >= 2 && pointTag.length >= 2 && (questionTag.includes(pointTag) || pointTag.includes(questionTag))) score += 2;
    }
  }
  if (commonReasons.has(question.error_reason)) score += 3;
  if (point.title && (question.title.includes(point.title) || question.content.includes(point.title))) score += 4;
  if (question.category && question.category === point.category) score += 1;
  return score;
}

export class QuestionRepository {
  private readonly database: Database;
  private readonly scope: DatabaseMutationScope;
  private readonly now: () => string;

  constructor(database: Database, scope: DatabaseMutationScope, now: () => string = () => new Date().toISOString()) {
    assertDatabaseMutationScope(scope, database);
    this.database = database;
    this.scope = scope;
    this.now = now;
  }

  private assertScope(): void {
    assertDatabaseMutationScope(this.scope, this.database);
  }

  getQuestion(questionId: number): Question | null {
    const row = one<QuestionRow>(this.database, 'SELECT * FROM questions WHERE id = ?', [questionId]);
    return row ? this.hydrate(row) : null;
  }

  getImage(imageId: number): QuestionImage | null {
    return one<QuestionImage>(this.database, 'SELECT * FROM question_images WHERE id = ?', [imageId]);
  }

  getQuestionImages(questionId: number): QuestionImage[] {
    return all<QuestionImage>(this.database, 'SELECT * FROM question_images WHERE question_id = ? ORDER BY id ASC', [questionId]);
  }

  countQuestions(): number {
    return Number(one<{ count: number }>(this.database, 'SELECT COUNT(*) AS count FROM questions')?.count ?? 0);
  }

  create(input: QuestionInput, images: readonly QuestionImageInsert[] = []): Question {
    this.assertScope();
    const createdAt = this.now();
    run(this.database, `INSERT INTO questions (
      title, content, wrong_thinking, wrong_solution, correct_solution, answer, subject, category, question_type,
      error_reason, source, difficulty, mastery_level, note, review_count, correct_count, wrong_count,
      no_idea_count, consecutive_correct, last_reviewed_at, next_review_at, import_batch_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, NULL, NULL, ?, ?, ?)`, [
      input.title, input.content, input.wrong_thinking, input.wrong_solution || input.wrong_thinking,
      input.correct_solution, input.answer, normalizeSubject(input.subject, inferSubjectFromCategory(input.category)),
      input.category, input.question_type, input.error_reason, input.source, input.difficulty,
      normalizeMastery(input.mastery_level), input.note, input.import_batch_id ?? null, createdAt, createdAt
    ]);
    const questionId = lastInsertId(this.database);
    this.insertImages(questionId, images);
    this.replaceTags(questionId, input.tags);
    const saved = this.getQuestion(questionId);
    if (!saved) throw new Error('错题保存后读取失败');
    return saved;
  }

  update(questionId: number, input: QuestionInput, images: readonly QuestionImageInsert[] = []): { changed: boolean; question: Question } {
    this.assertScope();
    const current = this.getQuestion(questionId);
    if (!current) throw new Error('错题不存在');
    const normalizedSubject = normalizeSubject(input.subject, inferSubjectFromCategory(input.category));
    const normalizedTags = [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))].sort();
    const currentTags = [...current.tags].sort();
    const fieldsChanged = [
      current.title !== input.title,
      current.content !== input.content,
      current.wrong_thinking !== input.wrong_thinking,
      current.wrong_solution !== (input.wrong_solution || input.wrong_thinking),
      current.correct_solution !== input.correct_solution,
      current.answer !== input.answer,
      current.subject !== normalizedSubject,
      current.category !== input.category,
      current.question_type !== input.question_type,
      current.error_reason !== input.error_reason,
      current.source !== input.source,
      current.difficulty !== input.difficulty,
      current.mastery_level !== normalizeMastery(input.mastery_level),
      current.note !== input.note,
      currentTags.length !== normalizedTags.length || currentTags.some((tag, index) => tag !== normalizedTags[index]),
      images.length > 0
    ].some(Boolean);
    if (!fieldsChanged) return { changed: false, question: current };
    run(this.database, `UPDATE questions SET
      title = ?, content = ?, wrong_thinking = ?, wrong_solution = ?, correct_solution = ?, answer = ?,
      subject = ?, category = ?, question_type = ?, error_reason = ?, source = ?, difficulty = ?,
      mastery_level = ?, note = ?, updated_at = ? WHERE id = ?`, [
      input.title, input.content, input.wrong_thinking, input.wrong_solution || input.wrong_thinking,
      input.correct_solution, input.answer, normalizedSubject, input.category, input.question_type,
      input.error_reason, input.source, input.difficulty, normalizeMastery(input.mastery_level), input.note,
      this.now(), questionId
    ]);
    this.insertImages(questionId, images);
    this.replaceTags(questionId, input.tags);
    return { changed: true, question: this.getQuestion(questionId)! };
  }

  delete(questionId: number): boolean {
    this.assertScope();
    if (!this.getQuestion(questionId)) return false;
    run(this.database, 'DELETE FROM questions WHERE id = ?', [questionId]);
    return true;
  }

  removeImage(imageId: number): boolean {
    this.assertScope();
    if (!this.getImage(imageId)) return false;
    run(this.database, 'DELETE FROM question_images WHERE id = ?', [imageId]);
    return true;
  }

  markMastery(questionId: number, mastery: MasteryLevel): { changed: boolean; question: Question } {
    this.assertScope();
    const current = this.getQuestion(questionId);
    if (!current) throw new Error('错题不存在');
    const nextReviewAt = mastery === '已掌握' ? null : addDays(dateOnly(), 1);
    if (current.mastery_level === mastery && current.next_review_at === nextReviewAt) return { changed: false, question: current };
    run(this.database, 'UPDATE questions SET mastery_level = ?, next_review_at = ?, updated_at = ? WHERE id = ?', [
      mastery, nextReviewAt, this.now(), questionId
    ]);
    return { changed: true, question: this.getQuestion(questionId)! };
  }

  submitReview(input: ReviewSubmitInput): ReviewSubmitResult {
    this.assertScope();
    const question = this.getQuestion(input.questionId);
    if (!question) throw new Error('错题不存在');
    const reviewedAtDate = new Date(this.now());
    const reviewedAt = reviewedAtDate.toISOString();
    const masteryBefore = normalizeMastery(question.mastery_level);
    const consecutiveCorrect = input.result === 'correct' ? (question.consecutive_correct || 0) + 1 : 0;
    const masteryAfter = masteryAfterResult(masteryBefore, input.result);
    const nextReviewAt = nextReviewForResult(reviewedAtDate, input.result, consecutiveCorrect);
    const reviewCount = (question.review_count || 0) + 1;
    run(this.database, `INSERT INTO review_logs (
      question_id, result, mastery_before, mastery_after, reviewed_at, next_review_at,
      note, review_date, review_round, duration_minutes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`, [
      input.questionId, input.result, masteryBefore, masteryAfter, reviewedAt, nextReviewAt,
      input.note || '', dateOnly(reviewedAtDate), reviewCount, reviewedAt
    ]);
    run(this.database, `UPDATE questions SET
      review_count = ?, correct_count = ?, wrong_count = ?, no_idea_count = ?, consecutive_correct = ?,
      last_reviewed_at = ?, next_review_at = ?, mastery_level = ?, updated_at = ? WHERE id = ?`, [
      reviewCount,
      (question.correct_count || 0) + (input.result === 'correct' ? 1 : 0),
      (question.wrong_count || 0) + (input.result === 'wrong' || input.result === 'no_idea' ? 1 : 0),
      (question.no_idea_count || 0) + (input.result === 'no_idea' ? 1 : 0),
      consecutiveCorrect, reviewedAt, nextReviewAt, masteryAfter, this.now(), input.questionId
    ]);
    const updated = this.getQuestion(input.questionId);
    const log = one<ReviewLog>(this.database, 'SELECT * FROM review_logs WHERE question_id = ? ORDER BY id DESC LIMIT 1', [input.questionId]);
    if (!updated || !log) throw new Error('复习结果保存后读取失败');
    return {
      question: updated,
      log,
      message: `已记录：${resultLabel(input.result)}，下次复习：${dateOnly(new Date(nextReviewAt))}`
    };
  }

  undoReview(questionId: number, reviewLogId: number): QuestionUndoReviewResult {
    this.assertScope();
    if (!this.getQuestion(questionId)) throw new Error('错题不存在');
    const reviewLog = one<ReviewLog>(this.database, 'SELECT * FROM review_logs WHERE id = ?', [reviewLogId]);
    if (!reviewLog || reviewLog.question_id !== questionId) {
      throw new AgentError('VALIDATION_ERROR', { field: 'command.payload.reviewLogId' });
    }
    const latest = one<ReviewLog>(this.database, 'SELECT * FROM review_logs WHERE question_id = ? ORDER BY id DESC LIMIT 1', [questionId]);
    if (!latest || latest.id !== reviewLogId) {
      throw new AgentError('VALIDATION_ERROR', { field: 'command.payload.reviewLogId' });
    }

    run(this.database, 'DELETE FROM review_logs WHERE id = ? AND question_id = ?', [reviewLogId, questionId]);
    if (this.database.getRowsModified() !== 1) throw new Error('复习记录撤销失败');

    const remaining = all<ReviewLog>(this.database, 'SELECT * FROM review_logs WHERE question_id = ? ORDER BY id ASC', [questionId]);
    const latestRemaining = remaining.at(-1);
    const results = remaining.map((log) => normalizedReviewResult(log.result));
    let consecutiveCorrect = 0;
    for (let index = results.length - 1; index >= 0 && results[index] === 'correct'; index -= 1) {
      consecutiveCorrect += 1;
    }
    const correctCount = results.filter((result) => result === 'correct').length;
    const noIdeaCount = results.filter((result) => result === 'no_idea').length;
    const wrongCount = results.length - correctCount;
    const mastery = normalizeMastery(latestRemaining?.mastery_after ?? reviewLog.mastery_before);
    const lastReviewedAt = latestRemaining
      ? latestRemaining.reviewed_at ?? latestRemaining.review_date ?? latestRemaining.created_at ?? null
      : null;
    const nextReviewAt = latestRemaining?.next_review_at ?? null;

    run(this.database, `UPDATE questions SET
      review_count = ?, correct_count = ?, wrong_count = ?, no_idea_count = ?, consecutive_correct = ?,
      last_reviewed_at = ?, next_review_at = ?, mastery_level = ?, updated_at = ? WHERE id = ?`, [
      remaining.length, correctCount, wrongCount, noIdeaCount, consecutiveCorrect,
      lastReviewedAt, nextReviewAt, mastery, this.now(), questionId
    ]);
    const question = this.getQuestion(questionId);
    if (!question) throw new Error('复习记录撤销后读取失败');
    return { question, reviewLog };
  }

  linkKnowledgePoints(questionId: number, values: readonly string[], matchType: 'gpt' | 'auto' | 'manual'): LinkKnowledgeResult {
    this.assertScope();
    if (!this.getQuestion(questionId)) throw new Error('错题不存在');
    const warnings: string[] = [];
    let inserted = 0;
    const tokens = [...new Set(values.flatMap((value) => value.split(/[;,，；]/)).map((value) => value.trim()).filter(Boolean))];
    for (const token of tokens) {
      const byNodeId = one<KnowledgePoint>(this.database, 'SELECT * FROM knowledge_points WHERE node_id = ?', [token]);
      const matches = byNodeId ? [byNodeId] : all<KnowledgePoint>(this.database, 'SELECT * FROM knowledge_points WHERE title = ? ORDER BY level ASC, sort_order ASC', [token]);
      if (!matches.length) {
        warnings.push(`未匹配到知识点：${token}`);
        continue;
      }
      if (!byNodeId && matches.length > 1) warnings.push(`知识点标题重复，已使用第一个匹配项：${token}`);
      run(this.database, 'INSERT OR IGNORE INTO question_knowledge_points (question_id, knowledge_node_id, match_type, created_at) VALUES (?, ?, ?, ?)', [
        questionId, matches[0].node_id, matchType, this.now()
      ]);
      if (this.database.getRowsModified() > 0) inserted += 1;
    }
    return { inserted, warnings };
  }

  migrateCategories(limit: number): number {
    this.assertScope();
    const categoryMap: Record<string, string> = {
      '函数、极限与连续': '函数、极限、连续',
      多元函数微分学: '多元函数微积分学',
      重积分: '多元函数微积分学',
      曲线曲面积分: '多元函数微积分学',
      微分方程: '常微分方程',
      线性代数: '其他'
    };
    const rows = all<{ id: number; category: string }>(this.database,
      `SELECT id, category FROM questions WHERE category IN (${Object.keys(categoryMap).map(() => '?').join(', ')}) ORDER BY id ASC LIMIT ?`,
      [...Object.keys(categoryMap), limit]);
    for (const row of rows) run(this.database, 'UPDATE questions SET category = ?, updated_at = ? WHERE id = ?', [categoryMap[row.category], this.now(), row.id]);
    return rows.length;
  }

  rematchKnowledge(limit: number, questionIds?: readonly number[]): { scannedQuestions: number; insertedCount: number } {
    this.assertScope();
    const parameters: unknown[] = [];
    const where = questionIds?.length ? `WHERE q.id IN (${questionIds.map(() => '?').join(', ')})` : '';
    if (questionIds?.length) parameters.push(...questionIds);
    parameters.push(limit);
    const questions = all<QuestionMatchRow>(this.database, `SELECT q.*, COALESCE(group_concat(t.name, ';'), '') AS tag_text
      FROM questions q LEFT JOIN question_tags qt ON qt.question_id = q.id LEFT JOIN tags t ON t.id = qt.tag_id
      ${where} GROUP BY q.id ORDER BY q.id ASC LIMIT ?`, parameters);
    const points = all<KnowledgePoint>(this.database, 'SELECT * FROM knowledge_points WHERE deleted_at IS NULL OR deleted_at = "" ORDER BY level ASC, sort_order ASC');
    let insertedCount = 0;
    for (const question of questions) {
      const ranked = points.map((point) => ({ point, score: scoreQuestionPoint(question, point) }))
        .filter((item) => item.score >= 5)
        .sort((left, right) => right.score - left.score || left.point.level - right.point.level || left.point.sort_order - right.point.sort_order)
        .slice(0, 3);
      for (const item of ranked) {
        run(this.database, 'INSERT OR IGNORE INTO question_knowledge_points (question_id, knowledge_node_id, match_type, created_at) VALUES (?, ?, ?, ?)', [
          question.id, item.point.node_id, 'auto', this.now()
        ]);
        if (this.database.getRowsModified() > 0) insertedCount += 1;
      }
    }
    return { scannedQuestions: questions.length, insertedCount };
  }

  clearQuestionState(): number {
    this.assertScope();
    const deleted = this.countQuestions();
    if (!deleted) return 0;
    for (const table of ['question_knowledge_points', 'question_tags', 'review_logs', 'question_images', 'questions']) {
      run(this.database, `DELETE FROM ${table}`);
    }
    run(this.database, 'DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM question_tags)');
    return deleted;
  }

  private insertImages(questionId: number, images: readonly QuestionImageInsert[]): void {
    for (const image of images) {
      run(this.database, 'INSERT INTO question_images (question_id, image_type, file_path, created_at) VALUES (?, ?, ?, ?)', [
        questionId, image.imageType, image.filePath, this.now()
      ]);
    }
  }

  private replaceTags(questionId: number, tags: readonly string[]): void {
    run(this.database, 'DELETE FROM question_tags WHERE question_id = ?', [questionId]);
    const uniqueTags = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
    for (const tag of uniqueTags) {
      run(this.database, 'INSERT OR IGNORE INTO tags (name, created_at) VALUES (?, ?)', [tag, this.now()]);
      const tagRow = one<{ id: number }>(this.database, 'SELECT id FROM tags WHERE name = ?', [tag]);
      if (tagRow) run(this.database, 'INSERT OR IGNORE INTO question_tags (question_id, tag_id) VALUES (?, ?)', [questionId, tagRow.id]);
    }
  }

  private hydrate(row: QuestionRow): Question {
    const images = this.getQuestionImages(row.id);
    const tags = all<{ name: string }>(this.database, `SELECT t.name FROM tags t
      INNER JOIN question_tags qt ON qt.tag_id = t.id WHERE qt.question_id = ? ORDER BY t.name ASC`, [row.id]).map((tag) => tag.name);
    const knowledgePoints = all<KnowledgePoint>(this.database, `SELECT kp.* FROM knowledge_points kp
      INNER JOIN question_knowledge_points qkp ON qkp.knowledge_node_id = kp.node_id
      WHERE qkp.question_id = ? ORDER BY kp.level ASC, kp.sort_order ASC, kp.title ASC`, [row.id]);
    return {
      ...row,
      subject: normalizeSubject(row.subject),
      tags,
      question_images: images.filter((image) => image.image_type === 'original' || image.image_type === 'question'),
      solution_images: images.filter((image) => image.image_type === 'solution'),
      knowledge_points: knowledgePoints
    };
  }
}

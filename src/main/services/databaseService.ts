import fs from 'node:fs';
import path from 'node:path';
import initSqlJs, { type Database, type SqlValue } from 'sql.js';
import { schemaSql } from '../database/schema';
import { copyImageToStore, deleteFiles } from './fileService';
import { getPaths } from './pathService';
import type {
  AppPaths,
  ImageType,
  KnowledgePoint,
  MasteryLevel,
  Question,
  QuestionFilters,
  QuestionImage,
  QuestionInput,
  ReviewInput,
  ReviewLog,
  ReviewResult,
  ReviewResultV2,
  ReviewSubmitInput,
  ReviewSubmitResult,
  StatsData
} from '../../shared/types';

let db: Database | null = null;

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

function nowIso() {
  return new Date().toISOString();
}

function dateOnly(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(dateText: string, days: number) {
  const date = new Date(`${dateText}T00:00:00`);
  date.setDate(date.getDate() + days);
  return dateOnly(date);
}

function addDaysIso(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next.toISOString();
}

export function persistDatabase() {
  if (!db) return;
  const bytes = db.export();
  fs.mkdirSync(path.dirname(getPaths().database), { recursive: true });
  fs.writeFileSync(getPaths().database, Buffer.from(bytes));
}

export async function getDatabase() {
  if (db) return db;

  const SQL = await initSqlJs({
    locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm')
  });

  const dbPath = getPaths().database;
  if (fs.existsSync(dbPath)) {
    db = new SQL.Database(fs.readFileSync(dbPath));
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON;');
  db.exec(schemaSql);
  migrateDatabase(db);
  persistDatabase();
  return db;
}

function migrateDatabase(database: Database) {
  const columns = all<{ name: string }>(database, 'PRAGMA table_info(questions)').map((column) => column.name);
  const addQuestionColumn = (name: string, sql: string) => {
    if (!columns.includes(name)) database.run(`ALTER TABLE questions ADD COLUMN ${name} ${sql}`);
  };
  if (!columns.includes('wrong_thinking')) {
    database.run("ALTER TABLE questions ADD COLUMN wrong_thinking TEXT DEFAULT ''");
    database.run("UPDATE questions SET wrong_thinking = COALESCE(wrong_solution, '') WHERE wrong_thinking = ''");
  }
  if (!columns.includes('answer')) {
    database.run("ALTER TABLE questions ADD COLUMN answer TEXT DEFAULT ''");
  }
  addQuestionColumn('correct_count', 'INTEGER NOT NULL DEFAULT 0');
  addQuestionColumn('wrong_count', 'INTEGER NOT NULL DEFAULT 0');
  addQuestionColumn('no_idea_count', 'INTEGER NOT NULL DEFAULT 0');
  addQuestionColumn('consecutive_correct', 'INTEGER NOT NULL DEFAULT 0');
  addQuestionColumn('last_reviewed_at', 'TEXT');
  addQuestionColumn('next_review_at', 'TEXT');
  addQuestionColumn('review_count', 'INTEGER NOT NULL DEFAULT 0');

  database.run(`
    UPDATE questions SET mastery_level = CASE mastery_level
      WHEN '有点懂' THEN '较弱'
      WHEN '基本掌握' THEN '较好'
      WHEN '反复出错' THEN '未掌握'
      WHEN '未掌握' THEN '未掌握'
      WHEN '较弱' THEN '较弱'
      WHEN '一般' THEN '一般'
      WHEN '较好' THEN '较好'
      WHEN '已掌握' THEN '已掌握'
      ELSE '一般'
    END
  `);

  const reviewColumns = all<{ name: string }>(database, 'PRAGMA table_info(review_logs)').map((column) => column.name);
  const addReviewColumn = (name: string, sql: string) => {
    if (!reviewColumns.includes(name)) database.run(`ALTER TABLE review_logs ADD COLUMN ${name} ${sql}`);
  };
  addReviewColumn('mastery_before', 'TEXT');
  addReviewColumn('mastery_after', 'TEXT');
  addReviewColumn('reviewed_at', 'TEXT');
  addReviewColumn('next_review_at', 'TEXT');
  addReviewColumn('review_date', 'TEXT');
  addReviewColumn('review_round', 'INTEGER');
  addReviewColumn('duration_minutes', 'INTEGER NOT NULL DEFAULT 0');
  addReviewColumn('created_at', 'TEXT');
  database.run("UPDATE review_logs SET reviewed_at = COALESCE(reviewed_at, review_date, created_at) WHERE reviewed_at IS NULL");
  database.run("UPDATE review_logs SET created_at = COALESCE(created_at, reviewed_at, review_date) WHERE created_at IS NULL");
  database.run("CREATE INDEX IF NOT EXISTS idx_review_logs_question ON review_logs(question_id)");
  database.run("CREATE INDEX IF NOT EXISTS idx_review_logs_reviewed_at ON review_logs(reviewed_at)");
  database.run("CREATE INDEX IF NOT EXISTS idx_questions_next_review_at ON questions(next_review_at)");
  database.run("CREATE INDEX IF NOT EXISTS idx_questions_mastery ON questions(mastery_level)");

  const imageTable = one<{ sql: string }>(
    database,
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'question_images'"
  );
  if (imageTable?.sql && !imageTable.sql.includes("'original'")) {
    database.run(`
      CREATE TABLE question_images_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question_id INTEGER NOT NULL,
        image_type TEXT NOT NULL CHECK (image_type IN ('original', 'question', 'solution')),
        file_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
      )
    `);
    database.run(`
      INSERT INTO question_images_new (id, question_id, image_type, file_path, created_at)
      SELECT id, question_id, image_type, file_path, created_at FROM question_images
    `);
    database.run('DROP TABLE question_images');
    database.run('ALTER TABLE question_images_new RENAME TO question_images');
  }
}

export function runSql(database: Database, sql: string, params: unknown[] = []) {
  const stmt = database.prepare(sql);
  try {
    stmt.bind(params as SqlValue[]);
    stmt.step();
  } finally {
    stmt.free();
  }
}

export function allSql<T>(database: Database, sql: string, params: unknown[] = []) {
  const stmt = database.prepare(sql);
  const rows: T[] = [];
  try {
    stmt.bind(params as SqlValue[]);
    while (stmt.step()) rows.push(stmt.getAsObject() as T);
  } finally {
    stmt.free();
  }
  return rows;
}

export function oneSql<T>(database: Database, sql: string, params: unknown[] = []) {
  return allSql<T>(database, sql, params)[0] ?? null;
}

export function lastInsertId(database: Database) {
  const row = oneSql<{ id: number }>(database, 'SELECT last_insert_rowid() AS id');
  return Number(row?.id);
}

const getDb = getDatabase;
const persist = persistDatabase;
const run = runSql;
const all = allSql;
const one = oneSql;

async function replaceTags(database: Database, questionId: number, tags: string[]) {
  run(database, 'DELETE FROM question_tags WHERE question_id = ?', [questionId]);
  const uniqueTags = Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)));
  for (const tag of uniqueTags) {
    run(database, 'INSERT OR IGNORE INTO tags (name, created_at) VALUES (?, ?)', [tag, nowIso()]);
    const tagRow = one<{ id: number }>(database, 'SELECT id FROM tags WHERE name = ?', [tag]);
    if (tagRow) {
      run(database, 'INSERT OR IGNORE INTO question_tags (question_id, tag_id) VALUES (?, ?)', [questionId, tagRow.id]);
    }
  }
}

function hydrateQuestions(database: Database, rows: Array<Omit<Question, 'tags' | 'question_images' | 'solution_images'>>) {
  return rows.map((row) => hydrateQuestion(database, row));
}

function getQuestionKnowledgePoints(database: Database, questionId: number) {
  return all<KnowledgePoint>(
    database,
    `SELECT kp.* FROM knowledge_points kp
     INNER JOIN question_knowledge_points qkp ON qkp.knowledge_node_id = kp.node_id
     WHERE qkp.question_id = ?
     ORDER BY kp.level ASC, kp.sort_order ASC, kp.title ASC`,
    [questionId]
  );
}

function hydrateQuestion(database: Database, row: Omit<Question, 'tags' | 'question_images' | 'solution_images'>): Question {
  const images = all<QuestionImage>(database, 'SELECT * FROM question_images WHERE question_id = ? ORDER BY id ASC', [row.id]);
  const tags = all<{ name: string }>(
    database,
    `SELECT t.name FROM tags t
     INNER JOIN question_tags qt ON qt.tag_id = t.id
     WHERE qt.question_id = ?
     ORDER BY t.name ASC`,
    [row.id]
  ).map((tag) => tag.name);

  return {
    ...row,
    tags,
    question_images: images.filter((image) => image.image_type === 'original' || image.image_type === 'question'),
    solution_images: [],
    knowledge_points: getQuestionKnowledgePoints(database, row.id)
  };
}

function buildFilterSql(filters: QuestionFilters = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  const filterValue = (value?: string) => {
    const text = value?.trim() || '';
    return text && text !== '全部' ? text : '';
  };

  if (filters.search?.trim()) {
    where.push('(title LIKE ? OR content LIKE ? OR correct_solution LIKE ? OR answer LIKE ?)');
    params.push(`%${filters.search.trim()}%`, `%${filters.search.trim()}%`, `%${filters.search.trim()}%`, `%${filters.search.trim()}%`);
  }
  if (filterValue(filters.category)) {
    where.push('category = ?');
    params.push(filterValue(filters.category));
  }
  if (filterValue(filters.questionType)) {
    where.push('question_type = ?');
    params.push(filterValue(filters.questionType));
  }
  if (filterValue(filters.errorReason)) {
    where.push('error_reason = ?');
    params.push(filterValue(filters.errorReason));
  }
  if (filterValue(filters.masteryLevel)) {
    where.push('mastery_level = ?');
    params.push(filterValue(filters.masteryLevel));
  }
  if (filters.weakOnly) {
    where.push("(mastery_level IN ('\u672a\u638c\u63e1', '\u8f83\u5f31') OR COALESCE(wrong_count, 0) > COALESCE(correct_count, 0) OR COALESCE(no_idea_count, 0) > 0)");
  }
  if (filterValue(filters.difficulty)) {
    where.push('difficulty = ?');
    params.push(filterValue(filters.difficulty));
  }
  if (filterValue(filters.source)) {
    where.push('source = ?');
    params.push(filterValue(filters.source));
  }
  if (filters.tag?.trim()) {
    where.push(`id IN (
      SELECT qt.question_id FROM question_tags qt
      INNER JOIN tags t ON t.id = qt.tag_id
      WHERE t.name LIKE ?
    )`);
    params.push(`%${filters.tag.trim()}%`);
  }

  const sortBy = ['created_at', 'last_reviewed_at', 'review_count'].includes(filters.sortBy || '')
    ? filters.sortBy
    : 'created_at';
  const sortOrder = filters.sortOrder === 'asc' ? 'ASC' : 'DESC';
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  if (process.env.KAOYAN_DEBUG_FILTERS === '1') {
    console.debug('[QuestionFilters]', { filters, whereSql, params });
  }
  return { whereSql, params, orderSql: `ORDER BY ${sortBy} ${sortOrder}, id DESC` };
}

function insertImages(database: Database, questionId: number, imageType: ImageType, sourcePaths: string[]) {
  for (const sourcePath of sourcePaths) {
    const savedPath = copyImageToStore(questionId, imageType, sourcePath);
    run(database, 'INSERT INTO question_images (question_id, image_type, file_path, created_at) VALUES (?, ?, ?, ?)', [
      questionId,
      imageType,
      savedPath,
      nowIso()
    ]);
  }
}

export async function initializeDatabase() {
  await getDb();
}

export async function createQuestion(input: QuestionInput) {
  const database = await getDb();
  const createdAt = nowIso();

  database.run('BEGIN TRANSACTION');
  try {
    run(
      database,
      `INSERT INTO questions (
        title, content, wrong_thinking, wrong_solution, correct_solution, answer, category, question_type,
        error_reason, source, difficulty, mastery_level, note, review_count, correct_count, wrong_count,
        no_idea_count, consecutive_correct,
        last_reviewed_at, next_review_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, NULL, NULL, ?, ?)`,
      [
        input.title,
        input.content,
        input.wrong_thinking,
        input.wrong_solution || input.wrong_thinking,
        input.correct_solution,
        input.answer,
        input.category,
        input.question_type,
        input.error_reason,
        input.source,
        input.difficulty,
        normalizeMastery(input.mastery_level),
        input.note,
        createdAt,
        createdAt
      ]
    );

    const id = lastInsertId(database);
    insertImages(database, id, 'original', input.questionImageSources);
    await replaceTags(database, id, input.tags);
    database.run('COMMIT');
    persist();
    const saved = await getQuestion(id);
    if (!saved) throw new Error('错题保存后读取失败');
    return saved;
  } catch (error) {
    database.run('ROLLBACK');
    throw error;
  }
}

export async function listQuestions(filters: QuestionFilters = {}) {
  const database = await getDb();
  const { whereSql, params, orderSql } = buildFilterSql(filters);
  const rows = all<Omit<Question, 'tags' | 'question_images' | 'solution_images'>>(
    database,
    `SELECT * FROM questions ${whereSql} ${orderSql}`,
    params
  );
  return hydrateQuestions(database, rows);
}

export async function getQuestion(id: number) {
  const database = await getDb();
  const row = one<Omit<Question, 'tags' | 'question_images' | 'solution_images'>>(database, 'SELECT * FROM questions WHERE id = ?', [id]);
  return row ? hydrateQuestion(database, row) : null;
}

export async function getQuestionsByIds(ids: number[]) {
  if (!ids.length) return [];
  const database = await getDb();
  const uniqueIds = Array.from(new Set(ids));
  const placeholders = uniqueIds.map(() => '?').join(', ');
  const rows = all<Omit<Question, 'tags' | 'question_images' | 'solution_images'>>(
    database,
    `SELECT * FROM questions WHERE id IN (${placeholders})`,
    uniqueIds
  );
  const order = new Map(uniqueIds.map((id, index) => [id, index]));
  return hydrateQuestions(database, rows).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

export async function updateQuestion(id: number, input: QuestionInput) {
  const database = await getDb();
  run(
    database,
    `UPDATE questions SET
      title = ?, content = ?, wrong_thinking = ?, wrong_solution = ?, correct_solution = ?, answer = ?,
      category = ?, question_type = ?, error_reason = ?, source = ?,
      difficulty = ?, mastery_level = ?, note = ?, updated_at = ?
     WHERE id = ?`,
    [
      input.title,
      input.content,
      input.wrong_thinking,
      input.wrong_solution || input.wrong_thinking,
      input.correct_solution,
      input.answer,
      input.category,
      input.question_type,
      input.error_reason,
      input.source,
      input.difficulty,
      normalizeMastery(input.mastery_level),
      input.note,
      nowIso(),
      id
    ]
  );

  insertImages(database, id, 'original', input.questionImageSources);
  await replaceTags(database, id, input.tags);
  persist();
  return getQuestion(id);
}

function splitKnowledgeTokens(values: string[]) {
  return values
    .flatMap((value) => value.split(/[;,，；]/))
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function linkQuestionKnowledgePoints(questionId: number, values: string[], matchType: 'gpt' | 'auto' | 'manual' = 'gpt') {
  const database = await getDb();
  const warnings: string[] = [];
  const tokens = Array.from(new Set(splitKnowledgeTokens(values)));

  for (const token of tokens) {
    const byNodeId = one<KnowledgePoint>(database, 'SELECT * FROM knowledge_points WHERE node_id = ?', [token]);
    const matches = byNodeId ? [byNodeId] : all<KnowledgePoint>(database, 'SELECT * FROM knowledge_points WHERE title = ? ORDER BY level ASC, sort_order ASC', [token]);

    if (!matches.length) {
      warnings.push(`未匹配到知识点：${token}`);
      continue;
    }
    if (!byNodeId && matches.length > 1) {
      warnings.push(`知识点标题重复，已使用第一个匹配项：${token}`);
    }

    run(
      database,
      'INSERT OR IGNORE INTO question_knowledge_points (question_id, knowledge_node_id, match_type, created_at) VALUES (?, ?, ?, ?)',
      [questionId, matches[0].node_id, matchType, nowIso()]
    );
  }

  persist();
  return warnings;
}

export async function deleteQuestion(id: number, deleteImages: boolean) {
  const database = await getDb();
  const images = all<QuestionImage>(database, 'SELECT * FROM question_images WHERE question_id = ?', [id]);
  run(database, 'DELETE FROM questions WHERE id = ?', [id]);
  if (deleteImages) deleteFiles(images.map((image) => image.file_path));
  persist();
  return true;
}

export async function removeImage(imageId: number, deleteFile: boolean) {
  const database = await getDb();
  const image = one<QuestionImage>(database, 'SELECT * FROM question_images WHERE id = ?', [imageId]);
  run(database, 'DELETE FROM question_images WHERE id = ?', [imageId]);
  if (image && deleteFile) deleteFiles([image.file_path]);
  persist();
  return true;
}

export async function listReviewLogs(questionId: number) {
  const database = await getDb();
  return all<ReviewLog>(
    database,
    'SELECT * FROM review_logs WHERE question_id = ? ORDER BY COALESCE(reviewed_at, review_date, created_at) DESC, id DESC',
    [questionId]
  );
}

function normalizeMastery(value: string | null | undefined): MasteryLevel {
  return OLD_MASTERY_MAP[value || ''] ?? '一般';
}

function masteryAfterResult(current: MasteryLevel, result: ReviewResultV2): MasteryLevel {
  const index = MASTERY_ORDER.indexOf(normalizeMastery(current));
  if (result === 'correct') return MASTERY_ORDER[Math.min(index + 1, MASTERY_ORDER.length - 1)];
  if (result === 'wrong') return MASTERY_ORDER[Math.max(index - 1, 0)];
  if (current === '已掌握') return '一般';
  if (current === '较好') return '较弱';
  if (current === '一般') return '较弱';
  return '未掌握';
}

function nextReviewForResult(reviewedAt: Date, result: ReviewResultV2, consecutiveCorrect: number) {
  if (result !== 'correct') return addDaysIso(reviewedAt, 1);
  const days = consecutiveCorrect === 1 ? 2 : consecutiveCorrect === 2 ? 4 : consecutiveCorrect === 3 ? 7 : consecutiveCorrect === 4 ? 15 : 30;
  return addDaysIso(reviewedAt, days);
}

function resultLabel(result: ReviewResultV2) {
  if (result === 'correct') return '做对了';
  if (result === 'wrong') return '做错了';
  return '没思路';
}

function toReviewResultV2(result: ReviewResult): ReviewResultV2 {
  if (result === '做对了') return 'correct';
  if (result === '做错了') return 'wrong';
  return 'no_idea';
}

export async function submitReviewResult(input: ReviewSubmitInput): Promise<ReviewSubmitResult> {
  const database = await getDb();
  const question = await getQuestion(input.questionId);
  if (!question) throw new Error('错题不存在');

  const reviewedAtDate = new Date();
  const reviewedAt = reviewedAtDate.toISOString();
  const masteryBefore = normalizeMastery(question.mastery_level);
  const nextConsecutive = input.result === 'correct' ? (question.consecutive_correct || 0) + 1 : 0;
  const masteryAfter = masteryAfterResult(masteryBefore, input.result);
  const nextReviewAt = nextReviewForResult(reviewedAtDate, input.result, nextConsecutive);
  const nextRound = (question.review_count || 0) + 1;
  const nextCorrectCount = (question.correct_count || 0) + (input.result === 'correct' ? 1 : 0);
  const nextWrongCount = (question.wrong_count || 0) + (input.result === 'wrong' || input.result === 'no_idea' ? 1 : 0);
  const nextNoIdeaCount = (question.no_idea_count || 0) + (input.result === 'no_idea' ? 1 : 0);

  database.run('BEGIN TRANSACTION');
  try {
    run(
      database,
      `INSERT INTO review_logs (
        question_id, result, mastery_before, mastery_after, reviewed_at, next_review_at,
        note, review_date, review_round, duration_minutes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        input.questionId,
        input.result,
        masteryBefore,
        masteryAfter,
        reviewedAt,
        nextReviewAt,
        input.note || '',
        dateOnly(reviewedAtDate),
        nextRound,
        reviewedAt
      ]
    );

    run(
      database,
      `UPDATE questions SET
        review_count = ?, correct_count = ?, wrong_count = ?, no_idea_count = ?,
        consecutive_correct = ?, last_reviewed_at = ?, next_review_at = ?,
        mastery_level = ?, updated_at = ?
       WHERE id = ?`,
      [
        nextRound,
        nextCorrectCount,
        nextWrongCount,
        nextNoIdeaCount,
        nextConsecutive,
        reviewedAt,
        nextReviewAt,
        masteryAfter,
        nowIso(),
        input.questionId
      ]
    );
    database.run('COMMIT');
  } catch (error) {
    database.run('ROLLBACK');
    throw error;
  }

  persist();
  const updated = await getQuestion(input.questionId);
  if (!updated) throw new Error('复习结果保存后读取失败');
  const log = one<ReviewLog>(database, 'SELECT * FROM review_logs WHERE question_id = ? ORDER BY id DESC LIMIT 1', [input.questionId]);
  if (!log) throw new Error('复习日志保存后读取失败');
  return {
    question: updated,
    log,
    message: `已记录：${resultLabel(input.result)}，下次复习：${dateOnly(new Date(nextReviewAt))}`
  };
}

export async function addReviewLog(input: ReviewInput) {
  const result = await submitReviewResult({
    questionId: input.questionId,
    result: toReviewResultV2(input.result),
    note: input.note
  });
  return result.question;
}

export async function markMastery(id: number, mastery: MasteryLevel) {
  const database = await getDb();
  run(database, 'UPDATE questions SET mastery_level = ?, next_review_at = ?, updated_at = ? WHERE id = ?', [
    mastery,
    mastery === '已掌握' ? null : addDays(dateOnly(), 1),
    nowIso(),
    id
  ]);
  persist();
  return getQuestion(id);
}

export async function getDashboard() {
  const database = await getDb();
  const today = dateOnly();
  const weekStart = new Date();
  const day = weekStart.getDay() || 7;
  weekStart.setDate(weekStart.getDate() - day + 1);
  const weekStartText = dateOnly(weekStart);
  const dueSql = "((next_review_at IS NOT NULL AND next_review_at != '' AND substr(next_review_at, 1, 10) <= ?) OR ((next_review_at IS NULL OR next_review_at = '') AND COALESCE(review_count, 0) = 0))";
  const weakSql = "(mastery_level IN ('\u672a\u638c\u63e1', '\u8f83\u5f31') OR COALESCE(wrong_count, 0) > COALESCE(correct_count, 0) OR COALESCE(no_idea_count, 0) > 0)";
  const reviewDateSql = "substr(COALESCE(reviewed_at, review_date, created_at), 1, 10)";

  const total = one<{ count: number }>(database, 'SELECT COUNT(*) AS count FROM questions')?.count ?? 0;
  const due = one<{ count: number }>(database, `SELECT COUNT(*) AS count FROM questions WHERE ${dueSql}`, [today])?.count ?? 0;
  const unmastered = one<{ count: number }>(database, "SELECT COUNT(*) AS count FROM questions WHERE mastery_level = '\u672a\u638c\u63e1'")?.count ?? 0;
  const weakQuestions = one<{ count: number }>(database, `SELECT COUNT(*) AS count FROM questions WHERE ${weakSql}`)?.count ?? 0;
  const weeklyRows = all<{ result: string }>(database, `SELECT result FROM review_logs WHERE ${reviewDateSql} >= ?`, [weekStartText]);
  const reviewedThisWeek = weeklyRows.length;
  const correct = weeklyRows.filter((row) => row.result === 'correct').length;
  const wrong = weeklyRows.filter((row) => row.result === 'wrong').length;
  const noIdea = weeklyRows.filter((row) => row.result === 'no_idea').length;
  const correctRateThisWeek = reviewedThisWeek ? Math.round((correct / reviewedThisWeek) * 100) : null;
  const recent = hydrateQuestions(
    database,
    all<Omit<Question, 'tags' | 'question_images' | 'solution_images'>>(
      database,
      'SELECT * FROM questions ORDER BY created_at DESC LIMIT 5'
    )
  );
  const topCategories = all<{ name: string; count: number }>(
    database,
    'SELECT category AS name, COUNT(*) AS count FROM questions GROUP BY category ORDER BY count DESC LIMIT 3'
  );
  const topErrorReasons = all<{ name: string; count: number }>(
    database,
    "SELECT COALESCE(NULLIF(error_reason, ''), '\u5176\u4ed6') AS name, COUNT(*) AS count FROM questions GROUP BY COALESCE(NULLIF(error_reason, ''), '\u5176\u4ed6') ORDER BY count DESC LIMIT 5"
  );
  return {
    total,
    due,
    unmastered,
    weakQuestions,
    reviewedThisWeek,
    correctRateThisWeek,
    weeklyReviewSummary: { total: reviewedThisWeek, correct, wrong, noIdea, correctRate: correctRateThisWeek },
    topErrorReasons,
    recent,
    topCategories
  };
}

export async function getReviewBuckets() {
  const database = await getDb();
  const today = dateOnly();
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 6);
  const weekStartText = dateOnly(weekStart);
  const due = hydrateQuestions(
    database,
    all<Omit<Question, 'tags' | 'question_images' | 'solution_images'>>(
      database,
      `SELECT * FROM questions
       WHERE mastery_level != '已掌握'
         AND ((next_review_at IS NOT NULL AND substr(next_review_at, 1, 10) <= ?)
           OR (next_review_at IS NULL AND COALESCE(review_count, 0) = 0))
       ORDER BY
         CASE mastery_level WHEN '未掌握' THEN 0 WHEN '较弱' THEN 1 WHEN '一般' THEN 2 WHEN '较好' THEN 3 ELSE 4 END ASC,
         COALESCE(wrong_count, 0) DESC,
         COALESCE(no_idea_count, 0) DESC,
         COALESCE(last_reviewed_at, created_at) ASC`,
      [today]
    )
  );
  const unmastered = hydrateQuestions(
    database,
    all<Omit<Question, 'tags' | 'question_images' | 'solution_images'>>(
      database,
      "SELECT * FROM questions WHERE mastery_level = '未掌握' ORDER BY COALESCE(no_idea_count, 0) DESC, COALESCE(wrong_count, 0) DESC, created_at DESC"
    )
  );
  const weak = hydrateQuestions(
    database,
    all<Omit<Question, 'tags' | 'question_images' | 'solution_images'>>(
      database,
      `SELECT * FROM questions
       WHERE mastery_level IN ('未掌握', '较弱') OR COALESCE(wrong_count, 0) >= 2 OR COALESCE(no_idea_count, 0) >= 1
       ORDER BY
         CASE mastery_level WHEN '未掌握' THEN 0 WHEN '较弱' THEN 1 ELSE 2 END ASC,
         COALESCE(no_idea_count, 0) DESC,
         COALESCE(wrong_count, 0) DESC,
         updated_at DESC`
    )
  );
  const repeatedWrong = hydrateQuestions(
    database,
    all<Omit<Question, 'tags' | 'question_images' | 'solution_images'>>(
      database,
      "SELECT * FROM questions WHERE COALESCE(wrong_count, 0) >= 2 OR COALESCE(no_idea_count, 0) >= 1 ORDER BY COALESCE(no_idea_count, 0) DESC, COALESCE(wrong_count, 0) DESC, updated_at DESC"
    )
  );
  const weekReviewedCount = one<{ count: number }>(
    database,
    "SELECT COUNT(*) AS count FROM review_logs WHERE substr(COALESCE(reviewed_at, review_date, created_at), 1, 10) >= ?",
    [weekStartText]
  )?.count ?? 0;

  return {
    due,
    unmastered,
    repeatedWrong,
    weak,
    weekReviewedCount,
    counts: {
      due: due.length,
      unmastered: unmastered.length,
      weak: weak.length,
      weekReviewed: weekReviewedCount
    }
  };
}

function countBy(database: Database, column: string) {
  return all<{ name: string; count: number }>(
    database,
    `SELECT ${column} AS name, COUNT(*) AS count FROM questions GROUP BY ${column} ORDER BY count DESC`
  );
}

function lastSevenDaysCounts(database: Database, table: 'questions' | 'review_logs', dateColumn: string) {
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (6 - index));
    return dateOnly(date);
  });
  const rows = all<{ date: string; count: number }>(
    database,
    `SELECT substr(${dateColumn}, 1, 10) AS date, COUNT(*) AS count
     FROM ${table}
     WHERE substr(${dateColumn}, 1, 10) >= ?
     GROUP BY substr(${dateColumn}, 1, 10)`,
    [days[0]]
  );
  return days.map((date) => ({ date, count: rows.find((row) => row.date === date)?.count ?? 0 }));
}

export async function getStats(): Promise<StatsData> {
  const database = await getDb();
  const total = one<{ count: number }>(database, 'SELECT COUNT(*) AS count FROM questions')?.count ?? 0;
  const mastered = one<{ count: number }>(database, "SELECT COUNT(*) AS count FROM questions WHERE mastery_level = '已掌握'")?.count ?? 0;
  const repeatedWrong = one<{ count: number }>(database, "SELECT COUNT(*) AS count FROM questions WHERE COALESCE(wrong_count, 0) >= 2 OR COALESCE(no_idea_count, 0) >= 1")?.count ?? 0;
  const unmastered = one<{ count: number }>(
    database,
    "SELECT COUNT(*) AS count FROM questions WHERE mastery_level IN ('未掌握', '较弱')"
  )?.count ?? 0;
  const byCategory = countBy(database, 'category');
  const byType = countBy(database, 'question_type');
  const byReason = countBy(database, 'error_reason');

  return {
    total,
    mastered,
    unmastered,
    repeatedWrong,
    byCategory,
    byType,
    byReason,
    recentNew: lastSevenDaysCounts(database, 'questions', 'created_at'),
    recentReviews: lastSevenDaysCounts(database, 'review_logs', 'reviewed_at'),
    weakestCategories: byCategory.slice(0, 3),
    topReasons: byReason.slice(0, 3)
  };
}

export async function exportData() {
  const database = await getDb();
  const payload = {
    version: 1,
    exportedAt: nowIso(),
    questions: all(database, 'SELECT * FROM questions'),
    question_images: all(database, 'SELECT * FROM question_images'),
    review_logs: all(database, 'SELECT * FROM review_logs'),
    tags: all(database, 'SELECT * FROM tags'),
    question_tags: all(database, 'SELECT * FROM question_tags'),
    textbooks: all(database, 'SELECT * FROM textbooks'),
    knowledge_points: all(database, 'SELECT * FROM knowledge_points'),
    question_knowledge_points: all(database, 'SELECT * FROM question_knowledge_points')
  };
  const fileName = `kaoyan-math-mistakes-${dateOnly()}-${Date.now()}.json`;
  const target = path.join(getPaths().exports, fileName);
  fs.writeFileSync(target, JSON.stringify(payload, null, 2), 'utf8');
  return target;
}

function assertImportPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object') throw new Error('JSON 格式不正确');
  const data = payload as Record<string, unknown>;
  for (const key of ['questions', 'question_images', 'review_logs', 'tags', 'question_tags']) {
    if (!Array.isArray(data[key])) throw new Error(`JSON 缺少 ${key} 数组`);
  }
}

export async function importData(filePath: string) {
  const database = await getDb();
  const raw = fs.readFileSync(filePath, 'utf8');
  const payload = JSON.parse(raw) as Record<string, Array<Record<string, unknown>>>;
  assertImportPayload(payload);

  const backup = path.join(getPaths().backups, `before-import-${Date.now()}.db`);
  if (fs.existsSync(getPaths().database)) fs.copyFileSync(getPaths().database, backup);

  database.run('BEGIN TRANSACTION');
  try {
    for (const table of ['question_knowledge_points', 'knowledge_points', 'textbooks', 'question_tags', 'tags', 'review_logs', 'question_images', 'questions']) {
      database.run(`DELETE FROM ${table}`);
    }

    for (const q of payload.questions) {
      run(
        database,
        `INSERT INTO questions (
          id, title, content, wrong_thinking, wrong_solution, correct_solution, answer, category, question_type,
          error_reason, source, difficulty, mastery_level, note, review_count,
          correct_count, wrong_count, no_idea_count, consecutive_correct,
          last_reviewed_at, next_review_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          q.id,
          q.title,
          q.content,
          q.wrong_thinking ?? q.wrong_solution ?? '',
          q.wrong_solution,
          q.correct_solution,
          q.answer ?? '',
          q.category,
          q.question_type,
          q.error_reason,
          q.source,
          q.difficulty,
          normalizeMastery(String(q.mastery_level || '一般')),
          q.note,
          q.review_count ?? 0,
          q.correct_count ?? 0,
          q.wrong_count ?? 0,
          q.no_idea_count ?? 0,
          q.consecutive_correct ?? 0,
          q.last_reviewed_at,
          q.next_review_at,
          q.created_at,
          q.updated_at
        ]
      );
    }

    for (const image of payload.question_images) {
      run(database, 'INSERT INTO question_images (id, question_id, image_type, file_path, created_at) VALUES (?, ?, ?, ?, ?)', [
        image.id,
        image.question_id,
        image.image_type,
        image.file_path,
        image.created_at
      ]);
    }

    for (const log of payload.review_logs) {
      run(
        database,
        `INSERT INTO review_logs (
          id, question_id, result, mastery_before, mastery_after, reviewed_at, next_review_at,
          note, review_date, review_round, duration_minutes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          log.id,
          log.question_id,
          log.result,
          log.mastery_before ?? null,
          log.mastery_after ?? null,
          log.reviewed_at ?? log.review_date ?? log.created_at,
          log.next_review_at ?? null,
          log.note ?? '',
          log.review_date ?? (typeof log.reviewed_at === 'string' ? String(log.reviewed_at).slice(0, 10) : null),
          log.review_round ?? null,
          log.duration_minutes ?? 0,
          log.created_at ?? log.reviewed_at ?? log.review_date
        ]
      );
    }

    for (const tag of payload.tags) {
      run(database, 'INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)', [tag.id, tag.name, tag.created_at]);
    }

    for (const qt of payload.question_tags) {
      run(database, 'INSERT INTO question_tags (question_id, tag_id) VALUES (?, ?)', [qt.question_id, qt.tag_id]);
    }

    for (const textbook of payload.textbooks || []) {
      run(database, 'INSERT INTO textbooks (id, title, subject, edition, file_name, file_path, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        textbook.id,
        textbook.title,
        textbook.subject ?? '',
        textbook.edition ?? '',
        textbook.file_name ?? '',
        textbook.file_path ?? '',
        textbook.note ?? '',
        textbook.created_at,
        textbook.updated_at
      ]);
    }

    for (const point of payload.knowledge_points || []) {
      run(
        database,
        `INSERT INTO knowledge_points (
          id, textbook_id, node_id, parent_node_id, title, category, level, sort_order,
          book_page, pdf_page, summary, core_formulas, common_question_types,
          common_error_reasons, tags, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          point.id,
          point.textbook_id,
          point.node_id,
          point.parent_node_id,
          point.title,
          point.category ?? '',
          point.level ?? 1,
          point.sort_order ?? 0,
          point.book_page,
          point.pdf_page,
          point.summary ?? '',
          point.core_formulas ?? '[]',
          point.common_question_types ?? '[]',
          point.common_error_reasons ?? '[]',
          point.tags ?? '[]',
          point.created_at,
          point.updated_at
        ]
      );
    }

    for (const link of payload.question_knowledge_points || []) {
      run(database, 'INSERT OR IGNORE INTO question_knowledge_points (id, question_id, knowledge_node_id, match_type, created_at) VALUES (?, ?, ?, ?, ?)', [
        link.id,
        link.question_id,
        link.knowledge_node_id,
        link.match_type ?? 'gpt',
        link.created_at
      ]);
    }

    database.run('COMMIT');
    persist();
  } catch (error) {
    database.run('ROLLBACK');
    throw error;
  }

  return { imported: true, backup };
}

export async function clearAllData(deleteImages: boolean) {
  const database = await getDb();
  const images = all<QuestionImage>(database, 'SELECT * FROM question_images');
  for (const table of ['question_knowledge_points', 'knowledge_points', 'textbooks', 'question_tags', 'tags', 'review_logs', 'question_images', 'questions']) {
    database.run(`DELETE FROM ${table}`);
  }
  if (deleteImages) deleteFiles(images.map((image) => image.file_path));
  persist();
  return true;
}

export function resetDatabaseConnection() {
  if (db) {
    db.close();
    db = null;
  }
}

export function getCurrentPaths(): AppPaths {
  return getPaths();
}

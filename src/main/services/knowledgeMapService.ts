import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dialog, shell } from 'electron';
import AdmZip from 'adm-zip';
import { allSql, getDatabase, getQuestionsByIds, inferSubjectFromCategory, lastInsertId, normalizeSubject, oneSql, persistDatabase, runSql } from './databaseService';
import { getPaths } from './pathService';
import { createImportBatch, finalizeImportBatch, recordImportAsset, recordImportBatchItem } from './importBatchService';
import type {
  BindTextbookPdfResult,
  KnowledgeMapImportResult,
  KnowledgePoint,
  KnowledgePointDetail,
  KnowledgePointReviewQuestionsResult,
  KnowledgePointReviewStats,
  KnowledgePointTreeNode,
  KnowledgeRematchResult,
  KnowledgeReviewMode,
  OpenTextbookResult,
  Question,
  Textbook,
  TextbookPdfStatus
} from '../../shared/types';

const PDF_EXT = '.pdf';

function nowIso() {
  return new Date().toISOString();
}

function dateOnly(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getDescendantNodeIds(database: Awaited<ReturnType<typeof getDatabase>>, nodeId: string) {
  const rows = allSql<Pick<KnowledgePoint, 'node_id' | 'parent_node_id'>>(database, 'SELECT node_id, parent_node_id FROM knowledge_points WHERE deleted_at IS NULL OR deleted_at = ""');
  const children = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.parent_node_id) continue;
    const list = children.get(row.parent_node_id) ?? [];
    list.push(row.node_id);
    children.set(row.parent_node_id, list);
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    ids.push(id);
    for (const child of children.get(id) ?? []) visit(child);
  };
  visit(nodeId);
  return ids;
}

function placeholders(values: unknown[]) {
  return values.map(() => '?').join(', ');
}

function masteryScoreCase() {
  return `CASE q.mastery_level
    WHEN '\u672a\u638c\u63e1' THEN 0
    WHEN '\u8f83\u5f31' THEN 25
    WHEN '\u4e00\u822c' THEN 50
    WHEN '\u8f83\u597d' THEN 75
    WHEN '\u5df2\u638c\u63e1' THEN 100
    ELSE 50
  END`;
}

function dueCondition(today: string) {
  return `((q.next_review_at IS NOT NULL AND q.next_review_at != '' AND substr(q.next_review_at, 1, 10) <= '${today}')
    OR ((q.next_review_at IS NULL OR q.next_review_at = '') AND COALESCE(q.review_count, 0) = 0))`;
}

function weakCondition() {
  return `(q.mastery_level IN ('\u672a\u638c\u63e1', '\u8f83\u5f31')
    OR COALESCE(q.wrong_count, 0) > COALESCE(q.correct_count, 0)
    OR COALESCE(q.no_idea_count, 0) > 0)`;
}

async function buildKnowledgeReviewStats(
  database: Awaited<ReturnType<typeof getDatabase>>,
  point: KnowledgePoint,
  includeChildren = true
): Promise<KnowledgePointReviewStats> {
  const nodeIds = includeChildren ? getDescendantNodeIds(database, point.node_id) : [point.node_id];
  const today = dateOnly();
  const ph = placeholders(nodeIds);
  const aggregate = oneSql<{ total_questions: number; due_questions: number; weak_questions: number; average_mastery_score: number | null }>(
    database,
    `SELECT
      COUNT(DISTINCT q.id) AS total_questions,
      SUM(CASE WHEN ${dueCondition(today)} THEN 1 ELSE 0 END) AS due_questions,
      SUM(CASE WHEN ${weakCondition()} THEN 1 ELSE 0 END) AS weak_questions,
      AVG(${masteryScoreCase()}) AS average_mastery_score
     FROM questions q
     INNER JOIN (
       SELECT DISTINCT question_id FROM question_knowledge_points WHERE knowledge_node_id IN (${ph})
     ) rel ON rel.question_id = q.id`,
    nodeIds
  );

  return {
    node_id: point.node_id,
    title: point.title,
    subject: normalizeSubject(point.subject),
    category: point.category,
    level: point.level,
    sort_order: point.sort_order,
    book_page: point.book_page,
    pdf_page: point.pdf_page,
    tags: parseList(point.tags),
    commonQuestionTypes: parseList(point.common_question_types),
    total_questions: Number(aggregate?.total_questions ?? 0),
    due_questions: Number(aggregate?.due_questions ?? 0),
    weak_questions: Number(aggregate?.weak_questions ?? 0),
    average_mastery_score: aggregate?.average_mastery_score === null || aggregate?.average_mastery_score === undefined
      ? null
      : Math.round(Number(aggregate.average_mastery_score))
  };
}

function asText(value: unknown) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function asNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sanitizeFileName(name: string) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, '_');
}

function stringifyList(value: unknown) {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => asText(item)).filter(Boolean));
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return '[]';
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) return JSON.stringify(parsed.map((item) => asText(item)).filter(Boolean));
    } catch {
      // Plain delimited text is accepted for convenience.
    }
    return JSON.stringify(text.split(/[;,，；]/).map((item) => item.trim()).filter(Boolean));
  }
  return '[]';
}

function parseList(value: string) {
  try {
    const parsed = JSON.parse(value || '[]') as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => asText(item)).filter(Boolean) : [];
  } catch {
    return value ? [value] : [];
  }
}

function splitText(value: string) {
  return value
    .split(/[;,，；]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function chooseKnowledgeZip() {
  const result = await dialog.showOpenDialog({
    title: '选择知识地图导入包',
    properties: ['openFile'],
    filters: [{ name: '知识地图包', extensions: ['zip'] }]
  });
  return result.canceled ? null : result.filePaths[0];
}

async function choosePdfFile() {
  const result = await dialog.showOpenDialog({
    title: '绑定教材 PDF',
    properties: ['openFile'],
    filters: [{ name: 'PDF 文件', extensions: ['pdf'] }]
  });
  return result.canceled ? null : result.filePaths[0];
}

function ensureSafeZip(zip: AdmZip, tempDir: string) {
  for (const entry of zip.getEntries()) {
    const target = path.resolve(tempDir, entry.entryName);
    const relative = path.relative(tempDir, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`zip 包包含不安全路径：${entry.entryName}`);
    }
  }
}

function readJsonFile<T>(filePath: string, label: string): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch (error) {
    throw new Error(`${label} 格式错误：${error instanceof Error ? error.message : String(error)}`);
  }
}

function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(fullPath));
    if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function copyTextbookPdf(tempDir: string, textbookRaw: Record<string, unknown>) {
  const paths = getPaths();
  const preferredName = asText(textbookRaw.file_name);
  const pdfCandidates: string[] = [];

  if (preferredName) pdfCandidates.push(path.join(tempDir, preferredName));
  pdfCandidates.push(...walkFiles(tempDir).filter((filePath) => path.extname(filePath).toLowerCase() === PDF_EXT));

  const source = pdfCandidates.find((candidate) => fs.existsSync(candidate));
  if (!source) return { fileName: preferredName, filePath: asText(textbookRaw.file_path), copiedPath: null };

  const fileName = sanitizeFileName(preferredName || path.basename(source));
  const target = path.join(paths.textbooks, fileName);
  fs.copyFileSync(source, target);
  return { fileName, filePath: target, copiedPath: target };
}

function upsertTextbook(database: Awaited<ReturnType<typeof getDatabase>>, textbookRaw: Record<string, unknown>, copied: { fileName: string; filePath: string }) {
  const now = nowIso();
  const title = asText(textbookRaw.title) || '未命名教材';
  const edition = asText(textbookRaw.edition);
  const subject = normalizeSubject(textbookRaw.subject);
  const existing = oneSql<Textbook>(database, 'SELECT * FROM textbooks WHERE title = ? AND edition = ?', [title, edition]);
  const fileName = copied.fileName || asText(textbookRaw.file_name);
  const filePath = copied.filePath || asText(textbookRaw.file_path);

  if (existing) {
    runSql(
      database,
      `UPDATE textbooks SET subject = ?, file_name = ?, file_path = ?, note = ?, updated_at = ? WHERE id = ?`,
      [subject, fileName, filePath || existing.file_path, asText(textbookRaw.note), now, existing.id]
    );
    return existing.id;
  }

  runSql(
    database,
    `INSERT INTO textbooks (title, subject, edition, file_name, file_path, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [title, subject, edition, fileName, filePath, asText(textbookRaw.note), now, now]
  );
  return lastInsertId(database);
}

function upsertKnowledgePoint(database: Awaited<ReturnType<typeof getDatabase>>, textbookId: number, raw: Record<string, unknown>, inheritedSubject: string, batchId?: string) {
  const now = nowIso();
  const nodeId = asText(raw.node_id);
  if (!nodeId) throw new Error('\u006e\u006f\u0064\u0065\u005f\u0069\u0064 \u4e0d\u80fd\u4e3a\u7a7a');
  const title = asText(raw.title) || nodeId;
  const inherited = asText(inheritedSubject);
  const subject = normalizeSubject(raw.subject, inherited ? normalizeSubject(inherited) : inferSubjectFromCategory(raw.category));
  const existing = oneSql<KnowledgePoint>(database, 'SELECT * FROM knowledge_points WHERE node_id = ?', [nodeId]);
  if (existing && normalizeSubject(existing.subject) !== subject) {
    throw new Error(`node_id 已存在于${normalizeSubject(existing.subject)}知识点中：${nodeId}。当前采用全局唯一 node_id，请为不同学科使用学科前缀。`);
  }
  const params = [
    textbookId,
    asText(raw.parent_node_id) || null,
    title,
    subject,
    asText(raw.category),
    asNumber(raw.level) ?? 1,
    asNumber(raw.sort_order) ?? 0,
    asNumber(raw.book_page),
    asNumber(raw.pdf_page),
    asText(raw.summary),
    stringifyList(raw.core_formulas),
    stringifyList(raw.common_question_types),
    stringifyList(raw.common_error_reasons),
    stringifyList(raw.tags),
    now
  ];

  if (existing) {
    runSql(
      database,
      `UPDATE knowledge_points SET
        textbook_id = ?, parent_node_id = ?, title = ?, subject = ?, category = ?, level = ?, sort_order = ?,
        book_page = ?, pdf_page = ?, summary = ?, core_formulas = ?, common_question_types = ?,
        common_error_reasons = ?, tags = ?, updated_at = ?
       WHERE node_id = ?`,
      [...params, nodeId]
    );
    return { status: 'updated' as const, nodeId };
  }

  runSql(
    database,
    `INSERT INTO knowledge_points (
      textbook_id, node_id, parent_node_id, title, subject, category, level, sort_order,
      book_page, pdf_page, summary, core_formulas, common_question_types,
      common_error_reasons, tags, import_batch_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [textbookId, nodeId, ...params.slice(1), batchId ?? null, now]
  );
  return { status: 'imported' as const, nodeId };
}

export async function importKnowledgeMapZip(): Promise<KnowledgeMapImportResult | null> {
  const filePath = await chooseKnowledgeZip();
  if (!filePath) return null;

  const tempDir = path.join(getPaths().temp, `knowledge-map-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    const zip = new AdmZip(filePath);
    ensureSafeZip(zip, tempDir);
    zip.extractAllTo(tempDir, true);

    const textbookJson = path.join(tempDir, 'textbooks.json');
    const pointsJson = path.join(tempDir, 'knowledge_points.json');
    if (!fs.existsSync(textbookJson)) throw new Error('知识地图包缺少 textbooks.json');
    if (!fs.existsSync(pointsJson)) throw new Error('知识地图包缺少 knowledge_points.json');

    const textbookRaw = readJsonFile<Record<string, unknown>>(textbookJson, 'textbooks.json');
    const pointRows = readJsonFile<unknown>(pointsJson, 'knowledge_points.json');
    if (!Array.isArray(pointRows)) throw new Error('knowledge_points.json 必须是数组');

    const textbookSubject = normalizeSubject(textbookRaw.subject);
    const database = await getDatabase();
    const batchId = await createImportBatch({
      type: 'knowledge_map',
      name: asText(textbookRaw.title) || path.basename(filePath),
      sourceFileName: path.basename(filePath),
      source: asText(textbookRaw.title),
      metadata: textbookRaw
    });
    const result: KnowledgeMapImportResult = {
      textbookTitle: asText(textbookRaw.title) || '未命名教材',
      subject: textbookSubject,
      importedCount: 0,
      updatedCount: 0,
      failedCount: 0,
      failures: [],
      copiedPdfPath: null
    };

    database.run('BEGIN TRANSACTION');
    try {
      const copied = copyTextbookPdf(tempDir, textbookRaw);
      result.copiedPdfPath = copied.copiedPath;
      const textbookId = upsertTextbook(database, textbookRaw, copied);
      recordImportBatchItem(database, batchId, 'textbooks', textbookId);
      if (copied.copiedPath) recordImportAsset(database, batchId, 'textbook_pdf', copied.copiedPath);

      for (const row of pointRows) {
        try {
          const status = upsertKnowledgePoint(database, textbookId, (row ?? {}) as Record<string, unknown>, asText(textbookRaw.subject), batchId);
          if (status.status === 'imported') {
            result.importedCount += 1;
            recordImportBatchItem(database, batchId, 'knowledge_points', status.nodeId);
          } else result.updatedCount += 1;
        } catch (error) {
          result.failedCount += 1;
          const current = (row ?? {}) as Record<string, unknown>;
          result.failures.push({
            node_id: asText(current.node_id),
            title: asText(current.title),
            reason: error instanceof Error ? error.message : String(error)
          });
        }
      }

      finalizeImportBatch(database, batchId, result.failedCount && !result.importedCount && !result.updatedCount ? 'failed' : 'active');
      database.run('COMMIT');
      persistDatabase();
    } catch (error) {
      database.run('ROLLBACK');
      throw error;
    }

    return result;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildQuestionCounts(database: Awaited<ReturnType<typeof getDatabase>>) {
  const directRows = allSql<{ node_id: string; count: number }>(
    database,
    `SELECT knowledge_node_id AS node_id, COUNT(*) AS count
     FROM question_knowledge_points
     GROUP BY knowledge_node_id`
  );
  return new Map(directRows.map((row) => [row.node_id, row.count]));
}

export async function listKnowledgeTree(): Promise<KnowledgePointTreeNode[]> {
  const database = await getDatabase();
  const rows = allSql<KnowledgePoint>(database, 'SELECT * FROM knowledge_points WHERE deleted_at IS NULL OR deleted_at = "" ORDER BY level ASC, sort_order ASC, title ASC');
  const directCounts = buildQuestionCounts(database);
  const byId = new Map<string, KnowledgePointTreeNode>();

  for (const row of rows) {
    byId.set(row.node_id, { ...row, subject: normalizeSubject(row.subject), children: [], questionCount: directCounts.get(row.node_id) ?? 0 });
  }

  const roots: KnowledgePointTreeNode[] = [];
  for (const node of byId.values()) {
    if (node.parent_node_id && byId.has(node.parent_node_id)) byId.get(node.parent_node_id)!.children.push(node);
    else roots.push(node);
  }

  const sortNodes = (nodes: KnowledgePointTreeNode[]) => {
    nodes.sort((a, b) => a.level - b.level || a.sort_order - b.sort_order || a.title.localeCompare(b.title, 'zh-Hans-CN'));
    for (const node of nodes) sortNodes(node.children);
  };
  const aggregate = (node: KnowledgePointTreeNode): number => {
    node.questionCount += node.children.reduce((sum, child) => sum + aggregate(child), 0);
    return node.questionCount;
  };

  sortNodes(roots);
  roots.forEach(aggregate);
  return roots;
}

function resolveTextbookPdf(textbook: Textbook | null, bookPage: number | null, pdfPage: number | null): TextbookPdfStatus | null {
  if (!textbook) return null;
  const paths = getPaths();
  const dbFilePath = asText(textbook.file_path);
  const fileName = asText(textbook.file_name) || (dbFilePath ? path.basename(dbFilePath) : '');
  const lookupPath = fileName ? path.join(paths.textbooks, fileName) : '';
  const candidates: string[] = [];

  if (dbFilePath) {
    const normalized = dbFilePath.replace(/[\\/]+/g, path.sep);
    candidates.push(path.isAbsolute(normalized) ? path.normalize(normalized) : path.join(paths.textbooks, normalized));
  }
  if (lookupPath) candidates.push(lookupPath);

  const resolvedPath = candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0] || lookupPath;
  return {
    textbookTitle: textbook.title,
    fileName,
    filePath: dbFilePath,
    textbooksDir: paths.textbooks,
    lookupPath,
    resolvedPath,
    exists: Boolean(resolvedPath && fs.existsSync(resolvedPath)),
    bookPage,
    pdfPage
  };
}


export async function getKnowledgePointReviewStats(nodeId: string, includeChildren = true): Promise<KnowledgePointReviewStats | null> {
  const database = await getDatabase();
  const point = oneSql<KnowledgePoint>(database, 'SELECT * FROM knowledge_points WHERE node_id = ? AND (deleted_at IS NULL OR deleted_at = "")', [nodeId]);
  if (!point) return null;
  return buildKnowledgeReviewStats(database, point, includeChildren);
}

export async function listKnowledgeReviewStats(): Promise<KnowledgePointReviewStats[]> {
  const database = await getDatabase();
  const points = allSql<KnowledgePoint>(database, 'SELECT * FROM knowledge_points WHERE deleted_at IS NULL OR deleted_at = "" ORDER BY level ASC, sort_order ASC, title ASC');
  const stats = await Promise.all(points.map((point) => buildKnowledgeReviewStats(database, point, true)));
  return stats.filter((item) => item.total_questions > 0);
}

export async function getKnowledgeReviewQuestions(
  nodeId: string,
  mode: KnowledgeReviewMode,
  includeChildren = true
): Promise<KnowledgePointReviewQuestionsResult> {
  const database = await getDatabase();
  const point = oneSql<KnowledgePoint>(database, 'SELECT * FROM knowledge_points WHERE node_id = ? AND (deleted_at IS NULL OR deleted_at = "")', [nodeId]);
  if (!point) throw new Error('\u77e5\u8bc6\u70b9\u4e0d\u5b58\u5728');

  const nodeIds = includeChildren ? getDescendantNodeIds(database, nodeId) : [nodeId];
  const today = dateOnly();
  const ph = placeholders(nodeIds);
  const extraWhere = mode === 'due' ? `AND (${dueCondition(today)} OR q.mastery_level IN ('\u672a\u638c\u63e1', '\u8f83\u5f31'))` : '';
  const rows = allSql<{ id: number }>(
    database,
    `SELECT DISTINCT q.id
     FROM questions q
     INNER JOIN question_knowledge_points qkp ON qkp.question_id = q.id
     WHERE qkp.knowledge_node_id IN (${ph})
       ${extraWhere}
     ORDER BY
       CASE WHEN ${dueCondition(today)} THEN 0 ELSE 1 END ASC,
       CASE q.mastery_level WHEN '\u672a\u638c\u63e1' THEN 0 WHEN '\u8f83\u5f31' THEN 1 WHEN '\u4e00\u822c' THEN 2 WHEN '\u8f83\u597d' THEN 3 WHEN '\u5df2\u638c\u63e1' THEN 4 ELSE 2 END ASC,
       COALESCE(q.no_idea_count, 0) DESC,
       COALESCE(q.wrong_count, 0) DESC,
       COALESCE(q.last_reviewed_at, q.created_at) ASC`,
    nodeIds
  );
  const questions = await getQuestionsByIds(rows.map((row) => Number(row.id)));
  const stats = await buildKnowledgeReviewStats(database, point, includeChildren);
  return { point, stats, questions, mode, includeChildren };
}

export async function getKnowledgeDetail(nodeId: string): Promise<KnowledgePointDetail | null> {
  const database = await getDatabase();
  const point = oneSql<KnowledgePoint>(database, 'SELECT * FROM knowledge_points WHERE node_id = ? AND (deleted_at IS NULL OR deleted_at = "")', [nodeId]);
  if (!point) return null;
  const textbook = point.textbook_id ? oneSql<Textbook>(database, 'SELECT * FROM textbooks WHERE id = ?', [point.textbook_id]) : null;
  const relatedQuestions = allSql<Question>(
    database,
    `SELECT q.* FROM questions q
     INNER JOIN question_knowledge_points qkp ON qkp.question_id = q.id
     WHERE qkp.knowledge_node_id = ?
     ORDER BY q.updated_at DESC`,
    [nodeId]
  );
  return {
    ...point,
    subject: normalizeSubject(point.subject),
    textbook,
    pdfStatus: resolveTextbookPdf(textbook, point.book_page, point.pdf_page),
    coreFormulas: parseList(point.core_formulas),
    commonQuestionTypes: parseList(point.common_question_types),
    commonErrorReasons: parseList(point.common_error_reasons),
    tagList: parseList(point.tags),
    relatedQuestions,
    questionCount: relatedQuestions.length,
    reviewStats: await buildKnowledgeReviewStats(database, point, true)
  };
}

export async function listKnowledgeForQuestion(questionId: number) {
  const database = await getDatabase();
  return allSql<KnowledgePoint>(
    database,
    `SELECT kp.* FROM knowledge_points kp
     INNER JOIN question_knowledge_points qkp ON qkp.knowledge_node_id = kp.node_id
     WHERE qkp.question_id = ?
       AND (kp.deleted_at IS NULL OR kp.deleted_at = '')
     ORDER BY kp.level ASC, kp.sort_order ASC, kp.title ASC`,
    [questionId]
  );
}

export async function openTextbookPage(nodeId: string): Promise<OpenTextbookResult> {
  const detail = await getKnowledgeDetail(nodeId);
  const status = detail?.pdfStatus ?? null;
  if (!status) throw new Error('当前知识点未关联教材。');
  if (!status.exists) {
    throw new Error(
      `未找到教材 PDF。请将 PDF 放入：${status.textbooksDir}，并确保文件名与数据库中的 file_name 完全一致：${status.fileName || '未设置'}`
    );
  }

  const fileUrl = pathToFileURL(status.resolvedPath).href;
  const pageUrl = status.pdfPage ? `${fileUrl}#page=${status.pdfPage}` : fileUrl;
  let usedFallback = false;

  try {
    await shell.openExternal(pageUrl);
  } catch {
    usedFallback = true;
    const errorMessage = await shell.openPath(status.resolvedPath);
    if (errorMessage) throw new Error(`教材 PDF 打开失败：${errorMessage}`);
  }

  return {
    opened: true,
    filePath: status.resolvedPath,
    pdfPage: status.pdfPage,
    bookPage: status.bookPage,
    usedFallback,
    message: status.pdfPage || status.bookPage ? `如果未自动跳转，请手动跳转到 PDF 第 ${status.pdfPage || '-'} 页 / 书本第 ${status.bookPage || '-'} 页。` : '已打开教材 PDF。'
  };
}

export async function bindTextbookPdf(nodeId: string): Promise<BindTextbookPdfResult | null> {
  const database = await getDatabase();
  const point = oneSql<KnowledgePoint>(database, 'SELECT * FROM knowledge_points WHERE node_id = ? AND (deleted_at IS NULL OR deleted_at = "")', [nodeId]);
  if (!point?.textbook_id) throw new Error('当前知识点未关联教材，无法绑定 PDF。');

  const filePath = await choosePdfFile();
  if (!filePath) return null;

  const fileName = path.basename(filePath);
  runSql(database, 'UPDATE textbooks SET file_name = ?, file_path = ?, updated_at = ? WHERE id = ?', [fileName, filePath, nowIso(), point.textbook_id]);
  persistDatabase();

  const textbook = oneSql<Textbook>(database, 'SELECT * FROM textbooks WHERE id = ?', [point.textbook_id]);
  return {
    bound: true,
    filePath,
    fileName,
    status: resolveTextbookPdf(textbook, point.book_page, point.pdf_page)
  };
}

type QuestionMatchRow = Question & { tag_text: string };

function scoreQuestionPoint(question: QuestionMatchRow, point: KnowledgePoint) {
  const pointTags = new Set(parseList(point.tags));
  const commonTypes = new Set(parseList(point.common_question_types));
  const commonReasons = new Set(parseList(point.common_error_reasons));
  const questionTags = new Set(splitText(question.tag_text || ''));
  let score = 0;

  if (question.question_type === point.title) score += 8;
  if (commonTypes.has(question.question_type)) score += 7;
  for (const tag of questionTags) {
    if (pointTags.has(tag)) score += 3;
  }
  if (commonReasons.has(question.error_reason)) score += 3;
  if (point.title && (question.title.includes(point.title) || question.content.includes(point.title))) score += 4;
  if (question.category && question.category === point.category) score += 1;

  return score;
}

export async function rematchKnowledgePoints(): Promise<KnowledgeRematchResult> {
  const database = await getDatabase();
  const questions = allSql<QuestionMatchRow>(
    database,
    `SELECT q.*, COALESCE(group_concat(t.name, ';'), '') AS tag_text
     FROM questions q
     LEFT JOIN question_tags qt ON qt.question_id = q.id
     LEFT JOIN tags t ON t.id = qt.tag_id
     GROUP BY q.id
     ORDER BY q.id ASC`
  );
  const points = allSql<KnowledgePoint>(database, 'SELECT * FROM knowledge_points WHERE deleted_at IS NULL OR deleted_at = "" ORDER BY level ASC, sort_order ASC');
  const result: KnowledgeRematchResult = {
    scannedQuestions: questions.length,
    insertedCount: 0,
    skippedExistingCount: 0,
    unmatchedQuestions: 0
  };

  database.run('BEGIN TRANSACTION');
  try {
    for (const question of questions) {
      const ranked = points
        .map((point) => ({ point, score: scoreQuestionPoint(question, point) }))
        .filter((item) => item.score >= 5)
        .sort((a, b) => b.score - a.score || a.point.level - b.point.level || a.point.sort_order - b.point.sort_order)
        .slice(0, 3);

      if (!ranked.length) {
        result.unmatchedQuestions += 1;
        continue;
      }

      for (const item of ranked) {
        const exists = oneSql<{ id: number }>(
          database,
          'SELECT id FROM question_knowledge_points WHERE question_id = ? AND knowledge_node_id = ?',
          [question.id, item.point.node_id]
        );
        if (exists) {
          result.skippedExistingCount += 1;
          continue;
        }
        runSql(
          database,
          'INSERT INTO question_knowledge_points (question_id, knowledge_node_id, match_type, created_at) VALUES (?, ?, ?, ?)',
          [question.id, item.point.node_id, 'auto', nowIso()]
        );
        result.insertedCount += 1;
      }
    }

    database.run('COMMIT');
    persistDatabase();
  } catch (error) {
    database.run('ROLLBACK');
    throw error;
  }

  return result;
}

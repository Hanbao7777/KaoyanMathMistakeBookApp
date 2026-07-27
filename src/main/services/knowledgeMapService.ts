import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { dialog, shell } from 'electron';
import AdmZip from 'adm-zip';
import type { Database, SqlValue } from 'sql.js';
import { createInternalExecutionContext } from '../application/executionContext';
import { assertDatabaseMutationScope, type DatabaseMutationScope } from '../persistence/databaseCoordinator';
import { allSql, getDatabase, getDatabaseCoordinator, getQuestionsApplication, getQuestionsByIds, inferSubjectFromCategory, lastInsertId, normalizeSubject, oneSql } from './databaseService';
import { getPaths } from './pathService';
import { createBatchId } from './importBatchService';
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
const REMATCH_BATCH_SIZE = 500;

function nowIso() {
  return new Date().toISOString();
}

function mutateSql(database: Database, scope: DatabaseMutationScope, sql: string, params: readonly unknown[] = []) {
  assertDatabaseMutationScope(scope, database);
  const statement = database.prepare(sql);
  try {
    statement.bind([...params] as SqlValue[]);
    statement.step();
  } finally {
    statement.free();
  }
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

function upsertTextbook(database: Database, scope: DatabaseMutationScope, textbookRaw: Record<string, unknown>, copied: { fileName: string; filePath: string }) {
  const now = nowIso();
  const title = asText(textbookRaw.title) || '未命名教材';
  const edition = asText(textbookRaw.edition);
  const subject = normalizeSubject(textbookRaw.subject);
  const existing = oneSql<Textbook>(database, 'SELECT * FROM textbooks WHERE title = ? AND edition = ?', [title, edition]);
  const fileName = copied.fileName || asText(textbookRaw.file_name);
  const filePath = copied.filePath || asText(textbookRaw.file_path);

  if (existing) {
    mutateSql(
      database,
      scope,
      `UPDATE textbooks SET subject = ?, file_name = ?, file_path = ?, note = ?, updated_at = ? WHERE id = ?`,
      [subject, fileName, filePath || existing.file_path, asText(textbookRaw.note), now, existing.id]
    );
    return existing.id;
  }

  mutateSql(
    database,
    scope,
    `INSERT INTO textbooks (title, subject, edition, file_name, file_path, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [title, subject, edition, fileName, filePath, asText(textbookRaw.note), now, now]
  );
  return lastInsertId(database);
}

function upsertKnowledgePoint(database: Database, scope: DatabaseMutationScope, textbookId: number, raw: Record<string, unknown>, inheritedSubject: string, batchId?: string) {
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
    mutateSql(
      database,
      scope,
      `UPDATE knowledge_points SET
        textbook_id = ?, parent_node_id = ?, title = ?, subject = ?, category = ?, level = ?, sort_order = ?,
        book_page = ?, pdf_page = ?, summary = ?, core_formulas = ?, common_question_types = ?,
        common_error_reasons = ?, tags = ?, updated_at = ?
       WHERE node_id = ?`,
      [...params, nodeId]
    );
    return { status: 'updated' as const, nodeId };
  }

  mutateSql(
    database,
    scope,
    `INSERT INTO knowledge_points (
      textbook_id, node_id, parent_node_id, title, subject, category, level, sort_order,
      book_page, pdf_page, summary, core_formulas, common_question_types,
      common_error_reasons, tags, import_batch_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [textbookId, nodeId, ...params.slice(1), batchId ?? null, now]
  );
  return { status: 'imported' as const, nodeId };
}

function createKnowledgeImportBatch(database: Database, scope: DatabaseMutationScope, input: {
  id: string;
  name: string;
  sourceFileName: string;
  source: string;
  metadata: unknown;
}) {
  mutateSql(
    database,
    scope,
    `INSERT INTO import_batches (
      id, owner_client_id, type, name, source_file_name, source, imported_at, item_count, asset_count, status, metadata_json, deleted_at
    ) VALUES (?, 'local-renderer-management', 'knowledge_map', ?, ?, ?, ?, 0, 0, 'active', ?, NULL)`,
    [input.id, input.name, input.sourceFileName, input.source, nowIso(), JSON.stringify(input.metadata)]
  );
}

function recordKnowledgeImportItem(database: Database, scope: DatabaseMutationScope, batchId: string, targetTable: string, targetId: string | number) {
  mutateSql(
    database,
    scope,
    'INSERT INTO import_batch_items (batch_id, target_table, target_id, action, created_at) VALUES (?, ?, ?, ?, ?)',
    [batchId, targetTable, String(targetId), 'created', nowIso()]
  );
}

function recordKnowledgeImportAsset(database: Database, scope: DatabaseMutationScope, batchId: string, filePath: string) {
  if (!filePath) return;
  mutateSql(
    database,
    scope,
    'INSERT INTO import_assets (batch_id, asset_type, file_path, created_at, deleted_at) VALUES (?, ?, ?, ?, NULL)',
    [batchId, 'textbook_pdf', filePath, nowIso()]
  );
}

function finalizeKnowledgeImportBatch(database: Database, scope: DatabaseMutationScope, batchId: string, status: 'active' | 'failed') {
  const itemCount = oneSql<{ count: number }>(database, 'SELECT COUNT(*) AS count FROM import_batch_items WHERE batch_id = ?', [batchId])?.count ?? 0;
  const assetCount = oneSql<{ count: number }>(database, 'SELECT COUNT(*) AS count FROM import_assets WHERE batch_id = ?', [batchId])?.count ?? 0;
  mutateSql(database, scope, 'UPDATE import_batches SET item_count = ?, asset_count = ?, status = ? WHERE id = ?', [itemCount, assetCount, status, batchId]);
}

async function persistKnowledgeImport(
  textbookRaw: Record<string, unknown>,
  pointRows: unknown[],
  copied: { fileName: string; filePath: string; copiedPath: string | null },
  batch: { name: string; sourceFileName: string; source: string; metadata: unknown },
  result: KnowledgeMapImportResult
) {
  const coordinator = await getDatabaseCoordinator();
  const batchId = createBatchId('knowledge_map');
  await coordinator.executeWrite({
    requestId: crypto.randomUUID(),
    concurrency: 'none',
    execute(database, scope) {
      createKnowledgeImportBatch(database, scope, { id: batchId, ...batch });
      const textbookId = upsertTextbook(database, scope, textbookRaw, copied);
      recordKnowledgeImportItem(database, scope, batchId, 'textbooks', textbookId);
      if (copied.copiedPath) recordKnowledgeImportAsset(database, scope, batchId, copied.copiedPath);

      for (const row of pointRows) {
        try {
          const current = (row ?? {}) as Record<string, unknown>;
          const outcome = upsertKnowledgePoint(database, scope, textbookId, current, asText(textbookRaw.subject), batchId);
          if (outcome.status === 'imported') {
            result.importedCount += 1;
            recordKnowledgeImportItem(database, scope, batchId, 'knowledge_points', outcome.nodeId);
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

      finalizeKnowledgeImportBatch(database, scope, batchId, result.failedCount && !result.importedCount && !result.updatedCount ? 'failed' : 'active');
      return { changed: true, value: null };
    }
  });
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
    const result: KnowledgeMapImportResult = {
      textbookTitle: asText(textbookRaw.title) || '未命名教材',
      subject: textbookSubject,
      importedCount: 0,
      updatedCount: 0,
      failedCount: 0,
      failures: [],
      copiedPdfPath: null
    };

    const copied = copyTextbookPdf(tempDir, textbookRaw);
    result.copiedPdfPath = copied.copiedPath;
    await persistKnowledgeImport(textbookRaw, pointRows, copied, {
      name: asText(textbookRaw.title) || path.basename(filePath),
      sourceFileName: path.basename(filePath),
      source: asText(textbookRaw.title),
      metadata: textbookRaw
    }, result);

    return result;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Import the bundled knowledge_map_seed.zip from app resources.
 * Used on first launch when knowledge_points table is empty.
 * Reuses the same upsert logic as importKnowledgeMapZip().
 */
export async function seedImportKnowledgeMap(): Promise<KnowledgeMapImportResult> {
  const { app } = require('electron') as typeof import('electron');
  const resourcesDir = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '../../resources');
  const zipPath = path.join(resourcesDir, 'knowledge_map_seed.zip');

  if (!fs.existsSync(zipPath)) {
    throw new Error(`内置考点数据包不存在：${zipPath}`);
  }

  const tempDir = path.join(getPaths().temp, `seed-import-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    const zip = new AdmZip(zipPath);
    ensureSafeZip(zip, tempDir);
    zip.extractAllTo(tempDir, true);

    const textbookJson = path.join(tempDir, 'textbooks.json');
    const pointsJson = path.join(tempDir, 'knowledge_points.json');
    if (!fs.existsSync(textbookJson)) throw new Error('种子数据包缺少 textbooks.json');
    if (!fs.existsSync(pointsJson)) throw new Error('种子数据包缺少 knowledge_points.json');

    const textbookRaw = readJsonFile<Record<string, unknown>>(textbookJson, 'textbooks.json');
    const pointRows = readJsonFile<unknown>(pointsJson, 'knowledge_points.json');
    if (!Array.isArray(pointRows)) throw new Error('knowledge_points.json 必须是数组');

    const textbookSubject = normalizeSubject(textbookRaw.subject);
    const result: KnowledgeMapImportResult = {
      textbookTitle: asText(textbookRaw.title) || '考研数学考点汇总',
      subject: textbookSubject,
      importedCount: 0,
      updatedCount: 0,
      failedCount: 0,
      failures: [],
      copiedPdfPath: null
    };

    const copied = { fileName: asText(textbookRaw.file_name), filePath: asText(textbookRaw.file_path), copiedPath: null };
    await persistKnowledgeImport(textbookRaw, pointRows, copied, {
      name: asText(textbookRaw.title) || '考点汇总种子数据',
      sourceFileName: 'knowledge_map_seed.zip',
      source: asText(textbookRaw.title),
      metadata: { ...textbookRaw, seed: true }
    }, result);

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
  const coordinator = await getDatabaseCoordinator();
  const mutation = await coordinator.executeWrite({
    requestId: crypto.randomUUID(),
    concurrency: 'none',
    execute(currentDatabase, scope) {
      mutateSql(currentDatabase, scope, 'UPDATE textbooks SET file_name = ?, file_path = ?, updated_at = ? WHERE id = ?', [fileName, filePath, nowIso(), point.textbook_id]);
      return { changed: true, value: oneSql<Textbook>(currentDatabase, 'SELECT * FROM textbooks WHERE id = ?', [point.textbook_id]) };
    }
  });
  return {
    bound: true,
    filePath,
    fileName,
    status: resolveTextbookPdf(mutation.value, point.book_page, point.pdf_page)
  };
}

type QuestionMatchRow = Question & { tag_text: string };

function scoreQuestionPoint(question: QuestionMatchRow, point: KnowledgePoint) {
  const pointTags = parseList(point.tags);
  const pointTagsSet = new Set(pointTags);
  const commonTypes = new Set(parseList(point.common_question_types));
  const commonReasons = new Set(parseList(point.common_error_reasons));
  const questionTags = splitText(question.tag_text || '');
  const questionTagsSet = new Set(questionTags);
  let score = 0;

  // Exact question_type match
  if (question.question_type === point.title) score += 8;
  if (commonTypes.has(question.question_type)) score += 7;

  // Exact tag match
  for (const tag of questionTags) {
    if (pointTagsSet.has(tag)) score += 3;
  }

  // Substring tag match (question tag contains or is contained by point tag)
  for (const qTag of questionTags) {
    for (const pTag of pointTags) {
      if (qTag.length >= 2 && pTag.length >= 2 && (qTag.includes(pTag) || pTag.includes(qTag))) {
        score += 2;
      }
    }
  }

  // Error reason match
  if (commonReasons.has(question.error_reason)) score += 3;

  // Title/content contains point title
  if (point.title && (question.title.includes(point.title) || question.content.includes(point.title))) score += 4;

  // Category match
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
  let rankedLinkCount = 0;
  let unmatchedQuestions = 0;
  for (const question of questions) {
    const rankedCount = points
      .map((point) => scoreQuestionPoint(question, point))
      .filter((score) => score >= 5)
      .sort((left, right) => right - left)
      .slice(0, 3).length;
    rankedLinkCount += rankedCount;
    if (!rankedCount) unmatchedQuestions += 1;
  }

  const application = await getQuestionsApplication();
  let scannedQuestions = 0;
  let insertedCount = 0;
  for (let offset = 0; offset < questions.length; offset += REMATCH_BATCH_SIZE) {
    const questionIds = questions.slice(offset, offset + REMATCH_BATCH_SIZE).map((question) => question.id);
    const outcome = await application.execute(
      { type: 'questions.rematch_knowledge', payload: { limit: REMATCH_BATCH_SIZE, questionIds } },
      createInternalExecutionContext({ concurrency: 'none' })
    );
    scannedQuestions += outcome.value.scannedQuestions;
    insertedCount += outcome.value.insertedCount;
  }

  return {
    scannedQuestions,
    insertedCount,
    skippedExistingCount: Math.max(0, rankedLinkCount - insertedCount),
    unmatchedQuestions
  };
}

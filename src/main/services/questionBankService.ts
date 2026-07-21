import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { dialog, shell } from 'electron';
import AdmZip from 'adm-zip';
import * as XLSX from 'xlsx';
import type { Database, SqlValue } from 'sql.js';
import { AgentError } from '../../shared/agent/errors';
import { CATEGORIES, DIFFICULTIES, ERROR_REASONS, MASTERY_LEVELS, QUESTION_TYPES } from '../../shared/options';
import type {
  AddExternalQuestionToMistakesResult,
  DeleteExternalQuestionBatchResult,
  Difficulty,
  ExternalQuestion,
  ExternalQuestionAttempt,
  ExternalQuestionAttemptInput,
  ExternalQuestionFilters,
  ExternalQuestionResult,
  ExternalQuestionStats,
  ImageUrlResult,
  MasteryLevel,
  QuestionBankImportResult,
  QuestionFormat,
  QuestionInput
} from '../../shared/types';
import {
  allSql,
  getDatabase,
  getDatabaseCoordinator,
  inferSubjectFromCategory,
  normalizeSubject,
  oneSql,
} from './databaseService';
import { getPaths } from './pathService';
import {
  createOperationManifest,
  evidenceForBytes,
  OperationJournal,
  OperationManifestStore,
  type OperationFile,
  type OperationManifest,
  type OperationManifestError
} from '../persistence/operationJournal';
import { assertDatabaseMutationScope, type DatabaseMutationScope } from '../persistence/databaseCoordinator';
import { QuestionRepository, type QuestionImageInsert } from '../application/questions/questionRepository';
import { createManagedImagePath } from './fileService';

const QUESTION_FORMATS = new Set<QuestionFormat>(['选择题', '填空题', '解答题']);
const ATTEMPT_RESULTS = new Set<ExternalQuestionResult>(['correct', 'wrong', 'no_idea']);

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

function currentVersion(database: Database) {
  const row = oneSql<{ data_epoch: string; data_revision: number }>(database, 'SELECT data_epoch, data_revision FROM control_metadata WHERE id = 1');
  if (!row) throw new Error('Question-bank mutation requires control metadata');
  return { dataEpoch: row.data_epoch, dataRevision: row.data_revision };
}

function plannedVersion(database: Database) {
  const version = currentVersion(database);
  if (version.dataRevision === Number.MAX_SAFE_INTEGER) throw new Error('Question-bank revision overflow');
  return { before: version, after: { dataEpoch: version.dataEpoch, dataRevision: version.dataRevision + 1 } };
}

function operationError(error: unknown, phase: string): OperationManifestError {
  return {
    code: typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code.slice(0, 200)
      : 'question_bank_operation_failed',
    phase,
    message: error instanceof Error ? error.message.slice(0, 1_000) || 'Question-bank operation failed' : 'Question-bank operation failed'
  };
}

function addToMistakesJournal() {
  const root = path.normalize(path.join(getPaths().data, 'operation-journal'));
  const store = new OperationManifestStore(root);
  return {
    store,
    journal: new OperationJournal(store)
  };
}

function nowIso() {
  return new Date().toISOString();
}

function asText(value: unknown) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function asNumber(value: unknown) {
  const text = asText(value);
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function normalizeDifficulty(value: unknown): Difficulty {
  const text = asText(value);
  return (DIFFICULTIES as readonly string[]).includes(text) ? (text as Difficulty) : '中等';
}

function normalizeQuestionType(value: unknown) {
  const text = asText(value);
  return QUESTION_TYPES.includes(text) ? text : '其他';
}

function normalizeCategory(value: unknown) {
  const text = asText(value);
  return CATEGORIES.includes(text) ? text : '其他';
}

function inferQuestionFormat(questionNumber: number | null): QuestionFormat {
  if (!questionNumber) return '解答题';
  if (questionNumber >= 1 && questionNumber <= 10) return '选择题';
  if (questionNumber >= 11 && questionNumber <= 16) return '填空题';
  return '解答题';
}

function normalizeQuestionFormat(value: unknown, questionNumber: number | null): QuestionFormat {
  const text = asText(value);
  return QUESTION_FORMATS.has(text as QuestionFormat) ? (text as QuestionFormat) : inferQuestionFormat(questionNumber);
}

function parseTitleHints(title: string) {
  const year = title.match(/(20\d{2})/)?.[1] ?? '';
  const examType = title.match(/数学[一二三]/)?.[0] ?? '';
  const questionNumber = title.match(/第\s*(\d+)\s*题/)?.[1] ?? '';
  return {
    year: year ? Number(year) : null,
    examType,
    questionNumber: questionNumber ? Number(questionNumber) : null
  };
}

function stringifyOptions(value: unknown) {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => asText(item)).filter(Boolean));
  if (value && typeof value === 'object') return JSON.stringify(value);
  return asText(value);
}

function createImportBatchId() {
  return `qb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ensureQuestionBankBatchDir(batchId: string) {
  const dir = path.join(getPaths().root, 'assets', 'question_bank', batchId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeRelativePath(rawPath: string) {
  const normalized = rawPath.replace(/\\/g, '/').replace(/^\.?\//, '');
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '..')) return '';
  return parts.join('/');
}

function copyDirectoryPreserve(sourceDir: string, targetDir: string) {
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) return 0;
  let copied = 0;
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copied += copyDirectoryPreserve(source, target);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      copied += 1;
    }
  }
  return copied;
}

function copyQuestionBankImageAssets(tempDir: string, batchDir: string) {
  return copyDirectoryPreserve(path.join(tempDir, 'assets', 'images'), path.join(batchDir, 'images'));
}

function copyQuestionBankPaperAssets(tempDir: string, batchDir: string) {
  return copyDirectoryPreserve(path.join(tempDir, 'assets', 'papers'), path.join(batchDir, 'papers'));
}

function listFilesRecursive(rootDir: string) {
  const files: string[] = [];
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) return files;
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      if (entry.isFile()) files.push(full);
    }
  }
  return files;
}

function safeCopyAsset(tempDir: string, rawPath: string, batchDir: string, prefix: string) {
  if (!rawPath) return '';
  const [pathPart, fragmentPart] = rawPath.split('#');
  const fragment = fragmentPart ? `#${fragmentPart}` : '';
  if (path.isAbsolute(pathPart)) return fs.existsSync(pathPart) ? `${path.normalize(pathPart)}${fragment}` : rawPath;
  const source = path.resolve(tempDir, pathPart);
  const relative = path.relative(tempDir, source);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return rawPath;
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) return rawPath;

  const safePath = safeRelativePath(pathPart);
  const targetRelative = safePath.startsWith(`assets/${prefix}/`)
    ? safePath.slice(`assets/${prefix}/`.length)
    : path.basename(pathPart).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  const target = path.join(batchDir, prefix, targetRelative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return `${target}${fragment}`;
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

async function chooseQuestionBankZip() {
  const result = await dialog.showOpenDialog({
    title: '选择 question_bank_import.zip',
    properties: ['openFile'],
    filters: [{ name: '题库导入包', extensions: ['zip'] }]
  });
  return result.canceled ? null : result.filePaths[0];
}

function readJsonFile(filePath: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`metadata.json 格式错误：${error instanceof Error ? error.message : String(error)}`);
  }
}

function readExcelRows(filePath: string) {
  const workbook = XLSX.readFile(filePath);
  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) throw new Error('external_questions.xlsx 中没有工作表');
  const sheet = workbook.Sheets[firstSheet];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
}

function normalizeExternalRow(raw: Record<string, unknown>, tempDir: string, batchDir: string) {
  const title = asText(raw.title);
  const hints = parseTitleHints(title);
  const year = asNumber(raw.year) ?? hints.year;
  const questionNumber = asNumber(raw.question_number) ?? hints.questionNumber;
  const category = normalizeCategory(raw.category);
  const subject = normalizeSubject(raw.subject, inferSubjectFromCategory(category));
  const rawFilePath = safeCopyAsset(tempDir, asText(raw.raw_file_path), batchDir, 'raw');
  const paperPdfPath = safeCopyAsset(tempDir, asText(raw.paper_pdf_path), batchDir, 'papers');
  const solutionPdfPath = safeCopyAsset(tempDir, asText(raw.solution_pdf_path), batchDir, 'papers');

  return {
    title,
    content: asText(raw.content),
    options: stringifyOptions(raw.options),
    answer: asText(raw.answer),
    solution: asText(raw.solution),
    subject,
    category,
    question_format: normalizeQuestionFormat(raw.question_format, questionNumber),
    question_type: normalizeQuestionType(raw.question_type),
    difficulty: normalizeDifficulty(raw.difficulty),
    knowledge_points: asText(raw.knowledge_points),
    source: asText(raw.source),
    year,
    exam_type: asText(raw.exam_type) || hints.examType,
    question_number: questionNumber,
    section: asText(raw.section),
    tags: asText(raw.tags),
    raw_file_path: rawFilePath,
    paper_pdf_path: paperPdfPath,
    solution_pdf_path: solutionPdfPath
  };
}

function validateImageRefs(question: Pick<ExternalQuestion, 'id' | 'import_batch_id' | 'asset_base_path'>, refs: string[]) {
  const missing: string[] = [];
  for (const ref of refs) {
    const resolved = resolveExternalAssetPath(question as ExternalQuestion, ref);
    if (!resolved || !fs.existsSync(resolved)) missing.push(ref);
  }
  return missing;
}

function pdfExists(filePath: string) {
  const clean = stripFragment(filePath);
  return Boolean(clean && fs.existsSync(clean));
}

function duplicateWhere(row: ReturnType<typeof normalizeExternalRow>, fallbackSource = '') {
  const source = row.source || fallbackSource;
  if (source && row.exam_type && row.year && row.question_number) {
    return {
      sql: 'source = ? AND exam_type = ? AND year = ? AND question_number = ?',
      params: [source, row.exam_type, row.year, row.question_number]
    };
  }
  return {
    sql: 'source = ? AND title = ?',
    params: [source, row.title]
  };
}

function recordImportAssetMutation(
  database: Database,
  scope: DatabaseMutationScope,
  batchId: string,
  assetType: string,
  filePath: string,
  timestamp: string
) {
  if (!filePath) return;
  mutateSql(
    database,
    scope,
    'INSERT INTO import_assets (batch_id, asset_type, file_path, created_at, deleted_at) VALUES (?, ?, ?, ?, NULL)',
    [batchId, assetType, filePath, timestamp]
  );
}

function recordImportBatchItemMutation(
  database: Database,
  scope: DatabaseMutationScope,
  batchId: string,
  targetId: number,
  timestamp: string
) {
  mutateSql(
    database,
    scope,
    'INSERT INTO import_batch_items (batch_id, target_table, target_id, action, created_at) VALUES (?, ?, ?, ?, ?)',
    [batchId, 'external_questions', String(targetId), 'created', timestamp]
  );
}

function finalizeImportBatchMutation(database: Database, scope: DatabaseMutationScope, batchId: string, status: 'active' | 'failed') {
  const itemCount = oneSql<{ count: number }>(database, 'SELECT COUNT(*) AS count FROM import_batch_items WHERE batch_id = ?', [batchId])?.count ?? 0;
  const assetCount = oneSql<{ count: number }>(database, 'SELECT COUNT(*) AS count FROM import_assets WHERE batch_id = ?', [batchId])?.count ?? 0;
  mutateSql(database, scope, 'UPDATE import_batches SET item_count = ?, asset_count = ?, status = ? WHERE id = ?', [itemCount, assetCount, status, batchId]);
}

function createImportBatchMutation(
  database: Database,
  scope: DatabaseMutationScope,
  input: { id: string; name: string; sourceFileName: string; source: string; metadata: unknown; status?: 'active' | 'failed' }
) {
  mutateSql(
    database,
    scope,
    `INSERT INTO import_batches (
      id, owner_client_id, type, name, source_file_name, source, imported_at, item_count, asset_count, status, metadata_json, deleted_at
    ) VALUES (?, 'local-renderer-management', 'question_bank', ?, ?, ?, ?, 0, 0, ?, ?, NULL)`,
    [input.id, input.name, input.sourceFileName, input.source, nowIso(), input.status ?? 'active', JSON.stringify(input.metadata)]
  );
}

function lastInsertId(database: Database) {
  return Number(oneSql<{ id: number }>(database, 'SELECT last_insert_rowid() AS id')?.id);
}

export async function importQuestionBankZipFromPath(filePath: string): Promise<QuestionBankImportResult> {
  const tempDir = path.join(getPaths().temp, `question-bank-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const batchId = createImportBatchId();
  const batchDir = ensureQuestionBankBatchDir(batchId);

  try {
    const zip = new AdmZip(filePath);
    ensureSafeZip(zip, tempDir);
    zip.extractAllTo(tempDir, true);

    const excelPath = path.join(tempDir, 'external_questions.xlsx');
    const metadataPath = path.join(tempDir, 'metadata.json');
    if (!fs.existsSync(excelPath)) throw new Error('question_bank_import.zip 缺少 external_questions.xlsx');
    if (!fs.existsSync(metadataPath)) throw new Error('question_bank_import.zip 缺少 metadata.json');

    const metadata = readJsonFile(metadataPath);
    const rows = readExcelRows(excelPath);
    const copiedImageCount = copyQuestionBankImageAssets(tempDir, batchDir);
    const copiedPaperCount = copyQuestionBankPaperAssets(tempDir, batchDir);
    const result: QuestionBankImportResult = {
      bankName: asText(metadata.name) || asText(metadata.title) || '未命名题库',
      source: asText(metadata.source),
      version: asText(metadata.version),
      importBatchId: batchId,
      copiedImageCount,
      copiedPaperCount,
      imageReferenceCount: 0,
      missingImageReferences: [],
      paperPdfReferenceCount: 0,
      solutionPdfReferenceCount: 0,
      missingPdfReferences: [],
      addedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      failures: []
    };
    const coordinator = await getDatabaseCoordinator();
    try {
      await coordinator.executeWrite({
        requestId: `question-bank-import-${crypto.randomUUID()}`,
        concurrency: 'none',
        execute(database, scope) {
          createImportBatchMutation(database, scope, {
            id: batchId,
            name: result.bankName,
            sourceFileName: path.basename(filePath),
            source: result.source,
            metadata
          });
          const recordedAssets = new Set<string>();
          const recordAssetOnce = (assetType: string, assetPath: string) => {
            const normalized = path.normalize(stripFragment(assetPath || ''));
            if (!normalized || recordedAssets.has(`${assetType}:${normalized}`)) return;
            recordedAssets.add(`${assetType}:${normalized}`);
            recordImportAssetMutation(database, scope, batchId, assetType, normalized, nowIso());
          };
          if (copiedImageCount) {
            for (const file of listFilesRecursive(path.join(batchDir, 'images'))) {
              recordAssetOnce('question_bank_image', file);
            }
          }
          if (copiedPaperCount) {
            for (const file of listFilesRecursive(path.join(batchDir, 'papers'))) {
              recordAssetOnce('question_bank_pdf', file);
            }
          }
          for (const [index, raw] of rows.entries()) {
            try {
              const row = normalizeExternalRow(raw, tempDir, batchDir);
              if (!row.title) throw new Error('title 不能为空');
              if (!row.content) throw new Error('content 不能为空');

              const imageRefs = [...extractMarkdownImageRefs(row.content), ...extractMarkdownImageRefs(row.solution)];
              result.imageReferenceCount = (result.imageReferenceCount || 0) + imageRefs.length;
              const missingImages = validateImageRefs({ id: 0, import_batch_id: batchId, asset_base_path: batchDir }, imageRefs);
              if (missingImages.length) {
                result.missingImageReferences = Array.from(new Set([...(result.missingImageReferences || []), ...missingImages]));
              }
              if (row.paper_pdf_path) {
                result.paperPdfReferenceCount = (result.paperPdfReferenceCount || 0) + 1;
                if (!pdfExists(row.paper_pdf_path)) result.missingPdfReferences = Array.from(new Set([...(result.missingPdfReferences || []), row.paper_pdf_path]));
              }
              if (row.solution_pdf_path) {
                result.solutionPdfReferenceCount = (result.solutionPdfReferenceCount || 0) + 1;
                if (!pdfExists(row.solution_pdf_path)) result.missingPdfReferences = Array.from(new Set([...(result.missingPdfReferences || []), row.solution_pdf_path]));
              }

              const rowSource = row.source || result.source;
              const duplicate = duplicateWhere(row, result.source);
              const exists = oneSql<{ id: number }>(database, `SELECT id FROM external_questions WHERE ${duplicate.sql} LIMIT 1`, duplicate.params);
              if (exists) {
                if (row.solution_pdf_path) {
                  mutateSql(
                    database,
                    scope,
                    "UPDATE external_questions SET solution_pdf_path = ?, updated_at = ? WHERE id = ? AND COALESCE(solution_pdf_path, '') = ''",
                    [row.solution_pdf_path, nowIso(), exists.id]
                  );
                }
                result.skippedCount += 1;
                continue;
              }

              const timestamp = nowIso();
              mutateSql(
                database,
                scope,
                `INSERT INTO external_questions (
                  title, content, options, answer, solution, subject, category, question_format, question_type,
                  difficulty, knowledge_points, source, year, exam_type, question_number, section, tags,
                  raw_file_path, paper_pdf_path, solution_pdf_path, import_batch_id, asset_base_path,
                  added_to_mistakes, created_question_id, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
                [
                  row.title,
                  row.content,
                  row.options,
                  row.answer,
                  row.solution,
                  row.subject,
                  row.category,
                  row.question_format,
                  row.question_type,
                  row.difficulty,
                  row.knowledge_points,
                  rowSource,
                  row.year,
                  row.exam_type,
                  row.question_number,
                  row.section,
                  row.tags,
                  row.raw_file_path,
                  row.paper_pdf_path,
                  row.solution_pdf_path,
                  batchId,
                  batchDir,
                  timestamp,
                  timestamp
                ]
              );
              const createdId = lastInsertId(database);
              recordImportBatchItemMutation(database, scope, batchId, createdId, timestamp);
              if (row.raw_file_path) recordAssetOnce('other', row.raw_file_path);
              if (row.paper_pdf_path) recordAssetOnce('question_bank_pdf', row.paper_pdf_path);
              if (row.solution_pdf_path) recordAssetOnce('question_bank_solution_pdf', row.solution_pdf_path);
              result.addedCount += 1;
            } catch (error) {
              result.failedCount += 1;
              result.failures.push({
                rowNumber: index + 2,
                title: asText(raw.title),
                reason: error instanceof Error ? error.message : String(error)
              });
            }
          }

          finalizeImportBatchMutation(database, scope, batchId, 'active');
          return { changed: true, value: null };
        }
      });
    } catch (error) {
      if (coordinator.state === 'writable') {
        await coordinator.executeWrite({
          requestId: `question-bank-import-failed-${crypto.randomUUID()}`,
          concurrency: 'none',
          execute(database, scope) {
            createImportBatchMutation(database, scope, {
              id: batchId,
              name: result.bankName,
              sourceFileName: path.basename(filePath),
              source: result.source,
              metadata,
              status: 'failed'
            });
            return { changed: true, value: null };
          }
        }).catch(() => undefined);
      }
      throw error;
    }

    return result;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function importQuestionBankZip(): Promise<QuestionBankImportResult | null> {
  const filePath = await chooseQuestionBankZip();
  if (!filePath) return null;
  return importQuestionBankZipFromPath(filePath);
}

function latestAttemptsSql() {
  return `LEFT JOIN (
    SELECT a.*
    FROM external_question_attempts a
    INNER JOIN (
      SELECT external_question_id, MAX(id) AS latest_id
      FROM external_question_attempts
      GROUP BY external_question_id
    ) latest ON latest.latest_id = a.id
  ) latest_attempt ON latest_attempt.external_question_id = eq.id`;
}

function buildExternalFilterSql(filters: ExternalQuestionFilters = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  const clean = (value?: string) => (value && value !== '全部' ? value.trim() : '');

  if (clean(filters.year)) {
    where.push('eq.year = ?');
    params.push(Number(filters.year));
  }
  if (clean(filters.subject)) {
    where.push("COALESCE(NULLIF(eq.subject, ''), '高等数学') = ?");
    params.push(normalizeSubject(filters.subject));
  }
  if (clean(filters.questionFormat)) {
    where.push('eq.question_format = ?');
    params.push(filters.questionFormat);
  }
  if (clean(filters.questionType)) {
    where.push('eq.question_type = ?');
    params.push(filters.questionType);
  }
  if (filters.status === 'unattempted') where.push('latest_attempt.id IS NULL');
  if (filters.status === 'attempted') where.push('latest_attempt.id IS NOT NULL');
  if (filters.status === 'added') where.push('(COALESCE(eq.added_to_mistakes, 0) = 1 OR COALESCE(latest_attempt.added_to_mistakes, 0) = 1)');

  return {
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
    params
  };
}

export async function listExternalQuestions(filters: ExternalQuestionFilters = {}) {
  const database = await getDatabase();
  const { whereSql, params } = buildExternalFilterSql(filters);
  return allSql<ExternalQuestion>(
    database,
    `SELECT
      eq.*,
      latest_attempt.result AS latest_result,
      latest_attempt.attempted_at AS latest_attempted_at,
      latest_attempt.added_to_mistakes AS latest_added_to_mistakes,
      latest_attempt.created_question_id AS latest_created_question_id,
      CASE WHEN COALESCE(eq.added_to_mistakes, 0) = 1 OR COALESCE(latest_attempt.added_to_mistakes, 0) = 1 THEN 1 ELSE 0 END AS added_to_mistakes,
      COALESCE(eq.created_question_id, latest_attempt.created_question_id) AS created_question_id
     FROM external_questions eq
     ${latestAttemptsSql()}
     ${whereSql}
     ORDER BY COALESCE(eq.year, 0) DESC, COALESCE(eq.question_number, 999) ASC, eq.id DESC`,
    params
  ).map(hydrateExternalQuestionPdfFallback);
}

export async function getExternalQuestion(id: number) {
  const database = await getDatabase();
  const question = oneSql<ExternalQuestion>(
    database,
    `SELECT
      eq.*,
      latest_attempt.result AS latest_result,
      latest_attempt.attempted_at AS latest_attempted_at,
      latest_attempt.added_to_mistakes AS latest_added_to_mistakes,
      latest_attempt.created_question_id AS latest_created_question_id,
      CASE WHEN COALESCE(eq.added_to_mistakes, 0) = 1 OR COALESCE(latest_attempt.added_to_mistakes, 0) = 1 THEN 1 ELSE 0 END AS added_to_mistakes,
      COALESCE(eq.created_question_id, latest_attempt.created_question_id) AS created_question_id
     FROM external_questions eq
     ${latestAttemptsSql()}
     WHERE eq.id = ?`,
    [id]
  );
  return question ? hydrateExternalQuestionPdfFallback(question) : null;
}

function stripFragment(filePath: string) {
  return filePath.split('#')[0];
}

function getFragment(filePath: string) {
  const index = filePath.indexOf('#');
  return index >= 0 ? filePath.slice(index) : '';
}

function resolveExternalAssetPath(question: ExternalQuestion, resourcePath: string) {
  const raw = asText(resourcePath);
  if (!raw) return '';
  const clean = stripFragment(raw).replace(/\\/g, '/').replace(/^\.?\//, '');
  const batchBase = question.asset_base_path || (question.import_batch_id ? path.join(getPaths().root, 'assets', 'question_bank', question.import_batch_id) : '');
  const candidates: string[] = [];

  if (path.isAbsolute(stripFragment(raw))) {
    candidates.push(path.normalize(stripFragment(raw)));
  }
  if (batchBase) {
    if (clean.startsWith('assets/images/')) candidates.push(path.join(batchBase, clean.slice('assets/images/'.length).replace(/\//g, path.sep).replace(/^/, `images${path.sep}`)));
    if (clean.startsWith('assets/papers/')) candidates.push(path.join(batchBase, clean.slice('assets/papers/'.length).replace(/\//g, path.sep).replace(/^/, `papers${path.sep}`)));
    candidates.push(path.join(batchBase, clean.replace(/\//g, path.sep)));
    candidates.push(path.join(batchBase, 'images', path.basename(clean)));
  }
  candidates.push(path.join(getPaths().root, clean.replace(/\//g, path.sep)));

  const unique = Array.from(new Set(candidates.map((candidate) => path.normalize(candidate))));
  return unique.find((candidate) => fs.existsSync(candidate)) || unique[0] || '';
}

function examTypeToken(examType: string) {
  if (/1|一/.test(examType)) return 'math1';
  if (/2|二/.test(examType)) return 'math2';
  if (/3|三/.test(examType)) return 'math3';
  return '';
}

function inferSolutionPdfPath(question: ExternalQuestion) {
  if (asText(question.solution_pdf_path)) return question.solution_pdf_path;
  const batchBase = question.asset_base_path || (question.import_batch_id ? path.join(getPaths().root, 'assets', 'question_bank', question.import_batch_id) : '');
  const papersDir = batchBase ? path.join(batchBase, 'papers') : '';
  if (!papersDir || !fs.existsSync(papersDir) || !fs.statSync(papersDir).isDirectory()) return '';

  const fragment = getFragment(question.paper_pdf_path || '');
  const paperBase = path.basename(stripFragment(question.paper_pdf_path || ''));
  const candidates: string[] = [];
  if (paperBase) {
    candidates.push(path.join(papersDir, paperBase.replace(/paper/i, 'solution')));
  }
  const token = examTypeToken(question.exam_type || '') || (paperBase.match(/math\d/i)?.[0] ?? '');
  if (token && question.year) candidates.push(path.join(papersDir, `${token}_${question.year}_solution.pdf`));
  if (question.year) {
    const files = fs.readdirSync(papersDir).filter((name) => name.toLowerCase().endsWith('.pdf'));
    const matched = files.find((name) => name.includes(String(question.year)) && /solution|answer|解析|答案/i.test(name));
    if (matched) candidates.push(path.join(papersDir, matched));
  }

  const found = Array.from(new Set(candidates.map((candidate) => path.normalize(candidate)))).find((candidate) => fs.existsSync(candidate));
  return found ? `${found}${fragment}` : '';
}

function hydrateExternalQuestionPdfFallback(question: ExternalQuestion): ExternalQuestion {
  const inferred = inferSolutionPdfPath(question);
  return inferred && inferred !== question.solution_pdf_path
    ? { ...question, solution_pdf_path: inferred }
    : question;
}

export async function getExternalQuestionAssetUrl(id: number, resourcePath: string): Promise<ImageUrlResult> {
  const question = await getExternalQuestion(id);
  if (!question) throw new Error('外部题目不存在');
  const resolvedPath = resolveExternalAssetPath(question, resourcePath);
  const exists = Boolean(resolvedPath && fs.existsSync(resolvedPath));
  if (!exists) {
    console.warn('[QuestionBank] Markdown 图片未找到', {
      questionId: id,
      resourcePath,
      resolvedPath,
      batchId: question.import_batch_id
    });
  }
  return {
    originalPath: resourcePath,
    resolvedPath,
    url: exists ? pathToFileURL(resolvedPath).href : '',
    exists
  };
}

export async function getExternalQuestionStats(): Promise<ExternalQuestionStats> {
  const database = await getDatabase();
  const total = oneSql<{ count: number }>(database, 'SELECT COUNT(*) AS count FROM external_questions')?.count ?? 0;
  const latest = allSql<{ result: string; added_to_mistakes: number }>(
    database,
    `SELECT latest_attempt.result,
       CASE WHEN COALESCE(eq.added_to_mistakes, 0) = 1 OR COALESCE(latest_attempt.added_to_mistakes, 0) = 1 THEN 1 ELSE 0 END AS added_to_mistakes
     FROM external_questions eq
     INNER JOIN (
       SELECT a.*
       FROM external_question_attempts a
       INNER JOIN (
         SELECT external_question_id, MAX(id) AS latest_id
         FROM external_question_attempts
         GROUP BY external_question_id
       ) latest ON latest.latest_id = a.id
     ) latest_attempt ON latest_attempt.external_question_id = eq.id`
  );
  const added = oneSql<{ count: number }>(
    database,
    `SELECT COUNT(*) AS count
     FROM external_questions eq
     ${latestAttemptsSql()}
     WHERE COALESCE(eq.added_to_mistakes, 0) = 1 OR COALESCE(latest_attempt.added_to_mistakes, 0) = 1`
  )?.count ?? 0;
  const years = allSql<{ year: number }>(
    database,
    'SELECT DISTINCT year FROM external_questions WHERE year IS NOT NULL ORDER BY year DESC'
  ).map((row) => Number(row.year));
  const questionTypes = allSql<{ question_type: string }>(
    database,
    "SELECT DISTINCT question_type FROM external_questions WHERE question_type IS NOT NULL AND question_type != '' ORDER BY question_type ASC"
  ).map((row) => row.question_type);

  return {
    total,
    attempted: latest.length,
    wrong: latest.filter((row) => row.result === 'wrong').length,
    noIdea: latest.filter((row) => row.result === 'no_idea').length,
    added,
    years,
    questionTypes
  };
}

export async function recordExternalQuestionAttempt(input: ExternalQuestionAttemptInput): Promise<ExternalQuestionAttempt> {
  if (!ATTEMPT_RESULTS.has(input.result)) throw new Error('训练结果不合法');
  const coordinator = await getDatabaseCoordinator();
  const result = await coordinator.executeWrite({
    requestId: `question-bank-attempt-${crypto.randomUUID()}`,
    concurrency: 'none',
    execute(database, scope) {
      const question = oneSql<{ id: number; added_to_mistakes: number; created_question_id: number | null }>(database, 'SELECT id, added_to_mistakes, created_question_id FROM external_questions WHERE id = ?', [input.externalQuestionId]);
      if (!question) throw new Error('外部题目不存在');
      if (question.added_to_mistakes && question.created_question_id) {
        throw new Error('这道题已经加入错题本');
      }
      mutateSql(
        database,
        scope,
        `INSERT INTO external_question_attempts (
          external_question_id, result, attempted_at, note, added_to_mistakes, created_question_id
        ) VALUES (?, ?, ?, ?, 0, NULL)`,
        [input.externalQuestionId, input.result, nowIso(), input.note || '']
      );
      const attempt = oneSql<ExternalQuestionAttempt>(database, 'SELECT * FROM external_question_attempts WHERE id = last_insert_rowid()');
      if (!attempt) throw new Error('训练记录保存后读取失败');
      return { changed: true, value: attempt };
    }
  });
  return result.value;
}

function splitTokens(value: string) {
  return value
    .split(/[;,；，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractMarkdownImageRefs(value: string) {
  const refs: string[] = [];
  const pattern = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value || ''))) refs.push(match[1]);
  return refs;
}

function stripMarkdownImageRefs(value: string) {
  return (value || '').replace(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '').trim();
}

function resolveExistingMarkdownImages(question: ExternalQuestion, value: string) {
  return extractMarkdownImageRefs(value)
    .map((ref) => resolveExternalAssetPath(question, ref))
    .filter((resolved) => resolved && fs.existsSync(resolved));
}

function buildWrongThinking(question: ExternalQuestion, latest: ExternalQuestionAttempt | null) {
  if (latest?.result === 'wrong') return '来自题库训练。用户本次标记为做错。';
  if (latest?.result === 'no_idea') return '来自题库训练。用户本次标记为没思路。';
  return '来自题库训练。用户主动加入错题本。';
}

function masteryFromAttempt(latest: ExternalQuestionAttempt | null): MasteryLevel {
  if (latest?.result === 'wrong') return '较弱';
  if (latest?.result === 'no_idea') return '未掌握';
  return '一般';
}

async function prepareAddToMistakesImages(
  database: Database,
  requestId: string,
  externalQuestionId: number,
  questionId: number,
  input: QuestionInput,
  setManifest: (manifest: OperationManifest) => void
): Promise<readonly QuestionImageInsert[]> {
  const files: OperationFile[] = [];
  const images: QuestionImageInsert[] = [];
  const sourceRoots = new Set<string>();
  const operationRoot = path.normalize(path.join(getPaths().images, '.question-bank-operations'));
  const append = (sourcePath: string, imageType: 'original' | 'solution', index: number) => {
    const absoluteSource = path.normalize(path.resolve(sourcePath));
    const fileId = `${imageType}-${index + 1}`;
    const destination = createManagedImagePath(questionId, imageType, absoluteSource, `${requestId}-${fileId}`);
    sourceRoots.add(path.dirname(absoluteSource));
    files.push({
      fileId,
      kind: 'create',
      sourcePath: absoluteSource,
      targetPath: destination.absolutePath,
      stagingPath: path.normalize(path.join(operationRoot, 'staging', `${requestId}-${fileId}.stage`)),
      content: evidenceForBytes(fs.readFileSync(absoluteSource)),
      status: 'pending'
    });
    images.push({ imageType, filePath: destination.storedPath });
  };
  input.questionImageSources.forEach((sourcePath, index) => append(sourcePath, 'original', index));
  input.solutionImageSources.forEach((sourcePath, index) => append(sourcePath, 'solution', index));
  if (!files.length) return images;

  const paths = getPaths();
  fs.mkdirSync(operationRoot, { recursive: true });
  fs.mkdirSync(path.join(paths.data, 'operation-journal'), { recursive: true });
  const version = plannedVersion(database);
  const manifest = createOperationManifest({
    operationId: requestId,
    requestId,
    commandType: 'questionBank.addToMistakes',
    source: 'internal',
    clientId: 'question-bank-service',
    traceId: requestId,
    inputHash: crypto.createHash('sha256').update(JSON.stringify({ externalQuestionId })).digest('hex'),
    storage: 'data_root',
    versionBefore: version.before,
    versionAfter: version.after,
    affectedEntities: [
      { entityType: 'external_question', entityId: String(externalQuestionId) },
      { entityType: 'question', entityId: String(questionId) }
    ],
    roots: {
      manifestRoot: path.normalize(path.join(paths.data, 'operation-journal')),
      managedRoots: [path.normalize(paths.root)],
      sourceRoots: [...sourceRoots]
    },
    files,
    createdAt: nowIso()
  });
  const { journal } = addToMistakesJournal();
  const prepared = await journal.prepare(manifest);
  setManifest(prepared);
  const staged = await journal.stage(prepared);
  setManifest(staged);
  return images;
}

async function failAddToMistakesOperation(
  coordinator: Awaited<ReturnType<typeof getDatabaseCoordinator>>,
  manifest: OperationManifest,
  error: unknown
) {
  const { store, journal } = addToMistakesJournal();
  const latest = await store.read(manifest.operationId) ?? manifest;
  try {
    if (coordinator.state === 'writable') {
      await journal.compensate(latest, operationError(error, 'database_command'));
      return;
    }
    await journal.needsRecovery(latest, operationError(error, 'database_command'));
  } catch (recoveryError) {
    const current = await store.read(manifest.operationId) ?? latest;
    await journal.needsRecovery(current, operationError(recoveryError, 'compensation')).catch(() => undefined);
    if (coordinator.state === 'writable') {
      const lease = await coordinator.beginMaintenance();
      coordinator.finishMaintenance(lease, 'needs_recovery');
    }
    throw new AgentError('RECOVERY_FENCE');
  }
}

async function completeAddToMistakesOperation(
  coordinator: Awaited<ReturnType<typeof getDatabaseCoordinator>>,
  manifest: OperationManifest
) {
  const { store, journal } = addToMistakesJournal();
  try {
    const latest = await store.read(manifest.operationId) ?? manifest;
    await journal.commitFiles(await journal.markDatabaseCommitted(latest));
  } catch (error) {
    const latest = await store.read(manifest.operationId) ?? manifest;
    await journal.needsRecovery(latest, operationError(error, 'file_finalization')).catch(() => undefined);
    if (coordinator.state === 'writable') {
      const lease = await coordinator.beginMaintenance();
      coordinator.finishMaintenance(lease, 'needs_recovery');
    }
    throw new AgentError('RECOVERY_FENCE');
  }
}

export async function addExternalQuestionToMistakes(id: number): Promise<AddExternalQuestionToMistakesResult> {
  const coordinator = await getDatabaseCoordinator();
  const requestId = `question-bank-add-${id}-${crypto.randomUUID()}`;
  let manifest: OperationManifest | null = null;
  let result;
  try {
    result = await coordinator.executeWrite({
      requestId,
      concurrency: 'none',
      async execute(database, scope) {
        const external = oneSql<ExternalQuestion>(database, 'SELECT * FROM external_questions WHERE id = ?', [id]);
        if (!external) throw new Error('外部题目不存在');
        const question = hydrateExternalQuestionPdfFallback(external);
        const latest = oneSql<ExternalQuestionAttempt>(
          database,
          'SELECT * FROM external_question_attempts WHERE external_question_id = ? ORDER BY id DESC LIMIT 1',
          [id]
        );
        if ((question.added_to_mistakes && question.created_question_id) || (latest?.added_to_mistakes && latest.created_question_id)) {
          throw new Error('这道题已经加入错题本');
        }

        const mastery = masteryFromAttempt(latest);
        const wrongThinking = buildWrongThinking(question, latest);
        const input: QuestionInput = {
          title: question.title,
          content: stripMarkdownImageRefs(question.content) || question.title,
          wrong_thinking: wrongThinking,
          wrong_solution: wrongThinking,
          correct_solution: stripMarkdownImageRefs(question.solution),
          answer: question.answer,
          subject: normalizeSubject(question.subject),
          category: normalizeCategory(question.category),
          question_type: normalizeQuestionType(question.question_type),
          error_reason: ERROR_REASONS.includes('方法没想到') ? '方法没想到' : '其他',
          source: `外部题库：${question.source || '未命名题库'}`,
          difficulty: normalizeDifficulty(question.difficulty),
          mastery_level: (MASTERY_LEVELS as readonly string[]).includes(mastery) ? mastery : '一般',
          note: [
            question.exam_type ? `考试类型：${question.exam_type}` : '',
            question.year ? `年份：${question.year}` : '',
            question.question_number ? `题号：${question.question_number}` : ''
          ].filter(Boolean).join('；'),
          tags: splitTokens(question.tags),
          questionImageSources: resolveExistingMarkdownImages(question, question.content),
          solutionImageSources: resolveExistingMarkdownImages(question, question.solution)
        };
        const repository = new QuestionRepository(database, scope);
        let created = repository.create({ ...input, questionImageSources: [], solutionImageSources: [] });
        const images = await prepareAddToMistakesImages(database, requestId, id, created.id, input, (next) => { manifest = next; });
        if (images.length) created = repository.update(created.id, input, images).question;
        repository.linkKnowledgePoints(created.id, splitTokens(question.knowledge_points), 'manual');
        mutateSql(
          database,
          scope,
          'UPDATE external_question_attempts SET added_to_mistakes = 1, created_question_id = ? WHERE external_question_id = ?',
          [created.id, id]
        );
        mutateSql(
          database,
          scope,
          'UPDATE external_questions SET added_to_mistakes = 1, created_question_id = ?, updated_at = ? WHERE id = ?',
          [created.id, nowIso(), id]
        );
        return { changed: true, value: { question: created, attempt: latest } };
      }
    });
  } catch (error) {
    const storedManifest = manifest ?? await addToMistakesJournal().store.read(requestId);
    if (storedManifest) await failAddToMistakesOperation(coordinator, storedManifest, error);
    throw error;
  }
  if (manifest) await completeAddToMistakesOperation(coordinator, manifest);
  return result.value;
}

export async function openExternalQuestionPaper(id: number) {
  const question = await getExternalQuestion(id);
  if (!question?.paper_pdf_path) throw new Error('当前题目没有关联原试卷 PDF');
  const normalized = resolveExternalAssetPath(question, question.paper_pdf_path);
  if (!fs.existsSync(normalized)) throw new Error(`原试卷 PDF 不存在：${normalized}`);
  const result = await shell.openPath(normalized);
  if (result) throw new Error(result);
  return true;
}

export async function openExternalQuestionSolutionPdf(id: number) {
  const question = await getExternalQuestion(id);
  if (!question?.solution_pdf_path) throw new Error('当前题目没有关联解析 PDF');
  const normalized = resolveExternalAssetPath(question, question.solution_pdf_path);
  if (!fs.existsSync(normalized)) throw new Error(`解析 PDF 不存在：${normalized}`);
  const result = await shell.openPath(normalized);
  if (result) throw new Error(result);
  return true;
}

export async function deleteExternalQuestionBatch(batchId: string): Promise<DeleteExternalQuestionBatchResult> {
  const cleanBatchId = safeRelativePath(batchId);
  if (!cleanBatchId || cleanBatchId !== batchId) throw new Error('题库批次 ID 不合法');
  const coordinator = await getDatabaseCoordinator();
  const deletion = await coordinator.executeWrite({
    requestId: `question-bank-delete-${crypto.randomUUID()}`,
    concurrency: 'none',
    execute(database, scope) {
      const questionCount = oneSql<{ count: number }>(database, 'SELECT COUNT(*) AS count FROM external_questions WHERE import_batch_id = ?', [batchId])?.count ?? 0;
      const attemptCount = oneSql<{ count: number }>(
        database,
        'SELECT COUNT(*) AS count FROM external_question_attempts WHERE external_question_id IN (SELECT id FROM external_questions WHERE import_batch_id = ?)',
        [batchId]
      )?.count ?? 0;
      if (attemptCount) {
        mutateSql(
          database,
          scope,
          'DELETE FROM external_question_attempts WHERE external_question_id IN (SELECT id FROM external_questions WHERE import_batch_id = ?)',
          [batchId]
        );
      }
      if (questionCount) mutateSql(database, scope, 'DELETE FROM external_questions WHERE import_batch_id = ?', [batchId]);
      return { changed: questionCount > 0 || attemptCount > 0, value: { questionCount, attemptCount } };
    }
  });

  const batchDir = path.join(getPaths().root, 'assets', 'question_bank', batchId);
  let movedAssetPath = '';
  if (fs.existsSync(batchDir)) {
    const trashDir = path.join(getPaths().root, 'trash', 'question_bank');
    fs.mkdirSync(trashDir, { recursive: true });
    movedAssetPath = path.join(trashDir, `${batchId}-${Date.now()}`);
    fs.renameSync(batchDir, movedAssetPath);
  }

  return {
    deletedQuestions: deletion.value.questionCount,
    deletedAttempts: deletion.value.attemptCount,
    movedAssetPath
  };
}

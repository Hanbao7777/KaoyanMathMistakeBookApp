import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dialog } from 'electron';
import AdmZip from 'adm-zip';
import * as XLSX from 'xlsx';
import { createInternalExecutionContext } from '../application/executionContext';
import { getDatabaseCoordinator, getQuestionsApplication, getReadOnlyDatabase } from './databaseService';
import { getPaths } from './pathService';
import type {
  Difficulty,
  MathSubject,
  MasteryLevel,
  Question,
  QuestionInput,
  StructuredImportKind,
  StructuredImportPreview,
  StructuredImportResult,
  StructuredImportRow
} from '../../shared/types';

const TEMPLATE_HEADERS = [
  'title',
  'content',
  'wrong_thinking',
  'correct_solution',
  'answer',
  'subject',
  'category',
  'question_type',
  'error_reason',
  'difficulty',
  'mastery_level',
  'source',
  'tags',
  'knowledge_points',
  'image_path'
];

const ALLOWED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const DIFFICULTY_VALUES = new Set(['简单', '中等', '困难', '压轴']);
const SUBJECT_VALUES = new Set<MathSubject>(['高等数学', '线性代数', '概率论', '其他']);
const MASTERY_MAP = new Map<string, MasteryLevel>([
  ['未掌握', '未掌握'],
  ['有点懂', '较弱'],
  ['基本掌握', '较好'],
  ['已掌握', '已掌握'],
  ['反复出错', '未掌握'],
  ['较弱', '较弱'],
  ['一般', '一般'],
  ['较好', '较好']
]);

interface ImportSession {
  preview: StructuredImportPreview;
  tempDir?: string;
}

type RowStatus = 'pending' | 'invalid' | 'failed' | 'partial' | 'succeeded';

interface DurableRowOutcome {
  rowNumber: number;
  title: string;
  status: RowStatus;
  questionId?: number;
  imageStatus: 'not_requested' | 'pending' | 'committed' | 'failed';
  knowledgeStatus: 'not_requested' | 'pending' | 'committed' | 'failed';
  reason?: string;
  warnings: string[];
}

interface StructuredBatchMetadata {
  schemaVersion: 1;
  kind: StructuredImportKind;
  totalRows: number;
  phase: 'processing' | 'completed' | 'cleanup_failed';
  cleanup: 'pending' | 'completed' | 'failed';
  rows: DurableRowOutcome[];
}

const sessions = new Map<string, ImportSession>();

function makeSessionId() {
  return `import-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function asText(value: unknown) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function normalizeImportedLatexText(value: unknown) {
  return asText(value)
    .replace(/\\\\(?=(frac|sqrt|lim|sum|int|alpha|beta|gamma|pi|theta|infty|to|left|right|cdot|times|leq|geq|neq|arctan|ln|sin|cos|tan)\b)/g, '\\')
    .replace(/\\lim_\s*([A-Za-z0-9]+)\s*\\to\s*\\infty/g, '\\lim_{$1\\to\\infty}')
    .replace(/\\frac\s*([A-Za-z0-9])\s*(\\[A-Za-z]+|[A-Za-z0-9])/g, '\\frac{$1}{$2}');
}

function withDefault(value: unknown, fallback: string) {
  const text = asText(value);
  return text || fallback;
}

function normalizeDifficulty(value: unknown): Difficulty {
  const text = withDefault(value, '中等');
  return (DIFFICULTY_VALUES.has(text) ? text : '中等') as Difficulty;
}

function normalizeMastery(value: unknown): MasteryLevel {
  const text = withDefault(value, '未掌握');
  return MASTERY_MAP.get(text) ?? '未掌握';
}

function inferSubjectFromCategory(category: unknown): MathSubject {
  const text = asText(category);
  if (text === '线性代数' || text === '行列式与矩阵' || text === '线性方程组与向量' || text === '特征值与二次型') return '线性代数';
  if (text === '概率论') return '概率论';
  return '高等数学';
}

function normalizeSubject(value: unknown, fallback: MathSubject): MathSubject {
  const text = asText(value) as MathSubject;
  return SUBJECT_VALUES.has(text) ? text : fallback;
}

function parseTags(value: unknown) {
  return asText(value)
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function parseKnowledgePoints(value: unknown) {
  return asText(value)
    .split(/[;,，；]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveImagePath(imagePath: string, baseDir: string) {
  if (!imagePath) return null;
  return path.isAbsolute(imagePath) ? imagePath : path.join(baseDir, imagePath);
}

function normalizeRow(raw: Record<string, unknown>, rowNumber: number, baseDir: string): StructuredImportRow {
  const imagePath = asText(raw.image_path);
  const resolvedImagePath = resolveImagePath(imagePath, baseDir);
  const errors: string[] = [];
  let hasImage = false;

  if (resolvedImagePath) {
    const ext = path.extname(resolvedImagePath).toLowerCase();
    if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
      errors.push('图片格式不支持，仅支持 jpg、jpeg、png、webp');
    } else if (!fs.existsSync(resolvedImagePath)) {
      errors.push(`图片文件不存在：${imagePath}`);
    } else {
      hasImage = true;
    }
  }

  return {
    rowNumber,
    title: withDefault(raw.title, '未命名错题'),
    content: normalizeImportedLatexText(raw.content),
    wrong_thinking: normalizeImportedLatexText(raw.wrong_thinking),
    correct_solution: normalizeImportedLatexText(raw.correct_solution),
    answer: normalizeImportedLatexText(raw.answer),
    subject: normalizeSubject(raw.subject, inferSubjectFromCategory(raw.category)),
    category: withDefault(raw.category, '其他'),
    question_type: withDefault(raw.question_type, '其他'),
    error_reason: withDefault(raw.error_reason, '其他'),
    difficulty: normalizeDifficulty(raw.difficulty),
    mastery_level: normalizeMastery(raw.mastery_level),
    source: withDefault(raw.source, '自己整理'),
    tags: parseTags(raw.tags),
    knowledge_points: parseKnowledgePoints(raw.knowledge_points),
    image_path: imagePath,
    resolved_image_path: resolvedImagePath,
    hasImage,
    isValid: errors.length === 0,
    errors
  };
}

function buildPreview(kind: StructuredImportKind, sourceFile: string, rows: StructuredImportRow[], tempDir?: string) {
  const sessionId = makeSessionId();
  const preview: StructuredImportPreview = {
    sessionId,
    kind,
    sourceFile,
    totalRows: rows.length,
    validRows: rows.filter((row) => row.isValid).length,
    invalidRows: rows.filter((row) => !row.isValid).length,
    rows
  };
  sessions.set(sessionId, { preview, tempDir });
  return preview;
}

function readExcelRows(filePath: string, baseDir: string) {
  const workbook = XLSX.readFile(filePath);
  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) throw new Error('Excel 文件中没有工作表');
  const sheet = workbook.Sheets[firstSheet];
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
  return rawRows.map((row, index) => normalizeRow(row, index + 2, baseDir));
}

function readJsonRows(filePath: string, baseDir: string) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  if (!Array.isArray(raw)) throw new Error('结构化 JSON 必须是错题对象数组');
  return raw.map((row, index) => normalizeRow((row ?? {}) as Record<string, unknown>, index + 1, baseDir));
}

async function chooseFile(title: string, extensions: string[]) {
  const result = await dialog.showOpenDialog({
    title,
    properties: ['openFile'],
    filters: [{ name: extensions.join(', '), extensions }]
  });
  return result.canceled ? null : result.filePaths[0];
}

export function createImportTemplate() {
  const row = {
    title: '反三角函数指数型数列极限',
    content: String.raw`\lim_{n\to\infty}\left(\frac{4}{\pi}\arctan\frac{n}{n+1}\right)^n`,
    wrong_thinking: '判断为 1 的无穷型，但后续极限转化不够规范。',
    correct_solution: '转化为 e^{n\\ln u_n}，再利用 arctan x 在 x=1 附近的线性近似。',
    answer: 'e^{-2/\\pi}',
    subject: '高等数学',
    category: '函数、极限、连续',
    question_type: '指数型极限',
    error_reason: '极限转化过程不够规范',
    difficulty: '中等',
    mastery_level: '较弱',
    source: '自己整理',
    tags: '极限,数列极限,1的无穷型,对数化,arctan',
    knowledge_points: 'limit_equivalent_infinitesimal',
    image_path: 'images/001.png'
  };
  const sheet = XLSX.utils.json_to_sheet([row], { header: TEMPLATE_HEADERS });
  XLSX.utils.sheet_add_aoa(sheet, [TEMPLATE_HEADERS], { origin: 'A1' });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'import');
  const target = path.join(getPaths().exports, `错题导入模板-${Date.now()}.xlsx`);
  XLSX.writeFile(workbook, target);
  return target;
}

export async function prepareExcelImport() {
  const filePath = await chooseFile('选择 Excel 错题文件', ['xlsx']);
  if (!filePath) return null;
  const rows = readExcelRows(filePath, path.dirname(filePath));
  return buildPreview('excel', filePath, rows);
}

export async function prepareJsonImport() {
  const filePath = await chooseFile('选择结构化 JSON 错题文件', ['json']);
  if (!filePath) return null;
  const rows = readJsonRows(filePath, path.dirname(filePath));
  return buildPreview('json', filePath, rows);
}

export async function prepareZipImport() {
  const filePath = await chooseFile('选择 zip 错题包', ['zip']);
  if (!filePath) return null;

  const sessionId = makeSessionId();
  const tempDir = path.join(getPaths().temp, sessionId);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    const zip = new AdmZip(filePath);
    for (const entry of zip.getEntries()) {
      const target = path.resolve(tempDir, entry.entryName);
      const relative = path.relative(tempDir, target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`zip 包包含不安全路径：${entry.entryName}`);
      }
    }
    zip.extractAllTo(tempDir, true);
    const excelPath = path.join(tempDir, 'import.xlsx');
    if (!fs.existsSync(excelPath)) throw new Error('zip 包中未找到 import.xlsx');
    const rows = readExcelRows(excelPath, tempDir);
    const preview = {
      sessionId,
      kind: 'zip' as const,
      sourceFile: filePath,
      totalRows: rows.length,
      validRows: rows.filter((row) => row.isValid).length,
      invalidRows: rows.filter((row) => !row.isValid).length,
      rows
    };
    sessions.set(sessionId, { preview, tempDir });
    return preview;
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function toQuestionInput(row: StructuredImportRow, batchId?: string): QuestionInput {
  return {
    title: row.title,
    content: row.content,
    wrong_thinking: row.wrong_thinking,
    wrong_solution: row.wrong_thinking,
    correct_solution: row.correct_solution,
    answer: row.answer,
    subject: row.subject,
    category: row.category,
    question_type: row.question_type,
    error_reason: row.error_reason,
    source: row.source,
    difficulty: row.difficulty,
    mastery_level: row.mastery_level,
    note: '',
    tags: row.tags,
    questionImageSources: row.resolved_image_path && row.hasImage ? [row.resolved_image_path] : [],
    solutionImageSources: [],
    import_batch_id: batchId
  };
}

function nowIso() {
  return new Date().toISOString();
}

function createBatchId() {
  return `wrong_questions-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function commandContext(traceId: string) {
  return createInternalExecutionContext({
    concurrency: 'none',
    requestId: crypto.randomUUID(),
    traceId
  });
}

function readMetadata(database: import('sql.js').Database, batchId: string): StructuredBatchMetadata {
  const statement = database.prepare('SELECT metadata_json FROM import_batches WHERE id = ?');
  try {
    statement.bind([batchId]);
    if (!statement.step()) throw new Error('结构化导入批次不存在');
    const value = statement.getAsObject().metadata_json;
    if (typeof value !== 'string') throw new Error('结构化导入批次元数据无效');
    return JSON.parse(value) as StructuredBatchMetadata;
  } finally {
    statement.free();
  }
}

async function createStructuredBatch(session: ImportSession) {
  const coordinator = await getDatabaseCoordinator();
  const batchId = createBatchId();
  const metadata: StructuredBatchMetadata = {
    schemaVersion: 1,
    kind: session.preview.kind,
    totalRows: session.preview.totalRows,
    phase: 'processing',
    cleanup: 'pending',
    rows: session.preview.rows.map((row) => ({
      rowNumber: row.rowNumber,
      title: row.title,
      status: 'pending',
      imageStatus: row.hasImage ? 'pending' : 'not_requested',
      knowledgeStatus: row.knowledge_points.length ? 'pending' : 'not_requested',
      warnings: []
    }))
  };
  await coordinator.executeWrite({
    requestId: crypto.randomUUID(),
    concurrency: 'none',
    execute(database) {
      database.run(
        `INSERT INTO import_batches (
          id, type, name, source_file_name, source, imported_at, item_count, asset_count, status, metadata_json, deleted_at
        ) VALUES (?, 'wrong_questions', ?, ?, '', ?, 0, 0, 'active', ?, NULL)`,
        [batchId, path.basename(session.preview.sourceFile), path.basename(session.preview.sourceFile), nowIso(), JSON.stringify(metadata)]
      );
      return { changed: true, value: batchId };
    }
  });
  return batchId;
}

async function recordRowOutcome(batchId: string, outcome: DurableRowOutcome, question?: Question) {
  const coordinator = await getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: crypto.randomUUID(),
    concurrency: 'none',
    execute(database) {
      const metadata = readMetadata(database, batchId);
      const index = metadata.rows.findIndex((row) => row.rowNumber === outcome.rowNumber);
      if (index < 0) throw new Error(`结构化导入行不存在：${outcome.rowNumber}`);
      metadata.rows[index] = outcome;
      if (question) {
        database.run(
          'INSERT INTO import_batch_items (batch_id, target_table, target_id, action, created_at) VALUES (?, ?, ?, ?, ?)',
          [batchId, 'questions', String(question.id), 'created', nowIso()]
        );
        for (const image of [...question.question_images, ...question.solution_images]) {
          const absolutePath = path.join(getPaths().root, image.file_path.replaceAll('/', path.sep));
          database.run(
            'INSERT INTO import_assets (batch_id, asset_type, file_path, created_at, deleted_at) VALUES (?, ?, ?, ?, NULL)',
            [batchId, 'question_image', absolutePath, nowIso()]
          );
        }
      }
      database.run('UPDATE import_batches SET metadata_json = ? WHERE id = ?', [JSON.stringify(metadata), batchId]);
      return { changed: true, value: null };
    }
  });
}

async function resolveKnowledgePoints(values: readonly string[]) {
  const database = await getReadOnlyDatabase();
  const nodeIds: string[] = [];
  const warnings: string[] = [];
  for (const token of values) {
    const byNodeId = database.select<{ node_id: string }>('SELECT node_id FROM knowledge_points WHERE node_id = ?', [token]);
    const matches = byNodeId.length
      ? byNodeId
      : database.select<{ node_id: string }>('SELECT node_id FROM knowledge_points WHERE title = ? ORDER BY level ASC, sort_order ASC', [token]);
    if (!matches.length) warnings.push(`未匹配到知识点：${token}`);
    else {
      if (!byNodeId.length && matches.length > 1) warnings.push(`知识点标题重复，已使用第一个匹配项：${token}`);
      nodeIds.push(matches[0].node_id);
    }
  }
  return { nodeIds, warnings };
}

async function finalizeStructuredBatch(batchId: string, result: StructuredImportResult, cleanup: 'completed' | 'failed') {
  const coordinator = await getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: crypto.randomUUID(),
    concurrency: 'none',
    execute(database) {
      const metadata = readMetadata(database, batchId);
      const unresolved = metadata.rows.filter((row) => row.status === 'pending').length;
      metadata.cleanup = cleanup;
      metadata.phase = cleanup === 'completed' && unresolved === 0 ? 'completed' : 'cleanup_failed';
      const itemStatement = database.prepare('SELECT COUNT(*) AS count FROM import_batch_items WHERE batch_id = ?');
      const assetStatement = database.prepare('SELECT COUNT(*) AS count FROM import_assets WHERE batch_id = ?');
      try {
        itemStatement.bind([batchId]);
        assetStatement.bind([batchId]);
        itemStatement.step();
        assetStatement.step();
        const itemCount = Number(itemStatement.getAsObject().count ?? 0);
        const assetCount = Number(assetStatement.getAsObject().count ?? 0);
        const status = result.successCount === 0 && result.failCount > 0 ? 'failed' : 'active';
        database.run(
          'UPDATE import_batches SET item_count = ?, asset_count = ?, status = ?, metadata_json = ? WHERE id = ?',
          [itemCount, assetCount, status, JSON.stringify(metadata), batchId]
        );
      } finally {
        itemStatement.free();
        assetStatement.free();
      }
      return { changed: true, value: null };
    }
  });
}

export async function confirmStructuredImport(sessionId: string): Promise<StructuredImportResult> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('导入会话已失效，请重新选择文件');

  const result: StructuredImportResult = {
    successCount: 0,
    failCount: 0,
    imageCopiedCount: 0,
    failures: [],
    warnings: []
  };
  const traceId = crypto.randomUUID();
  const batchId = await createStructuredBatch(session);
  const application = await getQuestionsApplication();

  for (const row of session.preview.rows) {
    if (!row.isValid) {
      const reason = row.errors.join('；');
      result.failCount += 1;
      result.failures.push({ rowNumber: row.rowNumber, title: row.title, reason });
      await recordRowOutcome(batchId, {
        rowNumber: row.rowNumber,
        title: row.title,
        status: 'invalid',
        imageStatus: row.hasImage ? 'failed' : 'not_requested',
        knowledgeStatus: row.knowledge_points.length ? 'failed' : 'not_requested',
        reason,
        warnings: []
      });
      continue;
    }

    let saved: Question | undefined;
    try {
      const created = await application.execute(
        { type: 'questions.create', payload: { input: toQuestionInput(row, batchId), externalRef: `${batchId}:${row.rowNumber}` } },
        commandContext(traceId)
      );
      saved = created.value;
      const resolved = await resolveKnowledgePoints(row.knowledge_points);
      for (const message of resolved.warnings) {
        result.warnings?.push({ rowNumber: row.rowNumber, title: row.title, message });
      }
      if (resolved.nodeIds.length) {
        await application.execute({
          type: 'questions.link_knowledge',
          payload: { questionId: saved.id, knowledgeNodeIds: resolved.nodeIds, matchType: 'gpt' }
        }, commandContext(traceId));
      }
      await recordRowOutcome(batchId, {
        rowNumber: row.rowNumber,
        title: row.title,
        status: 'succeeded',
        questionId: saved.id,
        imageStatus: row.hasImage ? 'committed' : 'not_requested',
        knowledgeStatus: row.knowledge_points.length ? 'committed' : 'not_requested',
        warnings: resolved.warnings
      }, saved);
      result.successCount += 1;
      if (row.hasImage) result.imageCopiedCount += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      result.failCount += 1;
      result.failures.push({ rowNumber: row.rowNumber, title: row.title, reason });
      await recordRowOutcome(batchId, {
        rowNumber: row.rowNumber,
        title: row.title,
        status: saved ? 'partial' : 'failed',
        questionId: saved?.id,
        imageStatus: saved && row.hasImage ? 'committed' : row.hasImage ? 'failed' : 'not_requested',
        knowledgeStatus: row.knowledge_points.length ? 'failed' : 'not_requested',
        reason,
        warnings: []
      }, saved);
    }
  }

  let cleanup: 'completed' | 'failed' = 'completed';
  try {
    cleanupStructuredImport(sessionId);
  } catch (error) {
    cleanup = 'failed';
    result.warnings?.push({
      rowNumber: 0,
      title: path.basename(session.preview.sourceFile),
      message: `临时文件清理失败：${error instanceof Error ? error.message : String(error)}`
    });
  }
  await finalizeStructuredBatch(batchId, result, cleanup);

  return result;
}

export function cleanupStructuredImport(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return true;
  if (session.tempDir) {
    fs.rmSync(session.tempDir, { recursive: true, force: true });
  }
  sessions.delete(sessionId);
  return true;
}

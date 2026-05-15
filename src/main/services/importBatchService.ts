import fs from 'node:fs';
import path from 'node:path';
import { shell } from 'electron';
import {
  allSql,
  getDatabase,
  oneSql,
  persistDatabase,
  runSql
} from './databaseService';
import { createDatabaseBackup } from './backupService';
import { getPaths } from './pathService';
import type {
  DeleteImportBatchOptions,
  DeleteImportBatchResult,
  DeleteLegacyExternalQuestionGroupResult,
  ImportAsset,
  ImportBatch,
  ImportBatchDetail,
  ImportBatchType,
  LegacyExternalQuestionGroup
} from '../../shared/types';

function nowIso() {
  return new Date().toISOString();
}

export function createBatchId(type: ImportBatchType) {
  return `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function createImportBatch(input: {
  id?: string;
  type: ImportBatchType;
  name?: string;
  sourceFileName?: string;
  source?: string;
  metadata?: unknown;
}) {
  const database = await getDatabase();
  const id = input.id || createBatchId(input.type);
  runSql(
    database,
    `INSERT INTO import_batches (
      id, type, name, source_file_name, source, imported_at, item_count, asset_count, status, metadata_json, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'active', ?, NULL)`,
    [
      id,
      input.type,
      input.name || '',
      input.sourceFileName || '',
      input.source || '',
      nowIso(),
      input.metadata ? JSON.stringify(input.metadata) : ''
    ]
  );
  return id;
}

export function recordImportBatchItem(database: Awaited<ReturnType<typeof getDatabase>>, batchId: string, targetTable: string, targetId: string | number, action = 'created') {
  runSql(
    database,
    'INSERT INTO import_batch_items (batch_id, target_table, target_id, action, created_at) VALUES (?, ?, ?, ?, ?)',
    [batchId, targetTable, String(targetId), action, nowIso()]
  );
}

export function recordImportAsset(database: Awaited<ReturnType<typeof getDatabase>>, batchId: string, assetType: string, filePath: string) {
  if (!filePath) return;
  runSql(
    database,
    'INSERT INTO import_assets (batch_id, asset_type, file_path, created_at, deleted_at) VALUES (?, ?, ?, ?, NULL)',
    [batchId, assetType, filePath, nowIso()]
  );
}

export function finalizeImportBatch(database: Awaited<ReturnType<typeof getDatabase>>, batchId: string, status: 'active' | 'failed' = 'active') {
  const itemCount = oneSql<{ count: number }>(database, 'SELECT COUNT(*) AS count FROM import_batch_items WHERE batch_id = ?', [batchId])?.count ?? 0;
  const assetCount = oneSql<{ count: number }>(database, 'SELECT COUNT(*) AS count FROM import_assets WHERE batch_id = ?', [batchId])?.count ?? 0;
  runSql(database, 'UPDATE import_batches SET item_count = ?, asset_count = ?, status = ? WHERE id = ?', [itemCount, assetCount, status, batchId]);
}

export async function listImportBatches() {
  const database = await getDatabase();
  return allSql<ImportBatch>(
    database,
    "SELECT * FROM import_batches ORDER BY imported_at DESC"
  );
}

export async function getImportBatchDetail(batchId: string): Promise<ImportBatchDetail | null> {
  const database = await getDatabase();
  const batch = oneSql<ImportBatch>(database, 'SELECT * FROM import_batches WHERE id = ?', [batchId]);
  if (!batch) return null;
  const items = allSql<ImportBatchDetail['items'][number]>(database, 'SELECT * FROM import_batch_items WHERE batch_id = ? ORDER BY id ASC', [batchId]);
  const assets = allSql<ImportAsset>(database, 'SELECT * FROM import_assets WHERE batch_id = ? ORDER BY id ASC', [batchId]);
  const tableCounts = allSql<{ target_table: string; count: number }>(
    database,
    'SELECT target_table, COUNT(*) AS count FROM import_batch_items WHERE batch_id = ? GROUP BY target_table ORDER BY target_table ASC',
    [batchId]
  );
  return { batch, items, assets, tableCounts };
}

function uniqueTargetPath(targetPath: string) {
  if (!fs.existsSync(targetPath)) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  let index = 1;
  let next = targetPath;
  while (fs.existsSync(next)) {
    next = path.join(dir, `${base}-${index}${ext}`);
    index += 1;
  }
  return next;
}

function safeMoveAsset(filePath: string, batchId: string) {
  const cleanBatch = batchId.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  const trashRoot = path.join(getPaths().root, 'trash', 'imports', cleanBatch);
  const normalized = path.normalize(filePath.split('#')[0]);
  if (!normalized || !fs.existsSync(normalized)) return { moved: false, failed: '' };
  const batchRoot = path.normalize(path.join(getPaths().root, 'assets', 'question_bank', batchId));
  const relativeToBatch = path.relative(batchRoot, normalized);
  const safeRelative = relativeToBatch && !relativeToBatch.startsWith('..') && !path.isAbsolute(relativeToBatch)
    ? relativeToBatch
    : path.basename(normalized);
  const target = uniqueTargetPath(path.join(trashRoot, safeRelative));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.renameSync(normalized, target);
    return { moved: true, failed: '' };
  } catch {
    try {
      fs.copyFileSync(normalized, target);
      fs.unlinkSync(normalized);
      return { moved: true, failed: '' };
    } catch (error) {
      return { moved: false, failed: `${normalized}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}

function moveAssets(database: Awaited<ReturnType<typeof getDatabase>>, batchId: string, assets: ImportAsset[]) {
  let moved = 0;
  const failed: string[] = [];
  for (const asset of assets) {
    const result = safeMoveAsset(asset.file_path, batchId);
    if (result.moved) {
      moved += 1;
      runSql(database, 'UPDATE import_assets SET deleted_at = ? WHERE id = ?', [nowIso(), asset.id]);
    }
    if (result.failed) failed.push(result.failed);
  }
  return { moved, failed };
}

export async function deleteImportBatch(batchId: string, options: DeleteImportBatchOptions = {}): Promise<DeleteImportBatchResult> {
  const database = await getDatabase();
  const detail = await getImportBatchDetail(batchId);
  if (!detail) throw new Error('导入批次不存在');
  if (detail.batch.status === 'deleted') throw new Error('该导入批次已经删除');

  const backup = createDatabaseBackup('before_delete_import');
  const result: DeleteImportBatchResult = {
    backupPath: backup.filePath,
    deletedQuestions: 0,
    deletedExternalQuestions: 0,
    deletedAttempts: 0,
    softDeletedKnowledgePoints: 0,
    movedAssets: 0,
    failedAssets: []
  };

  const externalIds = detail.items.filter((item) => item.target_table === 'external_questions').map((item) => item.target_id);
  const questionIds = detail.items.filter((item) => item.target_table === 'questions').map((item) => item.target_id);
  const knowledgeIds = detail.items.filter((item) => item.target_table === 'knowledge_points').map((item) => item.target_id);
  const linkedQuestionIds = externalIds.length
    ? (() => {
      const ph = externalIds.map(() => '?').join(', ');
      return allSql<{ question_id: number }>(
        database,
        `SELECT DISTINCT created_question_id AS question_id FROM external_questions
         WHERE id IN (${ph}) AND created_question_id IS NOT NULL
         UNION
         SELECT DISTINCT created_question_id AS question_id FROM external_question_attempts
         WHERE external_question_id IN (${ph}) AND created_question_id IS NOT NULL`,
        [...externalIds, ...externalIds]
      ).map((row) => String(row.question_id));
    })()
    : [];

  database.run('BEGIN TRANSACTION');
  try {
    if (externalIds.length) {
      const ph = externalIds.map(() => '?').join(', ');
      result.deletedAttempts = oneSql<{ count: number }>(database, `SELECT COUNT(*) AS count FROM external_question_attempts WHERE external_question_id IN (${ph})`, externalIds)?.count ?? 0;
      runSql(database, `DELETE FROM external_question_attempts WHERE external_question_id IN (${ph})`, externalIds);
      result.deletedExternalQuestions = oneSql<{ count: number }>(database, `SELECT COUNT(*) AS count FROM external_questions WHERE id IN (${ph})`, externalIds)?.count ?? 0;
      runSql(database, `DELETE FROM external_questions WHERE id IN (${ph})`, externalIds);
    }

    if (questionIds.length && detail.batch.type === 'wrong_questions') {
      const ph = questionIds.map(() => '?').join(', ');
      result.deletedQuestions = oneSql<{ count: number }>(database, `SELECT COUNT(*) AS count FROM questions WHERE id IN (${ph})`, questionIds)?.count ?? 0;
      runSql(database, `DELETE FROM questions WHERE id IN (${ph})`, questionIds);
    }

    if (options.deleteLinkedQuestions && linkedQuestionIds.length) {
      const linkedPh = linkedQuestionIds.map(() => '?').join(', ');
      result.deletedQuestions += oneSql<{ count: number }>(database, `SELECT COUNT(*) AS count FROM questions WHERE id IN (${linkedPh})`, linkedQuestionIds)?.count ?? 0;
      runSql(database, `DELETE FROM questions WHERE id IN (${linkedPh})`, linkedQuestionIds);
    } else if (linkedQuestionIds.length && options.deleteAssets !== false) {
      result.failedAssets.push(`已保留资源：该题库已有 ${linkedQuestionIds.length} 道题加入错题本，移动资源可能导致错题图片丢失。`);
    }

    if (options.deleteAssets !== false && (!linkedQuestionIds.length || options.deleteLinkedQuestions)) {
      const moved = moveAssets(database, batchId, detail.assets);
      result.movedAssets = moved.moved;
      result.failedAssets = [...result.failedAssets, ...moved.failed];
    }

    if (knowledgeIds.length) {
      const ph = knowledgeIds.map(() => '?').join(', ');
      result.softDeletedKnowledgePoints = oneSql<{ count: number }>(database, `SELECT COUNT(*) AS count FROM knowledge_points WHERE node_id IN (${ph})`, knowledgeIds)?.count ?? 0;
      runSql(database, `UPDATE knowledge_points SET deleted_at = ? WHERE node_id IN (${ph})`, [nowIso(), ...knowledgeIds]);
    }

    runSql(database, "UPDATE import_batches SET status = 'deleted', deleted_at = ? WHERE id = ?", [nowIso(), batchId]);
    database.run('COMMIT');
    persistDatabase();
  } catch (error) {
    database.run('ROLLBACK');
    throw error;
  }

  return result;
}

export async function listLegacyExternalQuestionGroups(): Promise<LegacyExternalQuestionGroup[]> {
  const database = await getDatabase();
  return allSql<LegacyExternalQuestionGroup>(
    database,
    `SELECT
      COALESCE(NULLIF(eq.source, ''), '未知来源') || '|' || COALESCE(NULLIF(eq.exam_type, ''), '未知考试') || '|' || COALESCE(CAST(eq.year AS TEXT), '未知年份') AS groupKey,
      COALESCE(NULLIF(eq.source, ''), '未知来源') AS source,
      COALESCE(NULLIF(eq.exam_type, ''), '未知考试') AS exam_type,
      eq.year AS year,
      COUNT(*) AS questionCount,
      COUNT(DISTINCT a.external_question_id) AS attemptedCount,
      SUM(CASE WHEN COALESCE(eq.added_to_mistakes, 0) = 1 OR COALESCE(a.added_to_mistakes, 0) = 1 THEN 1 ELSE 0 END) AS addedToMistakesCount
     FROM external_questions eq
     LEFT JOIN external_question_attempts a ON a.external_question_id = eq.id
     WHERE COALESCE(eq.import_batch_id, '') = ''
     GROUP BY eq.source, eq.exam_type, eq.year
     ORDER BY eq.year DESC, eq.source ASC`
  );
}

export async function deleteLegacyExternalQuestionGroup(groupKey: string): Promise<DeleteLegacyExternalQuestionGroupResult> {
  const [source, examType, yearText] = groupKey.split('|');
  if (!source || !examType || !yearText) throw new Error('历史题库分组不合法');
  const database = await getDatabase();
  const backup = createDatabaseBackup('before_delete_import');
  const result: DeleteLegacyExternalQuestionGroupResult = {
    backupPath: backup.filePath,
    deletedQuestions: 0,
    deletedAttempts: 0,
    movedAssets: 0,
    failedAssets: []
  };
  const year = yearText === '未知年份' ? null : Number(yearText);
  const params = [source === '未知来源' ? '' : source, examType === '未知考试' ? '' : examType];
  const yearSql = year === null ? 'eq.year IS NULL' : 'eq.year = ?';
  const finalParams = year === null ? params : [...params, year];
  const ids = allSql<{ id: number; raw_file_path: string; paper_pdf_path: string }>(
    database,
    `SELECT eq.id, eq.raw_file_path, eq.paper_pdf_path FROM external_questions eq
     WHERE COALESCE(eq.import_batch_id, '') = ''
       AND COALESCE(eq.source, '') = ?
       AND COALESCE(eq.exam_type, '') = ?
       AND ${yearSql}`,
    finalParams
  );
  if (!ids.length) return result;
  const idValues = ids.map((row) => String(row.id));
  const ph = idValues.map(() => '?').join(', ');

  database.run('BEGIN TRANSACTION');
  try {
    result.deletedAttempts = oneSql<{ count: number }>(database, `SELECT COUNT(*) AS count FROM external_question_attempts WHERE external_question_id IN (${ph})`, idValues)?.count ?? 0;
    runSql(database, `DELETE FROM external_question_attempts WHERE external_question_id IN (${ph})`, idValues);
    result.deletedQuestions = ids.length;
    runSql(database, `DELETE FROM external_questions WHERE id IN (${ph})`, idValues);
    database.run('COMMIT');
    persistDatabase();
  } catch (error) {
    database.run('ROLLBACK');
    throw error;
  }

  return result;
}

export async function openTrashFolder() {
  const trash = path.join(getPaths().root, 'trash');
  fs.mkdirSync(trash, { recursive: true });
  const result = await shell.openPath(trash);
  if (result) throw new Error(result);
  return true;
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { shell } from 'electron';
import type { Database, SqlValue } from 'sql.js';
import { AgentError } from '../../shared/agent/errors';
import {
  allSql,
  executeWriteWithVerifiedSnapshot,
  getDatabase,
  getDatabaseCoordinator,
  getQuestionsApplication,
  getReadOnlyDatabase,
  oneSql,
  runSql
} from './databaseService';
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
import { QuestionRepository } from '../application/questions/questionRepository';

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
      id, owner_client_id, type, name, source_file_name, source, imported_at, item_count, asset_count, status, metadata_json, deleted_at
    ) VALUES (?, 'local-renderer-management', ?, ?, ?, ?, ?, 0, 0, 'active', ?, NULL)`,
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
  if (!row) throw new Error('Import-batch deletion requires control metadata');
  return { dataEpoch: row.data_epoch, dataRevision: row.data_revision };
}

function operationError(error: unknown, phase: string): OperationManifestError {
  return {
    code: typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code.slice(0, 200)
      : 'import_batch_delete_failed',
    phase,
    message: error instanceof Error ? error.message.slice(0, 1_000) || 'Import-batch deletion failed' : 'Import-batch deletion failed'
  };
}

function deletionJournal() {
  const store = new OperationManifestStore(path.normalize(path.join(getPaths().data, 'operation-journal')));
  return { store, journal: new OperationJournal(store) };
}

function isInside(candidate: string, root: string) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function deletionFiles(batchId: string, assets: ImportAsset[]) {
  const paths = getPaths();
  const root = path.normalize(paths.root);
  const cleanBatch = batchId.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  const trashRoot = path.normalize(path.join(root, 'trash', 'imports', cleanBatch));
  const batchRoot = path.normalize(path.join(root, 'assets', 'question_bank', batchId));
  const grouped = new Map<string, number[]>();
  const failed: string[] = [];
  for (const asset of assets) {
    const targetPath = path.normalize(asset.file_path.split('#')[0]);
    if (!targetPath || !fs.existsSync(targetPath)) continue;
    if (!isInside(targetPath, root)) {
      failed.push(`已保留资源：文件不在受管数据目录中：${targetPath}`);
      continue;
    }
    const ids = grouped.get(targetPath) ?? [];
    ids.push(asset.id);
    grouped.set(targetPath, ids);
  }

  const files: OperationFile[] = [];
  const assetIds: number[] = [];
  for (const [targetPath, ids] of grouped) {
    const relativeToBatch = path.relative(batchRoot, targetPath);
    const safeRelative = relativeToBatch && !relativeToBatch.startsWith('..') && !path.isAbsolute(relativeToBatch)
      ? relativeToBatch
      : path.basename(targetPath);
    files.push({
      fileId: `asset-${ids[0]}`,
      kind: 'quarantine_delete',
      targetPath,
      quarantinePath: path.normalize(uniqueTargetPath(path.join(trashRoot, safeRelative))),
      content: evidenceForBytes(fs.readFileSync(targetPath)),
      status: 'pending'
    });
    assetIds.push(...ids);
  }
  return { files, assetIds, failed };
}

function createDeletionBackup() {
  const paths = getPaths();
  fs.mkdirSync(paths.backups, { recursive: true });
  if (!fs.existsSync(paths.database)) throw new Error(`数据库文件不存在：${paths.database}`);
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const timestamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  const filePath = path.join(paths.backups, `mistakes_before_delete_import_${timestamp}.db`);
  fs.copyFileSync(paths.database, filePath);
  return filePath;
}

async function compensateDeletion(
  coordinator: Awaited<ReturnType<typeof getDatabaseCoordinator>>,
  manifest: OperationManifest,
  error: unknown
) {
  const { store, journal } = deletionJournal();
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

async function completeDeletion(
  coordinator: Awaited<ReturnType<typeof getDatabaseCoordinator>>,
  manifest: OperationManifest
) {
  const { store, journal } = deletionJournal();
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

export async function deleteImportBatch(batchId: string, options: DeleteImportBatchOptions = {}): Promise<DeleteImportBatchResult> {
  const coordinator = await getDatabaseCoordinator();
  const requestId = `import-batch-delete-${crypto.randomUUID()}`;
  let manifest: OperationManifest | null = null;
  const result: DeleteImportBatchResult = {
    backupPath: '',
    deletedQuestions: 0,
    deletedExternalQuestions: 0,
    deletedAttempts: 0,
    softDeletedKnowledgePoints: 0,
    movedAssets: 0,
    failedAssets: []
  };
  try {
    await coordinator.executeWrite({
      requestId,
      concurrency: 'none',
      async execute(database, scope) {
        const batch = oneSql<ImportBatch>(database, 'SELECT * FROM import_batches WHERE id = ?', [batchId]);
        if (!batch) throw new Error('导入批次不存在');
        if (batch.status === 'deleted') throw new Error('该导入批次已经删除');
        const items = allSql<ImportBatchDetail['items'][number]>(database, 'SELECT * FROM import_batch_items WHERE batch_id = ? ORDER BY id ASC', [batchId]);
        const assets = allSql<ImportAsset>(database, 'SELECT * FROM import_assets WHERE batch_id = ? ORDER BY id ASC', [batchId]);
        const externalIds = items.filter((item) => item.target_table === 'external_questions').map((item) => item.target_id);
        const questionIds = items.filter((item) => item.target_table === 'questions').map((item) => item.target_id);
        const knowledgeIds = items.filter((item) => item.target_table === 'knowledge_points').map((item) => item.target_id);
        const linkedQuestionIds = externalIds.length
          ? (() => {
            const placeholders = externalIds.map(() => '?').join(', ');
            return allSql<{ question_id: number }>(database, `SELECT DISTINCT created_question_id AS question_id FROM external_questions
              WHERE id IN (${placeholders}) AND created_question_id IS NOT NULL
              UNION
              SELECT DISTINCT created_question_id AS question_id FROM external_question_attempts
              WHERE external_question_id IN (${placeholders}) AND created_question_id IS NOT NULL`, [...externalIds, ...externalIds])
              .map((row) => String(row.question_id));
          })()
          : [];
        const questionsToDelete = new Set(batch.type === 'wrong_questions' ? questionIds : []);
        if (options.deleteLinkedQuestions) linkedQuestionIds.forEach((id) => questionsToDelete.add(id));

        result.backupPath = createDeletionBackup();
        if (linkedQuestionIds.length && !options.deleteLinkedQuestions && options.deleteAssets !== false) {
          result.failedAssets.push(`已保留资源：该题库已有 ${linkedQuestionIds.length} 道题加入错题本，移动资源可能导致错题图片丢失。`);
        } else if (options.deleteAssets !== false) {
          const deletion = deletionFiles(batchId, assets);
          result.failedAssets.push(...deletion.failed);
          if (deletion.files.length) {
            const versionBefore = currentVersion(database);
            if (versionBefore.dataRevision === Number.MAX_SAFE_INTEGER) throw new Error('Import-batch deletion revision overflow');
            const paths = getPaths();
            fs.mkdirSync(path.join(paths.data, 'operation-journal'), { recursive: true });
            const created = createOperationManifest({
              operationId: requestId,
              requestId,
              commandType: 'importBatches.delete',
              source: 'internal',
              clientId: 'import-batch-service',
              traceId: requestId,
              inputHash: crypto.createHash('sha256').update(JSON.stringify({ batchId, options })).digest('hex'),
              storage: 'data_root',
              versionBefore,
              versionAfter: { dataEpoch: versionBefore.dataEpoch, dataRevision: versionBefore.dataRevision + 1 },
              affectedEntities: [
                { entityType: 'import_batch', entityId: batchId },
                ...[...questionsToDelete].map((id) => ({ entityType: 'question', entityId: id }))
              ],
              roots: {
                manifestRoot: path.normalize(path.join(paths.data, 'operation-journal')),
                managedRoots: [path.normalize(paths.root)],
                sourceRoots: [path.normalize(paths.root)]
              },
              files: deletion.files,
              createdAt: nowIso()
            });
            const operationJournal = deletionJournal().journal;
            manifest = await operationJournal.prepare(created);
            manifest = await operationJournal.stage(manifest);
            result.movedAssets = deletion.files.length;
            for (const assetId of deletion.assetIds) {
              mutateSql(database, scope, 'UPDATE import_assets SET deleted_at = ? WHERE id = ?', [nowIso(), assetId]);
            }
          }
        }

        if (externalIds.length) {
          const placeholders = externalIds.map(() => '?').join(', ');
          result.deletedAttempts = oneSql<{ count: number }>(database, `SELECT COUNT(*) AS count FROM external_question_attempts WHERE external_question_id IN (${placeholders})`, externalIds)?.count ?? 0;
          mutateSql(database, scope, `DELETE FROM external_question_attempts WHERE external_question_id IN (${placeholders})`, externalIds);
          result.deletedExternalQuestions = oneSql<{ count: number }>(database, `SELECT COUNT(*) AS count FROM external_questions WHERE id IN (${placeholders})`, externalIds)?.count ?? 0;
          mutateSql(database, scope, `DELETE FROM external_questions WHERE id IN (${placeholders})`, externalIds);
        }

        const repository = new QuestionRepository(database, scope);
        for (const questionId of questionsToDelete) {
          if (repository.delete(Number(questionId))) result.deletedQuestions += 1;
        }

        if (knowledgeIds.length) {
          const placeholders = knowledgeIds.map(() => '?').join(', ');
          result.softDeletedKnowledgePoints = oneSql<{ count: number }>(database, `SELECT COUNT(*) AS count FROM knowledge_points WHERE node_id IN (${placeholders})`, knowledgeIds)?.count ?? 0;
          mutateSql(database, scope, `UPDATE knowledge_points SET deleted_at = ? WHERE node_id IN (${placeholders})`, [nowIso(), ...knowledgeIds]);
        }

        mutateSql(database, scope, "UPDATE import_batches SET status = 'deleted', deleted_at = ? WHERE id = ?", [nowIso(), batchId]);
        return { changed: true, value: null };
      }
    });
  } catch (error) {
    const storedManifest = manifest ?? await deletionJournal().store.read(requestId);
    if (storedManifest) await compensateDeletion(coordinator, storedManifest, error);
    throw error;
  }

  if (manifest) await completeDeletion(coordinator, manifest);

  return result;
}

export async function listLegacyExternalQuestionGroups(): Promise<LegacyExternalQuestionGroup[]> {
  const database = await getReadOnlyDatabase();
  return [...database.select<Record<string, unknown>>(
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
  )] as unknown as LegacyExternalQuestionGroup[];
}

export async function deleteLegacyExternalQuestionGroup(groupKey: string): Promise<DeleteLegacyExternalQuestionGroupResult> {
  const [source, examType, yearText] = groupKey.split('|');
  if (!source || !examType || !yearText) throw new Error('历史题库分组不合法');
  const year = yearText === '未知年份' ? null : Number(yearText);
  const params = [source === '未知来源' ? '' : source, examType === '未知考试' ? '' : examType];
  const yearSql = year === null ? 'eq.year IS NULL' : 'eq.year = ?';
  const finalParams = year === null ? params : [...params, year];
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const timestamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  const backupPath = path.join(getPaths().backups, `mistakes_before_delete_import_${timestamp}.db`);
  const requestId = crypto.randomUUID();
  const application = await getQuestionsApplication();
  const preparedEvents = application.eventBus.prepareEvents(
    [{ type: 'legacy.operation_completed', payload: { operation: 'import-batch-delete-legacy-external-group' } }],
    { requestId, traceId: crypto.randomUUID(), source: 'internal' }
  );
  const { result: write } = await executeWriteWithVerifiedSnapshot(backupPath, {
    requestId,
    concurrency: 'none',
    execute(database, scope) {
      const result: DeleteLegacyExternalQuestionGroupResult = {
        backupPath,
        deletedQuestions: 0,
        deletedAttempts: 0,
        movedAssets: 0,
        failedAssets: []
      };
      const ids = allSql<{ id: number }>(
        database,
        `SELECT eq.id FROM external_questions eq
         WHERE COALESCE(eq.import_batch_id, '') = ''
           AND COALESCE(eq.source, '') = ?
           AND COALESCE(eq.exam_type, '') = ?
           AND ${yearSql}`,
        finalParams
      );
      if (!ids.length) return { changed: false, value: result };
      const idValues = ids.map((row) => String(row.id));
      const placeholders = idValues.map(() => '?').join(', ');
      result.deletedAttempts = oneSql<{ count: number }>(
        database,
        `SELECT COUNT(*) AS count FROM external_question_attempts WHERE external_question_id IN (${placeholders})`,
        idValues
      )?.count ?? 0;
      mutateSql(database, scope, `DELETE FROM external_question_attempts WHERE external_question_id IN (${placeholders})`, idValues);
      result.deletedQuestions = ids.length;
      mutateSql(database, scope, `DELETE FROM external_questions WHERE id IN (${placeholders})`, idValues);
      return { changed: true, value: result };
    }
  });
  if (write.changed) {
    await application.eventBus.publish(application.eventBus.finalizeEvents(preparedEvents, {
      versionBefore: write.versionBefore,
      versionAfter: write.versionAfter
    }));
  }
  return write.value;
}

export async function openTrashFolder() {
  const trash = path.join(getPaths().root, 'trash');
  fs.mkdirSync(trash, { recursive: true });
  const result = await shell.openPath(trash);
  if (result) throw new Error(result);
  return true;
}

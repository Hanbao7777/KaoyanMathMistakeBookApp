import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Database, SqlValue } from 'sql.js';
import { AgentError } from '../../../shared/agent/errors';
import type { DataVersion, EntityRef } from '../../../shared/agent/v1/contracts';
import { canonicalizeJson, hashCanonicalJson } from '../../../shared/agent/v1/gatewaySchemas';
import { RevisionStore } from '../../persistence/revisionStore';
import { getPaths } from '../../services/pathService';

export const importBatchDeletionMaxAffectedEntities = 500;
export const localRendererManagementClientId = 'local-renderer-management';

export type ImportBatchDeletionFileRoot = 'images' | 'question_bank_batch' | 'textbooks';
export type ImportBatchDeletionFileAction = 'quarantine' | 'preserve';
export type ImportBatchDeletionRowMutation = 'delete' | 'update' | 'cascade_delete' | 'cascade_null' | 'preserve';

export interface ImportBatchDeletionInventoryRow {
  readonly table: string;
  readonly rowKey: string;
  readonly rowHash: string;
  readonly mutation: ImportBatchDeletionRowMutation;
}

export interface ImportBatchDeletionManagedFile {
  readonly fileId: string;
  readonly rootKind: ImportBatchDeletionFileRoot;
  readonly internalPath: string;
  readonly pathHash: string;
  readonly contentHash: string;
  readonly contentSize: number;
  readonly sourceBindingsHash: string;
  readonly action: ImportBatchDeletionFileAction;
}

export interface ImportBatchDeletionMutation {
  readonly questionIds: readonly number[];
  readonly questionImageIds: readonly number[];
  readonly reviewLogIds: readonly number[];
  readonly questionTagKeys: readonly string[];
  readonly questionKnowledgeLinkIds: readonly number[];
  readonly externalQuestionIds: readonly number[];
  readonly externalAttemptIds: readonly number[];
  readonly externalQuestionNullIds: readonly number[];
  readonly externalAttemptNullIds: readonly number[];
  readonly knowledgeNodeIds: readonly string[];
  readonly importAssetIds: readonly number[];
}

export interface ImportBatchDeletionResolution {
  readonly batchId: string;
  readonly batchType: string;
  readonly batchOwnerClientId: string | null;
  readonly ownershipPolicy: 'owner_bound' | 'legacy_local_renderer_only';
  readonly deleteManagedAssets: boolean;
  readonly deletedQuestionCount: number;
  readonly deletedExternalQuestionCount: number;
  readonly deletedAttemptCount: number;
  readonly softDeletedKnowledgeCount: number;
  readonly managedFileCount: number;
  readonly quarantinedFileCount: number;
  readonly affectedEntityCount: number;
  readonly inventoryRows: readonly ImportBatchDeletionInventoryRow[];
  readonly managedFiles: readonly ImportBatchDeletionManagedFile[];
  readonly affectedEntities: readonly EntityRef[];
  readonly inventoryHash: string;
  readonly affectedSetHash: string;
  readonly targetHash: string;
  readonly mutation: ImportBatchDeletionMutation;
  readonly dataVersion: DataVersion;
}

interface ResolveIdentity {
  readonly clientId: string;
  readonly renderer: boolean;
}

interface StrictFileSource {
  readonly rootKind: ImportBatchDeletionFileRoot;
  readonly batchId: string;
  readonly reference: string;
  readonly expectedHash?: string;
  readonly expectedSize?: number;
}

interface CollectedFile {
  readonly evidence: ReturnType<typeof strictBatchFile>;
  readonly bindings: Array<Readonly<Record<string, unknown>>>;
  readonly preserveReasons: Set<string>;
  readonly importAssetIds: Set<number>;
}

const allowedBatchTypes = new Set(['wrong_questions', 'question_bank', 'knowledge_map', 'textbook', 'unknown']);
const allowedItemTables = new Set(['questions', 'external_questions', 'knowledge_points', 'textbooks']);

function select<T extends Record<string, unknown>>(database: Database, sql: string, values: readonly SqlValue[] = []): T[] {
  const statement = database.prepare(sql);
  try {
    if (values.length) statement.bind([...values]);
    const rows: T[] = [];
    while (statement.step()) rows.push(statement.getAsObject() as T);
    return rows;
  } finally {
    statement.free();
  }
}

function stream<T extends Record<string, unknown>>(
  database: Database,
  sql: string,
  values: readonly SqlValue[],
  visit: (row: T) => void
): void {
  const statement = database.prepare(sql);
  try {
    if (values.length) statement.bind([...values]);
    while (statement.step()) visit(statement.getAsObject() as T);
  } finally {
    statement.free();
  }
}

function one<T extends Record<string, unknown>>(database: Database, sql: string, values: readonly SqlValue[] = []): T | undefined {
  return select<T>(database, sql, values)[0];
}

function normalizedSqlValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return Object.freeze({ bytesSha256: createHash('sha256').update(value).digest('hex'), size: value.byteLength });
  return value;
}

function normalizedRow(row: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizedSqlValue(value)])));
}

function rowBinding(table: string, rowKey: string, row: Record<string, unknown>, mutation: ImportBatchDeletionRowMutation): ImportBatchDeletionInventoryRow {
  return Object.freeze({ table, rowKey, rowHash: hashCanonicalJson({ table, rowKey, row: normalizedRow(row) }), mutation });
}

function placeholders(values: readonly unknown[]): string {
  if (values.length === 0) throw new AgentError('RECOVERY_FENCE');
  return values.map(() => '?').join(',');
}

function countRows(database: Database, sql: string, values: readonly SqlValue[] = []): number {
  const count = Number(one<{ count: number }>(database, sql, values)?.count ?? -1);
  if (!Number.isSafeInteger(count) || count < 0) throw new AgentError('RECOVERY_FENCE');
  return count;
}

function reserveResolvedRows(current: number, additional: number): number {
  if (!Number.isSafeInteger(current) || current < 0 || !Number.isSafeInteger(additional) || additional < 0) {
    throw new AgentError('RECOVERY_FENCE');
  }
  const next = current + additional;
  if (next > importBatchDeletionMaxAffectedEntities) throw new AgentError('POLICY_DENIED');
  return next;
}

function assertResolvedEntityBound(resolvedRowCount: number, managedFileCount: number): void {
  if (!Number.isSafeInteger(resolvedRowCount) || resolvedRowCount < 0 ||
      !Number.isSafeInteger(managedFileCount) || managedFileCount < 0) {
    throw new AgentError('RECOVERY_FENCE');
  }
  if (resolvedRowCount + managedFileCount > importBatchDeletionMaxAffectedEntities) throw new AgentError('POLICY_DENIED');
}

function selectCounted<T extends Record<string, unknown>>(
  database: Database,
  expectedCount: number,
  sql: string,
  values: readonly SqlValue[] = []
): T[] {
  const rows = select<T>(database, sql, values);
  if (rows.length !== expectedCount) throw new AgentError('RECOVERY_FENCE');
  return rows;
}

function rootFor(rootKind: ImportBatchDeletionFileRoot, batchId: string): string {
  const paths = getPaths();
  if (rootKind === 'images') return path.normalize(paths.images);
  if (rootKind === 'textbooks') return path.normalize(paths.textbooks);
  return path.normalize(path.join(paths.root, 'assets', 'question_bank', batchId));
}

export function importBatchDeletionManagedRoot(file: Pick<ImportBatchDeletionManagedFile, 'rootKind'>, batchId: string): string {
  return rootFor(file.rootKind, batchId);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function referencePath(reference: string): string {
  const clean = reference.split('#')[0];
  return path.normalize(path.isAbsolute(clean) ? clean : path.resolve(getPaths().root, clean));
}

function strictBatchFile(source: StrictFileSource): {
  readonly rootKind: ImportBatchDeletionFileRoot;
  readonly internalPath: string;
  readonly pathHash: string;
  readonly contentHash: string;
  readonly contentSize: number;
} {
  const root = rootFor(source.rootKind, source.batchId);
  if (!path.isAbsolute(root) || !fs.existsSync(root)) throw new AgentError('RECOVERY_FENCE');
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new AgentError('RECOVERY_FENCE');
  const realRoot = path.normalize(fs.realpathSync(root));
  if (path.resolve(realRoot).toLowerCase() !== path.resolve(root).toLowerCase()) throw new AgentError('RECOVERY_FENCE');
  const candidate = referencePath(source.reference);
  if (!isInside(root, candidate) || !fs.existsSync(candidate)) throw new AgentError('RECOVERY_FENCE');
  const linkStat = fs.lstatSync(candidate);
  if (linkStat.isSymbolicLink() || !linkStat.isFile() || linkStat.size < 1) throw new AgentError('RECOVERY_FENCE');
  const realFile = path.normalize(fs.realpathSync(candidate));
  if (!isInside(realRoot, realFile)) throw new AgentError('RECOVERY_FENCE');
  const handle = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const opened = fs.fstatSync(handle);
    if (!opened.isFile() || opened.dev !== linkStat.dev || opened.ino !== linkStat.ino || opened.size !== linkStat.size) {
      throw new AgentError('RECOVERY_FENCE');
    }
    bytes = fs.readFileSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  const contentHash = `sha256-v1:${createHash('sha256').update(bytes).digest('hex')}`;
  if ((source.expectedHash && source.expectedHash !== contentHash) ||
      (source.expectedSize !== undefined && source.expectedSize !== bytes.byteLength)) throw new AgentError('RECOVERY_FENCE');
  const relativePath = path.relative(root, candidate).replaceAll(path.sep, '/');
  const rootIdentity = source.rootKind === 'question_bank_batch' ? `question_bank_batch:${source.batchId}` : source.rootKind;
  return Object.freeze({
    rootKind: source.rootKind,
    internalPath: candidate,
    pathHash: hashCanonicalJson({ root: rootIdentity, relativePath }),
    contentHash,
    contentSize: bytes.byteLength
  });
}

export function verifyImportBatchDeletionManagedFile(file: ImportBatchDeletionManagedFile, batchId: string): void {
  const verified = strictBatchFile({
    rootKind: file.rootKind,
    batchId,
    reference: file.internalPath,
    expectedHash: file.contentHash,
    expectedSize: file.contentSize
  });
  if (verified.pathHash !== file.pathHash || verified.internalPath !== file.internalPath) throw new AgentError('RECOVERY_FENCE');
}

function sortNumbers(values: Iterable<number>): readonly number[] {
  return Object.freeze([...new Set(values)].sort((left, right) => left - right));
}

function sortStrings(values: Iterable<string>): readonly string[] {
  return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));
}

function directPathMatches(reference: unknown, candidate: string): boolean {
  return typeof reference === 'string' && reference.length > 0 && referencePath(reference).toLowerCase() === candidate.toLowerCase();
}

function exactReferenceBinding(
  table: string,
  rowKey: string,
  row: Record<string, unknown>,
  relation: Readonly<Record<string, string>>
): Readonly<Record<string, unknown>> {
  return Object.freeze({ table, rowKey, rowHash: rowBinding(table, rowKey, row, 'preserve').rowHash, ...relation });
}

export function resolveImportBatchDeletion(
  database: Database,
  batchId: string,
  deleteManagedAssets: boolean,
  identity: ResolveIdentity
): ImportBatchDeletionResolution {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,199}$/.test(batchId) || typeof deleteManagedAssets !== 'boolean') {
    throw new AgentError('VALIDATION_ERROR', { field: 'command.payload.batchId' });
  }
  const batch = one<Record<string, unknown>>(database, 'SELECT * FROM import_batches WHERE id=?', [batchId]);
  if (!batch || batch.status === 'deleted' || !allowedBatchTypes.has(String(batch.type))) throw new AgentError('HANDLER_NOT_FOUND');
  const batchOwnerClientId = typeof batch.owner_client_id === 'string' && batch.owner_client_id.length > 0 ? batch.owner_client_id : null;
  const legacyLocal = batchOwnerClientId === null && identity.renderer && identity.clientId === localRendererManagementClientId;
  if (batchOwnerClientId !== identity.clientId && !legacyLocal) throw new AgentError('HANDLER_NOT_FOUND');
  const ownershipPolicy = legacyLocal ? 'legacy_local_renderer_only' as const : 'owner_bound' as const;

  const itemCount = countRows(database, 'SELECT COUNT(*) AS count FROM import_batch_items WHERE batch_id=?', [batchId]);
  const assetCount = countRows(database, 'SELECT COUNT(*) AS count FROM import_assets WHERE batch_id=?', [batchId]);
  let resolvedRowCount = reserveResolvedRows(reserveResolvedRows(1, itemCount), assetCount);
  const items = selectCounted<Record<string, unknown>>(database, itemCount, 'SELECT * FROM import_batch_items WHERE batch_id=? ORDER BY id', [batchId]);
  const assets = selectCounted<Record<string, unknown>>(database, assetCount, 'SELECT * FROM import_assets WHERE batch_id=? ORDER BY id', [batchId]);
  if (items.some((item) => !allowedItemTables.has(String(item.target_table)))) throw new AgentError('RECOVERY_FENCE');

  const questionCount = batch.type === 'wrong_questions'
    ? countRows(database, 'SELECT COUNT(*) AS count FROM questions WHERE import_batch_id=?', [batchId])
    : 0;
  resolvedRowCount = reserveResolvedRows(resolvedRowCount, questionCount);
  const externalQuestionCount = countRows(database, 'SELECT COUNT(*) AS count FROM external_questions WHERE import_batch_id=?', [batchId]);
  resolvedRowCount = reserveResolvedRows(resolvedRowCount, externalQuestionCount);
  const knowledgeCount = countRows(database, 'SELECT COUNT(*) AS count FROM knowledge_points WHERE import_batch_id=? AND deleted_at IS NULL', [batchId]);
  resolvedRowCount = reserveResolvedRows(resolvedRowCount, knowledgeCount);
  const questionRows = questionCount
    ? selectCounted<Record<string, unknown>>(database, questionCount, 'SELECT * FROM questions WHERE import_batch_id=? ORDER BY id', [batchId])
    : [];
  const questionIds = sortNumbers(questionRows.map((row) => Number(row.id)));
  const externalRows = externalQuestionCount
    ? selectCounted<Record<string, unknown>>(database, externalQuestionCount, 'SELECT * FROM external_questions WHERE import_batch_id=? ORDER BY id', [batchId])
    : [];
  const externalQuestionIds = sortNumbers(externalRows.map((row) => Number(row.id)));
  const knowledgeRows = knowledgeCount
    ? selectCounted<Record<string, unknown>>(database, knowledgeCount, 'SELECT * FROM knowledge_points WHERE import_batch_id=? AND deleted_at IS NULL ORDER BY node_id', [batchId])
    : [];
  const knowledgeNodeIds = sortStrings(knowledgeRows.map((row) => String(row.node_id)));

  const questionImageWhere = questionIds.length ? `question_id IN (${placeholders(questionIds)})` : '';
  const questionImageCount = questionIds.length ? countRows(database, `SELECT COUNT(*) AS count FROM question_images WHERE ${questionImageWhere}`, questionIds) : 0;
  resolvedRowCount = reserveResolvedRows(resolvedRowCount, questionImageCount);
  const questionImageRows = questionImageCount
    ? selectCounted<Record<string, unknown>>(database, questionImageCount, `SELECT * FROM question_images WHERE ${questionImageWhere} ORDER BY id`, questionIds)
    : [];

  const reviewWhere = questionIds.length ? `question_id IN (${placeholders(questionIds)})` : '';
  const reviewCount = questionIds.length ? countRows(database, `SELECT COUNT(*) AS count FROM review_logs WHERE ${reviewWhere}`, questionIds) : 0;
  resolvedRowCount = reserveResolvedRows(resolvedRowCount, reviewCount);
  const reviewRows = reviewCount
    ? selectCounted<Record<string, unknown>>(database, reviewCount, `SELECT * FROM review_logs WHERE ${reviewWhere} ORDER BY id`, questionIds)
    : [];

  const questionTagWhere = questionIds.length ? `question_id IN (${placeholders(questionIds)})` : '';
  const questionTagCount = questionIds.length ? countRows(database, `SELECT COUNT(*) AS count FROM question_tags WHERE ${questionTagWhere}`, questionIds) : 0;
  resolvedRowCount = reserveResolvedRows(resolvedRowCount, questionTagCount);
  const questionTagRows = questionTagCount
    ? selectCounted<Record<string, unknown>>(database, questionTagCount, `SELECT * FROM question_tags WHERE ${questionTagWhere} ORDER BY question_id,tag_id`, questionIds)
    : [];

  const questionKnowledgeWhere = questionIds.length ? `question_id IN (${placeholders(questionIds)})` : '';
  const questionKnowledgeCount = questionIds.length ? countRows(database, `SELECT COUNT(*) AS count FROM question_knowledge_points WHERE ${questionKnowledgeWhere}`, questionIds) : 0;
  resolvedRowCount = reserveResolvedRows(resolvedRowCount, questionKnowledgeCount);
  const questionKnowledgeRows = questionKnowledgeCount
    ? selectCounted<Record<string, unknown>>(database, questionKnowledgeCount, `SELECT * FROM question_knowledge_points WHERE ${questionKnowledgeWhere} ORDER BY id`, questionIds)
    : [];

  const attemptWhere = externalQuestionIds.length ? `external_question_id IN (${placeholders(externalQuestionIds)})` : '';
  const attemptCount = externalQuestionIds.length ? countRows(database, `SELECT COUNT(*) AS count FROM external_question_attempts WHERE ${attemptWhere}`, externalQuestionIds) : 0;
  resolvedRowCount = reserveResolvedRows(resolvedRowCount, attemptCount);
  const attemptRows = attemptCount
    ? selectCounted<Record<string, unknown>>(database, attemptCount, `SELECT * FROM external_question_attempts WHERE ${attemptWhere} ORDER BY id`, externalQuestionIds)
    : [];
  const externalAttemptIds = sortNumbers(attemptRows.map((row) => Number(row.id)));

  const externalNullValues = [...questionIds, ...externalQuestionIds];
  const externalNullWhere = questionIds.length
    ? `created_question_id IN (${placeholders(questionIds)})${externalQuestionIds.length ? ` AND id NOT IN (${placeholders(externalQuestionIds)})` : ''}`
    : '';
  const externalNullCount = questionIds.length ? countRows(database, `SELECT COUNT(*) AS count FROM external_questions WHERE ${externalNullWhere}`, externalNullValues) : 0;
  resolvedRowCount = reserveResolvedRows(resolvedRowCount, externalNullCount);
  const externalNullRows = externalNullCount
    ? selectCounted<Record<string, unknown>>(database, externalNullCount, `SELECT * FROM external_questions WHERE ${externalNullWhere} ORDER BY id`, externalNullValues)
    : [];

  const attemptNullValues = [...questionIds, ...externalAttemptIds];
  const attemptNullWhere = questionIds.length
    ? `created_question_id IN (${placeholders(questionIds)})${externalAttemptIds.length ? ` AND id NOT IN (${placeholders(externalAttemptIds)})` : ''}`
    : '';
  const attemptNullCount = questionIds.length ? countRows(database, `SELECT COUNT(*) AS count FROM external_question_attempts WHERE ${attemptNullWhere}`, attemptNullValues) : 0;
  resolvedRowCount = reserveResolvedRows(resolvedRowCount, attemptNullCount);
  const attemptNullRows = attemptNullCount
    ? selectCounted<Record<string, unknown>>(database, attemptNullCount, `SELECT * FROM external_question_attempts WHERE ${attemptNullWhere} ORDER BY id`, attemptNullValues)
    : [];

  const collected = new Map<string, CollectedFile>();
  const collect = (source: StrictFileSource, binding: Readonly<Record<string, unknown>>, importAssetId?: number) => {
    const evidence = strictBatchFile(source);
    const key = path.resolve(evidence.internalPath).toLowerCase();
    const existing = collected.get(key);
    if (existing) {
      if (existing.evidence.rootKind !== evidence.rootKind || existing.evidence.pathHash !== evidence.pathHash ||
          existing.evidence.contentHash !== evidence.contentHash || existing.evidence.contentSize !== evidence.contentSize) throw new AgentError('RECOVERY_FENCE');
      existing.bindings.push(binding);
      if (importAssetId !== undefined) existing.importAssetIds.add(importAssetId);
      return existing;
    }
    const created: CollectedFile = { evidence, bindings: [binding], preserveReasons: new Set(), importAssetIds: new Set(importAssetId === undefined ? [] : [importAssetId]) };
    collected.set(key, created);
    assertResolvedEntityBound(resolvedRowCount, collected.size);
    return created;
  };

  for (const image of questionImageRows) {
    collect(
      { rootKind: 'images', batchId, reference: String(image.file_path) },
      exactReferenceBinding('question_images', String(image.id), image, Object.freeze({ field: 'file_path' }))
    );
  }
  for (const asset of assets) {
    if (asset.deleted_at !== null && asset.deleted_at !== undefined) continue;
    const assetType = String(asset.asset_type);
    let rootKind: ImportBatchDeletionFileRoot;
    if (assetType === 'question_image') rootKind = 'images';
    else if (assetType === 'textbook_pdf') rootKind = 'textbooks';
    else if (String(batch.type) === 'question_bank' && ['question_bank_image', 'question_bank_pdf', 'question_bank_solution_pdf', 'other'].includes(assetType)) rootKind = 'question_bank_batch';
    else throw new AgentError('RECOVERY_FENCE');
    const entry = collect(
      { rootKind, batchId, reference: String(asset.file_path) },
      exactReferenceBinding('import_assets', String(asset.id), asset, Object.freeze({ field: 'file_path' })),
      Number(asset.id)
    );
    if (rootKind === 'textbooks') entry.preserveReasons.add('live_textbook_reference');
    if (rootKind === 'images' && !questionImageRows.some((image) => directPathMatches(image.file_path, entry.evidence.internalPath))) {
      entry.preserveReasons.add('unbound_question_image_asset');
    }
  }
  const batchRoot = rootFor('question_bank_batch', batchId);
  assertResolvedEntityBound(resolvedRowCount, collected.size);
  const preserveInventory = new Map<string, ImportBatchDeletionInventoryRow>();
  const sortedCollected = Object.freeze([...collected.values()].sort((left, right) => left.evidence.pathHash.localeCompare(right.evidence.pathHash)));
  const preserveRow = (table: string, rowKey: string, row: Record<string, unknown>): ImportBatchDeletionInventoryRow => {
    const key = `${table}\0${rowKey}`;
    const binding = rowBinding(table, rowKey, row, 'preserve');
    const existing = preserveInventory.get(key);
    if (existing) {
      if (existing.rowHash !== binding.rowHash) throw new AgentError('RECOVERY_FENCE');
      return existing;
    }
    resolvedRowCount = reserveResolvedRows(resolvedRowCount, 1);
    assertResolvedEntityBound(resolvedRowCount, collected.size);
    preserveInventory.set(key, binding);
    return binding;
  };
  const preservePathReferences = (
    table: string,
    rowKey: string,
    row: Record<string, unknown>,
    field: string,
    reason: string
  ) => {
    const matches = sortedCollected.filter((entry) => directPathMatches(row[field], entry.evidence.internalPath));
    if (matches.length === 0) return;
    const binding = preserveRow(table, rowKey, row);
    for (const entry of matches) {
      entry.preserveReasons.add(reason);
      entry.bindings.push(Object.freeze({ table, rowKey, rowHash: binding.rowHash, field }));
    }
  };

  stream<Record<string, unknown>>(
    database,
    questionIds.length
      ? `SELECT id,file_path FROM question_images WHERE question_id NOT IN (${placeholders(questionIds)}) ORDER BY id`
      : 'SELECT id,file_path FROM question_images ORDER BY id',
    questionIds,
    (candidate) => {
      const rowKey = String(candidate.id);
      const matches = sortedCollected.some((entry) => directPathMatches(candidate.file_path, entry.evidence.internalPath));
      if (!matches) return;
      const row = one<Record<string, unknown>>(database, 'SELECT * FROM question_images WHERE id=?', [Number(candidate.id)]);
      if (!row) throw new AgentError('RECOVERY_FENCE');
      preservePathReferences('question_images', rowKey, row, 'file_path', 'shared_question_image');
    }
  );
  stream<Record<string, unknown>>(
    database,
    'SELECT id,file_path FROM import_assets WHERE batch_id<>? AND deleted_at IS NULL ORDER BY id',
    [batchId],
    (candidate) => {
      const rowKey = String(candidate.id);
      const matches = sortedCollected.some((entry) => directPathMatches(candidate.file_path, entry.evidence.internalPath));
      if (!matches) return;
      const row = one<Record<string, unknown>>(database, 'SELECT * FROM import_assets WHERE id=?', [Number(candidate.id)]);
      if (!row) throw new AgentError('RECOVERY_FENCE');
      preservePathReferences('import_assets', rowKey, row, 'file_path', 'shared_import_asset');
    }
  );
  stream<Record<string, unknown>>(
    database,
    externalQuestionIds.length
      ? `SELECT id,raw_file_path,paper_pdf_path,solution_pdf_path,asset_base_path FROM external_questions WHERE id NOT IN (${placeholders(externalQuestionIds)}) ORDER BY id`
      : 'SELECT id,raw_file_path,paper_pdf_path,solution_pdf_path,asset_base_path FROM external_questions ORDER BY id',
    externalQuestionIds,
    (candidate) => {
      const rowKey = String(candidate.id);
      const pathFields = ['raw_file_path', 'paper_pdf_path', 'solution_pdf_path'];
      const sharesPath = pathFields.some((field) => sortedCollected.some((entry) => directPathMatches(candidate[field], entry.evidence.internalPath)));
      const sharesBatchRoot = typeof candidate.asset_base_path === 'string' && path.normalize(candidate.asset_base_path) === batchRoot &&
        sortedCollected.some((entry) => entry.evidence.rootKind === 'question_bank_batch');
      if (!sharesPath && !sharesBatchRoot) return;
      const row = one<Record<string, unknown>>(database, 'SELECT * FROM external_questions WHERE id=?', [Number(candidate.id)]);
      if (!row) throw new AgentError('RECOVERY_FENCE');
      for (const field of pathFields) preservePathReferences('external_questions', rowKey, row, field, 'shared_external_question_asset');
      if (typeof row.asset_base_path === 'string' && path.normalize(row.asset_base_path) === batchRoot) {
        const binding = preserveRow('external_questions', rowKey, row);
        for (const entry of sortedCollected.filter((entry) => entry.evidence.rootKind === 'question_bank_batch')) {
          entry.preserveReasons.add('shared_external_question_asset');
          entry.bindings.push(Object.freeze({ table: 'external_questions', rowKey, rowHash: binding.rowHash, relation: 'asset_base_path' }));
        }
      }
    }
  );
  stream<Record<string, unknown>>(
    database,
    'SELECT id,file_path FROM textbooks ORDER BY id',
    [],
    (candidate) => {
      const rowKey = String(candidate.id);
      const matches = sortedCollected.some((entry) => directPathMatches(candidate.file_path, entry.evidence.internalPath));
      if (!matches) return;
      const row = one<Record<string, unknown>>(database, 'SELECT * FROM textbooks WHERE id=?', [Number(candidate.id)]);
      if (!row) throw new AgentError('RECOVERY_FENCE');
      preservePathReferences('textbooks', rowKey, row, 'file_path', 'live_textbook_reference');
    }
  );

  const managedFiles = Object.freeze([...collected.values()].map((entry) => {
    const action: ImportBatchDeletionFileAction = deleteManagedAssets && entry.preserveReasons.size === 0 ? 'quarantine' : 'preserve';
    const bindings = [...entry.bindings, ...[...entry.preserveReasons].sort().map((reason) => Object.freeze({ preserveReason: reason }))]
      .sort((left, right) => canonicalizeJson(left).localeCompare(canonicalizeJson(right)));
    return Object.freeze({
      fileId: `batch-asset-${entry.evidence.pathHash.slice(10, 50)}`,
      rootKind: entry.evidence.rootKind,
      internalPath: entry.evidence.internalPath,
      pathHash: entry.evidence.pathHash,
      contentHash: entry.evidence.contentHash,
      contentSize: entry.evidence.contentSize,
      sourceBindingsHash: hashCanonicalJson(bindings),
      action
    });
  }).sort((left, right) => left.pathHash.localeCompare(right.pathHash)));
  const quarantinedPaths = new Set(managedFiles.filter((file) => file.action === 'quarantine').map((file) => file.internalPath.toLowerCase()));
  const importAssetIds = sortNumbers([...collected.values()].flatMap((entry) =>
    quarantinedPaths.has(entry.evidence.internalPath.toLowerCase()) ? [...entry.importAssetIds] : []));

  const inventoryRows: ImportBatchDeletionInventoryRow[] = [
    rowBinding('import_batches', batchId, batch, 'update'),
    ...items.map((row) => rowBinding('import_batch_items', String(row.id), row, 'preserve')),
    ...assets.map((row) => rowBinding('import_assets', String(row.id), row, importAssetIds.includes(Number(row.id)) ? 'update' : 'preserve')),
    ...questionRows.map((row) => rowBinding('questions', String(row.id), row, 'delete')),
    ...questionImageRows.map((row) => rowBinding('question_images', String(row.id), row, 'cascade_delete')),
    ...reviewRows.map((row) => rowBinding('review_logs', String(row.id), row, 'cascade_delete')),
    ...questionTagRows.map((row) => rowBinding('question_tags', `${row.question_id}:${row.tag_id}`, row, 'cascade_delete')),
    ...questionKnowledgeRows.map((row) => rowBinding('question_knowledge_points', String(row.id), row, 'cascade_delete')),
    ...externalRows.map((row) => rowBinding('external_questions', String(row.id), row, 'delete')),
    ...attemptRows.map((row) => rowBinding('external_question_attempts', String(row.id), row, 'cascade_delete')),
    ...externalNullRows.map((row) => rowBinding('external_questions', String(row.id), row, 'cascade_null')),
    ...attemptNullRows.map((row) => rowBinding('external_question_attempts', String(row.id), row, 'cascade_null')),
    ...knowledgeRows.map((row) => rowBinding('knowledge_points', String(row.node_id), row, 'update')),
    ...preserveInventory.values()
  ].sort((left, right) => `${left.table}\0${left.rowKey}\0${left.mutation}`.localeCompare(`${right.table}\0${right.rowKey}\0${right.mutation}`));
  if (new Set(inventoryRows.map((row) => `${row.table}\0${row.rowKey}`)).size !== inventoryRows.length) throw new AgentError('RECOVERY_FENCE');
  if (inventoryRows.length !== resolvedRowCount) throw new AgentError('RECOVERY_FENCE');
  const affectedRows = inventoryRows.filter((row) => row.mutation !== 'preserve');
  const rowEntities = inventoryRows.map((row) => Object.freeze({ entityType: `database_row_${row.table}`, entityId: row.rowHash }));
  const fileBindings = managedFiles.map(({ fileId, rootKind, pathHash, contentHash, contentSize, sourceBindingsHash, action }) =>
    Object.freeze({ fileId, rootKind, pathHash, contentHash, contentSize, sourceBindingsHash, action }));
  const fileEntities = fileBindings.map((file) => Object.freeze({ entityType: 'managed_import_batch_asset', entityId: hashCanonicalJson(file) }));
  const affectedEntities = Object.freeze([...rowEntities, ...fileEntities]
    .sort((left, right) => `${left.entityType}\0${left.entityId}`.localeCompare(`${right.entityType}\0${right.entityId}`)));
  if (affectedEntities.length > importBatchDeletionMaxAffectedEntities) throw new AgentError('POLICY_DENIED');
  const inventoryHash = hashCanonicalJson({
    schemaVersion: 1,
    batchId,
    ownershipPolicy,
    inventoryRows,
    fileBindings
  });
  const affectedSetHash = hashCanonicalJson(affectedEntities);
  const targetHash = hashCanonicalJson({
    operation: 'imports.delete_batch',
    batchId,
    deleteManagedAssets,
    inventoryHash,
    affectedSetHash,
    affectedEntityCount: affectedEntities.length
  });
  const mutation = Object.freeze({
    questionIds,
    questionImageIds: sortNumbers(questionImageRows.map((row) => Number(row.id))),
    reviewLogIds: sortNumbers(reviewRows.map((row) => Number(row.id))),
    questionTagKeys: sortStrings(questionTagRows.map((row) => `${row.question_id}:${row.tag_id}`)),
    questionKnowledgeLinkIds: sortNumbers(questionKnowledgeRows.map((row) => Number(row.id))),
    externalQuestionIds,
    externalAttemptIds,
    externalQuestionNullIds: sortNumbers(externalNullRows.map((row) => Number(row.id))),
    externalAttemptNullIds: sortNumbers(attemptNullRows.map((row) => Number(row.id))),
    knowledgeNodeIds,
    importAssetIds
  });
  return Object.freeze({
    batchId,
    batchType: String(batch.type),
    batchOwnerClientId,
    ownershipPolicy,
    deleteManagedAssets,
    deletedQuestionCount: questionIds.length,
    deletedExternalQuestionCount: externalQuestionIds.length,
    deletedAttemptCount: externalAttemptIds.length,
    softDeletedKnowledgeCount: knowledgeNodeIds.length,
    managedFileCount: managedFiles.length,
    quarantinedFileCount: managedFiles.filter((file) => file.action === 'quarantine').length,
    affectedEntityCount: affectedEntities.length,
    inventoryRows: Object.freeze(inventoryRows),
    managedFiles,
    affectedEntities,
    inventoryHash,
    affectedSetHash,
    targetHash,
    mutation,
    dataVersion: Object.freeze({ ...new RevisionStore(database).readCurrentVersion() })
  });
}

function run(database: Database, sql: string, values: readonly SqlValue[]): number {
  const statement = database.prepare(sql);
  try {
    statement.run([...values]);
    return database.getRowsModified();
  } finally {
    statement.free();
  }
}

function deleteIds(database: Database, table: string, column: string, ids: readonly (number | string)[]): void {
  if (ids.length === 0) return;
  run(database, `DELETE FROM "${table}" WHERE "${column}" IN (${placeholders(ids)})`, ids);
}

export function applyImportBatchDeletion(database: Database, resolution: ImportBatchDeletionResolution, deletedAt: string): void {
  const mutation = resolution.mutation;
  if (mutation.externalQuestionNullIds.length) run(database, `UPDATE external_questions SET created_question_id=NULL WHERE id IN (${placeholders(mutation.externalQuestionNullIds)})`, mutation.externalQuestionNullIds);
  if (mutation.externalAttemptNullIds.length) run(database, `UPDATE external_question_attempts SET created_question_id=NULL WHERE id IN (${placeholders(mutation.externalAttemptNullIds)})`, mutation.externalAttemptNullIds);
  deleteIds(database, 'external_question_attempts', 'id', mutation.externalAttemptIds);
  deleteIds(database, 'external_questions', 'id', mutation.externalQuestionIds);
  deleteIds(database, 'question_knowledge_points', 'id', mutation.questionKnowledgeLinkIds);
  if (mutation.questionTagKeys.length) {
    for (const key of mutation.questionTagKeys) {
      const [questionId, tagId] = key.split(':').map(Number);
      if (!Number.isSafeInteger(questionId) || !Number.isSafeInteger(tagId)) throw new AgentError('RECOVERY_FENCE');
      run(database, 'DELETE FROM question_tags WHERE question_id=? AND tag_id=?', [questionId, tagId]);
    }
  }
  deleteIds(database, 'review_logs', 'id', mutation.reviewLogIds);
  deleteIds(database, 'question_images', 'id', mutation.questionImageIds);
  deleteIds(database, 'questions', 'id', mutation.questionIds);
  if (mutation.knowledgeNodeIds.length) run(database, `UPDATE knowledge_points SET deleted_at=? WHERE node_id IN (${placeholders(mutation.knowledgeNodeIds)}) AND deleted_at IS NULL`, [deletedAt, ...mutation.knowledgeNodeIds]);
  if (mutation.importAssetIds.length) run(database, `UPDATE import_assets SET deleted_at=? WHERE id IN (${placeholders(mutation.importAssetIds)}) AND batch_id=? AND deleted_at IS NULL`, [deletedAt, ...mutation.importAssetIds, resolution.batchId]);
  const ownerClause = resolution.batchOwnerClientId === null ? 'owner_client_id IS NULL' : 'owner_client_id=?';
  const ownerValues = resolution.batchOwnerClientId === null ? [] : [resolution.batchOwnerClientId];
  const changed = run(database, `UPDATE import_batches SET status='deleted',deleted_at=? WHERE id=? AND status<>'deleted' AND ${ownerClause}`, [deletedAt, resolution.batchId, ...ownerValues]);
  if (changed !== 1 || (database.exec('PRAGMA foreign_key_check')[0]?.values.length ?? 0) !== 0) throw new AgentError('RECOVERY_FENCE');
}

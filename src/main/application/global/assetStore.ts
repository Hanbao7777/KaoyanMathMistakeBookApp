import type { Database } from 'sql.js';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { AgentError } from '../../../shared/agent/errors';
import { canonicalizeJson, hashCanonicalJson } from '../../../shared/agent/v1/gatewaySchemas';
import { assertDatabaseMutationScope, type DatabaseMutationScope } from '../../persistence/databaseCoordinator';
import type { ReadOnlyDatabaseFacade } from '../queryBus';

export type GlobalAssetKind = 'backup' | 'export' | 'database_import' | 'root_selection';
export type GlobalAssetStatus = 'intent' | 'staged' | 'published' | 'consumed' | 'quarantined' | 'failed' | 'needs_recovery';
export interface GlobalAsset { readonly assetId: string; readonly ownerClientId: string; readonly kind: GlobalAssetKind; readonly status: GlobalAssetStatus; readonly metadata: Readonly<Record<string, unknown>>; readonly createdAt: string; readonly updatedAt: string; }
export interface InternalGlobalAsset extends GlobalAsset { readonly internalPath?: string; readonly stagedPath?: string; readonly contentHash?: string; readonly contentSize?: number; readonly jobId?: string; readonly operationJournalId?: string; }
const kinds = new Set<GlobalAssetKind>(['backup', 'export', 'database_import', 'root_selection']);
const statuses = new Set<GlobalAssetStatus>(['intent', 'staged', 'published', 'consumed', 'quarantined', 'failed', 'needs_recovery']);
const transitions: Readonly<Record<GlobalAssetStatus, readonly GlobalAssetStatus[]>> = Object.freeze({ intent: ['staged', 'failed', 'needs_recovery'], staged: ['published', 'quarantined', 'failed', 'needs_recovery'], published: ['consumed', 'quarantined', 'needs_recovery'], consumed: ['needs_recovery'], quarantined: [], failed: [], needs_recovery: [] });
const safeIdentifier = /^[A-Za-z0-9._:-]{1,200}$/;
const assetIdentifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const operationJournalIdentifier = /^[A-Za-z0-9_-]{1,200}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const contentHash = /^sha256-v1:[0-9a-f]{64}$/;
const sensitiveKey = /(?:path|root|secret|token|credential|password|private|authorization)/i;
const absolutePath = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

type AssetDatabase = Database | ReadOnlyDatabaseFacade;
function rows(database: AssetDatabase, sql: string, values: readonly unknown[] = []): Record<string, unknown>[] {
  if ('select' in database) return database.select<Record<string, unknown>>(sql, values as never).map((value) => ({ ...value }));
  const statement = database.prepare(sql); const result: Record<string, unknown>[] = [];
  try { statement.bind(values as never); while (statement.step()) result.push(statement.getAsObject()); return result; } finally { statement.free(); }
}
function row(database: AssetDatabase, sql: string, values: readonly unknown[]): Record<string, unknown> | undefined { return rows(database, sql, values)[0]; }
function validateTimestamp(value: unknown): value is string { return typeof value === 'string' && timestampPattern.test(value) && new Date(value).toISOString() === value; }
function validateBinding(value: unknown, pattern: RegExp): string | undefined { if (value === null || value === undefined) return undefined; if (typeof value !== 'string' || !pattern.test(value)) throw new AgentError('RECOVERY_FENCE'); return value; }
function redactMetadata(value: unknown, key?: string): unknown {
  if (key && sensitiveKey.test(key)) return undefined;
  if (typeof value === 'string' && absolutePath.test(value)) return undefined;
  if (Array.isArray(value)) return value.map((entry) => redactMetadata(entry)).filter((entry) => entry !== undefined);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    const redacted = redactMetadata(entryValue, entryKey);
    if (redacted !== undefined) result[entryKey] = redacted;
  }
  return result;
}
function asset(value: Record<string, unknown>, internal = false): GlobalAsset | InternalGlobalAsset {
  let metadata: unknown;
  try { metadata = JSON.parse(String(value.metadata_json)); } catch { throw new AgentError('RECOVERY_FENCE'); }
  const assetId = String(value.asset_id);
  const ownerClientId = String(value.owner_client_id);
  const kind = value.kind as GlobalAssetKind;
  const status = value.status as GlobalAssetStatus;
  const createdAt = String(value.created_at);
  const updatedAt = String(value.updated_at);
  const jobId = validateBinding(value.job_id, uuid);
  const operationJournalId = validateBinding(value.operation_journal_id, operationJournalIdentifier);
  const stagedPath = typeof value.staged_path === 'string' ? value.staged_path : undefined;
  const contentHashValue = typeof value.content_hash === 'string' ? value.content_hash : undefined;
  const contentSize = typeof value.content_size === 'number' ? value.content_size : undefined;
  if (!assetIdentifier.test(assetId) || !safeIdentifier.test(ownerClientId) || !kinds.has(kind) || !statuses.has(status) ||
      !validateTimestamp(createdAt) || !validateTimestamp(updatedAt) || updatedAt < createdAt || !metadata || typeof metadata !== 'object' ||
      Array.isArray(metadata) || canonicalizeJson(metadata) !== value.metadata_json || hashCanonicalJson(metadata) !== value.metadata_hash) {
    throw new AgentError('RECOVERY_FENCE');
  }
  const visibleMetadata = (internal ? metadata : redactMetadata(metadata)) as Record<string, unknown>;
  const base = { assetId, ownerClientId, kind, status, metadata: Object.freeze(visibleMetadata), createdAt, updatedAt };
  return internal
    ? Object.freeze({ ...base, ...(typeof value.internal_path === 'string' ? { internalPath: value.internal_path } : {}), ...(stagedPath ? { stagedPath } : {}), ...(contentHashValue && contentHash.test(contentHashValue) ? { contentHash: contentHashValue } : {}), ...(contentSize !== undefined && Number.isSafeInteger(contentSize) && contentSize >= 0 ? { contentSize } : {}), ...(jobId ? { jobId } : {}), ...(operationJournalId ? { operationJournalId } : {}) })
    : Object.freeze(base);
}

export function createGlobalAsset(database: Database, input: { assetId: string; ownerClientId: string; kind: GlobalAssetKind; metadata: Record<string, unknown>; internalPath?: string; jobId?: string; now: string }, scope?: DatabaseMutationScope): GlobalAsset {
  if (scope) assertDatabaseMutationScope(scope, database);
  if (!assetIdentifier.test(input.assetId) || !safeIdentifier.test(input.ownerClientId) || !kinds.has(input.kind) || !validateTimestamp(input.now) ||
      (input.jobId !== undefined && !uuid.test(input.jobId)) || (input.internalPath !== undefined && typeof input.internalPath !== 'string')) throw new AgentError('VALIDATION_ERROR');
  const metadataJson = canonicalizeJson(input.metadata);
  const metadataHash = hashCanonicalJson(input.metadata);
  const existing = row(database, 'SELECT * FROM agent_global_assets WHERE asset_id = ?', [input.assetId]);
  if (existing) {
    const current = getInternalGlobalAsset(database, input.assetId)!;
    if (current.ownerClientId !== input.ownerClientId || current.kind !== input.kind || current.status !== 'intent' ||
        canonicalizeJson(input.metadata) !== canonicalizeJson(current.metadata) || current.jobId !== input.jobId) throw new AgentError('IDEMPOTENCY_CONFLICT');
    return asset(row(database, 'SELECT * FROM agent_global_assets WHERE asset_id = ?', [input.assetId])!) as GlobalAsset;
  }
  database.run('INSERT INTO agent_global_assets (asset_id,owner_client_id,kind,status,metadata_json,metadata_hash,internal_path,job_id,created_at,updated_at) VALUES (?,?,?,\'intent\',?,?,?,?,?,?)', [input.assetId, input.ownerClientId, input.kind, metadataJson, metadataHash, input.internalPath ?? null, input.jobId ?? null, input.now, input.now]);
  return asset(row(database, 'SELECT * FROM agent_global_assets WHERE asset_id = ?', [input.assetId])!);
}
export function getGlobalAsset(database: AssetDatabase, assetId: string, ownerClientId: string, local = false): GlobalAsset | undefined { if (!assetIdentifier.test(assetId) || !safeIdentifier.test(ownerClientId)) throw new AgentError('VALIDATION_ERROR'); const found = row(database, 'SELECT * FROM agent_global_assets WHERE asset_id = ?', [assetId]); if (!found) return undefined; const result = asset(found); if (!local && result.ownerClientId !== ownerClientId) throw new AgentError('SCOPE_DENIED'); return result; }
export function getInternalGlobalAsset(database: AssetDatabase, assetId: string): InternalGlobalAsset | undefined { if (!assetIdentifier.test(assetId)) throw new AgentError('VALIDATION_ERROR'); const found = row(database, 'SELECT * FROM agent_global_assets WHERE asset_id = ?', [assetId]); return found ? asset(found, true) as InternalGlobalAsset : undefined; }
export function listInternalGlobalAssets(database: AssetDatabase): readonly InternalGlobalAsset[] {
  return Object.freeze(rows(database, 'SELECT * FROM agent_global_assets ORDER BY asset_id').map((entry) => asset(entry, true) as InternalGlobalAsset));
}
export function transitionGlobalAsset(database: Database, assetId: string, next: GlobalAssetStatus, now: string, binding: { jobId?: string; operationJournalId?: string } = {}, scope?: DatabaseMutationScope): GlobalAsset {
  if (scope) assertDatabaseMutationScope(scope, database);
  const current = getInternalGlobalAsset(database, assetId);
  if (!current || !statuses.has(next) || !transitions[current.status].includes(next) || !validateTimestamp(now) || now < current.updatedAt) throw new AgentError('RECOVERY_FENCE');
  if (binding.jobId !== undefined && (!uuid.test(binding.jobId) || (current.jobId !== undefined && current.jobId !== binding.jobId))) throw new AgentError('RECOVERY_FENCE');
  if (binding.operationJournalId !== undefined && (!operationJournalIdentifier.test(binding.operationJournalId) || (current.operationJournalId !== undefined && current.operationJournalId !== binding.operationJournalId))) throw new AgentError('RECOVERY_FENCE');
  database.run('UPDATE agent_global_assets SET status=?, job_id=COALESCE(?,job_id), operation_journal_id=COALESCE(?,operation_journal_id), updated_at=? WHERE asset_id=? AND status=? AND updated_at<=?', [next, binding.jobId ?? null, binding.operationJournalId ?? null, now, assetId, current.status, now]);
  if (database.getRowsModified() !== 1) throw new AgentError('RECOVERY_FENCE');
  return getInternalGlobalAsset(database, assetId)!;
}

export function bindGlobalAssetMaterialization(database: Database, assetId: string, evidence: { readonly stagedPath?: string; readonly internalPath?: string; readonly contentHash: string; readonly contentSize: number; readonly operationJournalId?: string }, now: string, scope: DatabaseMutationScope): InternalGlobalAsset {
  assertDatabaseMutationScope(scope, database);
  const current = getInternalGlobalAsset(database, assetId);
  if (!current || !contentHash.test(evidence.contentHash) || !Number.isSafeInteger(evidence.contentSize) || evidence.contentSize < 0 ||
      (evidence.operationJournalId !== undefined && !operationJournalIdentifier.test(evidence.operationJournalId)) || !validateTimestamp(now)) throw new AgentError('RECOVERY_FENCE');
  if ((evidence.stagedPath !== undefined && typeof evidence.stagedPath !== 'string') || (evidence.internalPath !== undefined && typeof evidence.internalPath !== 'string')) throw new AgentError('RECOVERY_FENCE');
  database.run('UPDATE agent_global_assets SET staged_path=COALESCE(?,staged_path), internal_path=COALESCE(?,internal_path), content_hash=COALESCE(?,content_hash), content_size=COALESCE(?,content_size), operation_journal_id=COALESCE(?,operation_journal_id), updated_at=? WHERE asset_id=?', [evidence.stagedPath ?? null, evidence.internalPath ?? null, evidence.contentHash, evidence.contentSize, evidence.operationJournalId ?? null, now, assetId]);
  return getInternalGlobalAsset(database, assetId)!;
}
export function listGlobalAssets(database: AssetDatabase, ownerClientId: string, kind: GlobalAssetKind, after: string | undefined, limit: number): readonly GlobalAsset[] {
  if (!safeIdentifier.test(ownerClientId) || !kinds.has(kind) || (after !== undefined && !assetIdentifier.test(after)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 201) throw new AgentError('VALIDATION_ERROR');
  const values = after ? [ownerClientId, kind, after, limit] : [ownerClientId, kind, limit];
  return Object.freeze(rows(database, `SELECT * FROM agent_global_assets WHERE owner_client_id=? AND kind=? ${after ? 'AND asset_id>?' : ''} ORDER BY asset_id LIMIT ?`, values).map((entry) => asset(entry) as GlobalAsset));
}

export type BackupDeletionJournalStatus = 'intent' | 'moved' | 'completed' | 'failed' | 'needs_recovery';
export interface BackupDeletionAdmission { readonly requestId: string; readonly receiptId: string; readonly reservationId: string; readonly grantId: string; readonly affectedSetHash: string; }
export interface BackupDeletionJournal { readonly journalId: string; readonly assetId: string; readonly ownerClientId: string; readonly requestId: string; readonly receiptId: string; readonly reservationId: string; readonly grantId: string; readonly affectedSetHash: string; readonly contentHash: string; readonly contentSize: number; readonly targetHash: string; readonly status: BackupDeletionJournalStatus; readonly createdAt: string; readonly updatedAt: string; }
const deletionStatuses = new Set<BackupDeletionJournalStatus>(['intent', 'moved', 'completed', 'failed', 'needs_recovery']);
export function decodeBackupDeletionJournal(value: Record<string, unknown>): BackupDeletionJournal {
  const journalId = String(value.journal_id); const assetId = String(value.asset_id); const ownerClientId = String(value.owner_client_id);
  const requestId = String(value.request_id); const receiptId = String(value.receipt_id); const reservationId = String(value.reservation_id); const grantId = String(value.grant_id);
  const affectedSetHash = String(value.affected_set_hash); const contentHashValue = String(value.content_hash); const targetHash = String(value.target_hash); const status = value.status as BackupDeletionJournalStatus;
  const contentSize = value.content_size; const createdAt = String(value.created_at); const updatedAt = String(value.updated_at);
  if (!operationJournalIdentifier.test(journalId) || !assetIdentifier.test(assetId) || !safeIdentifier.test(ownerClientId) || !uuid.test(requestId) || !uuid.test(receiptId) || !uuid.test(reservationId) || !uuid.test(grantId) || !contentHash.test(affectedSetHash) || !contentHash.test(contentHashValue) || !contentHash.test(targetHash) || !deletionStatuses.has(status) || typeof contentSize !== 'number' || !Number.isSafeInteger(contentSize) || contentSize < 0 || !validateTimestamp(createdAt) || !validateTimestamp(updatedAt) || updatedAt < createdAt) throw new AgentError('RECOVERY_FENCE');
  return Object.freeze({ journalId, assetId, ownerClientId, requestId, receiptId, reservationId, grantId, affectedSetHash, contentHash: contentHashValue, contentSize, targetHash, status, createdAt, updatedAt });
}
export function ensureBackupDeletionJournal(database: Database, input: { readonly journalId: string; readonly assetId: string; readonly ownerClientId: string; readonly contentHash: string; readonly contentSize: number; readonly targetHash: string; readonly admission: BackupDeletionAdmission; readonly now: string }, scope: DatabaseMutationScope): BackupDeletionJournalStatus {
  assertDatabaseMutationScope(scope, database);
  const existing = row(database, 'SELECT * FROM agent_backup_deletion_journals WHERE journal_id=?', [input.journalId]);
  if (existing) {
    const decoded = decodeBackupDeletionJournal(existing);
    if (decoded.assetId !== input.assetId || decoded.ownerClientId !== input.ownerClientId || decoded.contentHash !== input.contentHash || decoded.contentSize !== input.contentSize || decoded.targetHash !== input.targetHash || decoded.requestId !== input.admission.requestId || decoded.receiptId !== input.admission.receiptId || decoded.reservationId !== input.admission.reservationId || decoded.grantId !== input.admission.grantId || decoded.affectedSetHash !== input.admission.affectedSetHash) throw new AgentError('IDEMPOTENCY_CONFLICT');
    return decoded.status;
  }
  database.run("INSERT INTO agent_backup_deletion_journals (journal_id,asset_id,owner_client_id,request_id,receipt_id,reservation_id,grant_id,affected_set_hash,content_hash,content_size,target_hash,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?, 'intent', ?, ?)", [input.journalId, input.assetId, input.ownerClientId, input.admission.requestId, input.admission.receiptId, input.admission.reservationId, input.admission.grantId, input.admission.affectedSetHash, input.contentHash, input.contentSize, input.targetHash, input.now, input.now]);
  return 'intent';
}
export function transitionBackupDeletionJournal(database: Database, journalId: string, from: BackupDeletionJournalStatus, to: BackupDeletionJournalStatus, now: string, scope: DatabaseMutationScope): boolean {
  assertDatabaseMutationScope(scope, database);
  database.run('UPDATE agent_backup_deletion_journals SET status=?, updated_at=? WHERE journal_id=? AND status=?', [to, now, journalId, from]);
  return database.getRowsModified() === 1;
}
export function backupDeletionJournalStatus(database: AssetDatabase, journalId: string): BackupDeletionJournalStatus | undefined { const found = row(database, 'SELECT * FROM agent_backup_deletion_journals WHERE journal_id=?', [journalId]); return found ? decodeBackupDeletionJournal(found).status : undefined; }
export function assertBackupDeletionReceiptTarget(database: Database, clientId: string, requestId: string, targetHash: string, scope: DatabaseMutationScope): BackupDeletionAdmission {
  assertDatabaseMutationScope(scope, database);
  const receipt = row(database, `SELECT i.receipt_id,i.operation,i.status,i.reservation_id,i.grant_id,i.r4_target_hash,i.affected_set_hash,
      g.operation AS grant_operation,g.reservation_id AS grant_reservation_id
    FROM agent_idempotency i INNER JOIN agent_r4_grants g ON g.grant_id=i.grant_id
    WHERE i.client_id=? AND i.request_id=?`, [clientId, requestId]);
  const receiptOperation = receipt?.operation;
  if (!receipt || (receiptOperation !== 'backups.delete' && receiptOperation !== 'agent.changesets.apply') || receipt.status !== 'admitted' ||
      receipt.grant_operation !== 'backups.delete' || receipt.grant_reservation_id !== receipt.reservation_id ||
      typeof receipt.receipt_id !== 'string' || typeof receipt.reservation_id !== 'string' || typeof receipt.grant_id !== 'string' ||
      typeof receipt.affected_set_hash !== 'string' || receipt.r4_target_hash !== targetHash) throw new AgentError('RECOVERY_FENCE');
  return Object.freeze({ requestId, receiptId: receipt.receipt_id, reservationId: receipt.reservation_id, grantId: receipt.grant_id, affectedSetHash: receipt.affected_set_hash });
}

export interface DatabaseRestoreAdmission extends BackupDeletionAdmission {
  readonly receiptOperation: 'database.restore' | 'agent.changesets.apply';
  readonly receiptPayloadHash: string;
  readonly restorePayloadHash: string;
  readonly risk: 'R4';
  readonly baseVersion: { readonly dataEpoch: string; readonly dataRevision: number };
  readonly catalog: { readonly version: string; readonly hash: string };
  readonly recovery: 'consistency_bundle';
  readonly maxAffectedEntities: number;
  readonly reservationExpiresAt: string;
  readonly reservedAt: string;
  readonly receiptCreatedAt: string;
  readonly changeSetId?: string;
}

export interface DatabaseImportAdmission extends BackupDeletionAdmission {
  readonly receiptOperation: 'database.replace_from_import' | 'agent.changesets.apply';
  readonly receiptPayloadHash: string;
  readonly importPayloadHash: string;
  readonly risk: 'R4';
  readonly baseVersion: { readonly dataEpoch: string; readonly dataRevision: number };
  readonly catalog: { readonly version: string; readonly hash: string };
  readonly recovery: 'consistency_bundle';
  readonly maxAffectedEntities: number;
  readonly reservationExpiresAt: string;
  readonly reservedAt: string;
  readonly receiptCreatedAt: string;
  readonly changeSetId?: string;
}

export interface DatabaseClearAdmission extends BackupDeletionAdmission {
  readonly receiptOperation: 'database.clear_all' | 'agent.changesets.apply';
  readonly receiptPayloadHash: string;
  readonly clearPayloadHash: string;
  readonly risk: 'R4';
  readonly baseVersion: { readonly dataEpoch: string; readonly dataRevision: number };
  readonly catalog: { readonly version: string; readonly hash: string };
  readonly recovery: 'consistency_bundle';
  readonly maxAffectedEntities: number;
  readonly reservationExpiresAt: string;
  readonly reservedAt: string;
  readonly receiptCreatedAt: string;
  readonly changeSetId?: string;
}

export interface ImportBatchDeletionAdmission extends BackupDeletionAdmission {
  readonly receiptOperation: 'imports.delete_batch' | 'agent.changesets.apply';
  readonly receiptPayloadHash: string;
  readonly deletePayloadHash: string;
  readonly risk: 'R4';
  readonly baseVersion: { readonly dataEpoch: string; readonly dataRevision: number };
  readonly catalog: { readonly version: string; readonly hash: string };
  readonly recovery: 'consistency_bundle';
  readonly maxAffectedEntities: number;
  readonly reservationExpiresAt: string;
  readonly reservedAt: string;
  readonly receiptCreatedAt: string;
  readonly changeSetId?: string;
}

export interface DataRootMigrationAdmission extends BackupDeletionAdmission {
  readonly receiptOperation: 'data_root.migrate' | 'agent.changesets.apply';
  readonly receiptPayloadHash: string;
  readonly migratePayloadHash: string;
  readonly risk: 'R4';
  readonly baseVersion: { readonly dataEpoch: string; readonly dataRevision: number };
  readonly catalog: { readonly version: string; readonly hash: string };
  readonly recovery: 'consistency_bundle';
  readonly maxAffectedEntities: number;
  readonly reservationExpiresAt: string;
  readonly reservedAt: string;
  readonly receiptCreatedAt: string;
  readonly changeSetId?: string;
}

export function assertDataRootMigrationReceiptTarget(
  database: Database,
  clientId: string,
  requestId: string,
  binding: { readonly targetHash: string; readonly affectedSetHash: string; readonly baseVersion: { readonly dataEpoch: string; readonly dataRevision: number }; readonly catalog: { readonly version: string; readonly hash: string } },
  scope: DatabaseMutationScope
): DataRootMigrationAdmission {
  assertDatabaseMutationScope(scope, database);
  const receipt = row(database, `SELECT i.receipt_id,i.operation,i.payload_json,i.payload_hash,i.risk,i.status,i.reservation_id,i.grant_id,i.r4_target_hash,i.affected_set_hash,
      i.base_data_epoch,i.base_data_revision,i.catalog_version,i.catalog_hash,i.r4_recovery,i.r4_max_affected_entities,i.r4_reservation_expires_at,i.created_at,
      g.client_id AS grant_client_id,g.operation AS grant_operation,g.payload_hash AS grant_payload_hash,g.target_hash AS grant_target_hash,
      g.catalog_version AS grant_catalog_version,g.catalog_hash AS grant_catalog_hash,g.recovery AS grant_recovery,
      g.max_affected_entities AS grant_max_affected_entities,g.status AS grant_status,g.reservation_id AS grant_reservation_id,
      g.reserved_client_id,g.reserved_request_id,g.reserved_payload_hash,g.reserved_affected_set_hash,g.reserved_base_epoch,
      g.reserved_base_revision,g.reserved_catalog_version,g.reserved_catalog_hash,g.reserved_at
    FROM agent_idempotency i INNER JOIN agent_r4_grants g ON g.grant_id=i.grant_id
    WHERE i.client_id=? AND i.request_id=?`, [clientId, requestId]);
  const receiptOperation = receipt?.operation;
  if (!receipt || (receiptOperation !== 'data_root.migrate' && receiptOperation !== 'agent.changesets.apply') || receipt.status !== 'admitted' ||
      receipt.grant_operation !== 'data_root.migrate' || receipt.grant_reservation_id !== receipt.reservation_id || receipt.grant_client_id !== clientId ||
      receipt.grant_status !== 'reserved' || receipt.grant_target_hash !== binding.targetHash || receipt.grant_catalog_version !== binding.catalog.version ||
      receipt.grant_catalog_hash !== binding.catalog.hash || receipt.grant_recovery !== 'consistency_bundle' || receipt.grant_max_affected_entities !== 500 ||
      receipt.reserved_client_id !== clientId || receipt.reserved_request_id !== requestId || receipt.reserved_payload_hash !== receipt.grant_payload_hash ||
      receipt.reserved_affected_set_hash !== binding.affectedSetHash || receipt.reserved_base_epoch !== binding.baseVersion.dataEpoch ||
      receipt.reserved_base_revision !== binding.baseVersion.dataRevision || receipt.reserved_catalog_version !== binding.catalog.version ||
      receipt.reserved_catalog_hash !== binding.catalog.hash || receipt.affected_set_hash !== binding.affectedSetHash || receipt.r4_target_hash !== binding.targetHash ||
      receipt.base_data_epoch !== binding.baseVersion.dataEpoch || receipt.base_data_revision !== binding.baseVersion.dataRevision ||
      typeof receipt.receipt_id !== 'string' || typeof receipt.reservation_id !== 'string' || typeof receipt.grant_id !== 'string' ||
      typeof receipt.payload_hash !== 'string' || typeof receipt.grant_payload_hash !== 'string' || typeof receipt.r4_reservation_expires_at !== 'string' ||
      typeof receipt.reserved_at !== 'string' || typeof receipt.created_at !== 'string') throw new AgentError('RECOVERY_FENCE');
  let changeSetId: string | undefined;
  if (receiptOperation === 'agent.changesets.apply') {
    let payload: unknown; try { payload = JSON.parse(String(receipt.payload_json)); } catch { throw new AgentError('RECOVERY_FENCE'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof (payload as { changeSetId?: unknown }).changeSetId !== 'string') throw new AgentError('RECOVERY_FENCE');
    changeSetId = (payload as { changeSetId: string }).changeSetId;
  }
  return Object.freeze({ requestId, receiptId: String(receipt.receipt_id), reservationId: String(receipt.reservation_id), grantId: String(receipt.grant_id),
    affectedSetHash: binding.affectedSetHash, receiptOperation, receiptPayloadHash: String(receipt.payload_hash), migratePayloadHash: String(receipt.grant_payload_hash),
    risk: 'R4' as const, baseVersion: Object.freeze({ ...binding.baseVersion }), catalog: Object.freeze({ ...binding.catalog }), recovery: 'consistency_bundle' as const,
    maxAffectedEntities: 500, reservationExpiresAt: String(receipt.r4_reservation_expires_at), reservedAt: String(receipt.reserved_at),
    receiptCreatedAt: String(receipt.created_at), ...(changeSetId ? { changeSetId } : {}) });
}

export function assertDatabaseRestoreReceiptTarget(database: Database, clientId: string, requestId: string, targetHash: string, scope: DatabaseMutationScope): DatabaseRestoreAdmission {
  assertDatabaseMutationScope(scope, database);
  const receipt = row(database, `SELECT i.receipt_id,i.operation,i.payload_json,i.payload_hash,i.risk,i.status,i.reservation_id,i.grant_id,i.r4_target_hash,i.affected_set_hash,
      i.base_data_epoch,i.base_data_revision,i.catalog_version,i.catalog_hash,i.r4_recovery,i.r4_max_affected_entities,i.r4_reservation_expires_at,i.created_at,
      g.operation AS grant_operation,g.payload_hash AS grant_payload_hash,g.reservation_id AS grant_reservation_id,g.reserved_at
    FROM agent_idempotency i INNER JOIN agent_r4_grants g ON g.grant_id=i.grant_id
    WHERE i.client_id=? AND i.request_id=?`, [clientId, requestId]);
  const receiptOperation = receipt?.operation;
  if (!receipt || (receiptOperation !== 'database.restore' && receiptOperation !== 'agent.changesets.apply') || receipt.status !== 'admitted' ||
      receipt.grant_operation !== 'database.restore' || receipt.grant_reservation_id !== receipt.reservation_id ||
      typeof receipt.receipt_id !== 'string' || typeof receipt.reservation_id !== 'string' || typeof receipt.grant_id !== 'string' ||
      typeof receipt.affected_set_hash !== 'string' || typeof receipt.payload_hash !== 'string' || typeof receipt.grant_payload_hash !== 'string' ||
      typeof receipt.base_data_epoch !== 'string' || !Number.isSafeInteger(receipt.base_data_revision) ||
      typeof receipt.catalog_version !== 'string' || typeof receipt.catalog_hash !== 'string' ||
      receipt.risk !== 'R4' || receipt.r4_recovery !== 'consistency_bundle' || receipt.r4_max_affected_entities !== 500 ||
      typeof receipt.r4_reservation_expires_at !== 'string' || typeof receipt.reserved_at !== 'string' || typeof receipt.created_at !== 'string' ||
      receipt.r4_target_hash !== targetHash) throw new AgentError('RECOVERY_FENCE');
  let changeSetId: string | undefined;
  if (receiptOperation === 'agent.changesets.apply') {
    let payload: unknown;
    try { payload = JSON.parse(String(receipt.payload_json)); } catch { throw new AgentError('RECOVERY_FENCE'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof (payload as { changeSetId?: unknown }).changeSetId !== 'string') throw new AgentError('RECOVERY_FENCE');
    changeSetId = (payload as { changeSetId: string }).changeSetId;
  }
  return Object.freeze({
    requestId, receiptId: receipt.receipt_id, reservationId: receipt.reservation_id, grantId: receipt.grant_id,
    affectedSetHash: receipt.affected_set_hash, receiptOperation, receiptPayloadHash: receipt.payload_hash,
    restorePayloadHash: receipt.grant_payload_hash, risk: 'R4' as const,
    baseVersion: Object.freeze({ dataEpoch: receipt.base_data_epoch, dataRevision: Number(receipt.base_data_revision) }),
    catalog: Object.freeze({ version: receipt.catalog_version, hash: receipt.catalog_hash }),
    recovery: 'consistency_bundle' as const, maxAffectedEntities: 500,
    reservationExpiresAt: receipt.r4_reservation_expires_at, reservedAt: receipt.reserved_at,
    receiptCreatedAt: receipt.created_at,
    ...(changeSetId ? { changeSetId } : {})
  });
}

export function assertDatabaseImportReceiptTarget(database: Database, clientId: string, requestId: string, targetHash: string, scope: DatabaseMutationScope): DatabaseImportAdmission {
  assertDatabaseMutationScope(scope, database);
  const receipt = row(database, `SELECT i.receipt_id,i.operation,i.payload_json,i.payload_hash,i.risk,i.status,i.reservation_id,i.grant_id,i.r4_target_hash,i.affected_set_hash,
      i.base_data_epoch,i.base_data_revision,i.catalog_version,i.catalog_hash,i.r4_recovery,i.r4_max_affected_entities,i.r4_reservation_expires_at,i.created_at,
      g.operation AS grant_operation,g.payload_hash AS grant_payload_hash,g.reservation_id AS grant_reservation_id,g.reserved_at
    FROM agent_idempotency i INNER JOIN agent_r4_grants g ON g.grant_id=i.grant_id
    WHERE i.client_id=? AND i.request_id=?`, [clientId, requestId]);
  const receiptOperation = receipt?.operation;
  if (!receipt || (receiptOperation !== 'database.replace_from_import' && receiptOperation !== 'agent.changesets.apply') || receipt.status !== 'admitted' ||
      receipt.grant_operation !== 'database.replace_from_import' || receipt.grant_reservation_id !== receipt.reservation_id ||
      typeof receipt.receipt_id !== 'string' || typeof receipt.reservation_id !== 'string' || typeof receipt.grant_id !== 'string' ||
      typeof receipt.affected_set_hash !== 'string' || typeof receipt.payload_hash !== 'string' || typeof receipt.grant_payload_hash !== 'string' ||
      typeof receipt.base_data_epoch !== 'string' || !Number.isSafeInteger(receipt.base_data_revision) ||
      typeof receipt.catalog_version !== 'string' || typeof receipt.catalog_hash !== 'string' ||
      receipt.risk !== 'R4' || receipt.r4_recovery !== 'consistency_bundle' || receipt.r4_max_affected_entities !== 500 ||
      typeof receipt.r4_reservation_expires_at !== 'string' || typeof receipt.reserved_at !== 'string' || typeof receipt.created_at !== 'string' ||
      receipt.r4_target_hash !== targetHash) throw new AgentError('RECOVERY_FENCE');
  let changeSetId: string | undefined;
  if (receiptOperation === 'agent.changesets.apply') {
    let payload: unknown;
    try { payload = JSON.parse(String(receipt.payload_json)); } catch { throw new AgentError('RECOVERY_FENCE'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof (payload as { changeSetId?: unknown }).changeSetId !== 'string') throw new AgentError('RECOVERY_FENCE');
    changeSetId = (payload as { changeSetId: string }).changeSetId;
  }
  return Object.freeze({
    requestId, receiptId: receipt.receipt_id, reservationId: receipt.reservation_id, grantId: receipt.grant_id,
    affectedSetHash: receipt.affected_set_hash, receiptOperation, receiptPayloadHash: receipt.payload_hash,
    importPayloadHash: receipt.grant_payload_hash, risk: 'R4' as const,
    baseVersion: Object.freeze({ dataEpoch: receipt.base_data_epoch, dataRevision: Number(receipt.base_data_revision) }),
    catalog: Object.freeze({ version: receipt.catalog_version, hash: receipt.catalog_hash }),
    recovery: 'consistency_bundle' as const, maxAffectedEntities: 500,
    reservationExpiresAt: receipt.r4_reservation_expires_at, reservedAt: receipt.reserved_at,
    receiptCreatedAt: receipt.created_at,
    ...(changeSetId ? { changeSetId } : {})
  });
}

export function assertDatabaseClearReceiptTarget(
  database: Database,
  clientId: string,
  requestId: string,
  binding: {
    readonly targetHash: string;
    readonly affectedSetHash: string;
    readonly baseVersion: { readonly dataEpoch: string; readonly dataRevision: number };
    readonly catalog: { readonly version: string; readonly hash: string };
  },
  scope: DatabaseMutationScope
): DatabaseClearAdmission {
  assertDatabaseMutationScope(scope, database);
  const receipt = row(database, `SELECT i.receipt_id,i.operation,i.payload_json,i.payload_hash,i.risk,i.status,i.reservation_id,i.grant_id,i.r4_target_hash,i.affected_set_hash,
      i.base_data_epoch,i.base_data_revision,i.catalog_version,i.catalog_hash,i.r4_recovery,i.r4_max_affected_entities,i.r4_reservation_expires_at,i.created_at,
      g.client_id AS grant_client_id,g.operation AS grant_operation,g.payload_hash AS grant_payload_hash,g.target_hash AS grant_target_hash,
      g.catalog_version AS grant_catalog_version,g.catalog_hash AS grant_catalog_hash,g.recovery AS grant_recovery,
      g.max_affected_entities AS grant_max_affected_entities,g.status AS grant_status,g.reservation_id AS grant_reservation_id,
      g.reserved_client_id,g.reserved_request_id,g.reserved_payload_hash,g.reserved_affected_set_hash,g.reserved_base_epoch,
      g.reserved_base_revision,g.reserved_catalog_version,g.reserved_catalog_hash,g.reserved_at
    FROM agent_idempotency i INNER JOIN agent_r4_grants g ON g.grant_id=i.grant_id
    WHERE i.client_id=? AND i.request_id=?`, [clientId, requestId]);
  const receiptOperation = receipt?.operation;
  if (!receipt || (receiptOperation !== 'database.clear_all' && receiptOperation !== 'agent.changesets.apply') || receipt.status !== 'admitted' ||
      receipt.grant_operation !== 'database.clear_all' || receipt.grant_reservation_id !== receipt.reservation_id ||
      receipt.grant_client_id !== clientId || receipt.grant_status !== 'reserved' || receipt.grant_target_hash !== binding.targetHash ||
      receipt.grant_catalog_version !== binding.catalog.version || receipt.grant_catalog_hash !== binding.catalog.hash ||
      receipt.grant_recovery !== 'consistency_bundle' || receipt.grant_max_affected_entities !== 500 ||
      receipt.reserved_client_id !== clientId || receipt.reserved_request_id !== requestId ||
      receipt.reserved_payload_hash !== receipt.grant_payload_hash || receipt.reserved_affected_set_hash !== binding.affectedSetHash ||
      receipt.reserved_base_epoch !== binding.baseVersion.dataEpoch || receipt.reserved_base_revision !== binding.baseVersion.dataRevision ||
      receipt.reserved_catalog_version !== binding.catalog.version || receipt.reserved_catalog_hash !== binding.catalog.hash ||
      typeof receipt.receipt_id !== 'string' || typeof receipt.reservation_id !== 'string' || typeof receipt.grant_id !== 'string' ||
      typeof receipt.affected_set_hash !== 'string' || typeof receipt.payload_hash !== 'string' || typeof receipt.grant_payload_hash !== 'string' ||
      receipt.affected_set_hash !== binding.affectedSetHash || receipt.r4_target_hash !== binding.targetHash ||
      receipt.base_data_epoch !== binding.baseVersion.dataEpoch || receipt.base_data_revision !== binding.baseVersion.dataRevision ||
      receipt.catalog_version !== binding.catalog.version || receipt.catalog_hash !== binding.catalog.hash ||
      receipt.risk !== 'R4' || receipt.r4_recovery !== 'consistency_bundle' || receipt.r4_max_affected_entities !== 500 ||
      typeof receipt.r4_reservation_expires_at !== 'string' || typeof receipt.reserved_at !== 'string' || typeof receipt.created_at !== 'string') {
    throw new AgentError('RECOVERY_FENCE');
  }
  let changeSetId: string | undefined;
  if (receiptOperation === 'agent.changesets.apply') {
    let payload: unknown;
    try { payload = JSON.parse(String(receipt.payload_json)); } catch { throw new AgentError('RECOVERY_FENCE'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof (payload as { changeSetId?: unknown }).changeSetId !== 'string') {
      throw new AgentError('RECOVERY_FENCE');
    }
    changeSetId = (payload as { changeSetId: string }).changeSetId;
  }
  return Object.freeze({
    requestId, receiptId: receipt.receipt_id, reservationId: receipt.reservation_id, grantId: receipt.grant_id,
    affectedSetHash: receipt.affected_set_hash, receiptOperation, receiptPayloadHash: receipt.payload_hash,
    clearPayloadHash: receipt.grant_payload_hash, risk: 'R4' as const,
    baseVersion: Object.freeze({ dataEpoch: String(receipt.base_data_epoch), dataRevision: Number(receipt.base_data_revision) }),
    catalog: Object.freeze({ version: String(receipt.catalog_version), hash: String(receipt.catalog_hash) }),
    recovery: 'consistency_bundle' as const, maxAffectedEntities: 500,
    reservationExpiresAt: String(receipt.r4_reservation_expires_at), reservedAt: String(receipt.reserved_at),
    receiptCreatedAt: String(receipt.created_at),
    ...(changeSetId ? { changeSetId } : {})
  });
}

export function assertImportBatchDeletionReceiptTarget(
  database: Database,
  clientId: string,
  requestId: string,
  binding: {
    readonly targetHash: string;
    readonly affectedSetHash: string;
    readonly baseVersion: { readonly dataEpoch: string; readonly dataRevision: number };
    readonly catalog: { readonly version: string; readonly hash: string };
  },
  scope: DatabaseMutationScope
): ImportBatchDeletionAdmission {
  assertDatabaseMutationScope(scope, database);
  const receipt = row(database, `SELECT i.receipt_id,i.operation,i.payload_json,i.payload_hash,i.risk,i.status,i.reservation_id,i.grant_id,i.r4_target_hash,i.affected_set_hash,
      i.base_data_epoch,i.base_data_revision,i.catalog_version,i.catalog_hash,i.r4_recovery,i.r4_max_affected_entities,i.r4_reservation_expires_at,i.created_at,
      g.client_id AS grant_client_id,g.operation AS grant_operation,g.payload_hash AS grant_payload_hash,g.target_hash AS grant_target_hash,
      g.catalog_version AS grant_catalog_version,g.catalog_hash AS grant_catalog_hash,g.recovery AS grant_recovery,
      g.max_affected_entities AS grant_max_affected_entities,g.status AS grant_status,g.reservation_id AS grant_reservation_id,
      g.reserved_client_id,g.reserved_request_id,g.reserved_payload_hash,g.reserved_affected_set_hash,g.reserved_base_epoch,
      g.reserved_base_revision,g.reserved_catalog_version,g.reserved_catalog_hash,g.reserved_at
    FROM agent_idempotency i INNER JOIN agent_r4_grants g ON g.grant_id=i.grant_id
    WHERE i.client_id=? AND i.request_id=?`, [clientId, requestId]);
  const receiptOperation = receipt?.operation;
  if (!receipt || (receiptOperation !== 'imports.delete_batch' && receiptOperation !== 'agent.changesets.apply') || receipt.status !== 'admitted' ||
      receipt.grant_operation !== 'imports.delete_batch' || receipt.grant_reservation_id !== receipt.reservation_id ||
      receipt.grant_client_id !== clientId || receipt.grant_status !== 'reserved' || receipt.grant_target_hash !== binding.targetHash ||
      receipt.grant_catalog_version !== binding.catalog.version || receipt.grant_catalog_hash !== binding.catalog.hash ||
      receipt.grant_recovery !== 'consistency_bundle' || receipt.grant_max_affected_entities !== 500 ||
      receipt.reserved_client_id !== clientId || receipt.reserved_request_id !== requestId ||
      receipt.reserved_payload_hash !== receipt.grant_payload_hash || receipt.reserved_affected_set_hash !== binding.affectedSetHash ||
      receipt.reserved_base_epoch !== binding.baseVersion.dataEpoch || receipt.reserved_base_revision !== binding.baseVersion.dataRevision ||
      receipt.reserved_catalog_version !== binding.catalog.version || receipt.reserved_catalog_hash !== binding.catalog.hash ||
      typeof receipt.receipt_id !== 'string' || typeof receipt.reservation_id !== 'string' || typeof receipt.grant_id !== 'string' ||
      typeof receipt.affected_set_hash !== 'string' || typeof receipt.payload_hash !== 'string' || typeof receipt.grant_payload_hash !== 'string' ||
      receipt.affected_set_hash !== binding.affectedSetHash || receipt.r4_target_hash !== binding.targetHash ||
      receipt.base_data_epoch !== binding.baseVersion.dataEpoch || receipt.base_data_revision !== binding.baseVersion.dataRevision ||
      receipt.catalog_version !== binding.catalog.version || receipt.catalog_hash !== binding.catalog.hash ||
      receipt.risk !== 'R4' || receipt.r4_recovery !== 'consistency_bundle' || receipt.r4_max_affected_entities !== 500 ||
      typeof receipt.r4_reservation_expires_at !== 'string' || typeof receipt.reserved_at !== 'string' || typeof receipt.created_at !== 'string') {
    throw new AgentError('RECOVERY_FENCE');
  }
  let changeSetId: string | undefined;
  if (receiptOperation === 'agent.changesets.apply') {
    let payload: unknown;
    try { payload = JSON.parse(String(receipt.payload_json)); } catch { throw new AgentError('RECOVERY_FENCE'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof (payload as { changeSetId?: unknown }).changeSetId !== 'string') {
      throw new AgentError('RECOVERY_FENCE');
    }
    changeSetId = (payload as { changeSetId: string }).changeSetId;
  }
  return Object.freeze({
    requestId, receiptId: receipt.receipt_id, reservationId: receipt.reservation_id, grantId: receipt.grant_id,
    affectedSetHash: receipt.affected_set_hash, receiptOperation, receiptPayloadHash: receipt.payload_hash,
    deletePayloadHash: receipt.grant_payload_hash, risk: 'R4' as const,
    baseVersion: Object.freeze({ dataEpoch: String(receipt.base_data_epoch), dataRevision: Number(receipt.base_data_revision) }),
    catalog: Object.freeze({ version: String(receipt.catalog_version), hash: String(receipt.catalog_hash) }),
    recovery: 'consistency_bundle' as const, maxAffectedEntities: 500,
    reservationExpiresAt: String(receipt.r4_reservation_expires_at), reservedAt: String(receipt.reserved_at),
    receiptCreatedAt: String(receipt.created_at),
    ...(changeSetId ? { changeSetId } : {})
  });
}

/** Validate every persisted row before the control plane admits new work. */
export function scanGlobalAssets(database: AssetDatabase): readonly GlobalAsset[] {
  const assets = rows(database, 'SELECT * FROM agent_global_assets ORDER BY asset_id').map((entry) => asset(entry, true) as InternalGlobalAsset);
  for (const current of assets) {
    if (current.status === 'published' || current.status === 'consumed') {
      if (!current.internalPath || !current.contentHash || current.contentSize === undefined || !fs.existsSync(current.internalPath)) throw new AgentError('RECOVERY_FENCE');
      const bytes = fs.readFileSync(current.internalPath);
      if (`sha256-v1:${createHash('sha256').update(bytes).digest('hex')}` !== current.contentHash || bytes.length !== current.contentSize) throw new AgentError('RECOVERY_FENCE');
    }
    if (current.status === 'staged' && (!current.stagedPath || !current.contentHash || current.contentSize === undefined || !fs.existsSync(current.stagedPath))) throw new AgentError('RECOVERY_FENCE');
    if (!current.jobId) continue;
    const job = row(database, 'SELECT owner_client_id, operation FROM agent_jobs WHERE job_id = ?', [current.jobId]);
    if (!job || job.owner_client_id !== current.ownerClientId || !['backups.materialize', 'exports.materialize'].includes(String(job.operation))) throw new AgentError('RECOVERY_FENCE');
  }
  return Object.freeze(assets.map(({ internalPath, jobId, operationJournalId, ...publicAsset }) => Object.freeze(publicAsset)));
}

export const recoverGlobalAssets = scanGlobalAssets;

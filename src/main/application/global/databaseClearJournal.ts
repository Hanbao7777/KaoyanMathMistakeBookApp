import fs from 'node:fs';
import path from 'node:path';
import { AgentError } from '../../../shared/agent/errors';
import type { DataVersion } from '../../../shared/agent/v1/contracts';
import type { EntityRef } from '../../../shared/agent/v1/contracts';
import type { CatalogIdentity, OperationName } from '../../../shared/agent/v1/gatewayContracts';
import { canonicalizeJson, hashCanonicalJson } from '../../../shared/agent/v1/gatewaySchemas';
import { defaultDirectoryDurabilityDependencies, flushDirectory, flushFile } from '../../persistence/fileDurability';
import {
  defaultMaterializationFileDependencies,
  type MaterializationDurabilityDependencies,
  type MaterializationFileDependencies,
  type MaterializationWriteHandle
} from './materializationJournal';

export const databaseClearPhases = Object.freeze([
  'intent', 'inventory_validated', 'recovery_published', 'files_quarantined',
  'live_published', 'completed', 'needs_recovery'
] as const);
export type DatabaseClearPhase = typeof databaseClearPhases[number];

export interface DatabaseClearFileEvidence {
  readonly contentHash: string;
  readonly contentSize: number;
}

export interface DatabaseClearManagedFile {
  readonly fileId: string;
  readonly sourceKind: 'question_image' | 'import_managed_image';
  readonly internalPath: string;
  readonly pathHash: string;
  readonly contentHash: string;
  readonly contentSize: number;
  readonly sourceBindingsHash: string;
}

export interface DatabaseClearManifest {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly ownerClientId: string;
  readonly requestId: string;
  readonly receiptId: string;
  readonly receiptOperation: OperationName;
  readonly receiptPayloadHash: string;
  readonly risk: 'R4';
  readonly reservationId: string;
  readonly grantId: string;
  readonly changeSetId?: string;
  readonly clearPayloadHash: string;
  readonly affectedSetHash: string;
  readonly targetHash: string;
  readonly recovery: 'consistency_bundle';
  readonly maxAffectedEntities: number;
  readonly reservationExpiresAt: string;
  readonly reservedAt: string;
  readonly receiptCreatedAt: string;
  readonly deleteManagedImages: boolean;
  readonly businessRowCount: number;
  readonly managedImageCount: number;
  readonly affectedEntityCount: number;
  readonly affectedEntities: readonly EntityRef[];
  readonly inventoryHash: string;
  readonly managedFiles: readonly DatabaseClearManagedFile[];
  readonly baseVersion: DataVersion;
  readonly catalog: CatalogIdentity;
  readonly phase: DatabaseClearPhase;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly versionAfter?: DataVersion;
  readonly recoveryDatabasePath?: string;
  readonly recoveryDatabaseEvidence?: DatabaseClearFileEvidence;
  readonly recoveryInventoryPath?: string;
  readonly recoveryInventoryEvidence?: DatabaseClearFileEvidence;
  readonly liveDatabaseEvidence?: DatabaseClearFileEvidence;
  readonly reason?: string;
}

const identifier = /^[A-Za-z0-9_-]{1,200}$/;
const safeClient = /^[A-Za-z0-9._:-]{1,200}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = /^sha256-v1:[0-9a-f]{64}$/;
const safeEntityType = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const transitions: Readonly<Record<DatabaseClearPhase, readonly DatabaseClearPhase[]>> = Object.freeze({
  intent: ['intent', 'inventory_validated', 'needs_recovery'],
  inventory_validated: ['inventory_validated', 'recovery_published', 'needs_recovery'],
  recovery_published: ['recovery_published', 'files_quarantined', 'needs_recovery'],
  files_quarantined: ['files_quarantined', 'live_published', 'needs_recovery'],
  live_published: ['live_published', 'completed', 'needs_recovery'],
  completed: ['completed'],
  needs_recovery: ['needs_recovery']
});

function exactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentError('RECOVERY_FENCE');
  const keys = Object.keys(value as Record<string, unknown>);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => !allowed.has(key))) throw new AgentError('RECOVERY_FENCE');
}

function safeTimestamp(value: string): boolean {
  return timestamp.test(value) && new Date(value).toISOString() === value;
}

function validateVersion(value: DataVersion | undefined, required: boolean): void {
  if (!required && value === undefined) return;
  exactKeys(value, ['dataEpoch', 'dataRevision']);
  if (!value || typeof value.dataEpoch !== 'string' || value.dataEpoch.length < 1 ||
      !Number.isSafeInteger(value.dataRevision) || value.dataRevision < 0) throw new AgentError('RECOVERY_FENCE');
}

function validateEvidence(value: DatabaseClearFileEvidence | undefined): void {
  if (value === undefined) return;
  exactKeys(value, ['contentHash', 'contentSize']);
  if (!hash.test(value.contentHash) || !Number.isSafeInteger(value.contentSize) || value.contentSize < 0) throw new AgentError('RECOVERY_FENCE');
}

function validatePath(value: string | undefined, required: boolean): void {
  if (!required && value === undefined) return;
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) throw new AgentError('RECOVERY_FENCE');
}

function validateManagedFile(value: DatabaseClearManagedFile): void {
  exactKeys(value, ['fileId', 'sourceKind', 'internalPath', 'pathHash', 'contentHash', 'contentSize', 'sourceBindingsHash']);
  if (!identifier.test(value.fileId) || !['question_image', 'import_managed_image'].includes(value.sourceKind) ||
      !path.isAbsolute(value.internalPath) || path.normalize(value.internalPath) !== value.internalPath ||
      !hash.test(value.pathHash) || !hash.test(value.contentHash) || !hash.test(value.sourceBindingsHash) ||
      !Number.isSafeInteger(value.contentSize) || value.contentSize < 1) throw new AgentError('RECOVERY_FENCE');
}

function validate(manifest: DatabaseClearManifest, root: string): void {
  exactKeys(manifest, [
    'schemaVersion', 'operationId', 'ownerClientId', 'requestId', 'receiptId', 'receiptOperation', 'receiptPayloadHash', 'risk',
    'reservationId', 'grantId', 'clearPayloadHash', 'affectedSetHash', 'targetHash', 'recovery', 'maxAffectedEntities',
    'reservationExpiresAt', 'reservedAt', 'receiptCreatedAt', 'deleteManagedImages', 'businessRowCount', 'managedImageCount',
    'affectedEntityCount', 'affectedEntities', 'inventoryHash', 'managedFiles', 'baseVersion', 'catalog', 'phase', 'createdAt', 'updatedAt'
  ], [
    'changeSetId', 'versionAfter', 'recoveryDatabasePath', 'recoveryDatabaseEvidence', 'recoveryInventoryPath',
    'recoveryInventoryEvidence', 'liveDatabaseEvidence', 'reason'
  ]);
  exactKeys(manifest.catalog, ['version', 'hash']);
  validateVersion(manifest.baseVersion, true);
  validateVersion(manifest.versionAfter, manifest.phase === 'live_published' || manifest.phase === 'completed');
  validateEvidence(manifest.recoveryDatabaseEvidence);
  validateEvidence(manifest.recoveryInventoryEvidence);
  validateEvidence(manifest.liveDatabaseEvidence);
  const recoveryRequired = ['recovery_published', 'files_quarantined', 'live_published', 'completed'].includes(manifest.phase);
  validatePath(manifest.recoveryDatabasePath, recoveryRequired);
  validatePath(manifest.recoveryInventoryPath, recoveryRequired);
  if (manifest.schemaVersion !== 1 || !identifier.test(manifest.operationId) || !safeClient.test(manifest.ownerClientId) ||
      !uuid.test(manifest.requestId) || !uuid.test(manifest.receiptId) || !uuid.test(manifest.reservationId) || !uuid.test(manifest.grantId) ||
      (manifest.receiptOperation !== 'database.clear_all' && manifest.receiptOperation !== 'agent.changesets.apply') ||
      (manifest.changeSetId !== undefined && !uuid.test(manifest.changeSetId)) ||
      (manifest.receiptOperation === 'agent.changesets.apply') !== (manifest.changeSetId !== undefined) ||
      !hash.test(manifest.receiptPayloadHash) || !hash.test(manifest.clearPayloadHash) || !hash.test(manifest.affectedSetHash) ||
      !hash.test(manifest.targetHash) || !hash.test(manifest.inventoryHash) || manifest.risk !== 'R4' ||
      manifest.recovery !== 'consistency_bundle' || manifest.maxAffectedEntities !== 500 ||
      !safeTimestamp(manifest.reservationExpiresAt) || !safeTimestamp(manifest.reservedAt) || !safeTimestamp(manifest.receiptCreatedAt) ||
      typeof manifest.deleteManagedImages !== 'boolean' || !Number.isSafeInteger(manifest.businessRowCount) || manifest.businessRowCount < 0 ||
      !Number.isSafeInteger(manifest.managedImageCount) || manifest.managedImageCount < 0 ||
      !Number.isSafeInteger(manifest.affectedEntityCount) || manifest.affectedEntityCount < 0 || manifest.affectedEntityCount > manifest.maxAffectedEntities ||
      !Array.isArray(manifest.affectedEntities) || manifest.affectedEntities.length !== manifest.affectedEntityCount ||
      hashCanonicalJson(manifest.affectedEntities) !== manifest.affectedSetHash ||
      manifest.managedImageCount !== manifest.managedFiles.length || manifest.affectedEntityCount !== manifest.businessRowCount + manifest.managedImageCount ||
      !Array.isArray(manifest.managedFiles) || new Set(manifest.managedFiles.map((file) => file.fileId)).size !== manifest.managedFiles.length ||
      typeof manifest.catalog.version !== 'string' || manifest.catalog.version.length < 1 || !hash.test(manifest.catalog.hash) ||
      !databaseClearPhases.includes(manifest.phase) || !safeTimestamp(manifest.createdAt) || !safeTimestamp(manifest.updatedAt) ||
      manifest.updatedAt < manifest.createdAt || (manifest.reason !== undefined && (typeof manifest.reason !== 'string' || manifest.reason.length > 120))) {
    throw new AgentError('RECOVERY_FENCE');
  }
  manifest.managedFiles.forEach(validateManagedFile);
  const normalizedFiles = [...manifest.managedFiles].sort((left, right) => left.pathHash.localeCompare(right.pathHash));
  if (canonicalizeJson(normalizedFiles) !== canonicalizeJson(manifest.managedFiles) ||
      new Set(manifest.managedFiles.map((file) => path.resolve(file.internalPath).toLowerCase())).size !== manifest.managedFiles.length ||
      new Set(manifest.managedFiles.map((file) => file.pathHash)).size !== manifest.managedFiles.length) throw new AgentError('RECOVERY_FENCE');
  for (const entity of manifest.affectedEntities) {
    exactKeys(entity, ['entityType', 'entityId']);
    if (typeof entity.entityType !== 'string' || !safeEntityType.test(entity.entityType) ||
        typeof entity.entityId !== 'string' || entity.entityId.length < 1 || entity.entityId.length > 200) throw new AgentError('RECOVERY_FENCE');
  }
  const normalizedEntities = [...manifest.affectedEntities]
    .sort((left, right) => `${left.entityType}\0${left.entityId}`.localeCompare(`${right.entityType}\0${right.entityId}`));
  if (canonicalizeJson(normalizedEntities) !== canonicalizeJson(manifest.affectedEntities) ||
      new Set(manifest.affectedEntities.map((entity) => `${entity.entityType}\0${entity.entityId}`)).size !== manifest.affectedEntities.length) {
    throw new AgentError('RECOVERY_FENCE');
  }
  const rowBindings = manifest.affectedEntities.filter((entity) => entity.entityType.startsWith('database_row_'))
    .map((entity) => Object.freeze({ table: entity.entityType.slice('database_row_'.length), rowHash: entity.entityId }))
    .sort((left, right) => `${left.table}\0${left.rowHash}`.localeCompare(`${right.table}\0${right.rowHash}`));
  const fileBindings = manifest.managedFiles.map(({ fileId, sourceKind, pathHash, contentHash, contentSize, sourceBindingsHash }) =>
    Object.freeze({ fileId, sourceKind, pathHash, contentHash, contentSize, sourceBindingsHash }));
  const fileEntities = manifest.affectedEntities.filter((entity) => entity.entityType === 'managed_image');
  if (rowBindings.length !== manifest.businessRowCount || fileEntities.length !== manifest.managedImageCount ||
      canonicalizeJson(fileBindings.map(hashCanonicalJson).sort()) !== canonicalizeJson(fileEntities.map((entity) => entity.entityId).sort()) ||
      hashCanonicalJson({ schemaVersion: 1, rowBindings, fileBindings }) !== manifest.inventoryHash ||
      hashCanonicalJson({
        operation: 'database.clear_all', deleteManagedImages: manifest.deleteManagedImages, inventoryHash: manifest.inventoryHash,
        affectedSetHash: manifest.affectedSetHash, businessRowCount: manifest.businessRowCount, managedImageCount: manifest.managedImageCount
      }) !== manifest.targetHash) throw new AgentError('RECOVERY_FENCE');
  if ((manifest.phase === 'intent' || manifest.phase === 'inventory_validated') &&
      (manifest.versionAfter || manifest.recoveryDatabasePath || manifest.recoveryDatabaseEvidence || manifest.recoveryInventoryPath ||
       manifest.recoveryInventoryEvidence || manifest.liveDatabaseEvidence || manifest.reason)) throw new AgentError('RECOVERY_FENCE');
  if (recoveryRequired && (!manifest.recoveryDatabasePath || !manifest.recoveryDatabaseEvidence ||
      !manifest.recoveryInventoryPath || !manifest.recoveryInventoryEvidence)) throw new AgentError('RECOVERY_FENCE');
  if ((manifest.phase === 'recovery_published' || manifest.phase === 'files_quarantined') &&
      (manifest.versionAfter || manifest.liveDatabaseEvidence || manifest.reason)) throw new AgentError('RECOVERY_FENCE');
  if ((manifest.phase === 'live_published' || manifest.phase === 'completed') && (!manifest.versionAfter || !manifest.liveDatabaseEvidence || manifest.reason)) {
    throw new AgentError('RECOVERY_FENCE');
  }
  if (manifest.phase === 'needs_recovery' && manifest.liveDatabaseEvidence && !manifest.versionAfter) throw new AgentError('RECOVERY_FENCE');
  const target = path.join(root, `${manifest.operationId}.database-clear.json`);
  const relative = path.relative(root, target);
  if (!path.isAbsolute(root) || path.normalize(root) !== root || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new AgentError('RECOVERY_FENCE');
  }
}

function identity(manifest: DatabaseClearManifest): string {
  const {
    phase: _phase, updatedAt: _updatedAt, versionAfter: _versionAfter, recoveryDatabasePath: _recoveryDatabasePath,
    recoveryDatabaseEvidence: _recoveryDatabaseEvidence, recoveryInventoryPath: _recoveryInventoryPath,
    recoveryInventoryEvidence: _recoveryInventoryEvidence, liveDatabaseEvidence: _liveDatabaseEvidence, reason: _reason, ...stable
  } = manifest;
  return canonicalizeJson(stable);
}

async function flushRequiredDirectory(directory: string, dependencies: MaterializationDurabilityDependencies): Promise<void> {
  const outcome = await flushDirectory(directory, dependencies.directoryDurability ?? defaultDirectoryDurabilityDependencies);
  if (outcome.status === 'failed') throw new AgentError('RECOVERY_FENCE');
}

export class DatabaseClearJournalStore {
  private readonly files: MaterializationFileDependencies;
  private readonly dependencies: MaterializationDurabilityDependencies;

  constructor(readonly root: string, dependencies: MaterializationDurabilityDependencies = {}) {
    if (!path.isAbsolute(root) || path.normalize(root) !== root) throw new Error('Database clear journal root must be normalized and absolute');
    this.files = dependencies.files ?? defaultMaterializationFileDependencies;
    this.dependencies = dependencies;
  }

  private file(operationId: string): string {
    if (!identifier.test(operationId)) throw new AgentError('RECOVERY_FENCE');
    return path.join(this.root, `${operationId}.database-clear.json`);
  }

  read(operationId: string): DatabaseClearManifest | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(operationId), 'utf8')) as DatabaseClearManifest;
      validate(parsed, this.root);
      return Object.freeze(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof AgentError) throw error;
      throw new AgentError('RECOVERY_FENCE');
    }
  }

  scan(): readonly DatabaseClearManifest[] {
    try {
      if (!fs.existsSync(this.root)) return Object.freeze([]);
      return Object.freeze(fs.readdirSync(this.root, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.database-clear.json'))
        .map((entry) => this.read(entry.name.slice(0, -'.database-clear.json'.length))!)
        .sort((left, right) => left.operationId.localeCompare(right.operationId)));
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError('RECOVERY_FENCE');
    }
  }

  async publish(manifest: DatabaseClearManifest): Promise<DatabaseClearManifest> {
    validate(manifest, this.root);
    const existing = this.read(manifest.operationId);
    if (existing) {
      if (identity(existing) !== identity(manifest) || manifest.updatedAt < existing.updatedAt || !transitions[existing.phase].includes(manifest.phase)) {
        throw new AgentError('RECOVERY_FENCE');
      }
    } else if (manifest.phase !== 'intent') throw new AgentError('RECOVERY_FENCE');
    await this.files.mkdir(this.root);
    const target = this.file(manifest.operationId);
    const temporary = path.join(this.root, `.${manifest.operationId}.${hashCanonicalJson({ now: manifest.updatedAt, phase: manifest.phase }).slice(10, 26)}.tmp`);
    let handle: MaterializationWriteHandle | undefined;
    let renamed = false;
    try {
      handle = await this.files.openExclusive(temporary);
      await handle.writeFile(Buffer.from(`${canonicalizeJson(manifest)}\n`, 'utf8'));
      const flushed = await flushFile(handle);
      if (flushed.status !== 'flushed') throw new AgentError('RECOVERY_FENCE');
      await handle.close();
      handle = undefined;
      await this.files.rename(temporary, target);
      renamed = true;
      await flushRequiredDirectory(this.root, this.dependencies);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (!renamed) await this.files.unlink(temporary).catch(() => undefined);
      throw error;
    }
    return Object.freeze(manifest);
  }

  async ensureIntent(input: Omit<DatabaseClearManifest, 'schemaVersion' | 'phase' | 'createdAt' | 'updatedAt'>, now: string): Promise<DatabaseClearManifest> {
    const proposed = Object.freeze({ schemaVersion: 1 as const, ...input, phase: 'intent' as const, createdAt: now, updatedAt: now });
    const existing = this.read(input.operationId);
    if (existing) {
      if (identity(existing) !== identity(proposed)) throw new AgentError('IDEMPOTENCY_CONFLICT');
      return existing;
    }
    return this.publish(proposed);
  }

  async advance(
    manifest: DatabaseClearManifest,
    phase: DatabaseClearPhase,
    now: string,
    extras: Partial<Pick<DatabaseClearManifest, 'versionAfter' | 'recoveryDatabasePath' | 'recoveryDatabaseEvidence' |
      'recoveryInventoryPath' | 'recoveryInventoryEvidence' | 'liveDatabaseEvidence' | 'reason'>> = {}
  ): Promise<DatabaseClearManifest> {
    if (!safeTimestamp(now) || now < manifest.updatedAt || !transitions[manifest.phase].includes(phase)) throw new AgentError('RECOVERY_FENCE');
    return this.publish(Object.freeze({ ...manifest, ...extras, phase, updatedAt: now }));
  }
}

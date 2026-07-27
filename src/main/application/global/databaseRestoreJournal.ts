import fs from 'node:fs';
import path from 'node:path';
import { AgentError } from '../../../shared/agent/errors';
import type { DataVersion } from '../../../shared/agent/v1/contracts';
import type { CatalogIdentity, OperationName } from '../../../shared/agent/v1/gatewayContracts';
import { canonicalizeJson, hashCanonicalJson } from '../../../shared/agent/v1/gatewaySchemas';
import type { MaterializationDurabilityDependencies, MaterializationFileDependencies, MaterializationWriteHandle } from './materializationJournal';
import { defaultMaterializationFileDependencies } from './materializationJournal';
import { defaultDirectoryDurabilityDependencies, flushDirectory, flushFile } from '../../persistence/fileDurability';

export const databaseRestorePhases = Object.freeze([
  'intent', 'backup_validated', 'recovery_published', 'live_published', 'completed', 'needs_recovery'
] as const);
export type DatabaseRestorePhase = typeof databaseRestorePhases[number];

export interface DatabaseRestoreFileEvidence {
  readonly contentHash: string;
  readonly contentSize: number;
}

export interface DatabaseRestoreManifest {
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
  readonly restorePayloadHash: string;
  readonly affectedSetHash: string;
  readonly targetHash: string;
  readonly recovery: 'consistency_bundle';
  readonly maxAffectedEntities: number;
  readonly reservationExpiresAt: string;
  readonly reservedAt: string;
  readonly receiptCreatedAt: string;
  readonly backup: {
    readonly assetId: string;
    readonly contentHash: string;
    readonly contentSize: number;
    readonly internalPath: string;
  };
  readonly baseVersion: DataVersion;
  readonly catalog: CatalogIdentity;
  readonly phase: DatabaseRestorePhase;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly versionAfter?: DataVersion;
  readonly recoveryDatabasePath?: string;
  readonly recoveryDatabaseEvidence?: DatabaseRestoreFileEvidence;
  readonly liveDatabaseEvidence?: DatabaseRestoreFileEvidence;
  readonly reason?: string;
}

const identifier = /^[A-Za-z0-9_-]{1,200}$/;
const safeClient = /^[A-Za-z0-9._:-]{1,200}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = /^sha256-v1:[0-9a-f]{64}$/;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const transitions: Readonly<Record<DatabaseRestorePhase, readonly DatabaseRestorePhase[]>> = Object.freeze({
  intent: ['intent', 'backup_validated', 'needs_recovery'],
  backup_validated: ['backup_validated', 'recovery_published', 'needs_recovery'],
  recovery_published: ['recovery_published', 'live_published', 'needs_recovery'],
  live_published: ['live_published', 'completed', 'needs_recovery'],
  completed: ['completed'],
  needs_recovery: ['needs_recovery']
});

function safeTimestamp(value: string): boolean {
  return timestamp.test(value) && new Date(value).toISOString() === value;
}

function assertWithin(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (!path.isAbsolute(root) || path.normalize(root) !== root || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new AgentError('RECOVERY_FENCE');
  }
}

function validateEvidence(evidence: DatabaseRestoreFileEvidence | undefined): void {
  if (evidence !== undefined && (!hash.test(evidence.contentHash) || !Number.isSafeInteger(evidence.contentSize) || evidence.contentSize < 0)) throw new AgentError('RECOVERY_FENCE');
}

function exactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentError('RECOVERY_FENCE');
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value as Record<string, unknown>).sort();
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => !allowed.has(key))) throw new AgentError('RECOVERY_FENCE');
}

function validateVersion(value: DataVersion | undefined, required: boolean): void {
  if (!required && value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentError('RECOVERY_FENCE');
  exactKeys(value, ['dataEpoch', 'dataRevision']);
  if (!value.dataEpoch || !Number.isSafeInteger(value.dataRevision) || value.dataRevision < 0) throw new AgentError('RECOVERY_FENCE');
}

function validatePath(value: string | undefined, required: boolean): void {
  if (!required && value === undefined) return;
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) throw new AgentError('RECOVERY_FENCE');
}

function validate(manifest: DatabaseRestoreManifest, root: string): void {
  const optional = ['changeSetId', 'versionAfter', 'recoveryDatabasePath', 'recoveryDatabaseEvidence', 'liveDatabaseEvidence', 'reason'];
  exactKeys(manifest, [
    'schemaVersion', 'operationId', 'ownerClientId', 'requestId', 'receiptId', 'receiptOperation', 'receiptPayloadHash', 'risk',
    'reservationId', 'grantId', 'restorePayloadHash', 'affectedSetHash', 'targetHash', 'recovery', 'maxAffectedEntities',
    'reservationExpiresAt', 'reservedAt', 'receiptCreatedAt', 'backup', 'baseVersion', 'catalog', 'phase', 'createdAt', 'updatedAt'
  ], optional);
  exactKeys(manifest.backup, ['assetId', 'contentHash', 'contentSize', 'internalPath']);
  exactKeys(manifest.catalog, ['version', 'hash']);
  validateVersion(manifest.baseVersion, true);
  validateVersion(manifest.versionAfter, manifest.phase === 'live_published' || manifest.phase === 'completed');
  if (manifest.schemaVersion !== 1 || !identifier.test(manifest.operationId) || !safeClient.test(manifest.ownerClientId) ||
      !uuid.test(manifest.requestId) || !uuid.test(manifest.receiptId) || !uuid.test(manifest.reservationId) || !uuid.test(manifest.grantId) ||
      (manifest.receiptOperation !== 'database.restore' && manifest.receiptOperation !== 'agent.changesets.apply') ||
      (manifest.changeSetId !== undefined && !uuid.test(manifest.changeSetId)) || !hash.test(manifest.receiptPayloadHash) ||
      (manifest.receiptOperation === 'agent.changesets.apply') !== (manifest.changeSetId !== undefined) ||
      manifest.risk !== 'R4' || !hash.test(manifest.restorePayloadHash) || !hash.test(manifest.affectedSetHash) ||
      !hash.test(manifest.targetHash) || !identifier.test(manifest.backup.assetId) || !hash.test(manifest.backup.contentHash) ||
      manifest.recovery !== 'consistency_bundle' || manifest.maxAffectedEntities !== 500 || !safeTimestamp(manifest.reservationExpiresAt) ||
      !safeTimestamp(manifest.reservedAt) || !safeTimestamp(manifest.receiptCreatedAt) ||
      !Number.isSafeInteger(manifest.backup.contentSize) || manifest.backup.contentSize < 0 ||
      !path.isAbsolute(manifest.backup.internalPath) || path.normalize(manifest.backup.internalPath) !== manifest.backup.internalPath ||
      !manifest.catalog.version || !hash.test(manifest.catalog.hash) || !databaseRestorePhases.includes(manifest.phase) ||
      !safeTimestamp(manifest.createdAt) || !safeTimestamp(manifest.updatedAt) || manifest.updatedAt < manifest.createdAt ||
      (manifest.reason !== undefined && (typeof manifest.reason !== 'string' || manifest.reason.length > 120))) throw new AgentError('RECOVERY_FENCE');
  validateEvidence(manifest.recoveryDatabaseEvidence);
  validateEvidence(manifest.liveDatabaseEvidence);
  validatePath(manifest.recoveryDatabasePath, manifest.phase === 'recovery_published' || manifest.phase === 'live_published' || manifest.phase === 'completed');
  if (manifest.phase === 'intent' && (manifest.versionAfter || manifest.recoveryDatabasePath || manifest.recoveryDatabaseEvidence || manifest.liveDatabaseEvidence || manifest.reason)) throw new AgentError('RECOVERY_FENCE');
  if (manifest.phase === 'backup_validated' && (manifest.versionAfter || manifest.recoveryDatabasePath || manifest.recoveryDatabaseEvidence || manifest.liveDatabaseEvidence || manifest.reason)) throw new AgentError('RECOVERY_FENCE');
  if (manifest.phase === 'recovery_published' && (!manifest.recoveryDatabasePath || !manifest.recoveryDatabaseEvidence || manifest.versionAfter || manifest.liveDatabaseEvidence || manifest.reason)) throw new AgentError('RECOVERY_FENCE');
  if (manifest.phase === 'live_published' && (!manifest.versionAfter || !manifest.recoveryDatabasePath || !manifest.recoveryDatabaseEvidence || !manifest.liveDatabaseEvidence || manifest.reason)) throw new AgentError('RECOVERY_FENCE');
  if (manifest.phase === 'completed' && (!manifest.versionAfter || !manifest.recoveryDatabasePath || !manifest.recoveryDatabaseEvidence || !manifest.liveDatabaseEvidence || manifest.reason)) throw new AgentError('RECOVERY_FENCE');
  if (manifest.phase === 'needs_recovery' && manifest.liveDatabaseEvidence && !manifest.versionAfter) throw new AgentError('RECOVERY_FENCE');
  assertWithin(root, path.join(root, `${manifest.operationId}.database-restore.json`));
}

function identity(manifest: DatabaseRestoreManifest): string {
  const { phase: _phase, updatedAt: _updatedAt, versionAfter: _versionAfter, recoveryDatabasePath: _recoveryDatabasePath,
    recoveryDatabaseEvidence: _recoveryDatabaseEvidence, liveDatabaseEvidence: _liveDatabaseEvidence, reason: _reason, ...stable } = manifest;
  return canonicalizeJson(stable);
}

async function flushRequiredDirectory(directory: string, dependencies: MaterializationDurabilityDependencies): Promise<void> {
  const outcome = await flushDirectory(directory, dependencies.directoryDurability ?? defaultDirectoryDurabilityDependencies);
  if (outcome.status === 'failed') throw new AgentError('RECOVERY_FENCE');
}

export class DatabaseRestoreJournalStore {
  private readonly files: MaterializationFileDependencies;
  private readonly dependencies: MaterializationDurabilityDependencies;

  constructor(readonly root: string, dependencies: MaterializationDurabilityDependencies = {}) {
    if (!path.isAbsolute(root) || path.normalize(root) !== root) throw new Error('Database restore journal root must be normalized and absolute');
    this.files = dependencies.files ?? defaultMaterializationFileDependencies;
    this.dependencies = dependencies;
  }

  private file(operationId: string): string {
    if (!identifier.test(operationId)) throw new AgentError('RECOVERY_FENCE');
    const result = path.join(this.root, `${operationId}.database-restore.json`);
    assertWithin(this.root, result);
    return result;
  }

  read(operationId: string): DatabaseRestoreManifest | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(operationId), 'utf8')) as DatabaseRestoreManifest;
      validate(parsed, this.root);
      return Object.freeze(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof AgentError) throw error;
      throw new AgentError('RECOVERY_FENCE');
    }
  }

  scan(): readonly DatabaseRestoreManifest[] {
    try {
      if (!fs.existsSync(this.root)) return Object.freeze([]);
      return Object.freeze(fs.readdirSync(this.root, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.database-restore.json'))
        .map((entry) => this.read(entry.name.slice(0, -'.database-restore.json'.length))!)
        .sort((left, right) => left.operationId.localeCompare(right.operationId)));
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError('RECOVERY_FENCE');
    }
  }

  async publish(manifest: DatabaseRestoreManifest): Promise<DatabaseRestoreManifest> {
    validate(manifest, this.root);
    const existing = this.read(manifest.operationId);
    if (existing) {
      if (identity(existing) !== identity(manifest) || manifest.updatedAt < existing.updatedAt || !transitions[existing.phase].includes(manifest.phase)) throw new AgentError('RECOVERY_FENCE');
    } else if (manifest.phase !== 'intent') throw new AgentError('RECOVERY_FENCE');
    await this.files.mkdir(this.root);
    const target = this.file(manifest.operationId);
    const temporary = path.join(this.root, `.${manifest.operationId}.${hashCanonicalJson({ now: manifest.updatedAt, phase: manifest.phase }).slice(10, 26)}.tmp`);
    assertWithin(this.root, temporary);
    let handle: MaterializationWriteHandle | undefined;
    let renamed = false;
    try {
      handle = await this.files.openExclusive(temporary);
      await handle.writeFile(Buffer.from(`${canonicalizeJson(manifest)}\n`, 'utf8'));
      const flushed = await flushFile(handle);
      if (flushed.status !== 'flushed') throw new AgentError('RECOVERY_FENCE');
      await handle.close(); handle = undefined;
      await this.files.rename(temporary, target); renamed = true;
      await flushRequiredDirectory(this.root, this.dependencies);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (!renamed) await this.files.unlink(temporary).catch(() => undefined);
      throw error;
    }
    return Object.freeze(manifest);
  }

  async ensureIntent(input: Omit<DatabaseRestoreManifest, 'schemaVersion' | 'phase' | 'createdAt' | 'updatedAt'>, now: string): Promise<DatabaseRestoreManifest> {
    const proposed = Object.freeze({ schemaVersion: 1 as const, ...input, phase: 'intent' as const, createdAt: now, updatedAt: now });
    const existing = this.read(input.operationId);
    if (existing) {
      if (identity(existing) !== identity(proposed)) throw new AgentError('IDEMPOTENCY_CONFLICT');
      return existing;
    }
    return this.publish(proposed);
  }

  async advance(manifest: DatabaseRestoreManifest, phase: DatabaseRestorePhase, now: string, extras: Partial<Pick<DatabaseRestoreManifest, 'versionAfter' | 'recoveryDatabasePath' | 'recoveryDatabaseEvidence' | 'liveDatabaseEvidence' | 'reason'>> = {}): Promise<DatabaseRestoreManifest> {
    if (!safeTimestamp(now) || now < manifest.updatedAt || !transitions[manifest.phase].includes(phase)) throw new AgentError('RECOVERY_FENCE');
    return this.publish(Object.freeze({ ...manifest, ...extras, phase, updatedAt: now }));
  }
}

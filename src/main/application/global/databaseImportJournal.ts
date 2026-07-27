import fs from 'node:fs';
import path from 'node:path';
import { AgentError } from '../../../shared/agent/errors';
import type { DataVersion } from '../../../shared/agent/v1/contracts';
import type { CatalogIdentity, OperationName } from '../../../shared/agent/v1/gatewayContracts';
import { canonicalizeJson, hashCanonicalJson } from '../../../shared/agent/v1/gatewaySchemas';
import { defaultDirectoryDurabilityDependencies, flushDirectory, flushFile } from '../../persistence/fileDurability';
import {
  defaultMaterializationFileDependencies,
  type MaterializationDurabilityDependencies,
  type MaterializationFileDependencies,
  type MaterializationWriteHandle
} from './materializationJournal';

export const databaseImportPhases = Object.freeze([
  'intent', 'package_validated', 'recovery_published', 'live_published', 'completed', 'needs_recovery'
] as const);
export type DatabaseImportPhase = typeof databaseImportPhases[number];

export interface DatabaseImportSemanticEvidence {
  readonly contentHash: string;
  readonly contentSize: number;
}

export interface DatabaseImportManifest {
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
  readonly importPayloadHash: string;
  readonly affectedSetHash: string;
  readonly targetHash: string;
  readonly recovery: 'consistency_bundle';
  readonly maxAffectedEntities: number;
  readonly reservationExpiresAt: string;
  readonly reservedAt: string;
  readonly receiptCreatedAt: string;
  readonly package: {
    readonly assetId: string;
    readonly contentHash: string;
    readonly contentSize: number;
    readonly semanticHash: string;
    readonly rowCount: number;
    readonly internalPath: string;
  };
  readonly baseVersion: DataVersion;
  readonly catalog: CatalogIdentity;
  readonly phase: DatabaseImportPhase;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly versionAfter?: DataVersion;
  readonly recoveryDatabasePath?: string;
  readonly recoveryDatabaseEvidence?: DatabaseImportSemanticEvidence;
  readonly liveDatabaseEvidence?: DatabaseImportSemanticEvidence;
  readonly reason?: string;
}

const identifier = /^[A-Za-z0-9_-]{1,200}$/;
const safeClient = /^[A-Za-z0-9._:-]{1,200}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = /^sha256-v1:[0-9a-f]{64}$/;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const transitions: Readonly<Record<DatabaseImportPhase, readonly DatabaseImportPhase[]>> = Object.freeze({
  intent: ['intent', 'package_validated', 'needs_recovery'],
  package_validated: ['package_validated', 'recovery_published', 'needs_recovery'],
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
  if (!path.isAbsolute(root) || path.normalize(root) !== root || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new AgentError('RECOVERY_FENCE');
}

function exactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentError('RECOVERY_FENCE');
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value as Record<string, unknown>).sort();
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => !allowed.has(key))) throw new AgentError('RECOVERY_FENCE');
}

function validateVersion(value: DataVersion | undefined, required: boolean): void {
  if (!required && value === undefined) return;
  exactKeys(value, ['dataEpoch', 'dataRevision']);
  if (!value || typeof value.dataEpoch !== 'string' || value.dataEpoch.length < 1 || !Number.isSafeInteger(value.dataRevision) || value.dataRevision < 0) throw new AgentError('RECOVERY_FENCE');
}

function validateEvidence(value: DatabaseImportSemanticEvidence | undefined): void {
  if (value !== undefined) {
    exactKeys(value, ['contentHash', 'contentSize']);
    if (!hash.test(value.contentHash) || !Number.isSafeInteger(value.contentSize) || value.contentSize < 0) throw new AgentError('RECOVERY_FENCE');
  }
}

function validate(manifest: DatabaseImportManifest, root: string): void {
  exactKeys(manifest, [
    'schemaVersion', 'operationId', 'ownerClientId', 'requestId', 'receiptId', 'receiptOperation', 'receiptPayloadHash', 'risk',
    'reservationId', 'grantId', 'importPayloadHash', 'affectedSetHash', 'targetHash', 'recovery', 'maxAffectedEntities',
    'reservationExpiresAt', 'reservedAt', 'receiptCreatedAt', 'package', 'baseVersion', 'catalog', 'phase', 'createdAt', 'updatedAt'
  ], ['changeSetId', 'versionAfter', 'recoveryDatabasePath', 'recoveryDatabaseEvidence', 'liveDatabaseEvidence', 'reason']);
  exactKeys(manifest.package, ['assetId', 'contentHash', 'contentSize', 'semanticHash', 'rowCount', 'internalPath']);
  exactKeys(manifest.catalog, ['version', 'hash']);
  validateVersion(manifest.baseVersion, true);
  validateVersion(manifest.versionAfter, manifest.phase === 'live_published' || manifest.phase === 'completed');
  validateEvidence(manifest.recoveryDatabaseEvidence);
  validateEvidence(manifest.liveDatabaseEvidence);
  if (manifest.schemaVersion !== 1 || !identifier.test(manifest.operationId) || !safeClient.test(manifest.ownerClientId) ||
      !uuid.test(manifest.requestId) || !uuid.test(manifest.receiptId) || !uuid.test(manifest.reservationId) || !uuid.test(manifest.grantId) ||
      (manifest.receiptOperation !== 'database.replace_from_import' && manifest.receiptOperation !== 'agent.changesets.apply') ||
      (manifest.changeSetId !== undefined && !uuid.test(manifest.changeSetId)) ||
      (manifest.receiptOperation === 'agent.changesets.apply') !== (manifest.changeSetId !== undefined) ||
      !hash.test(manifest.receiptPayloadHash) || !hash.test(manifest.importPayloadHash) || !hash.test(manifest.affectedSetHash) || !hash.test(manifest.targetHash) ||
      manifest.risk !== 'R4' || manifest.recovery !== 'consistency_bundle' || manifest.maxAffectedEntities !== 500 ||
      !safeTimestamp(manifest.reservationExpiresAt) || !safeTimestamp(manifest.reservedAt) || !safeTimestamp(manifest.receiptCreatedAt) ||
      !identifier.test(manifest.package.assetId) || !hash.test(manifest.package.contentHash) || !hash.test(manifest.package.semanticHash) ||
      !Number.isSafeInteger(manifest.package.contentSize) || manifest.package.contentSize < 1 ||
      !Number.isSafeInteger(manifest.package.rowCount) || manifest.package.rowCount < 0 ||
      !path.isAbsolute(manifest.package.internalPath) || path.normalize(manifest.package.internalPath) !== manifest.package.internalPath ||
      !manifest.catalog.version || !hash.test(manifest.catalog.hash) || !databaseImportPhases.includes(manifest.phase) ||
      !safeTimestamp(manifest.createdAt) || !safeTimestamp(manifest.updatedAt) || manifest.updatedAt < manifest.createdAt ||
      (manifest.recoveryDatabasePath !== undefined && (!path.isAbsolute(manifest.recoveryDatabasePath) || path.normalize(manifest.recoveryDatabasePath) !== manifest.recoveryDatabasePath)) ||
      (manifest.reason !== undefined && (typeof manifest.reason !== 'string' || manifest.reason.length > 120))) throw new AgentError('RECOVERY_FENCE');
  const needsRecoveryPackage = manifest.phase === 'recovery_published' || manifest.phase === 'live_published' || manifest.phase === 'completed';
  if (needsRecoveryPackage && (!manifest.recoveryDatabasePath || !manifest.recoveryDatabaseEvidence)) throw new AgentError('RECOVERY_FENCE');
  if ((manifest.phase === 'intent' || manifest.phase === 'package_validated') && (manifest.versionAfter || manifest.recoveryDatabasePath || manifest.recoveryDatabaseEvidence || manifest.liveDatabaseEvidence || manifest.reason)) throw new AgentError('RECOVERY_FENCE');
  if (manifest.phase === 'recovery_published' && (manifest.versionAfter || manifest.liveDatabaseEvidence || manifest.reason)) throw new AgentError('RECOVERY_FENCE');
  if ((manifest.phase === 'live_published' || manifest.phase === 'completed') && (!manifest.versionAfter || !manifest.liveDatabaseEvidence || manifest.reason)) throw new AgentError('RECOVERY_FENCE');
  if (manifest.phase === 'needs_recovery' && manifest.liveDatabaseEvidence && !manifest.versionAfter) throw new AgentError('RECOVERY_FENCE');
  assertWithin(root, path.join(root, `${manifest.operationId}.database-import.json`));
}

function identity(manifest: DatabaseImportManifest): string {
  const { phase: _phase, updatedAt: _updatedAt, versionAfter: _versionAfter, recoveryDatabasePath: _recoveryDatabasePath,
    recoveryDatabaseEvidence: _recoveryDatabaseEvidence, liveDatabaseEvidence: _liveDatabaseEvidence, reason: _reason, ...stable } = manifest;
  return canonicalizeJson(stable);
}

async function flushRequiredDirectory(directory: string, dependencies: MaterializationDurabilityDependencies): Promise<void> {
  const outcome = await flushDirectory(directory, dependencies.directoryDurability ?? defaultDirectoryDurabilityDependencies);
  if (outcome.status === 'failed') throw new AgentError('RECOVERY_FENCE');
}

export class DatabaseImportJournalStore {
  private readonly files: MaterializationFileDependencies;
  private readonly dependencies: MaterializationDurabilityDependencies;

  constructor(readonly root: string, dependencies: MaterializationDurabilityDependencies = {}) {
    if (!path.isAbsolute(root) || path.normalize(root) !== root) throw new Error('Database import journal root must be normalized and absolute');
    this.files = dependencies.files ?? defaultMaterializationFileDependencies;
    this.dependencies = dependencies;
  }

  private file(operationId: string): string {
    if (!identifier.test(operationId)) throw new AgentError('RECOVERY_FENCE');
    const result = path.join(this.root, `${operationId}.database-import.json`);
    assertWithin(this.root, result);
    return result;
  }

  read(operationId: string): DatabaseImportManifest | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(operationId), 'utf8')) as DatabaseImportManifest;
      validate(parsed, this.root);
      return Object.freeze(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof AgentError) throw error;
      throw new AgentError('RECOVERY_FENCE');
    }
  }

  scan(): readonly DatabaseImportManifest[] {
    try {
      if (!fs.existsSync(this.root)) return Object.freeze([]);
      return Object.freeze(fs.readdirSync(this.root, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.database-import.json'))
        .map((entry) => this.read(entry.name.slice(0, -'.database-import.json'.length))!)
        .sort((left, right) => left.operationId.localeCompare(right.operationId)));
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError('RECOVERY_FENCE');
    }
  }

  async publish(manifest: DatabaseImportManifest): Promise<DatabaseImportManifest> {
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

  async ensureIntent(input: Omit<DatabaseImportManifest, 'schemaVersion' | 'phase' | 'createdAt' | 'updatedAt'>, now: string): Promise<DatabaseImportManifest> {
    const proposed = Object.freeze({ schemaVersion: 1 as const, ...input, phase: 'intent' as const, createdAt: now, updatedAt: now });
    const existing = this.read(input.operationId);
    if (existing) {
      if (identity(existing) !== identity(proposed)) throw new AgentError('IDEMPOTENCY_CONFLICT');
      return existing;
    }
    return this.publish(proposed);
  }

  async advance(manifest: DatabaseImportManifest, phase: DatabaseImportPhase, now: string, extras: Partial<Pick<DatabaseImportManifest, 'versionAfter' | 'recoveryDatabasePath' | 'recoveryDatabaseEvidence' | 'liveDatabaseEvidence' | 'reason'>> = {}): Promise<DatabaseImportManifest> {
    if (!safeTimestamp(now) || now < manifest.updatedAt || !transitions[manifest.phase].includes(phase)) throw new AgentError('RECOVERY_FENCE');
    return this.publish(Object.freeze({ ...manifest, ...extras, phase, updatedAt: now }));
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { AgentError } from '../../../shared/agent/errors';
import type { DataVersion, EntityRef } from '../../../shared/agent/v1/contracts';
import type { CatalogIdentity, OperationName } from '../../../shared/agent/v1/gatewayContracts';
import { canonicalizeJson } from '../../../shared/agent/v1/gatewaySchemas';

export const dataRootMigrationPhases = Object.freeze([
  'intent', 'verified', 'copying', 'copied', 'hash_verified', 'candidate_published', 'config_published',
  'runtime_reopened', 'receipt_terminalized', 'completed', 'needs_recovery'
] as const);
export type DataRootMigrationPhase = typeof dataRootMigrationPhases[number];

export interface DataRootMigrationManifest {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly ownerClientId: string;
  readonly requestId: string;
  readonly receiptId: string;
  readonly receiptOperation: OperationName;
  readonly receiptPayloadHash: string;
  readonly migratePayloadHash: string;
  readonly reservationId: string;
  readonly grantId: string;
  readonly changeSetId?: string;
  readonly selectionId: string;
  readonly targetPath: string;
  readonly targetIdentity: string;
  readonly sourcePath: string;
  readonly sourceIdentity: string;
  readonly inventoryHash: string;
  readonly inventoryCount: number;
  readonly inventoryBytes: number;
  readonly requiredBytes: number;
  readonly planningAvailableBytes: number;
  readonly schemaHash: string;
  readonly affectedEntities: readonly EntityRef[];
  readonly affectedSetHash: string;
  readonly targetHash: string;
  readonly selectionBindingHash: string;
  readonly baseVersion: DataVersion;
  readonly catalog: CatalogIdentity;
  readonly recovery: 'consistency_bundle';
  readonly maxAffectedEntities: 500;
  readonly reservationExpiresAt: string;
  readonly reservedAt: string;
  readonly receiptCreatedAt: string;
  readonly phase: DataRootMigrationPhase;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly versionAfter?: DataVersion;
  readonly reason?: string;
}

const id = /^[A-Za-z0-9_-]{1,200}$/;
const hash = /^sha256-v1:[0-9a-f]{64}$/;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const transitions: Readonly<Record<DataRootMigrationPhase, readonly DataRootMigrationPhase[]>> = Object.freeze({
  intent: ['intent', 'verified', 'needs_recovery'], verified: ['verified', 'copying', 'needs_recovery'],
  copying: ['copying', 'copied', 'needs_recovery'], copied: ['copied', 'hash_verified', 'needs_recovery'],
  hash_verified: ['hash_verified', 'candidate_published', 'needs_recovery'],
  candidate_published: ['candidate_published', 'config_published', 'needs_recovery'],
  config_published: ['config_published', 'runtime_reopened', 'needs_recovery'],
  runtime_reopened: ['runtime_reopened', 'receipt_terminalized', 'needs_recovery'],
  receipt_terminalized: ['receipt_terminalized', 'completed', 'needs_recovery'], completed: ['completed'], needs_recovery: ['needs_recovery']
});

function validTimestamp(value: unknown): value is string { return typeof value === 'string' && timestamp.test(value) && new Date(value).toISOString() === value; }
function validate(manifest: DataRootMigrationManifest): void {
  const required = ['schemaVersion','operationId','ownerClientId','requestId','receiptId','receiptOperation','receiptPayloadHash','migratePayloadHash',
    'reservationId','grantId','selectionId','targetPath','targetIdentity','sourcePath','sourceIdentity','inventoryHash','inventoryCount','inventoryBytes',
    'requiredBytes','planningAvailableBytes','schemaHash','affectedEntities','affectedSetHash','targetHash','selectionBindingHash','baseVersion','catalog',
    'recovery','maxAffectedEntities','reservationExpiresAt','reservedAt','receiptCreatedAt','phase','createdAt','updatedAt'];
  const allowed = new Set([...required, 'changeSetId', 'versionAfter', 'reason']);
  if (!manifest || typeof manifest !== 'object' || required.some((key) => !(key in manifest)) || Object.keys(manifest).some((key) => !allowed.has(key)) ||
      manifest.schemaVersion !== 1 || !id.test(manifest.operationId) || !id.test(manifest.selectionId) || !path.isAbsolute(manifest.targetPath) ||
      path.normalize(manifest.targetPath) !== manifest.targetPath || !path.isAbsolute(manifest.sourcePath) || path.normalize(manifest.sourcePath) !== manifest.sourcePath ||
      !hash.test(manifest.targetIdentity) || !hash.test(manifest.sourceIdentity) || !hash.test(manifest.inventoryHash) || !hash.test(manifest.schemaHash) ||
      !hash.test(manifest.affectedSetHash) || !hash.test(manifest.targetHash) || !hash.test(manifest.selectionBindingHash) || !hash.test(manifest.receiptPayloadHash) ||
      !hash.test(manifest.migratePayloadHash) || !Array.isArray(manifest.affectedEntities) || manifest.affectedEntities.length > 500 ||
      !Number.isSafeInteger(manifest.inventoryCount) || manifest.inventoryCount < 0 || !Number.isSafeInteger(manifest.inventoryBytes) || manifest.inventoryBytes < 0 ||
      !Number.isSafeInteger(manifest.requiredBytes) || manifest.requiredBytes < 0 || !Number.isSafeInteger(manifest.planningAvailableBytes) || manifest.planningAvailableBytes < 0 ||
      manifest.recovery !== 'consistency_bundle' || manifest.maxAffectedEntities !== 500 || !dataRootMigrationPhases.includes(manifest.phase) ||
      !validTimestamp(manifest.createdAt) || !validTimestamp(manifest.updatedAt) || !validTimestamp(manifest.reservationExpiresAt) ||
      !validTimestamp(manifest.reservedAt) || !validTimestamp(manifest.receiptCreatedAt)) throw new AgentError('RECOVERY_FENCE');
}

function identity(manifest: DataRootMigrationManifest): string {
  const { phase: _p, updatedAt: _u, versionAfter: _v, reason: _r, ...stable } = manifest;
  return canonicalizeJson(stable);
}

export class DataRootMigrationJournalStore {
  constructor(readonly root: string) {
    if (!path.isAbsolute(root) || path.normalize(root) !== root) throw new Error('Data-root migration journal root must be normalized and absolute');
  }
  private file(operationId: string): string {
    if (!id.test(operationId)) throw new AgentError('RECOVERY_FENCE');
    return path.join(this.root, `${operationId}.data-root-migration.json`);
  }
  read(operationId: string): DataRootMigrationManifest | undefined {
    try { const value = JSON.parse(fs.readFileSync(this.file(operationId), 'utf8')) as DataRootMigrationManifest; validate(value); return Object.freeze(value); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; if (error instanceof AgentError) throw error; throw new AgentError('RECOVERY_FENCE'); }
  }
  scan(): readonly DataRootMigrationManifest[] {
    if (!fs.existsSync(this.root)) return Object.freeze([]);
    try { return Object.freeze(fs.readdirSync(this.root, { withFileTypes: true }).filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.data-root-migration.json'))
      .map((entry) => this.read(entry.name.slice(0, -'.data-root-migration.json'.length))!).sort((a, b) => a.operationId.localeCompare(b.operationId))); }
    catch (error) { if (error instanceof AgentError) throw error; throw new AgentError('RECOVERY_FENCE'); }
  }
  publish(manifest: DataRootMigrationManifest): DataRootMigrationManifest {
    validate(manifest);
    const existing = this.read(manifest.operationId);
    if (existing && (identity(existing) !== identity(manifest) || !transitions[existing.phase].includes(manifest.phase))) throw new AgentError('RECOVERY_FENCE');
    if (!existing && manifest.phase !== 'intent') throw new AgentError('RECOVERY_FENCE');
    fs.mkdirSync(this.root, { recursive: true });
    const target = this.file(manifest.operationId);
    const temporary = path.join(this.root, `.${manifest.operationId}.${process.pid}.tmp`);
    const handle = fs.openSync(temporary, 'wx');
    try { fs.writeFileSync(handle, `${canonicalizeJson(manifest)}\n`, 'utf8'); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    fs.renameSync(temporary, target);
    try { const directory = fs.openSync(this.root, 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); } } catch { /* unsupported on some Windows filesystems */ }
    return Object.freeze(manifest);
  }
  ensureIntent(input: Omit<DataRootMigrationManifest, 'schemaVersion'|'phase'|'createdAt'|'updatedAt'>, now: string): DataRootMigrationManifest {
    const proposed = Object.freeze({ schemaVersion: 1 as const, ...input, phase: 'intent' as const, createdAt: now, updatedAt: now });
    const existing = this.read(input.operationId); if (existing) { if (identity(existing) !== identity(proposed)) throw new AgentError('IDEMPOTENCY_CONFLICT'); return existing; }
    return this.publish(proposed);
  }
  advance(manifest: DataRootMigrationManifest, phase: DataRootMigrationPhase, now: string, extras: Partial<Pick<DataRootMigrationManifest,'versionAfter'|'reason'>> = {}): DataRootMigrationManifest {
    if (!transitions[manifest.phase].includes(phase) || !validTimestamp(now) || now < manifest.updatedAt) throw new AgentError('RECOVERY_FENCE');
    return this.publish(Object.freeze({ ...manifest, ...extras, phase, updatedAt: now }));
  }
}

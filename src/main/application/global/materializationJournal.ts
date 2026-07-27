import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AgentError } from '../../../shared/agent/errors';
import { canonicalizeJson, hashCanonicalJson } from '../../../shared/agent/v1/gatewaySchemas';
import { defaultDirectoryDurabilityDependencies, flushDirectory, flushFile, type DirectoryDurabilityDependencies, type DurabilityHandle, type DurabilityOutcome } from '../../persistence/fileDurability';

export const materializationPhases = Object.freeze([
  'intent', 'staged_file_written', 'staged_evidence_persisted', 'final_file_published',
  'published_evidence_persisted', 'terminal_receipt_persisted', 'job_terminalized', 'needs_recovery'
] as const);
export type MaterializationPhase = typeof materializationPhases[number];
export interface MaterializationEvidence { readonly hash: string; readonly size: number; }
export interface MaterializationManifest {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly assetId: string;
  readonly jobId: string;
  readonly requestId: string;
  readonly ownerClientId: string;
  readonly sessionId: string;
  readonly kind: 'backup' | 'export';
  readonly expectedVersion: { readonly dataEpoch: string; readonly dataRevision: number };
  readonly metadataHash: string;
  readonly stagedPath: string;
  readonly finalPath: string;
  readonly quarantinePath: string;
  readonly phase: MaterializationPhase;
  readonly evidence?: MaterializationEvidence;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reason?: string;
}

export interface MaterializationWriteHandle extends DurabilityHandle {
  writeFile(data: Uint8Array): Promise<void>;
}

export interface MaterializationFileDependencies {
  mkdir(directoryPath: string): Promise<void>;
  openExclusive(filePath: string): Promise<MaterializationWriteHandle>;
  openRead(filePath: string): Promise<DurabilityHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
}

export interface MaterializationDurabilityDependencies {
  files?: MaterializationFileDependencies;
  directoryDurability?: DirectoryDurabilityDependencies;
  randomId?: () => string;
}

const operationId = /^[A-Za-z0-9_-]{1,200}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = /^sha256-v1:[0-9a-f]{64}$/;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const transitions: Readonly<Record<MaterializationPhase, readonly MaterializationPhase[]>> = Object.freeze({
  intent: ['intent', 'staged_file_written', 'needs_recovery'],
  staged_file_written: ['staged_file_written', 'staged_evidence_persisted', 'needs_recovery'],
  staged_evidence_persisted: ['staged_evidence_persisted', 'final_file_published', 'needs_recovery'],
  final_file_published: ['final_file_published', 'published_evidence_persisted', 'needs_recovery'],
  published_evidence_persisted: ['published_evidence_persisted', 'terminal_receipt_persisted', 'needs_recovery'],
  terminal_receipt_persisted: ['terminal_receipt_persisted', 'job_terminalized', 'needs_recovery'],
  job_terminalized: ['job_terminalized'], needs_recovery: ['needs_recovery']
});

function assertWithin(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (!path.isAbsolute(root) || path.normalize(root) !== root || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new AgentError('RECOVERY_FENCE');
  }
}

function safeTimestamp(value: string): boolean { return timestamp.test(value) && new Date(value).toISOString() === value; }

function validate(manifest: MaterializationManifest, journalRoot: string, managedRoots: readonly string[]): void {
  if (manifest.schemaVersion !== 1 || !operationId.test(manifest.operationId) || !operationId.test(manifest.assetId) || !uuid.test(manifest.jobId) || !uuid.test(manifest.requestId) ||
      !operationId.test(manifest.ownerClientId) || !uuid.test(manifest.sessionId) || !['backup', 'export'].includes(manifest.kind) || !hash.test(manifest.metadataHash) ||
      !materializationPhases.includes(manifest.phase) || !safeTimestamp(manifest.createdAt) || !safeTimestamp(manifest.updatedAt) || manifest.updatedAt < manifest.createdAt ||
      !manifest.expectedVersion.dataEpoch || !Number.isSafeInteger(manifest.expectedVersion.dataRevision) || manifest.expectedVersion.dataRevision < 0) throw new AgentError('RECOVERY_FENCE');
  if (!managedRoots.some((root) => { try { assertWithin(root, manifest.stagedPath); return true; } catch { return false; } }) ||
      !managedRoots.some((root) => { try { assertWithin(root, manifest.finalPath); return true; } catch { return false; } }) ||
      !managedRoots.some((root) => { try { assertWithin(root, manifest.quarantinePath); return true; } catch { return false; } })) throw new AgentError('RECOVERY_FENCE');
  assertWithin(journalRoot, path.join(journalRoot, `${manifest.operationId}.materialization.json`));
  if (new Set([manifest.stagedPath, manifest.finalPath, manifest.quarantinePath].map((entry) => path.resolve(entry).toLowerCase())).size !== 3) throw new AgentError('RECOVERY_FENCE');
  if (manifest.evidence && (!hash.test(manifest.evidence.hash) || !Number.isSafeInteger(manifest.evidence.size) || manifest.evidence.size < 0)) throw new AgentError('RECOVERY_FENCE');
  if (manifest.reason !== undefined && (typeof manifest.reason !== 'string' || manifest.reason.length > 120)) throw new AgentError('RECOVERY_FENCE');
}

function identity(manifest: MaterializationManifest): string {
  const { phase: _phase, evidence: _evidence, createdAt: _createdAt, updatedAt: _updatedAt, reason: _reason, ...stable } = manifest;
  return canonicalizeJson(stable);
}

function durabilityFailure(_outcome: DurabilityOutcome): never {
  throw new AgentError('RECOVERY_FENCE');
}

async function flushRequiredDirectory(directory: string, dependencies: MaterializationDurabilityDependencies): Promise<void> {
  const outcome = await flushDirectory(directory, dependencies.directoryDurability ?? defaultDirectoryDurabilityDependencies);
  if (outcome.status !== 'flushed') durabilityFailure(outcome);
}

export async function flushMaterializationFile(filePath: string, dependencies: MaterializationDurabilityDependencies = {}): Promise<void> {
  const handle = await (dependencies.files ?? defaultMaterializationFileDependencies).openRead(filePath);
  try {
    const outcome = await flushFile(handle);
    if (outcome.status !== 'flushed') durabilityFailure(outcome);
  } finally {
    await handle.close().catch(() => undefined);
  }
  await flushRequiredDirectory(path.dirname(filePath), dependencies);
}

/** Renames only into an absent App-owned target and flushes every changed directory. */
export async function publishMaterializationFile(from: string, to: string, dependencies: MaterializationDurabilityDependencies = {}): Promise<void> {
  const files = dependencies.files ?? defaultMaterializationFileDependencies;
  await flushMaterializationFile(from, dependencies);
  await files.mkdir(path.dirname(to));
  try { await fs.promises.lstat(to); throw new AgentError('RECOVERY_FENCE'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await files.rename(from, to);
  await flushRequiredDirectory(path.dirname(to), dependencies);
  if (path.dirname(from) !== path.dirname(to)) await flushRequiredDirectory(path.dirname(from), dependencies);
}

/** Quarantine never overwrites prior evidence; an occupied target is an ambiguity fence. */
export async function quarantineMaterializationFile(from: string, to: string, dependencies: MaterializationDurabilityDependencies = {}): Promise<void> {
  const files = dependencies.files ?? defaultMaterializationFileDependencies;
  await files.mkdir(path.dirname(to));
  try { await fs.promises.lstat(to); throw new AgentError('RECOVERY_FENCE'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await files.rename(from, to);
  await flushRequiredDirectory(path.dirname(to), dependencies);
  if (path.dirname(from) !== path.dirname(to)) await flushRequiredDirectory(path.dirname(from), dependencies);
}

export async function removeMaterializationFile(filePath: string, dependencies: MaterializationDurabilityDependencies = {}): Promise<void> {
  const files = dependencies.files ?? defaultMaterializationFileDependencies;
  await files.unlink(filePath);
  await flushRequiredDirectory(path.dirname(filePath), dependencies);
}

export function materializationEvidence(filePath: string): MaterializationEvidence {
  const bytes = fs.readFileSync(filePath);
  return Object.freeze({ hash: `sha256-v1:${createHash('sha256').update(bytes).digest('hex')}`, size: bytes.length });
}

export class MaterializationJournalStore {
  readonly managedRoots: readonly string[];
  private readonly files: MaterializationFileDependencies;
  private readonly dependencies: MaterializationDurabilityDependencies;
  private readonly randomId: () => string;
  constructor(readonly root: string, managedRoots: readonly string[] = [root], dependencies: MaterializationDurabilityDependencies = {}) {
    if (!path.isAbsolute(root) || path.normalize(root) !== root) throw new Error('Materialization journal root must be normalized and absolute');
    if (managedRoots.length === 0) throw new Error('Materialization managed roots are required');
    this.managedRoots = Object.freeze(managedRoots.map((entry) => {
      if (!path.isAbsolute(entry) || path.normalize(entry) !== entry) throw new Error('Materialization managed root must be normalized and absolute');
      return entry;
    }));
    this.files = dependencies.files ?? defaultMaterializationFileDependencies;
    this.dependencies = dependencies;
    this.randomId = dependencies.randomId ?? randomUUID;
  }

  private file(operation: string): string { const result = path.join(this.root, `${operation}.materialization.json`); assertWithin(this.root, result); return result; }

  read(operation: string): MaterializationManifest | undefined {
    if (!operationId.test(operation)) throw new AgentError('RECOVERY_FENCE');
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(operation), 'utf8')) as MaterializationManifest;
      validate(parsed, this.root, this.managedRoots);
      return Object.freeze(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof AgentError) throw error;
      throw new AgentError('RECOVERY_FENCE');
    }
  }

  scan(): readonly MaterializationManifest[] {
    try {
      if (!fs.existsSync(this.root)) return Object.freeze([]);
      const manifests: MaterializationManifest[] = [];
      for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
        if (!entry.name.endsWith('.materialization.json') || entry.isSymbolicLink() || !entry.isFile()) continue;
        manifests.push(this.read(entry.name.slice(0, -'.materialization.json'.length))!);
      }
      return Object.freeze(manifests.sort((left, right) => left.operationId.localeCompare(right.operationId)));
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError('RECOVERY_FENCE');
    }
  }

  async publish(manifest: MaterializationManifest): Promise<MaterializationManifest> {
    validate(manifest, this.root, this.managedRoots);
    const existing = this.read(manifest.operationId);
    if (existing) {
      if (identity(existing) !== identity(manifest) || manifest.updatedAt < existing.updatedAt || !transitions[existing.phase].includes(manifest.phase)) throw new AgentError('RECOVERY_FENCE');
    } else if (manifest.phase !== 'intent') throw new AgentError('RECOVERY_FENCE');
    await this.files.mkdir(this.root);
    const target = this.file(manifest.operationId);
    const nonce = this.randomId().replace(/[^A-Za-z0-9_-]/g, '');
    if (!nonce) throw new AgentError('RECOVERY_FENCE');
    const temporary = path.join(this.root, `.${manifest.operationId}.${nonce}.tmp`);
    assertWithin(this.root, temporary);
    let handle: MaterializationWriteHandle | undefined;
    let renamed = false;
    try {
      handle = await this.files.openExclusive(temporary);
      await handle.writeFile(Buffer.from(`${canonicalizeJson(manifest)}\n`, 'utf8'));
      const fileFlush = await flushFile(handle);
      if (fileFlush.status !== 'flushed') durabilityFailure(fileFlush);
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

  async advance(manifest: MaterializationManifest, phase: MaterializationPhase, now: string, evidence?: MaterializationEvidence, reason?: string): Promise<MaterializationManifest> {
    if (!safeTimestamp(now) || now < manifest.updatedAt) throw new AgentError('RECOVERY_FENCE');
    if (!transitions[manifest.phase].includes(phase)) throw new AgentError('RECOVERY_FENCE');
    return this.publish(Object.freeze({ ...manifest, phase, ...(evidence ? { evidence: Object.freeze(evidence) } : {}), ...(reason ? { reason } : {}), updatedAt: now }));
  }

  async ensureIntent(input: Omit<MaterializationManifest, 'schemaVersion' | 'phase' | 'createdAt' | 'updatedAt'>, now: string): Promise<MaterializationManifest> {
    const proposed: MaterializationManifest = Object.freeze({ schemaVersion: 1, ...input, phase: 'intent', createdAt: now, updatedAt: now });
    const existing = this.read(input.operationId);
    if (existing) {
      if (identity(existing) !== identity(proposed)) throw new AgentError('IDEMPOTENCY_CONFLICT');
      return existing;
    }
    return this.publish(proposed);
  }
}

export const defaultMaterializationFileDependencies: MaterializationFileDependencies = {
  async mkdir(directoryPath) { await fs.promises.mkdir(directoryPath, { recursive: true }); },
  async openExclusive(filePath) { return fs.promises.open(filePath, 'wx'); },
  async openRead(filePath) { return fs.promises.open(filePath, 'r+'); },
  async rename(from, to) { await fs.promises.rename(from, to); },
  async unlink(filePath) { await fs.promises.unlink(filePath); }
};

export function materializationMetadataHash(metadata: Readonly<Record<string, unknown>>): string { return hashCanonicalJson(metadata); }

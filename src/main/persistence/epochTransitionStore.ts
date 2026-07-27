import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DataVersion } from '../../shared/agent';
import {
  defaultDirectoryDurabilityDependencies,
  flushDirectory,
  type DirectoryDurabilityDependencies
} from './fileDurability';
import type { CommittedEpochTransition } from './recoveryState';

export interface EpochTransitionEvidence extends CommittedEpochTransition {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly operationId: string;
  readonly livePath: string;
  readonly fromVersion: DataVersion;
  readonly toVersion: DataVersion;
  readonly createdAt: string;
}

export interface EpochTransitionStoreDependencies {
  randomId?: () => string;
  directoryDurability?: DirectoryDurabilityDependencies;
}

function safeId(value: string, field: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function assertVersion(version: DataVersion, field: string): void {
  if (typeof version.dataEpoch !== 'string' || version.dataEpoch.length === 0 || version.dataEpoch.length > 200 ||
    !Number.isSafeInteger(version.dataRevision) || version.dataRevision < 0) throw new Error(`${field} is invalid`);
}

function validateEvidence(value: unknown): asserts value is EpochTransitionEvidence {
  if (!value || typeof value !== 'object') throw new Error('Epoch transition evidence must be an object');
  const allowedKeys = new Set(['schemaVersion', 'instanceId', 'operationId', 'livePath', 'fromVersion', 'toVersion', 'createdAt', 'fromEpoch', 'toEpoch']);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new Error('Epoch transition evidence contains unknown fields');
  const evidence = value as Partial<EpochTransitionEvidence>;
  if (evidence.schemaVersion !== 1) throw new Error('Epoch transition evidence schemaVersion is invalid');
  safeId(evidence.instanceId ?? '', 'instanceId');
  safeId(evidence.operationId ?? '', 'operationId');
  if (typeof evidence.livePath !== 'string' || !path.isAbsolute(evidence.livePath) || path.normalize(evidence.livePath) !== evidence.livePath) throw new Error('Epoch transition evidence livePath is invalid');
  if (!evidence.fromVersion || !evidence.toVersion) throw new Error('Epoch transition evidence versions are required');
  assertVersion(evidence.fromVersion, 'fromVersion');
  assertVersion(evidence.toVersion, 'toVersion');
  if (evidence.fromVersion.dataEpoch === evidence.toVersion.dataEpoch || evidence.fromEpoch !== evidence.fromVersion.dataEpoch ||
    evidence.toEpoch !== evidence.toVersion.dataEpoch || evidence.toVersion.dataRevision !== 0 ||
    typeof evidence.createdAt !== 'string' || !Number.isFinite(Date.parse(evidence.createdAt))) throw new Error('Epoch transition evidence is inconsistent');
}

export function createEpochTransitionEvidence(input: Omit<EpochTransitionEvidence, 'schemaVersion' | 'fromEpoch' | 'toEpoch'>): EpochTransitionEvidence {
  const evidence: EpochTransitionEvidence = {
    schemaVersion: 1,
    ...input,
    livePath: path.normalize(input.livePath),
    fromEpoch: input.fromVersion.dataEpoch,
    toEpoch: input.toVersion.dataEpoch
  };
  validateEvidence(evidence);
  return Object.freeze(evidence);
}

export class EpochTransitionStore {
  readonly root: string;
  private readonly randomId: () => string;
  private readonly directoryDurability: DirectoryDurabilityDependencies;

  constructor(root: string, dependencies: EpochTransitionStoreDependencies = {}) {
    if (!path.isAbsolute(root) || path.normalize(root) !== root) throw new Error('Epoch transition root must be a normalized absolute path');
    this.root = root;
    this.randomId = dependencies.randomId ?? crypto.randomUUID;
    this.directoryDurability = dependencies.directoryDurability ?? defaultDirectoryDurabilityDependencies;
  }

  private evidencePath(operationId: string): string {
    return path.join(this.root, `${safeId(operationId, 'operationId')}.transition.json`);
  }

  async publish(evidence: EpochTransitionEvidence): Promise<void> {
    validateEvidence(evidence);
    const target = this.evidencePath(evidence.operationId);
    await fs.promises.mkdir(this.root, { recursive: true });
    const temporary = path.join(this.root, `.${evidence.operationId}.${safeId(this.randomId(), 'transition nonce')}.tmp`);
    const handle = await fs.promises.open(temporary, 'wx');
    try {
      await handle.writeFile(Buffer.from(`${JSON.stringify(evidence)}\n`, 'utf8'));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.promises.rename(temporary, target);
      const directoryFlush = await flushDirectory(this.root, this.directoryDurability);
      if (directoryFlush.status === 'failed') throw directoryFlush.error;
    } catch (error) {
      await fs.promises.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async transitionsFor(livePath: string): Promise<EpochTransitionEvidence[]> {
    const normalizedLivePath = path.normalize(livePath);
    let entries: string[];
    try {
      entries = await fs.promises.readdir(this.root);
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
    const transitions: EpochTransitionEvidence[] = [];
    for (const entry of entries.filter((name) => name.endsWith('.transition.json')).sort()) {
      const evidence = JSON.parse(await fs.promises.readFile(path.join(this.root, entry), 'utf8')) as unknown;
      validateEvidence(evidence);
      if (entry !== `${evidence.operationId}.transition.json`) throw new Error('Epoch transition filename does not match operationId');
      if (evidence.livePath === normalizedLivePath) transitions.push(evidence);
    }
    return transitions;
  }

  async consume(operationId: string): Promise<void> {
    try {
      await fs.promises.unlink(this.evidencePath(operationId));
      const directoryFlush = await flushDirectory(this.root, this.directoryDurability);
      if (directoryFlush.status === 'failed') throw directoryFlush.error;
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
  }
}

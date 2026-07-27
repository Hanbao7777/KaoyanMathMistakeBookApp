import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  defaultDirectoryDurabilityDependencies,
  flushDirectory,
  flushFile,
  type DirectoryDurabilityDependencies,
  type DurabilityHandle
} from '../fileDurability';
import {
  assertLegalOperationTransition,
  assertPathConfined,
  validateOperationManifest,
  type OperationManifest
} from './types';

export const manifestPublishStages = [
  'beforeTempOpen',
  'afterTempOpen',
  'afterTempWrite',
  'afterTempFlush',
  'afterRename',
  'afterDirectoryFlush'
] as const;

export type ManifestPublishStage = (typeof manifestPublishStages)[number];

export interface ManifestFileHandle extends DurabilityHandle {
  writeFile(data: Uint8Array): Promise<void>;
}

export interface ManifestFileDependencies {
  mkdir(directoryPath: string): Promise<void>;
  openExclusive(filePath: string): Promise<ManifestFileHandle>;
  readFile(filePath: string): Promise<Uint8Array>;
  realpath(filePath: string): Promise<string>;
  readdir(directoryPath: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
}

export interface ManifestStoreDependencies {
  files?: ManifestFileDependencies;
  directoryDurability?: DirectoryDurabilityDependencies;
  randomId?: () => string;
  hook?: (stage: ManifestPublishStage, manifest: OperationManifest, tempPath?: string) => void | Promise<void>;
}

export interface ManifestScanIssue {
  path: string;
  code: 'malformed_manifest' | 'manifest_read_failed';
  error: unknown;
}

export interface ManifestScanResult {
  manifests: OperationManifest[];
  issues: ManifestScanIssue[];
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function safeOperationId(operationId: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(operationId)) throw new Error('operationId is not safe for a manifest filename');
  return operationId;
}

function parseManifest(bytes: Uint8Array): OperationManifest {
  const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  validateOperationManifest(value);
  return value;
}

function immutableIdentity(manifest: OperationManifest): string {
  return JSON.stringify({
    manifestVersion: manifest.manifestVersion,
    schemaVersion: manifest.schemaVersion,
    operationId: manifest.operationId,
    requestId: manifest.requestId,
    commandType: manifest.commandType,
    source: manifest.source,
    clientId: manifest.clientId,
    traceId: manifest.traceId,
    inputHash: manifest.inputHash,
    storage: manifest.storage,
    versionBefore: manifest.versionBefore,
    versionAfter: manifest.versionAfter,
    affectedEntities: manifest.affectedEntities,
    roots: manifest.roots,
    files: manifest.files.map(({ status: _status, ...file }) => file),
    compensation: manifest.compensation,
    createdAt: manifest.createdAt
  });
}

function isSameOrDescendant(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export class OperationManifestStore {
  readonly root: string;
  private readonly files: ManifestFileDependencies;
  private readonly directoryDurability: DirectoryDurabilityDependencies;
  private readonly randomId: () => string;
  private readonly hook?: ManifestStoreDependencies['hook'];

  constructor(root: string, dependencies: ManifestStoreDependencies = {}) {
    if (!path.isAbsolute(root) || path.normalize(root) !== root) throw new Error('Manifest root must be a normalized absolute path');
    this.root = root;
    this.files = dependencies.files ?? defaultManifestFileDependencies;
    this.directoryDurability = dependencies.directoryDurability ?? defaultDirectoryDurabilityDependencies;
    this.randomId = dependencies.randomId ?? crypto.randomUUID;
    this.hook = dependencies.hook;
  }

  manifestPath(operationId: string): string {
    const result = path.join(this.root, `${safeOperationId(operationId)}.operation.json`);
    assertPathConfined(result, [this.root], 'manifestPath');
    return result;
  }

  async read(operationId: string): Promise<OperationManifest | null> {
    try {
      return parseManifest(await this.files.readFile(this.manifestPath(operationId)));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
  }

  async publish(manifest: OperationManifest): Promise<void> {
    validateOperationManifest(manifest);
    if (manifest.roots.manifestRoot !== this.root) throw new Error('Manifest root does not match its store');
    const manifestPath = this.manifestPath(manifest.operationId);
    const existing = await this.read(manifest.operationId);
    if (existing) {
      if (immutableIdentity(existing) !== immutableIdentity(manifest)) throw new Error('Operation manifest identity is immutable');
      assertLegalOperationTransition(existing.state, manifest.state);
      if (Date.parse(manifest.updatedAt) < Date.parse(existing.updatedAt)) throw new Error('Operation manifest timestamp cannot move backwards');
    } else if (manifest.state !== 'prepared') {
      throw new Error('A new operation manifest must begin in prepared state');
    }

    await this.files.mkdir(this.root);
    const canonicalManifestRoot = await this.files.realpath(this.root);
    const canonicalManagedRoots = await Promise.all(manifest.roots.managedRoots.map((root) => this.files.realpath(root)));
    const overlapsManagedRoot = canonicalManagedRoots.some((root) =>
      isSameOrDescendant(canonicalManifestRoot, root) || isSameOrDescendant(root, canonicalManifestRoot)
    );
    if (manifest.storage === 'data_root' && !canonicalManagedRoots.some((root) => isSameOrDescendant(canonicalManifestRoot, root))) {
      throw new Error('Data-root manifest store escapes managed roots through a symbolic link');
    }
    if (manifest.storage === 'external_recovery' && overlapsManagedRoot) {
      throw new Error('External recovery manifest store overlaps managed roots through a symbolic link');
    }
    const nonce = this.randomId().replace(/[^A-Za-z0-9_-]/g, '');
    if (!nonce) throw new Error('Manifest temp nonce is invalid');
    const tempPath = path.join(this.root, `.${safeOperationId(manifest.operationId)}.${nonce}.tmp`);
    assertPathConfined(tempPath, [this.root], 'manifestTempPath');
    let handle: ManifestFileHandle | undefined;
    let renamed = false;
    try {
      await this.hook?.('beforeTempOpen', manifest, tempPath);
      handle = await this.files.openExclusive(tempPath);
      await this.hook?.('afterTempOpen', manifest, tempPath);
      await handle.writeFile(Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8'));
      await this.hook?.('afterTempWrite', manifest, tempPath);
      const fileFlush = await flushFile(handle);
      if (fileFlush.status !== 'flushed') throw fileFlush.status === 'failed' ? fileFlush.error : new Error('Manifest file flush unsupported');
      await this.hook?.('afterTempFlush', manifest, tempPath);
      await handle.close();
      handle = undefined;
      await this.files.rename(tempPath, manifestPath);
      renamed = true;
      await this.hook?.('afterRename', manifest, tempPath);
      const directoryFlush = await flushDirectory(this.root, this.directoryDurability);
      if (directoryFlush.status === 'failed') throw directoryFlush.error;
      await this.hook?.('afterDirectoryFlush', manifest, tempPath);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (!renamed) await this.files.unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  async scan(): Promise<ManifestScanResult> {
    let names: string[];
    try {
      names = await this.files.readdir(this.root);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { manifests: [], issues: [] };
      return { manifests: [], issues: [{ path: this.root, code: 'manifest_read_failed', error }] };
    }
    const manifests: OperationManifest[] = [];
    const issues: ManifestScanIssue[] = [];
    for (const name of names.filter((entry) => entry.endsWith('.operation.json')).sort()) {
      const manifestPath = path.join(this.root, name);
      try {
        const manifest = parseManifest(await this.files.readFile(manifestPath));
        if (name !== `${manifest.operationId}.operation.json`) throw new Error('Manifest filename does not match operationId');
        manifests.push(manifest);
      } catch (error) {
        issues.push({ path: manifestPath, code: 'malformed_manifest', error });
      }
    }
    return { manifests, issues };
  }
}

export const defaultManifestFileDependencies: ManifestFileDependencies = {
  async mkdir(directoryPath) {
    await fs.promises.mkdir(directoryPath, { recursive: true });
  },
  async openExclusive(filePath) {
    return fs.promises.open(filePath, 'wx');
  },
  async readFile(filePath) {
    return fs.promises.readFile(filePath);
  },
  async realpath(filePath) {
    return fs.promises.realpath(filePath);
  },
  async readdir(directoryPath) {
    return fs.promises.readdir(directoryPath);
  },
  async rename(from, to) {
    await fs.promises.rename(from, to);
  },
  async unlink(filePath) {
    await fs.promises.unlink(filePath);
  }
};

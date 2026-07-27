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
  assertPathConfined,
  assertSameVolume,
  type FileEvidence,
  type OperationFile,
  type OperationManifest
} from './types';

export interface JournalWriteHandle extends DurabilityHandle {
  writeFile(data: Uint8Array): Promise<void>;
}

export interface JournalFileDependencies {
  mkdir(directoryPath: string): Promise<void>;
  openExclusive(filePath: string): Promise<JournalWriteHandle>;
  readFile(filePath: string): Promise<Uint8Array>;
  realpath(filePath: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
}

export interface JournalIoDependencies {
  files?: JournalFileDependencies;
  directoryDurability?: DirectoryDurabilityDependencies;
}

export type FileInspection =
  | { status: 'missing' }
  | { status: 'match'; evidence: FileEvidence }
  | { status: 'mismatch'; evidence: FileEvidence };

export class OperationFileError extends Error {
  readonly code: string;
  readonly fileId: string;
  readonly phase: string;

  constructor(code: string, fileId: string, phase: string, message: string) {
    super(message);
    this.name = 'OperationFileError';
    this.code = code;
    this.fileId = fileId;
    this.phase = phase;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function sameEvidence(left: FileEvidence, right: FileEvidence): boolean {
  return left.sha256 === right.sha256 && left.size === right.size;
}

export function evidenceForBytes(bytes: Uint8Array): FileEvidence {
  return {
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength
  };
}

export async function inspectFile(
  filePath: string,
  expected: FileEvidence,
  dependencies: JournalIoDependencies = {}
): Promise<FileInspection> {
  const files = dependencies.files ?? defaultJournalFileDependencies;
  try {
    const evidence = evidenceForBytes(await files.readFile(filePath));
    return sameEvidence(evidence, expected) ? { status: 'match', evidence } : { status: 'mismatch', evidence };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { status: 'missing' };
    throw error;
  }
}

async function flushRequiredDirectory(directoryPath: string, dependencies: JournalIoDependencies): Promise<void> {
  const outcome = await flushDirectory(directoryPath, dependencies.directoryDurability ?? defaultDirectoryDurabilityDependencies);
  if (outcome.status === 'failed') throw outcome.error;
}

async function durableWriteExclusive(
  filePath: string,
  bytes: Uint8Array,
  dependencies: JournalIoDependencies
): Promise<void> {
  const files = dependencies.files ?? defaultJournalFileDependencies;
  await files.mkdir(path.dirname(filePath));
  let handle: JournalWriteHandle | undefined;
  try {
    handle = await files.openExclusive(filePath);
    await handle.writeFile(bytes);
    const flush = await flushFile(handle);
    if (flush.status !== 'flushed') throw flush.status === 'failed' ? flush.error : new Error('File flush unsupported');
    await handle.close();
    handle = undefined;
    await flushRequiredDirectory(path.dirname(filePath), dependencies);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  }
}

function validateFilePaths(manifest: OperationManifest, file: OperationFile): void {
  assertPathConfined(file.targetPath, manifest.roots.managedRoots, `${file.fileId}.targetPath`);
  if (file.sourcePath) assertPathConfined(file.sourcePath, manifest.roots.sourceRoots, `${file.fileId}.sourcePath`);
  if (file.stagingPath) {
    assertPathConfined(file.stagingPath, manifest.roots.managedRoots, `${file.fileId}.stagingPath`);
    assertSameVolume(file.stagingPath, file.targetPath, `${file.fileId}.stagingPath`);
  }
}

function isSameOrDescendant(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function nearestExistingRealPath(candidate: string, files: JournalFileDependencies): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      return await files.realpath(current);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

export async function assertRealPathConfined(
  candidate: string,
  roots: readonly string[],
  dependencies: JournalIoDependencies = {},
  name = 'path'
): Promise<void> {
  assertPathConfined(candidate, roots, name);
  const files = dependencies.files ?? defaultJournalFileDependencies;
  for (const root of roots.filter((entry) => isSameOrDescendant(candidate, entry))) {
    const [canonicalRoot, canonicalAncestor] = await Promise.all([
      files.realpath(root),
      nearestExistingRealPath(candidate, files)
    ]);
    if (isSameOrDescendant(canonicalAncestor, canonicalRoot)) return;
  }
  throw new Error(`${name} escapes its authorized roots through a symbolic link`);
}

export async function stageOperationFiles(
  manifest: OperationManifest,
  dependencies: JournalIoDependencies = {}
): Promise<OperationFile[]> {
  const result: OperationFile[] = [];
  for (const file of manifest.files) {
    validateFilePaths(manifest, file);
    await assertRealPathConfined(file.targetPath, manifest.roots.managedRoots, dependencies, `${file.fileId}.targetPath`);
    if (file.sourcePath) await assertRealPathConfined(file.sourcePath, manifest.roots.sourceRoots, dependencies, `${file.fileId}.sourcePath`);
    if (file.stagingPath) await assertRealPathConfined(file.stagingPath, manifest.roots.managedRoots, dependencies, `${file.fileId}.stagingPath`);
    if (file.quarantinePath) await assertRealPathConfined(file.quarantinePath, manifest.roots.managedRoots, dependencies, `${file.fileId}.quarantinePath`);
    if (file.kind === 'quarantine_delete') {
      result.push(file);
      continue;
    }
    if (file.status !== 'pending' && file.status !== 'staged') {
      result.push(file);
      continue;
    }
    const source = await inspectFile(file.sourcePath!, file.content, dependencies);
    if (source.status === 'missing') throw new OperationFileError('source_missing', file.fileId, 'stage', 'Source file is missing');
    if (source.status === 'mismatch') throw new OperationFileError('source_hash_mismatch', file.fileId, 'stage', 'Source file hash or size changed');
    const staged = await inspectFile(file.stagingPath!, file.content, dependencies);
    if (staged.status === 'mismatch') throw new OperationFileError('staging_hash_mismatch', file.fileId, 'stage', 'Existing staging file does not match');
    if (staged.status === 'missing') {
      const bytes = await (dependencies.files ?? defaultJournalFileDependencies).readFile(file.sourcePath!);
      await durableWriteExclusive(file.stagingPath!, bytes, dependencies);
      const verified = await inspectFile(file.stagingPath!, file.content, dependencies);
      if (verified.status !== 'match') throw new OperationFileError('staging_verification_failed', file.fileId, 'stage', 'Staged file verification failed');
    }
    result.push({ ...file, status: 'staged' });
  }
  return result;
}

export async function publishStagedFile(
  file: OperationFile,
  dependencies: JournalIoDependencies = {}
): Promise<void> {
  if (!file.stagingPath) throw new OperationFileError('staging_path_missing', file.fileId, 'commit', 'Staging path is missing');
  const files = dependencies.files ?? defaultJournalFileDependencies;
  const target = await inspectFile(file.targetPath, file.content, dependencies);
  if (target.status === 'match') {
    await removeVerifiedFile(file.stagingPath, file.content, dependencies);
    return;
  }
  if (target.status === 'mismatch') throw new OperationFileError('target_conflict', file.fileId, 'commit', 'Target contains unexpected content');
  const staged = await inspectFile(file.stagingPath, file.content, dependencies);
  if (staged.status === 'missing') throw new OperationFileError('staging_missing', file.fileId, 'commit', 'Staging file is missing');
  if (staged.status === 'mismatch') throw new OperationFileError('staging_hash_mismatch', file.fileId, 'commit', 'Staging file does not match');
  await files.mkdir(path.dirname(file.targetPath));
  const stagingDirectory = path.dirname(file.stagingPath);
  const targetDirectory = path.dirname(file.targetPath);
  await files.rename(file.stagingPath, file.targetPath);
  await flushRequiredDirectory(targetDirectory, dependencies);
  if (stagingDirectory !== targetDirectory) await flushRequiredDirectory(stagingDirectory, dependencies);
  const verified = await inspectFile(file.targetPath, file.content, dependencies);
  if (verified.status !== 'match') throw new OperationFileError('target_verification_failed', file.fileId, 'commit', 'Published target verification failed');
}

export async function removeVerifiedFile(
  filePath: string,
  evidence: FileEvidence,
  dependencies: JournalIoDependencies = {}
): Promise<void> {
  const inspection = await inspectFile(filePath, evidence, dependencies);
  if (inspection.status === 'missing') return;
  if (inspection.status === 'mismatch') throw new Error(`Refusing to remove unexpected file: ${filePath}`);
  await (dependencies.files ?? defaultJournalFileDependencies).unlink(filePath);
  await flushRequiredDirectory(path.dirname(filePath), dependencies);
}

export const defaultJournalFileDependencies: JournalFileDependencies = {
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
  async rename(from, to) {
    await fs.promises.rename(from, to);
  },
  async unlink(filePath) {
    await fs.promises.unlink(filePath);
  }
};

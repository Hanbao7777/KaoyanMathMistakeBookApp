import crypto from 'node:crypto';
import path from 'node:path';
import { defaultDirectoryDurabilityDependencies, flushDirectory, flushFile } from '../fileDurability';
import {
  defaultJournalFileDependencies,
  inspectFile,
  removeVerifiedFile,
  type JournalIoDependencies,
  type JournalWriteHandle,
  OperationFileError
} from './staging';
import { assertPathConfined, type FileEvidence, type OperationFile, type OperationManifest } from './types';

export interface QuarantineDependencies extends JournalIoDependencies {
  randomId?: () => string;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

async function flushDirectoryThroughProbe(directoryPath: string, dependencies: QuarantineDependencies): Promise<void> {
  const outcome = await flushDirectory(directoryPath, dependencies.directoryDurability ?? defaultDirectoryDurabilityDependencies);
  if (outcome.status === 'failed') throw outcome.error;
}

async function copyFlushRename(
  sourcePath: string,
  destinationPath: string,
  evidence: FileEvidence,
  dependencies: QuarantineDependencies,
  fileId: string,
  phase: string
): Promise<void> {
  const files = dependencies.files ?? defaultJournalFileDependencies;
  await files.mkdir(path.dirname(destinationPath));
  const nonce = (dependencies.randomId ?? crypto.randomUUID)().replace(/[^A-Za-z0-9_-]/g, '');
  if (!nonce) throw new OperationFileError('invalid_nonce', fileId, phase, 'Cross-device temp nonce is invalid');
  const tempPath = path.join(path.dirname(destinationPath), `.${path.basename(destinationPath)}.${nonce}.copy.tmp`);
  let handle: JournalWriteHandle | undefined;
  try {
    const bytes = await files.readFile(sourcePath);
    handle = await files.openExclusive(tempPath);
    await handle.writeFile(bytes);
    const flush = await flushFile(handle);
    if (flush.status !== 'flushed') throw flush.status === 'failed' ? flush.error : new Error('Cross-device copy flush unsupported');
    await handle.close();
    handle = undefined;
    const temp = await inspectFile(tempPath, evidence, dependencies);
    if (temp.status !== 'match') throw new OperationFileError('copy_verification_failed', fileId, phase, 'Cross-device copy verification failed');
    await files.rename(tempPath, destinationPath);
    await flushDirectoryThroughProbe(path.dirname(destinationPath), dependencies);
    const destination = await inspectFile(destinationPath, evidence, dependencies);
    if (destination.status !== 'match') throw new OperationFileError('destination_verification_failed', fileId, phase, 'Destination verification failed');
    await files.unlink(sourcePath);
    await flushDirectoryThroughProbe(path.dirname(sourcePath), dependencies);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await files.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export async function moveToQuarantine(
  sourcePath: string,
  quarantinePath: string,
  evidence: FileEvidence,
  fileId: string,
  dependencies: QuarantineDependencies = {}
): Promise<'renamed' | 'copied' | 'already_quarantined'> {
  const files = dependencies.files ?? defaultJournalFileDependencies;
  const source = await inspectFile(sourcePath, evidence, dependencies);
  const quarantined = await inspectFile(quarantinePath, evidence, dependencies);
  if (quarantined.status === 'mismatch') throw new OperationFileError('quarantine_conflict', fileId, 'quarantine', 'Quarantine path contains unexpected content');
  if (source.status === 'mismatch') throw new OperationFileError('source_hash_mismatch', fileId, 'quarantine', 'Source content changed before quarantine');
  if (quarantined.status === 'match') {
    if (source.status === 'match') await removeVerifiedFile(sourcePath, evidence, dependencies);
    return 'already_quarantined';
  }
  if (source.status === 'missing') throw new OperationFileError('source_missing', fileId, 'quarantine', 'Source and quarantine files are missing');
  await files.mkdir(path.dirname(quarantinePath));
  try {
    const sourceDirectory = path.dirname(sourcePath);
    const quarantineDirectory = path.dirname(quarantinePath);
    await files.rename(sourcePath, quarantinePath);
    await flushDirectoryThroughProbe(quarantineDirectory, dependencies);
    if (sourceDirectory !== quarantineDirectory) await flushDirectoryThroughProbe(sourceDirectory, dependencies);
    return 'renamed';
  } catch (error) {
    if (errorCode(error) !== 'EXDEV') throw error;
    await copyFlushRename(sourcePath, quarantinePath, evidence, dependencies, fileId, 'quarantine');
    return 'copied';
  }
}

export async function restoreFromQuarantine(
  quarantinePath: string,
  targetPath: string,
  evidence: FileEvidence,
  fileId: string,
  dependencies: QuarantineDependencies = {}
): Promise<void> {
  const files = dependencies.files ?? defaultJournalFileDependencies;
  const target = await inspectFile(targetPath, evidence, dependencies);
  const quarantined = await inspectFile(quarantinePath, evidence, dependencies);
  if (target.status === 'mismatch') throw new OperationFileError('target_conflict', fileId, 'compensation', 'Cannot restore over unexpected target content');
  if (quarantined.status === 'mismatch') throw new OperationFileError('quarantine_hash_mismatch', fileId, 'compensation', 'Quarantine content changed');
  if (target.status === 'match') {
    if (quarantined.status === 'match') await removeVerifiedFile(quarantinePath, evidence, dependencies);
    return;
  }
  if (quarantined.status === 'missing') throw new OperationFileError('recovery_asset_missing', fileId, 'compensation', 'Quarantine recovery asset is missing');
  await files.mkdir(path.dirname(targetPath));
  try {
    const quarantineDirectory = path.dirname(quarantinePath);
    const targetDirectory = path.dirname(targetPath);
    await files.rename(quarantinePath, targetPath);
    await flushDirectoryThroughProbe(targetDirectory, dependencies);
    if (quarantineDirectory !== targetDirectory) await flushDirectoryThroughProbe(quarantineDirectory, dependencies);
  } catch (error) {
    if (errorCode(error) !== 'EXDEV') throw error;
    await copyFlushRename(quarantinePath, targetPath, evidence, dependencies, fileId, 'compensation');
  }
  const restored = await inspectFile(targetPath, evidence, dependencies);
  if (restored.status !== 'match') throw new OperationFileError('restore_verification_failed', fileId, 'compensation', 'Restored file verification failed');
}

export async function quarantineDeletionFiles(
  manifest: OperationManifest,
  dependencies: QuarantineDependencies = {}
): Promise<OperationFile[]> {
  const result: OperationFile[] = [];
  for (const file of manifest.files) {
    if (file.kind !== 'quarantine_delete' || file.status === 'quarantined' || file.status === 'committed') {
      result.push(file);
      continue;
    }
    assertPathConfined(file.targetPath, manifest.roots.managedRoots, `${file.fileId}.targetPath`);
    assertPathConfined(file.quarantinePath!, manifest.roots.managedRoots, `${file.fileId}.quarantinePath`);
    await moveToQuarantine(file.targetPath, file.quarantinePath!, file.content, file.fileId, dependencies);
    result.push({ ...file, status: 'quarantined' });
  }
  return result;
}

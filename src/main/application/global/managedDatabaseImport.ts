import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AgentError } from '../../../shared/agent/errors';
import { defaultDirectoryDurabilityDependencies, flushDirectory } from '../../persistence/fileDurability';

export const MAX_DATABASE_IMPORT_PACKAGE_BYTES = 64 * 1024 * 1024;

export interface ManagedDatabaseImportPlan {
  readonly assetId: string;
  readonly fileName: string;
  readonly sourcePath: string;
  readonly internalPath: string;
  readonly bytes: Buffer;
  readonly contentHash: string;
  readonly contentSize: number;
}

export interface ManagedDatabaseImportEvidence {
  readonly hash: string;
  readonly size: number;
  readonly bytes: Buffer;
}

function networkPath(candidate: string): boolean {
  const normalized = candidate.replaceAll('/', '\\').toLowerCase();
  return normalized.startsWith('\\\\') || normalized.startsWith('\\?\\unc\\') || normalized.startsWith('\\.\\');
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function assertDirectorySafe(root: string, create: boolean): Promise<string> {
  if (!path.isAbsolute(root) || path.normalize(root) !== root || networkPath(root)) throw new AgentError('RECOVERY_FENCE');
  if (create) await fs.promises.mkdir(root, { recursive: true });
  const stat = await fs.promises.lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AgentError('RECOVERY_FENCE');
  const real = path.normalize(await fs.promises.realpath(root));
  if (path.resolve(real).toLowerCase() !== path.resolve(root).toLowerCase()) throw new AgentError('RECOVERY_FENCE');
  return real;
}

async function readSelectedPackage(filePath: string): Promise<{ readonly path: string; readonly bytes: Buffer }> {
  if (!path.isAbsolute(filePath) || networkPath(filePath)) throw new AgentError('VALIDATION_ERROR', { field: 'selectedImportPackage' });
  const normalized = path.normalize(filePath);
  if (path.extname(normalized).toLowerCase() !== '.json') throw new AgentError('VALIDATION_ERROR', { field: 'selectedImportPackage.extension' });
  const selectedStat = await fs.promises.lstat(normalized);
  if (selectedStat.isSymbolicLink() || !selectedStat.isFile() || selectedStat.size < 1 || selectedStat.size > MAX_DATABASE_IMPORT_PACKAGE_BYTES) {
    throw new AgentError('VALIDATION_ERROR', { field: 'selectedImportPackage' });
  }
  const real = path.normalize(await fs.promises.realpath(normalized));
  if (networkPath(real)) throw new AgentError('VALIDATION_ERROR', { field: 'selectedImportPackage' });
  const handle = await fs.promises.open(normalized, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== selectedStat.dev || opened.ino !== selectedStat.ino || opened.size !== selectedStat.size) throw new AgentError('RECOVERY_FENCE');
    return Object.freeze({ path: normalized, bytes: await handle.readFile() });
  } finally {
    await handle.close();
  }
}

export async function planUserSelectedDatabaseImport(filePath: string, managedRoot: string, assetId: string): Promise<ManagedDatabaseImportPlan> {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,199}$/.test(assetId)) throw new AgentError('VALIDATION_ERROR', { field: 'assetId' });
  const root = path.normalize(managedRoot);
  await assertDirectorySafe(root, true);
  const selected = await readSelectedPackage(filePath);
  const internalPath = path.normalize(path.join(root, `${assetId}.json`));
  if (!within(root, internalPath)) throw new AgentError('RECOVERY_FENCE');
  return Object.freeze({
    assetId,
    fileName: path.basename(selected.path),
    sourcePath: selected.path,
    internalPath,
    bytes: selected.bytes,
    contentHash: `sha256-v1:${createHash('sha256').update(selected.bytes).digest('hex')}`,
    contentSize: selected.bytes.byteLength
  });
}

export async function publishManagedDatabaseImport(plan: ManagedDatabaseImportPlan, managedRoot: string): Promise<void> {
  const root = path.normalize(managedRoot);
  await assertDirectorySafe(root, true);
  if (!within(root, plan.internalPath) || fs.existsSync(plan.internalPath)) throw new AgentError('RECOVERY_FENCE');
  const temporary = path.normalize(path.join(root, `.${plan.assetId}.${createHash('sha256').update(plan.contentHash).digest('hex').slice(0, 16)}.stage`));
  if (!within(root, temporary)) throw new AgentError('RECOVERY_FENCE');
  let handle: fs.promises.FileHandle | undefined;
  let published = false;
  try {
    handle = await fs.promises.open(temporary, 'wx');
    await handle.writeFile(plan.bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertDirectorySafe(root, false);
    await fs.promises.rename(temporary, plan.internalPath);
    published = true;
    const flushed = await flushDirectory(root, defaultDirectoryDurabilityDependencies);
    if (flushed.status === 'failed') throw flushed.error;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (!published) await fs.promises.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export function verifyManagedDatabaseImport(filePath: string, managedRoot: string, expected: { readonly hash: string; readonly size: number }): ManagedDatabaseImportEvidence {
  const root = path.normalize(managedRoot);
  const normalized = path.normalize(filePath);
  if (!path.isAbsolute(root) || !path.isAbsolute(normalized) || path.extname(normalized).toLowerCase() !== '.json' || !within(root, normalized)) throw new AgentError('RECOVERY_FENCE');
  const rootStat = fs.lstatSync(root);
  const fileStat = fs.lstatSync(normalized);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.size !== expected.size || fileStat.size < 1 || fileStat.size > MAX_DATABASE_IMPORT_PACKAGE_BYTES) throw new AgentError('RECOVERY_FENCE');
  const realRoot = path.normalize(fs.realpathSync(root));
  const realFile = path.normalize(fs.realpathSync(normalized));
  if (path.resolve(realRoot).toLowerCase() !== path.resolve(root).toLowerCase() || !within(realRoot, realFile)) throw new AgentError('RECOVERY_FENCE');
  const bytes = fs.readFileSync(normalized);
  const hash = `sha256-v1:${createHash('sha256').update(bytes).digest('hex')}`;
  if (hash !== expected.hash || bytes.byteLength !== expected.size) throw new AgentError('RECOVERY_FENCE');
  return Object.freeze({ hash, size: bytes.byteLength, bytes });
}

export async function removeManagedDatabaseImport(filePath: string, managedRoot: string): Promise<void> {
  const root = path.normalize(managedRoot);
  if (!within(root, path.normalize(filePath))) throw new AgentError('RECOVERY_FENCE');
  await fs.promises.unlink(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  const flushed = await flushDirectory(root, defaultDirectoryDurabilityDependencies);
  if (flushed.status === 'failed') throw flushed.error;
}

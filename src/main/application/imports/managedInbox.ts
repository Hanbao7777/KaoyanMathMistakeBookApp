import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AgentError } from '../../../shared/agent/errors';
import { getPaths } from '../../services/pathService';
import { defaultDirectoryDurabilityDependencies, flushDirectory } from '../../persistence/fileDurability';

export const importImageExtensions = Object.freeze(['.jpg', '.jpeg', '.png', '.webp'] as const);
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export interface ManagedImportAsset {
  readonly assetId: string;
  readonly fileName: string;
  readonly filePath: string;
  readonly sha256: string;
  readonly size: number;
}

export interface ManagedImportAssetPlan extends ManagedImportAsset {
  readonly sourcePath: string;
  readonly stagingPath: string;
  readonly sourceRoot: string;
}

function networkPath(candidate: string): boolean {
  const normalized = candidate.replaceAll('/', '\\').toLowerCase();
  return normalized.startsWith('\\\\') || normalized.startsWith('\\?\\unc\\') || normalized.startsWith('\\.\\');
}

function inboxRoot(): string { return path.normalize(path.join(getPaths().data, 'import-inbox', 'assets')); }

async function assertDirectoryChainSafe(root: string, create: boolean): Promise<void> {
  const parsed = path.parse(root);
  let current = parsed.root;
  for (const segment of root.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.promises.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AgentError('RECOVERY_FENCE');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
      break;
    }
  }
  if (create) await fs.promises.mkdir(root, { recursive: true });
  const stat = await fs.promises.lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AgentError('RECOVERY_FENCE');
  const real = await fs.promises.realpath(root);
  if (path.resolve(real).toLowerCase() !== path.resolve(root).toLowerCase()) throw new AgentError('RECOVERY_FENCE');
}

async function readSelectedImage(filePath: string): Promise<{ bytes: Buffer; stat: fs.Stats }> {
  if (!path.isAbsolute(filePath) || networkPath(filePath)) throw new AgentError('VALIDATION_ERROR', { field: 'selectedImage' });
  const normalized = path.normalize(filePath);
  if (!importImageExtensions.includes(path.extname(normalized).toLowerCase() as typeof importImageExtensions[number])) throw new AgentError('VALIDATION_ERROR', { field: 'selectedImage.extension' });
  const linkStat = await fs.promises.lstat(normalized);
  if (linkStat.isSymbolicLink() || !linkStat.isFile() || linkStat.size < 1 || linkStat.size > MAX_IMAGE_BYTES) throw new AgentError('VALIDATION_ERROR', { field: 'selectedImage' });
  const real = await fs.promises.realpath(normalized);
  if (networkPath(real)) throw new AgentError('VALIDATION_ERROR', { field: 'selectedImage' });
  const handle = await fs.promises.open(normalized, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const openStat = await handle.stat();
    if (!openStat.isFile() || openStat.dev !== linkStat.dev || openStat.ino !== linkStat.ino || openStat.size !== linkStat.size) throw new AgentError('RECOVERY_FENCE');
    return { bytes: await handle.readFile(), stat: openStat };
  } finally { await handle.close(); }
}

export async function planUserSelectedImportImages(filePaths: readonly string[]): Promise<readonly ManagedImportAssetPlan[]> {
  if (!Array.isArray(filePaths) || filePaths.length < 1 || filePaths.length > 10) throw new AgentError('VALIDATION_ERROR', { field: 'selectedImages' });
  const root = inboxRoot();
  await assertDirectoryChainSafe(root, true);
  const assets: ManagedImportAssetPlan[] = [];
  for (const selected of filePaths) {
    const { bytes } = await readSelectedImage(selected);
    const assetId = `asset-${crypto.randomUUID().toLowerCase()}`;
    const extension = path.extname(selected).toLowerCase();
    const target = path.normalize(path.join(root, `${assetId}${extension}`));
    const stagingPath = path.normalize(path.join(root, '.staging', `${assetId}.${crypto.randomUUID().replaceAll('-', '')}.stage`));
    assets.push(Object.freeze({ assetId, fileName: path.basename(selected), filePath: target, sourcePath: path.normalize(selected), stagingPath, sourceRoot: path.dirname(path.normalize(selected)), sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength }));
  }
  return Object.freeze(assets);
}

export async function stageUserSelectedImportImages(filePaths: readonly string[]): Promise<readonly ManagedImportAsset[]> {
  const plans = await planUserSelectedImportImages(filePaths);
  const root = inboxRoot();
  for (const plan of plans) {
    const bytes = await fs.promises.readFile(plan.sourcePath);
    const temporary = path.normalize(path.join(root, `.${plan.assetId}.${crypto.randomUUID().replaceAll('-', '')}.tmp`));
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(temporary, 'wx');
      await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
      await assertDirectoryChainSafe(root, false);
      await fs.promises.rename(temporary, plan.filePath);
      const flushed = await flushDirectory(root, defaultDirectoryDurabilityDependencies);
      if (flushed.status === 'failed') throw flushed.error;
    } catch (error) {
      await handle?.close().catch(() => undefined); await fs.promises.unlink(temporary).catch(() => undefined); throw error;
    }
  }
  return Object.freeze(plans.map(({ sourcePath: _sourcePath, stagingPath: _stagingPath, sourceRoot: _sourceRoot, ...asset }) => Object.freeze(asset)));
}

export async function verifyManagedImportAsset(asset: ManagedImportAsset): Promise<void> {
  const root = inboxRoot(); await assertDirectoryChainSafe(root, false);
  const relative = path.relative(root, asset.filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.dirname(relative) !== '.') throw new AgentError('RECOVERY_FENCE');
  const stat = await fs.promises.lstat(asset.filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== asset.size) throw new AgentError('RECOVERY_FENCE');
  const real = await fs.promises.realpath(asset.filePath);
  if (path.dirname(real).toLowerCase() !== root.toLowerCase()) throw new AgentError('RECOVERY_FENCE');
  const bytes = await fs.promises.readFile(asset.filePath);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new AgentError('RECOVERY_FENCE');
}

export function managedImportInboxRoot(): string { return inboxRoot(); }

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { app, dialog } from 'electron';
import type { AppPaths } from '../../shared/types';

const DEFAULT_ROOT = 'D:\\KaoyanMathMistakeBook';
const CONFIG_FILE = 'data-root.json';

interface PathConfig {
  root?: string;
}

export const rootSwitchStages = [
  'before_space_check',
  'after_space_check',
  'after_copy',
  'after_verify',
  'before_config_publish',
  'after_config_publish'
] as const;

export type RootSwitchStage = (typeof rootSwitchStages)[number];

export interface RootSwitchDependencies {
  availableBytes?: (targetRoot: string) => number;
  hook?: (stage: RootSwitchStage) => void | Promise<void>;
  randomId?: () => string;
}

export interface RootSwitchPlan {
  oldPaths: AppPaths;
  newPaths: AppPaths;
  copiedFiles: Array<{ relativePath: string; size: number; sha256: string }>;
  requiredBytes: number;
}

let currentPaths: AppPaths | null = null;

function configPath() {
  return path.join(app.getPath('userData'), CONFIG_FILE);
}

function readConfig(): PathConfig {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    return JSON.parse(raw) as PathConfig;
  } catch {
    return {};
  }
}

function writeFileDurably(filePath: string, bytes: Buffer) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const handle = fs.openSync(filePath, 'wx');
  try {
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function publishConfig(config: PathConfig, randomId: () => string = crypto.randomUUID) {
  const target = configPath();
  const nonce = randomId().replace(/[^A-Za-z0-9_-]/g, '');
  if (!nonce) throw new Error('Data-root configuration nonce is invalid');
  const temp = path.join(path.dirname(target), `.${CONFIG_FILE}.${nonce}.tmp`);
  writeFileDurably(temp, Buffer.from(`${JSON.stringify(config, null, 2)}\n`, 'utf8'));
  try {
    fs.renameSync(temp, target);
    try {
      const directory = fs.openSync(path.dirname(target), 'r');
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      if (!['EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM'].includes(code)) throw error;
    }
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function writeConfig(config: PathConfig) {
  publishConfig(config);
}

function buildPaths(root: string, isFallback: boolean, warning: string | null): AppPaths {
  return {
    root,
    data: path.join(root, 'data'),
    images: path.join(root, 'images'),
    exports: path.join(root, 'exports'),
    backups: path.join(root, 'backups'),
    temp: path.join(root, 'temp'),
    textbooks: path.join(root, 'textbooks'),
    database: path.join(root, 'data', 'mistakes.db'),
    isFallback,
    warning
  };
}

function ensureWritable(paths: AppPaths) {
  for (const dir of [paths.root, paths.data, paths.images, paths.exports, paths.backups, paths.temp, paths.textbooks]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const testFile = path.join(paths.root, `.write-test-${Date.now()}.tmp`);
  fs.writeFileSync(testFile, 'ok', 'utf8');
  fs.unlinkSync(testFile);
}

export function initializePaths() {
  const configuredRoot = readConfig().root;
  const preferredRoot = configuredRoot || DEFAULT_ROOT;

  try {
    const paths = buildPaths(preferredRoot, false, null);
    ensureWritable(paths);
    currentPaths = paths;
    return paths;
  } catch (error) {
    const fallbackRoot = path.join(app.getPath('documents'), 'KaoyanMathMistakeBook');
    const warning = `默认数据目录 ${preferredRoot} 不可用，已临时使用 ${fallbackRoot}。可在设置页更改数据保存位置。`;
    const paths = buildPaths(fallbackRoot, true, warning);
    ensureWritable(paths);
    currentPaths = paths;

    dialog.showMessageBox({
      type: 'warning',
      title: '数据目录不可用',
      message: '默认数据目录不可用',
      detail: `${warning}\n\n原始错误：${error instanceof Error ? error.message : String(error)}`
    }).catch(() => undefined);

    return paths;
  }
}

export function getPaths() {
  if (!currentPaths) {
    return initializePaths();
  }
  return currentPaths;
}

export function setDataRoot(root: string) {
  const paths = buildPaths(root, false, null);
  ensureWritable(paths);
  writeConfig({ root });
  currentPaths = paths;
  return paths;
}

function isSameOrDescendant(candidate: string, root: string) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function hashFile(filePath: string) {
  const bytes = fs.readFileSync(filePath);
  return { size: bytes.byteLength, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function listManagedFiles(paths: AppPaths) {
  const roots = [paths.data, paths.images, paths.exports, paths.backups, paths.temp, paths.textbooks];
  const files: Array<{ absolutePath: string; relativePath: string; size: number; sha256: string }> = [];
  const visit = (directory: string) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Data-root migration refuses symbolic links: ${absolutePath}`);
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile()) files.push({ absolutePath, relativePath: path.relative(paths.root, absolutePath), ...hashFile(absolutePath) });
    }
  };
  for (const root of roots) visit(root);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function defaultAvailableBytes(targetRoot: string) {
  const probe = fs.existsSync(targetRoot) ? targetRoot : path.dirname(targetRoot);
  const stats = fs.statfsSync(probe);
  return Number(stats.bavail) * Number(stats.bsize);
}

export async function stageDataRootSwitch(
  oldPaths: AppPaths,
  root: string,
  migrate: boolean,
  dependencies: RootSwitchDependencies = {}
): Promise<RootSwitchPlan> {
  const normalizedRoot = path.resolve(root);
  if (isSameOrDescendant(normalizedRoot, oldPaths.root) || isSameOrDescendant(oldPaths.root, normalizedRoot)) {
    throw new Error('New data root must not overlap the current data root');
  }
  const newPaths = buildPaths(normalizedRoot, false, null);
  if (fs.existsSync(normalizedRoot)) {
    const stat = fs.lstatSync(normalizedRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('New data root must be a regular directory');
    if (fs.readdirSync(normalizedRoot).length !== 0) throw new Error('New data root must be empty before migration');
  } else {
    fs.mkdirSync(normalizedRoot, { recursive: true });
  }
  ensureWritable(newPaths);

  const sourceFiles = migrate ? listManagedFiles(oldPaths) : [];
  const requiredBytes = sourceFiles.reduce((total, file) => total + file.size, 0);
  await dependencies.hook?.('before_space_check');
  const availableBytes = (dependencies.availableBytes ?? defaultAvailableBytes)(normalizedRoot);
  if (!Number.isFinite(availableBytes) || availableBytes < requiredBytes) {
    throw new Error(`Insufficient space for data-root migration: requires ${requiredBytes} bytes, available ${availableBytes} bytes`);
  }
  await dependencies.hook?.('after_space_check');

  for (const source of sourceFiles) {
    const target = path.join(normalizedRoot, source.relativePath);
    if (!isSameOrDescendant(target, normalizedRoot)) throw new Error('Data-root migration path escaped the target root');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source.absolutePath, target, fs.constants.COPYFILE_EXCL);
  }
  await dependencies.hook?.('after_copy');

  const copiedFiles = listManagedFiles(newPaths).map(({ relativePath, size, sha256 }) => ({ relativePath, size, sha256 }));
  if (copiedFiles.length !== sourceFiles.length || copiedFiles.some((file, index) =>
    file.relativePath !== sourceFiles[index].relativePath || file.size !== sourceFiles[index].size || file.sha256 !== sourceFiles[index].sha256
  )) throw new Error('Data-root migration verification failed');
  await dependencies.hook?.('after_verify');
  return { oldPaths, newPaths, copiedFiles, requiredBytes };
}

export async function publishDataRootSwitch(plan: RootSwitchPlan, dependencies: RootSwitchDependencies = {}) {
  await dependencies.hook?.('before_config_publish');
  publishConfig({ root: plan.newPaths.root }, dependencies.randomId);
  currentPaths = plan.newPaths;
  await dependencies.hook?.('after_config_publish');
  return plan.newPaths;
}

export function restoreDataRootAuthority(paths: AppPaths, randomId?: () => string) {
  publishConfig({ root: paths.root }, randomId);
  currentPaths = paths;
}

export function getDefaultRoot() {
  return DEFAULT_ROOT;
}

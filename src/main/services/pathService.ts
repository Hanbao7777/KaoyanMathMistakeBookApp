import fs from 'node:fs';
import path from 'node:path';
import { app, dialog } from 'electron';
import type { AppPaths } from '../../shared/types';

const DEFAULT_ROOT = 'D:\\KaoyanMathMistakeBook';
const CONFIG_FILE = 'data-root.json';

interface PathConfig {
  root?: string;
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

function writeConfig(config: PathConfig) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8');
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

export function copyExistingData(oldPaths: AppPaths, newPaths: AppPaths) {
  ensureWritable(newPaths);

  const copyDir = (from: string, to: string) => {
    if (!fs.existsSync(from)) return;
    fs.cpSync(from, to, { recursive: true, force: true });
  };

  copyDir(oldPaths.data, newPaths.data);
  copyDir(oldPaths.images, newPaths.images);
  copyDir(oldPaths.exports, newPaths.exports);
  copyDir(oldPaths.backups, newPaths.backups);
  copyDir(oldPaths.temp, newPaths.temp);
  copyDir(oldPaths.textbooks, newPaths.textbooks);
}

export function getDefaultRoot() {
  return DEFAULT_ROOT;
}

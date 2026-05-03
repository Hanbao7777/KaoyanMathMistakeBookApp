import fs from 'node:fs';
import path from 'node:path';
import { shell } from 'electron';
import { getPaths } from './pathService';
import { persistDatabase, resetDatabaseConnection } from './databaseService';
import type { DatabaseBackupInfo, DatabaseBackupKind, DatabaseBackupResult, RestoreDatabaseBackupResult } from '../../shared/types';

function pad(value: number) {
  return String(value).padStart(2, '0');
}

function timestamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function datePrefix(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function ensureBackupsDir() {
  const paths = getPaths();
  fs.mkdirSync(paths.backups, { recursive: true });
  return paths;
}

function backupTypeFromName(name: string): DatabaseBackupKind {
  if (name.startsWith('mistakes_auto_')) return 'auto';
  if (name.startsWith('mistakes_before_restore_')) return 'before_restore';
  return 'manual';
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function safeBackupPath(fileName: string) {
  const paths = ensureBackupsDir();
  const base = path.basename(fileName);
  if (base !== fileName) throw new Error('备份文件名不合法');
  const target = path.join(paths.backups, base);
  const relative = path.relative(paths.backups, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('备份路径不合法');
  return target;
}

function copyDatabase(prefix: string): DatabaseBackupResult {
  const paths = ensureBackupsDir();
  persistDatabase();
  if (!fs.existsSync(paths.database)) throw new Error(`数据库文件不存在：${paths.database}`);
  const fileName = `${prefix}_${timestamp()}.db`;
  const filePath = path.join(paths.backups, fileName);
  fs.copyFileSync(paths.database, filePath);
  return { fileName, filePath, createdAt: new Date().toISOString() };
}

function cleanupAutoBackups() {
  const paths = ensureBackupsDir();
  const autoBackups = fs.readdirSync(paths.backups)
    .filter((name) => name.startsWith('mistakes_auto_') && name.endsWith('.db'))
    .map((name) => {
      const filePath = path.join(paths.backups, name);
      return { name, filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const item of autoBackups.slice(30)) {
    try {
      fs.unlinkSync(item.filePath);
    } catch {
      // 自动清理失败不应影响启动。
    }
  }
}

export function createDatabaseBackup(type: DatabaseBackupKind = 'manual') {
  const prefix = type === 'auto' ? 'mistakes_auto' : type === 'before_restore' ? 'mistakes_before_restore' : 'mistakes_backup';
  return copyDatabase(prefix);
}

export function ensureDailyAutoBackup(): DatabaseBackupResult | null {
  const paths = ensureBackupsDir();
  const today = datePrefix();
  const exists = fs.readdirSync(paths.backups).some((name) => name.startsWith(`mistakes_auto_${today}_`) && name.endsWith('.db'));
  if (exists) {
    cleanupAutoBackups();
    return null;
  }
  const result = createDatabaseBackup('auto');
  cleanupAutoBackups();
  return result;
}

export function listDatabaseBackups(): DatabaseBackupInfo[] {
  const paths = ensureBackupsDir();
  return fs.readdirSync(paths.backups)
    .filter((name) => name.endsWith('.db') && name.startsWith('mistakes_'))
    .map((name) => {
      const filePath = path.join(paths.backups, name);
      const stat = fs.statSync(filePath);
      return {
        fileName: name,
        filePath,
        type: backupTypeFromName(name),
        createdAt: stat.mtime.toISOString(),
        sizeBytes: stat.size,
        sizeText: formatSize(stat.size)
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function restoreDatabaseBackup(fileName: string): RestoreDatabaseBackupResult {
  const paths = ensureBackupsDir();
  const backupPath = safeBackupPath(fileName);
  if (!fs.existsSync(backupPath)) throw new Error(`备份文件不存在：${backupPath}`);
  if (!fs.existsSync(paths.database)) throw new Error(`当前数据库文件不存在：${paths.database}`);

  const beforeRestore = createDatabaseBackup('before_restore');
  try {
    fs.copyFileSync(backupPath, paths.database);
    resetDatabaseConnection();
    return {
      restored: true,
      restoredFrom: backupPath,
      beforeRestoreBackup: beforeRestore.filePath,
      message: '恢复完成，请重启 App 以确保所有页面重新加载最新数据。'
    };
  } catch (error) {
    try {
      fs.copyFileSync(beforeRestore.filePath, paths.database);
    } catch {
      // 如果回滚也失败，保留原始错误给用户。
    }
    resetDatabaseConnection();
    throw error;
  }
}

export function deleteDatabaseBackup(fileName: string) {
  const target = safeBackupPath(fileName);
  if (!fs.existsSync(target)) return false;
  fs.unlinkSync(target);
  return true;
}

export async function openBackupsFolder() {
  const paths = ensureBackupsDir();
  const result = await shell.openPath(paths.backups);
  if (result) throw new Error(result);
  return true;
}

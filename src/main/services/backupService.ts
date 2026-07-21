import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { shell } from 'electron';
import { getPaths } from './pathService';
import {
  createVerifiedDatabaseSnapshot,
  createVerifiedDatabaseSnapshotSync,
  getDatabaseCoordinator,
  restoreDatabaseFromFile,
  type MaintenanceOperationDependencies
} from './databaseService';
import {
  createOperationManifest,
  evidenceForBytes,
  OperationJournal,
  OperationManifestStore
} from '../persistence/operationJournal';
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
  if (name.startsWith('mistakes_before_delete_import_')) return 'before_delete_import';
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

function backupTarget(prefix: string) {
  const paths = ensureBackupsDir();
  const fileName = `${prefix}_${timestamp()}.db`;
  const filePath = path.join(paths.backups, fileName);
  return { fileName, filePath, createdAt: new Date().toISOString() };
}

async function cleanupAutoBackups() {
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
      await deleteDatabaseBackup(item.name);
    } catch {
      // 自动清理失败不应影响启动。
    }
  }
}

export function createDatabaseBackup(type: DatabaseBackupKind = 'manual') {
  const prefix = type === 'auto'
    ? 'mistakes_auto'
    : type === 'before_restore'
      ? 'mistakes_before_restore'
      : type === 'before_delete_import'
        ? 'mistakes_before_delete_import'
        : 'mistakes_backup';
  const target = backupTarget(prefix);
  const paths = ensureBackupsDir();
  if (!fs.existsSync(paths.database)) throw new Error(`数据库文件不存在：${paths.database}`);
  createVerifiedDatabaseSnapshotSync(target.filePath);
  return target;
}

export async function createDatabaseBackupMaintained(
  type: DatabaseBackupKind = 'manual',
  dependencies: MaintenanceOperationDependencies = {}
): Promise<DatabaseBackupResult> {
  const prefix = type === 'auto'
    ? 'mistakes_auto'
    : type === 'before_restore'
      ? 'mistakes_before_restore'
      : type === 'before_delete_import'
        ? 'mistakes_before_delete_import'
        : 'mistakes_backup';
  const target = backupTarget(prefix);
  await createVerifiedDatabaseSnapshot(target.filePath, dependencies);
  return target;
}

/** Internal C13 seam: caller supplies only an App-owned staging location. */
export async function createDatabaseBackupAt(filePath: string, dependencies: MaintenanceOperationDependencies = {}): Promise<void> {
  const paths = ensureBackupsDir();
  const normalized = path.normalize(filePath);
  const allowedRoot = path.normalize(paths.temp);
  const relative = path.relative(allowedRoot, normalized);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Backup staging path is not App-owned');
  fs.mkdirSync(path.dirname(normalized), { recursive: true });
  await createVerifiedDatabaseSnapshot(normalized, dependencies);
}

async function ensureDailyAutoBackupOnce(): Promise<DatabaseBackupResult | null> {
  const paths = ensureBackupsDir();
  const today = datePrefix();
  const exists = fs.readdirSync(paths.backups).some((name) => name.startsWith(`mistakes_auto_${today}_`) && name.endsWith('.db'));
  if (exists) {
    await cleanupAutoBackups();
    return null;
  }
  const result = await createDatabaseBackupMaintained('auto');
  await cleanupAutoBackups();
  return result;
}

export function ensureDailyAutoBackup(): Promise<DatabaseBackupResult | null> {
  const operation = ensureDailyAutoBackupOnce();
  operation.catch((error) => console.warn('[AutoBackup]', error));
  return operation;
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

export async function restoreDatabaseBackup(
  fileName: string,
  dependencies: MaintenanceOperationDependencies = {}
): Promise<RestoreDatabaseBackupResult> {
  const paths = ensureBackupsDir();
  const backupPath = safeBackupPath(fileName);
  if (!fs.existsSync(backupPath)) throw new Error(`备份文件不存在：${backupPath}`);
  const restored = await restoreDatabaseFromFile(backupPath, dependencies);
  return {
    restored: true,
    restoredFrom: backupPath,
    beforeRestoreBackup: restored.recoveryDatabasePath,
    message: '恢复完成，请重启 App 以确保所有页面重新加载最新数据。'
  };
}

export async function deleteDatabaseBackup(fileName: string) {
  const target = safeBackupPath(fileName);
  if (!fs.existsSync(target)) return false;
  const paths = ensureBackupsDir();
  const coordinator = await getDatabaseCoordinator();
  const versionBefore = coordinator.currentVersion();
  const versionAfter = { dataEpoch: versionBefore.dataEpoch, dataRevision: versionBefore.dataRevision + 1 };
  if (!Number.isSafeInteger(versionAfter.dataRevision)) throw new Error('Backup deletion requires an epoch rotation');
  const operationId = randomUUID().replace(/[^A-Za-z0-9_-]/g, '');
  const manifestRoot = path.normalize(path.join(paths.data, 'operation-journal'));
  const quarantineRoot = path.normalize(path.join(paths.backups, '.quarantine'));
  fs.mkdirSync(manifestRoot, { recursive: true });
  fs.mkdirSync(quarantineRoot, { recursive: true });
  const bytes = fs.readFileSync(target);
  const manifest = createOperationManifest({
    operationId,
    requestId: operationId,
    commandType: 'backup.delete',
    source: 'internal',
    clientId: 'maintenance-kernel',
    traceId: operationId,
    inputHash: createHash('sha256').update(fileName).digest('hex'),
    storage: 'data_root',
    versionBefore,
    versionAfter,
    affectedEntities: [{ entityType: 'database_backup', entityId: fileName }],
    roots: { manifestRoot, managedRoots: [path.normalize(paths.root)], sourceRoots: [path.normalize(paths.root)] },
    files: [{
      fileId: 'backup-file',
      kind: 'quarantine_delete',
      targetPath: path.normalize(target),
      quarantinePath: path.normalize(path.join(quarantineRoot, `${operationId}-${path.basename(target)}.quarantine`)),
      content: evidenceForBytes(bytes),
      status: 'pending'
    }],
    createdAt: new Date().toISOString()
  });
  const store = new OperationManifestStore(manifestRoot);
  const journal = new OperationJournal(store);
  const staged = await journal.stage(await journal.prepare(manifest));
  try {
    await coordinator.executeWrite({
      requestId: operationId,
      concurrency: 'strict',
      expectedVersion: versionBefore,
      execute: () => ({ changed: true, value: true })
    });
    try {
      await journal.commitFiles(await journal.markDatabaseCommitted(staged));
    } catch (finalizationError) {
      const latest = await store.read(operationId) ?? staged;
      const recovered = await journal.recover(latest, coordinator.currentVersion());
      if (recovered.terminalState !== 'completed') throw finalizationError;
    }
    return true;
  } catch (error) {
    if (coordinator.currentVersion().dataEpoch === versionBefore.dataEpoch && coordinator.currentVersion().dataRevision === versionBefore.dataRevision) {
      await journal.compensate(staged, { code: 'backup_delete_failed', phase: 'database', message: error instanceof Error ? error.message : String(error) });
    } else {
      await journal.needsRecovery(staged, { code: 'backup_delete_indeterminate', phase: 'database', message: 'Backup deletion database outcome is indeterminate' });
    }
    throw error;
  }
}

export async function openBackupsFolder() {
  const paths = ensureBackupsDir();
  const result = await shell.openPath(paths.backups);
  if (result) throw new Error(result);
  return true;
}

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron';
import {
  assertDatabaseReadyForRuntimeIpc,
  getQuestionsApplication,
  getReadOnlyDatabase,
  initializeDatabase,
  resetDatabaseConnection,
  shutdownDatabase,
  type DatabaseInitializationResult
} from './services/databaseService';
import { createInternalExecutionContext } from './application/executionContext';
import { killOcrProcess } from './services/ocrService';
import { initializePaths } from './services/pathService';
import { registerIpc } from './ipc/registerIpc';
import { seedImportKnowledgeMap } from './services/knowledgeMapService';
import { initializeStudySupervisor } from './services/studySupervisorService';
import { initializeTickTickService } from './services/ticktickService';
import { ensureDailyAutoBackup } from './services/backupService';
import type {
  QuestionCategoryMigrationCommand,
  QuestionRematchCommand
} from '../shared/agent/v1/contracts';

const isDev = !app.isPackaged && process.env.KAOYAN_USE_RENDERER_BUILD !== '1';
let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
let shutdownComplete = false;
let mainShutdownPromise: Promise<void> | null = null;

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'mistake-image',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true
    }
  }
]);

function registerImageProtocol() {
  protocol.handle('mistake-image', (request) => {
    const url = new URL(request.url);
    const decoded = decodeURIComponent(url.pathname);
    const filePath = process.platform === 'win32' && decoded.startsWith('/') ? decoded.slice(1) : decoded;
    return net.fetch(pathToFileURL(filePath).href);
  });
}

const windowStatePath = path.join(app.getPath('userData'), 'window-state.json');

function saveWindowState() {
  if (!mainWindow) return;
  const bounds = mainWindow.getBounds();
  const state = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height
  };
  try {
    fs.writeFileSync(windowStatePath, JSON.stringify(state), 'utf8');
  } catch { /* ignore */ }
}

function loadWindowState(): { x?: number; y?: number; width: number; height: number } | null {
  try {
    if (fs.existsSync(windowStatePath)) {
      return JSON.parse(fs.readFileSync(windowStatePath, 'utf8'));
    }
  } catch { /* ignore */ }
  return null;
}

function createWindow() {
  const savedState = loadWindowState();
  const win = new BrowserWindow({
    width: savedState?.width || 1280,
    height: savedState?.height || 820,
    x: savedState?.x,
    y: savedState?.y,
    minWidth: 980,
    minHeight: 680,
    title: '考研高数错题本',
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  mainWindow = win;

  let saveTimeout: ReturnType<typeof setTimeout> | null = null;
  win.on('resize', () => {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveWindowState, 500);
  });
  win.on('move', () => {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveWindowState, 500);
  });

  win.on('close', () => {
    saveWindowState();
    if (!isQuitting) {
      isQuitting = true;
      app.quit();
    }
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  if (isDev) {
    win.loadURL('http://127.0.0.1:5173');
  } else {
    win.loadFile(path.join(__dirname, '../../renderer/index.html'));
  }
}

function reportStartupError(error: unknown) {
  const message = error instanceof Error ? `${error.message}\n\n${error.stack || ''}` : String(error);
  const logPath = path.join(os.tmpdir(), 'kaoyan-math-mistakebook-startup-error.log');
  try {
    fs.writeFileSync(logPath, `[${new Date().toISOString()}]\n${message}\n`, 'utf8');
  } catch {
    // Ignore logging failures while reporting startup failures.
  }
  console.error('[StartupError]', message);
  dialog.showErrorBox('考研数学错题本启动失败', `${error instanceof Error ? error.message : String(error)}\n\n错误日志：${logPath}`);
}

const STARTUP_QUESTION_BATCH_SIZE = 500;

type StartupQuestionCommand = QuestionCategoryMigrationCommand | QuestionRematchCommand;

export interface StartupQuestionCommandDependencies {
  countKnowledgePoints(): Promise<number>;
  listQuestionIds(): Promise<number[]>;
  seedKnowledgeMap(): Promise<{ importedCount: number; failedCount: number }>;
  executeQuestionCommand(command: StartupQuestionCommand): Promise<{ value: unknown }>;
  assertWritesSafe(): void;
  warn(label: string, error: unknown): void;
}

const defaultStartupQuestionCommandDependencies: StartupQuestionCommandDependencies = {
  async countKnowledgePoints() {
    const database = await getReadOnlyDatabase();
    return database.select<{ count: number }>(
      'SELECT COUNT(*) AS count FROM knowledge_points WHERE deleted_at IS NULL OR deleted_at = ""'
    )[0]?.count ?? 0;
  },
  async listQuestionIds() {
    const database = await getReadOnlyDatabase();
    return database.select<{ id: number }>('SELECT id FROM questions ORDER BY id ASC').map((row) => row.id);
  },
  seedKnowledgeMap: seedImportKnowledgeMap,
  async executeQuestionCommand(command) {
    const application = await getQuestionsApplication();
    return application.execute(command, createInternalExecutionContext({ concurrency: 'none' }));
  },
  assertWritesSafe: assertDatabaseReadyForRuntimeIpc,
  warn: (label, error) => console.warn(label, error)
};

async function runNonfatalStartupOperation(
  label: string,
  operation: () => Promise<void>,
  dependencies: StartupQuestionCommandDependencies
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    dependencies.assertWritesSafe();
    dependencies.warn(label, error);
  }
}

export async function runStartupQuestionCommands(
  dependencies: StartupQuestionCommandDependencies = defaultStartupQuestionCommandDependencies
): Promise<void> {
  await runNonfatalStartupOperation('[StartupSeed]', async () => {
    if (await dependencies.countKnowledgePoints() !== 0) return;
    console.log('[Seed] knowledge_points table empty, importing bundled exam points...');
    const result = await dependencies.seedKnowledgeMap();
    console.log(`[Seed] Imported ${result.importedCount} exam points, ${result.failedCount} failed`);
  }, dependencies);

  await runNonfatalStartupOperation('[StartupCategoryMigration]', async () => {
    console.log('[Migration] Migrating old category values...');
    let migrated = 0;
    while (true) {
      const result = await dependencies.executeQuestionCommand({
        type: 'questions.migrate_categories',
        payload: { limit: STARTUP_QUESTION_BATCH_SIZE }
      });
      const batchMigrated = (result.value as { migrated: number }).migrated;
      migrated += batchMigrated;
      if (batchMigrated < STARTUP_QUESTION_BATCH_SIZE) break;
    }
    console.log(`[Migration] Processed ${migrated} category mappings`);
  }, dependencies);

  await runNonfatalStartupOperation('[StartupKnowledgeRematch]', async () => {
    console.log('[Rematch] Re-matching questions to exam points...');
    const questionIds = await dependencies.listQuestionIds();
    let scannedQuestions = 0;
    let insertedCount = 0;
    for (let offset = 0; offset < questionIds.length; offset += STARTUP_QUESTION_BATCH_SIZE) {
      const result = await dependencies.executeQuestionCommand({
        type: 'questions.rematch_knowledge',
        payload: {
          limit: STARTUP_QUESTION_BATCH_SIZE,
          questionIds: questionIds.slice(offset, offset + STARTUP_QUESTION_BATCH_SIZE)
        }
      });
      const batch = result.value as { scannedQuestions: number; insertedCount: number };
      scannedQuestions += batch.scannedQuestions;
      insertedCount += batch.insertedCount;
    }
    console.log(`[Rematch] Scanned ${scannedQuestions} questions, ${insertedCount} new links`);
  }, dependencies);
}

export interface MainStartupDependencies {
  initializePaths(): unknown;
  initializeDatabase(): Promise<DatabaseInitializationResult>;
  assertDatabaseReadyForRuntimeIpc(): void;
  runStartupQuestionCommands?: () => Promise<void>;
  runCompatibilityStartupWriters?: () => Promise<void>;
  initializeStudySupervisor?: () => Promise<void>;
  initializeTickTickService?: () => Promise<void>;
  ensureDailyAutoBackup(): void;
  registerImageProtocol(): void;
  registerWindowStateIpc(): void;
  registerRuntimeIpc(): void;
  createWindow(): void;
}

const defaultMainStartupDependencies: MainStartupDependencies = {
  initializePaths,
  initializeDatabase,
  assertDatabaseReadyForRuntimeIpc,
  runStartupQuestionCommands,
  initializeStudySupervisor,
  initializeTickTickService,
  ensureDailyAutoBackup,
  registerImageProtocol,
  registerWindowStateIpc() {
    ipcMain.on('window:saveState', () => saveWindowState());
    ipcMain.handle('window:loadState', () => loadWindowState());
  },
  registerRuntimeIpc: registerIpc,
  createWindow
};

export async function runMainStartup(
  dependencies: MainStartupDependencies = defaultMainStartupDependencies
): Promise<void> {
  dependencies.initializePaths();
  const initialization = await dependencies.initializeDatabase();
  if (initialization.state === 'needs_recovery') dependencies.assertDatabaseReadyForRuntimeIpc();
  const runQuestionCommands = dependencies.runStartupQuestionCommands ?? dependencies.runCompatibilityStartupWriters;
  if (!runQuestionCommands) throw new Error('Startup question command adapter is unavailable');
  const usesCompatibilitySeam = !dependencies.runStartupQuestionCommands;
  if (usesCompatibilitySeam) dependencies.assertDatabaseReadyForRuntimeIpc();
  await runQuestionCommands();
  if (usesCompatibilitySeam) {
    await dependencies.initializeStudySupervisor?.();
    await dependencies.initializeTickTickService?.();
  } else {
    if (!dependencies.initializeStudySupervisor) throw new Error('Study supervisor startup initializer is unavailable');
    await dependencies.initializeStudySupervisor();
    if (!dependencies.initializeTickTickService) throw new Error('TickTick startup initializer is unavailable');
    await dependencies.initializeTickTickService();
    dependencies.assertDatabaseReadyForRuntimeIpc();
  }
  try {
    dependencies.ensureDailyAutoBackup();
  } catch (error) {
    console.warn('[AutoBackup]', error);
  }
  dependencies.registerImageProtocol();
  dependencies.registerWindowStateIpc();
  dependencies.registerRuntimeIpc();
  dependencies.createWindow();
}

process.on('uncaughtException', reportStartupError);
process.on('unhandledRejection', reportStartupError);

if (singleInstanceLock) {
app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  try {
    await runMainStartup();
  } catch (error) {
    reportStartupError(error);
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
}

app.on('window-all-closed', () => {
  isQuitting = true;
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  isQuitting = true;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.destroy();
  }
  if (shutdownComplete) return;
  event.preventDefault();
  if (!mainShutdownPromise) {
    mainShutdownPromise = shutdownDatabase()
      .catch((error) => console.warn('[ShutdownPersist]', error))
      .finally(() => {
        shutdownComplete = true;
        app.quit();
      });
  }
});

app.on('will-quit', () => {
  try {
    protocol.unhandle('mistake-image');
  } catch {
    // Protocol may not have been registered if startup failed early.
  }
  killOcrProcess();
  resetDatabaseConnection();
});

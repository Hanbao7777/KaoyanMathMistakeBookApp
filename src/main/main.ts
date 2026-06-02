import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron';
import { initializeDatabase } from './services/databaseService';
import { persistDatabase, resetDatabaseConnection } from './services/databaseService';
import { killOcrProcess } from './services/ocrService';
import { initializePaths } from './services/pathService';
import { registerIpc } from './ipc/registerIpc';
import { seedImportKnowledgeMap, rematchKnowledgePoints } from './services/knowledgeMapService';
import { getDatabase, migrateCategoryValues } from './services/databaseService';
import { ensureDailyAutoBackup } from './services/backupService';

const isDev = !app.isPackaged && process.env.KAOYAN_USE_RENDERER_BUILD !== '1';
let mainWindow: BrowserWindow | null = null;
let isQuitting = false;

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
    initializePaths();
    await initializeDatabase();

    // Seed exam points on first launch, then migrate categories and re-match questions
    try {
      const database = await getDatabase();
      const countResult = database.exec('SELECT COUNT(*) as c FROM knowledge_points WHERE deleted_at IS NULL OR deleted_at = ""');
      const count = countResult.length && countResult[0].values.length ? Number(countResult[0].values[0][0]) : 0;

      if (count === 0) {
        console.log('[Seed] knowledge_points table empty, importing bundled exam points...');
        const seedResult = await seedImportKnowledgeMap();
        console.log(`[Seed] Imported ${seedResult.importedCount} exam points, ${seedResult.failedCount} failed`);
      }

      console.log('[Migration] Migrating old category values...');
      const migrateResult = await migrateCategoryValues();
      console.log(`[Migration] Processed ${migrateResult.migrated} category mappings`);

      console.log('[Rematch] Re-matching questions to exam points...');
      const rematchResult = await rematchKnowledgePoints();
      console.log(`[Rematch] Scanned ${rematchResult.scannedQuestions} questions, ${rematchResult.insertedCount} new links, ${rematchResult.unmatchedQuestions} unmatched`);
    } catch (error) {
      console.warn('[StartupSeed]', error);
    }

    try {
      ensureDailyAutoBackup();
    } catch (error) {
      console.warn('[AutoBackup]', error);
    }
    registerImageProtocol();
    ipcMain.on('window:saveState', () => saveWindowState());
    ipcMain.handle('window:loadState', () => loadWindowState());
    registerIpc();
    createWindow();
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

app.on('before-quit', () => {
  isQuitting = true;
  try {
    persistDatabase();
  } catch (error) {
    console.warn('[ShutdownPersist]', error);
  }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.destroy();
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

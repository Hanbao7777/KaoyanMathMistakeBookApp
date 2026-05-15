import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, net, protocol } from 'electron';
import { initializeDatabase } from './services/databaseService';
import { persistDatabase, resetDatabaseConnection } from './services/databaseService';
import { initializePaths } from './services/pathService';
import { registerIpc } from './ipc/registerIpc';
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

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
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

  win.on('close', () => {
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
    try {
      ensureDailyAutoBackup();
    } catch (error) {
      console.warn('[AutoBackup]', error);
    }
    registerImageProtocol();
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
  resetDatabaseConnection();
});

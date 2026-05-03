import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, net, protocol } from 'electron';
import { initializeDatabase } from './services/databaseService';
import { initializePaths } from './services/pathService';
import { registerIpc } from './ipc/registerIpc';
import { ensureDailyAutoBackup } from './services/backupService';

const isDev = !app.isPackaged && process.env.KAOYAN_USE_RENDERER_BUILD !== '1';

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

  if (isDev) {
    win.loadURL('http://127.0.0.1:5173');
  } else {
    win.loadFile(path.join(__dirname, '../../renderer/index.html'));
  }
}

app.whenReady().then(async () => {
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

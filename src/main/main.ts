import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, net, Notification, protocol } from 'electron';
import {
  assertDatabaseReadyForRuntimeIpc,
  getQuestionsApplication,
  getAgentControlPlane,
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
import { agentPairingRuntimePaths, configureDirectHttpsStatus, configureExternalControlLifecycle, configureDirectHttpsController } from './ipc/adapters/agentControlCenterIpc';
import { seedImportKnowledgeMap } from './services/knowledgeMapService';
import { initializeStudySupervisor } from './services/studySupervisorService';
import { initializeTickTickService } from './services/ticktickService';
import { ensureDailyAutoBackup } from './services/backupService';
import { createConfiguredDirectHttpsOAuthResourceHost, McpLoopbackHost } from './mcp/server';
import { LocalOAuthAuthorizationServer } from './mcp/auth/oauthAuthorizationServer';
import { createOAuthMetadata } from './mcp/auth/oauthMetadata';
import { DirectHttpsOAuthController } from './mcp/runtime/directHttpsOAuthController';
import { CurrentUserKeyStore } from './mcp/tls/currentUserKeyStore';
import { CurrentUserRootCaLifecycle } from './mcp/tls/currentUserRootCa';
import { CurrentUserRootIssuer } from './mcp/tls/currentUserRootIssuer';
import { createMcpProtocolHandler, mcpInitializeResult } from './mcp/protocol';
import type {
  QuestionCategoryMigrationCommand,
  QuestionRematchCommand
} from '../shared/agent/v1/contracts';
const isDev = !app.isPackaged && process.env.KAOYAN_USE_RENDERER_BUILD !== '1';
const e2eHarnessEnabled = process.env.KAOYAN_E2E_HARNESS === '1';
const E2E_RESULT_CHANNEL = 'agentControl:e2e:writeResult';
const REAL_DATA_ROOT = path.resolve('D:\\KaoyanMathMistakeBook');
const E2E_MAX_ASSERTIONS = 100;
let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
let shutdownComplete = false;
let mainShutdownPromise: Promise<void> | null = null;
let e2eResultChannelRegistered = false;
let e2eResultSubmitted = false;
let mcpLoopbackHost: McpLoopbackHost | null = null;
let directHttpsController: DirectHttpsOAuthController | null = null;
let agentStartupNotificationShown = false;

export function isAgentStartupMode(argumentsList: readonly string[] = process.argv): boolean {
  return argumentsList.includes('--agent-startup');
}

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
    show: !isAgentStartupMode(),
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
    win.loadFile(path.join(__dirname, '../../renderer/index.html'), e2eHarnessEnabled ? { hash: '/e2e-agent-control' } : undefined);
  }
}

function notifyAgentStartupReady(): void {
  if (agentStartupNotificationShown || !isAgentStartupMode() || mcpLoopbackHost?.status().state !== 'ready' || !Notification.isSupported()) return;
  agentStartupNotificationShown = true;
  new Notification({ title: '考研高数错题本', body: '外部智能体连接服务已在后台准备就绪。' }).show();
}

interface E2eHarnessPaths {
  readonly root: string;
  readonly fixtureFile: string;
  readonly resultFile: string;
}

interface E2eHarnessResult {
  readonly ok: boolean;
  readonly assertions: readonly string[];
  readonly error?: string;
}

function isSameOrDescendant(candidate: string, ancestor: string): boolean {
  const relative = path.relative(ancestor, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertNotRealDataRelationship(candidate: string, label: string): void {
  const normalizedCandidate = path.resolve(candidate).toLowerCase();
  const normalizedRealRoot = REAL_DATA_ROOT.toLowerCase();
  if (isSameOrDescendant(normalizedCandidate, normalizedRealRoot) || isSameOrDescendant(normalizedRealRoot, normalizedCandidate)) {
    throw new Error(`${label} cannot relate to the real data root`);
  }
}

function strictHarnessPath(value: string | undefined, label: string, expectedKind: 'file' | 'directory'): { readonly path: string; readonly root: string } {
  if (!value) throw new Error(`${label} is required for the E2E harness`);
  assertNotRealDataRelationship(value, label);
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const candidate = fs.realpathSync.native(value);
  assertNotRealDataRelationship(candidate, label);
  const relative = path.relative(tempRoot, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must be an existing strict descendant of a kaoyan-* temporary root`);
  }
  const firstPart = relative.split(path.sep)[0];
  if (!firstPart?.toLowerCase().startsWith('kaoyan-')) {
    throw new Error(`${label} must be an existing strict descendant of a kaoyan-* temporary root`);
  }
  const root = fs.realpathSync.native(path.join(tempRoot, firstPart));
  if (path.dirname(root).toLowerCase() !== tempRoot.toLowerCase() || root.toLowerCase() === candidate.toLowerCase()) {
    throw new Error(`${label} must be below a unique kaoyan-* temporary root`);
  }
  const stats = fs.statSync(candidate);
  if ((expectedKind === 'file' && !stats.isFile()) || (expectedKind === 'directory' && !stats.isDirectory())) {
    throw new Error(`${label} must be an existing ${expectedKind}`);
  }
  return Object.freeze({ path: candidate, root });
}

function validateE2eHarnessEnvironment(): E2eHarnessPaths {
  const fixture = strictHarnessPath(process.env.KAOYAN_E2E_FIXTURE_FILE, 'Fixture file', 'file');
  const result = strictHarnessPath(process.env.KAOYAN_E2E_RESULT_FILE, 'Result file', 'file');
  const userData = strictHarnessPath(app.getPath('userData'), 'Electron userData directory', 'directory');
  if (fixture.root.toLowerCase() !== result.root.toLowerCase() || fixture.root.toLowerCase() !== userData.root.toLowerCase()) {
    throw new Error('E2E fixture, result, and userData paths must share one unique kaoyan-* temporary root');
  }
  if (fixture.path.toLowerCase() === result.path.toLowerCase()) throw new Error('E2E fixture and result files must be distinct');

  const configPath = path.join(userData.path, 'data-root.json');
  const config = strictHarnessPath(configPath, 'E2E data-root configuration', 'file');
  if (config.root.toLowerCase() !== fixture.root.toLowerCase()) throw new Error('E2E data-root configuration must share the harness temporary root');
  const rawConfig = fs.readFileSync(config.path, 'utf8');
  if (Buffer.byteLength(rawConfig, 'utf8') > 4_096) throw new Error('E2E data-root configuration is too large');
  let parsedConfig: unknown;
  try { parsedConfig = JSON.parse(rawConfig); } catch { throw new Error('E2E data-root configuration is malformed'); }
  if (!parsedConfig || typeof parsedConfig !== 'object' || Array.isArray(parsedConfig) || Object.keys(parsedConfig).length !== 1 || typeof (parsedConfig as { root?: unknown }).root !== 'string') {
    throw new Error('E2E data-root configuration is malformed');
  }
  const dataRoot = strictHarnessPath((parsedConfig as { root: string }).root, 'E2E data root', 'directory');
  if (dataRoot.root.toLowerCase() !== fixture.root.toLowerCase()) throw new Error('E2E data root must share the harness temporary root');
  if (isSameOrDescendant(dataRoot.path, userData.path) || isSameOrDescendant(userData.path, dataRoot.path)) {
    throw new Error('E2E data root and userData directory must not overlap');
  }
  for (const [label, target] of [['fixture', fixture.path], ['result', result.path]] as const) {
    if (isSameOrDescendant(target, userData.path) || isSameOrDescendant(target, dataRoot.path)) {
      throw new Error(`E2E ${label} file must not overlap userData or the data root`);
    }
  }
  return Object.freeze({ root: fixture.root, fixtureFile: fixture.path, resultFile: result.path });
}

function validateE2eResult(result: unknown): E2eHarnessResult {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid E2E result');
  const keys = Object.keys(result);
  if (keys.some((key) => !['ok', 'assertions', 'error'].includes(key)) || !keys.includes('ok') || !keys.includes('assertions')) throw new Error('Invalid E2E result');
  const value = result as { ok?: unknown; assertions?: unknown; error?: unknown };
  if (
    typeof value.ok !== 'boolean' || !Array.isArray(value.assertions) || value.assertions.length > E2E_MAX_ASSERTIONS ||
    value.assertions.some((item) => typeof item !== 'string' || item.length < 1 || item.length > 200) ||
    (value.error !== undefined && (typeof value.error !== 'string' || value.error.length < 1 || value.error.length > 2_000)) ||
    (value.ok ? value.error !== undefined : typeof value.error !== 'string')
  ) throw new Error('Invalid E2E result');
  return Object.freeze({ ok: value.ok, assertions: Object.freeze([...value.assertions]), ...(value.error ? { error: value.error } : {}) });
}

function registerE2eResultChannel(paths: E2eHarnessPaths): void {
  if (!e2eHarnessEnabled) throw new Error('E2E result channel requires the exact harness guard');
  if (e2eResultChannelRegistered) throw new Error('E2E result channel is already registered');
  e2eResultChannelRegistered = true;
  const resultHandle = fs.openSync(paths.resultFile, 'r+');
  ipcMain.handle(E2E_RESULT_CHANNEL, (_event, result: unknown) => {
    if (!e2eHarnessEnabled) throw new Error('E2E result channel is unavailable');
    if (e2eResultSubmitted) throw new Error('E2E result was already submitted');
    const value = validateE2eResult(result);
    e2eResultSubmitted = true;
    fs.ftruncateSync(resultHandle, 0);
    fs.writeFileSync(resultHandle, JSON.stringify(value), 'utf8');
    fs.fsyncSync(resultHandle);
    fs.closeSync(resultHandle);
    setTimeout(() => app.quit(), 30);
    return { ok: true, data: undefined };
  });
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
  ensureDailyAutoBackup(): void | Promise<unknown>;
  registerImageProtocol(): void;
  registerWindowStateIpc(): void;
  registerRuntimeIpc(): void;
  startMcpHost?(): Promise<void>;
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
  async startMcpHost() {
    const controlPlane = await getAgentControlPlane();
    const appInstanceId = controlPlane.httpOAuthAuthority.appInstanceId;
    const currentAuthority = async () => Object.freeze({ ...((await controlPlane.registry.getHttpOAuthAuthority()) ?? controlPlane.httpOAuthAuthority), appInstanceId });
    const initialAuthority = await currentAuthority();
    const directOauthScopes = Object.freeze(['system.read'] as const);
    const oauth = new LocalOAuthAuthorizationServer({ metadata: createOAuthMetadata({ authority: initialAuthority, scopes: directOauthScopes }), tokenStore: controlPlane.httpOAuthTokens, appInstanceId, clients: { getHttpClient: (id) => controlPlane.registry.getHttpClient(id), isHttpClientActive: (id) => controlPlane.registry.isHttpClientActive(id), currentScopes: (id) => controlPlane.registry.getHttpClientScopes(id) } });
    const controller = new DirectHttpsOAuthController({ authority: currentAuthority, updateAuthority: (value) => controlPlane.registry.updateHttpOAuthAuthority({ ...value, appInstanceId }), updateAuthorityInTransaction: (database, scope, value) => controlPlane.registry.updateHttpOAuthAuthorityInTransaction(database, scope, { ...value, appInstanceId }), executeControlWrite: controlPlane.executeControlWrite, audit: controlPlane.audit, keyStore: new CurrentUserKeyStore(), issuer: new CurrentUserRootIssuer(), roots: new CurrentUserRootCaLifecycle(), oauth, oauthTokenRecovery: () => controlPlane.httpOAuthTokens.invalidateAuthorizationCodes(), oauthScopes: directOauthScopes, ensureClients: async (authority) => {
      await controlPlane.registry.ensureHttpClient({ clientId: 'kaoyan-codex-local', product: 'codex', versionEvidence: 'codex-cli 0.144.3', redirectMode: 'codex-loopback', resource: authority.resource, issuer: authority.issuer, allowedScopes: ['system.read'], trust: 'observer', refreshTokensAllowed: true });
      await controlPlane.registry.ensureHttpClient({ clientId: 'kaoyan-claude-local', product: 'claude_code', versionEvidence: '2.1.216 (Claude Code)', redirectMode: 'claude-exact', exactRedirectUri: 'http://localhost:39457/callback', resource: authority.resource, issuer: authority.issuer, allowedScopes: ['system.read'], trust: 'observer', refreshTokensAllowed: true });
    }, refreshAuthenticator: (authority) => controlPlane.httpAuthenticator.setAuthority(authority, appInstanceId), createHost: (authority) => createConfiguredDirectHttpsOAuthResourceHost({ controlPlane, authority, oauth }) });
    directHttpsController = controller;
    await controller.reconcile();
    const pairingRuntimePaths = agentPairingRuntimePaths(app.getPath('userData'));
    const host = new McpLoopbackHost({
      discoveryRoot: pairingRuntimePaths.discoveryRoot,
      instanceId: appInstanceId,
      externalControlEnabled: controlPlane.externalControlEnabled,
      authenticatedReady: () => controlPlane.stdioAuthenticator.ready(),
      authenticator: controlPlane.stdioAuthenticator,
      gateway: controlPlane.gateway,
      initializeResult: mcpInitializeResult,
      onAuthenticatedRequest: createMcpProtocolHandler({ gateway: controlPlane.gateway }),
    });
    mcpLoopbackHost = host;
    configureDirectHttpsStatus(() => {
      const snapshot = directHttpsController?.statusSnapshot();
      if (!snapshot) return undefined;
      const { enabled: _enabled, ...runtime } = snapshot as { readonly enabled?: boolean; readonly [key: string]: unknown };
      return runtime as never;
    });
    configureDirectHttpsController(controller);
    configureExternalControlLifecycle(async (enabled) => {
      if (enabled) { await host.start(); await controller.startIfAuthorized(); }
      else { await controller.disable(); await host.disable(); }
    });
    await host.start();
    await controller.startIfAuthorized();
  },
  createWindow
};

export async function runMainStartup(
  dependencies: MainStartupDependencies = defaultMainStartupDependencies
): Promise<void> {
  const harnessPaths = e2eHarnessEnabled ? validateE2eHarnessEnvironment() : undefined;
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
    await dependencies.ensureDailyAutoBackup();
  } catch (error) {
    console.warn('[AutoBackup]', error);
  }
  dependencies.registerImageProtocol();
  dependencies.registerWindowStateIpc();
  dependencies.registerRuntimeIpc();
  if (initialization.state === 'writable') await dependencies.startMcpHost?.();
  notifyAgentStartupReady();
  if (harnessPaths) {
    const { applyAgentControlCenterFixture } = await import('./e2e/agentControlCenterFixture');
    await applyAgentControlCenterFixture(harnessPaths.fixtureFile);
    registerE2eResultChannel(harnessPaths);
  }
  dependencies.createWindow();
}

process.on('uncaughtException', reportStartupError);
process.on('unhandledRejection', reportStartupError);

if (singleInstanceLock) {
  app.on('second-instance', (_event, commandLine) => {
    if (isAgentStartupMode(commandLine)) return;
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
    mainShutdownPromise = Promise.resolve()
      .then(async () => {
        const host = mcpLoopbackHost;
        mcpLoopbackHost = null;
         await directHttpsController?.stop();
         directHttpsController = null;
         await host?.stop();
      })
      .then(() => shutdownDatabase())
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

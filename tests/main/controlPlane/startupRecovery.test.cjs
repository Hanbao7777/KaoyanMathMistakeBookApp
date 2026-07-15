const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const initSqlJs = require('sql.js');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const databaseService = environment.databaseService;
const pathService = environment.requireMain('services/pathService.js');
const schema = environment.requireMain('database/schema.js');
const bootstrap = environment.requireMain('persistence/databaseBootstrap.js');
const candidates = environment.requireMain('persistence/databaseCandidate.js');
const operationJournal = environment.requireMain('persistence/operationJournal/index.js');

let SQL;
let nonce = 0;

function nextId(prefix = 'startup') {
  nonce += 1;
  return `${prefix}-${nonce}`;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function currentPaths() {
  return pathService.getPaths();
}

async function resetRoots() {
  databaseService.resetDatabaseConnection();
  fs.rmSync(environment.dataRoot, { recursive: true, force: true });
  fs.rmSync(environment.userDataRoot, { recursive: true, force: true });
  fs.mkdirSync(environment.recoveryRoot, { recursive: true });
  pathService.setDataRoot(environment.dataRoot);
  nonce = 0;
}

function createDatabaseBytes(epoch, revision = 0, legacy = false) {
  const database = new SQL.Database();
  const schemaSql = legacy
    ? schema.schemaSql.replace(schema.controlMetadataSchemaSql, '')
    : schema.schemaSql;
  database.exec(schemaSql);
  if (!legacy) {
    bootstrap.bootstrapControlMetadata(database, {
      createEpoch: () => epoch,
      now: () => '2026-07-15T00:00:00.000Z'
    });
    if (revision > 0) {
      database.run('UPDATE control_metadata SET data_revision = ? WHERE id = 1', [revision]);
    }
  }
  const bytes = database.export();
  database.close();
  return bytes;
}

function readDiskVersion() {
  const database = new SQL.Database(fs.readFileSync(currentPaths().database));
  try {
    const row = database.exec('SELECT data_epoch, data_revision FROM control_metadata')[0].values[0];
    return { dataEpoch: row[0], dataRevision: row[1] };
  } finally {
    database.close();
  }
}

async function initializeWithTrace(extra = {}) {
  const trace = [];
  const result = await databaseService.initializeDatabase({
    createEpoch: () => 'startup-created-epoch',
    randomId: () => nextId('nonce'),
    now: () => '2026-07-15T00:00:00.000Z',
    onStage: (stage) => trace.push(stage),
    ...extra
  });
  return { result, trace };
}

test.before(async () => {
  SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
});
test.beforeEach(resetRoots);
test.after(() => environment.cleanupControlPlaneRoot());

test('starts an existing versioned database in recovery-first order', async () => {
  fs.writeFileSync(currentPaths().database, createDatabaseBytes('existing-epoch', 4));
  const { result, trace } = await initializeWithTrace();

  assert.equal(result.state, 'writable');
  assert.equal(result.bootstrapChanged, false);
  assert.deepEqual(readDiskVersion(), { dataEpoch: 'existing-epoch', dataRevision: 4 });
  assert.deepEqual(trace, [
    'candidate_recovery_started',
    'candidate_recovery_completed',
    'metadata_bootstrap_published',
    'coordinator_created',
    'operation_journal_recovered',
    'ready'
  ]);
});

test('bootstraps a sole legacy database and durably publishes metadata before coordinator creation', async () => {
  fs.writeFileSync(currentPaths().database, createDatabaseBytes('', 0, true));
  const { result, trace } = await initializeWithTrace();

  assert.equal(result.databaseRecovery.status, 'legacy_ready');
  assert.equal(result.bootstrapChanged, true);
  assert.deepEqual(readDiskVersion(), { dataEpoch: 'startup-created-epoch', dataRevision: 0 });
  assert.ok(trace.indexOf('metadata_bootstrap_published') < trace.indexOf('coordinator_created'));
});

test('recovers a pending data-root manifest against the verified database version', async () => {
  await initializeWithTrace();
  const version = (await databaseService.getDatabaseCoordinator()).currentVersion();
  databaseService.resetDatabaseConnection();

  const paths = currentPaths();
  const manifestRoot = path.join(paths.data, 'operation-journal');
  fs.mkdirSync(manifestRoot, { recursive: true });
  const manifest = operationJournal.createOperationManifest({
    operationId: 'pending-create',
    requestId: 'pending-create-request',
    commandType: 'test.pending_create',
    source: 'internal',
    clientId: 'internal',
    traceId: 'pending-create-trace',
    inputHash: '0'.repeat(64),
    storage: 'data_root',
    versionBefore: version,
    versionAfter: { dataEpoch: version.dataEpoch, dataRevision: version.dataRevision + 1 },
    affectedEntities: [{ entityType: 'question', entityId: '1' }],
    roots: { manifestRoot, managedRoots: [paths.root], sourceRoots: [paths.temp] },
    files: [{
      fileId: 'image-create',
      kind: 'create',
      sourcePath: path.join(paths.temp, 'source.png'),
      targetPath: path.join(paths.images, 'pending.png'),
      stagingPath: path.join(paths.temp, 'pending.png'),
      content: { sha256: '1'.repeat(64), size: 10 },
      status: 'pending'
    }],
    createdAt: '2026-07-15T00:00:00.000Z'
  });
  await new operationJournal.OperationManifestStore(manifestRoot).publish(manifest);
  const externalManifestRoot = path.join(environment.recoveryRoot, 'operation-journal');
  fs.mkdirSync(externalManifestRoot, { recursive: true });
  const externalManifest = operationJournal.createOperationManifest({
    operationId: 'pending-external-create',
    requestId: 'pending-external-request',
    commandType: 'test.pending_external_create',
    source: 'internal',
    clientId: 'internal',
    traceId: 'pending-external-trace',
    inputHash: '2'.repeat(64),
    storage: 'external_recovery',
    versionBefore: version,
    versionAfter: { dataEpoch: version.dataEpoch, dataRevision: version.dataRevision + 1 },
    affectedEntities: [{ entityType: 'database', entityId: 'active' }],
    roots: { manifestRoot: externalManifestRoot, managedRoots: [paths.root], sourceRoots: [paths.temp] },
    files: [{
      fileId: 'external-create',
      kind: 'create',
      sourcePath: path.join(paths.temp, 'external-source.bin'),
      targetPath: path.join(paths.images, 'external-pending.bin'),
      stagingPath: path.join(paths.temp, 'external-pending.bin'),
      content: { sha256: '3'.repeat(64), size: 20 },
      status: 'pending'
    }],
    createdAt: '2026-07-15T00:00:00.000Z'
  });
  await new operationJournal.OperationManifestStore(externalManifestRoot).publish(externalManifest);

  const { result } = await initializeWithTrace();
  assert.equal(result.state, 'writable');
  assert.equal(result.journalRecovery.compensated, 2);
  const recovered = await new operationJournal.OperationManifestStore(manifestRoot).read('pending-create');
  assert.equal(recovered.state, 'compensated');
  const recoveredExternal = await new operationJournal.OperationManifestStore(externalManifestRoot).read('pending-external-create');
  assert.equal(recoveredExternal.state, 'compensated');
});

test('corrupt and cross-epoch ambiguous candidates never trigger blank initialization', async () => {
  fs.writeFileSync(currentPaths().database, 'not a sqlite database');
  await assert.rejects(initializeWithTrace(), /Database candidate recovery failed/);
  assert.equal(fs.existsSync(currentPaths().database), false);
  assert.equal(fs.readdirSync(pathsDir()).some((name) => name.endsWith('.quarantine')), true);
  await assert.rejects(initializeWithTrace(), /Database candidate recovery failed/);
  assert.equal(fs.existsSync(currentPaths().database), false);

  await resetRoots();
  fs.writeFileSync(currentPaths().database, createDatabaseBytes('epoch-a', 5));
  const tempPath = path.join(pathsDir(), '.mistakes.db.other-epoch.nonce.tmp');
  fs.writeFileSync(tempPath, createDatabaseBytes('epoch-b', 0));
  await assert.rejects(initializeWithTrace(), /Database candidate recovery failed: ambiguous_candidates/);
  assert.deepEqual(readCandidateVersion(currentPaths().database), { dataEpoch: 'epoch-a', dataRevision: 5 });
  assert.deepEqual(readCandidateVersion(tempPath), { dataEpoch: 'epoch-b', dataRevision: 0 });
});

test('malformed manifests fence the verified database before runtime IPC admission', async () => {
  await initializeWithTrace();
  databaseService.resetDatabaseConnection();
  const manifestRoot = path.join(currentPaths().data, 'operation-journal');
  fs.mkdirSync(manifestRoot, { recursive: true });
  fs.writeFileSync(path.join(manifestRoot, 'broken.operation.json'), '{broken', 'utf8');

  const { result, trace } = await initializeWithTrace();
  assert.equal(result.state, 'needs_recovery');
  assert.equal(result.journalRecovery.needsRecovery, 1);
  assert.equal((await databaseService.getDatabaseCoordinator()).state, 'needs_recovery');
  assert.throws(() => databaseService.assertDatabaseReadyForRuntimeIpc(), /requires attention/);
  assert.equal(trace.at(-1), 'needs_recovery');
});

test('coordinator handle replacement keeps service reads coherent and closes the prior handle once', async () => {
  await initializeWithTrace();
  const coordinator = await databaseService.getDatabaseCoordinator();
  const previous = await databaseService.getDatabase();
  const result = await coordinator.executeWrite({
    requestId: 'handle-replacement',
    concurrency: 'none',
    execute(database) {
      database.run('CREATE TABLE a7_handle_test (value TEXT NOT NULL)');
      database.run("INSERT INTO a7_handle_test VALUES ('coherent')");
      return { changed: true, value: true };
    }
  });
  const active = await databaseService.getDatabase();
  const readOnly = await databaseService.getReadOnlyDatabase();

  assert.notEqual(active, previous);
  assert.equal(result.versionAfter.dataRevision, result.versionBefore.dataRevision + 1);
  assert.throws(() => previous.exec('SELECT 1'), /closed/i);
  assert.deepEqual(readOnly.select('SELECT value FROM a7_handle_test'), [{ value: 'coherent' }]);
  assert.throws(() => readOnly.select("UPDATE a7_handle_test SET value = 'bad'"), (error) => error.code === 'VALIDATION_ERROR');
});

test('shutdown performs one verified final publication and repeated calls share the same drain', async () => {
  await initializeWithTrace();
  const coordinator = await databaseService.getDatabaseCoordinator();
  const before = coordinator.currentVersion();
  const entered = deferred();
  const release = deferred();
  const blocker = coordinator.executeWrite({
    requestId: 'shutdown-pre-admitted-blocker',
    concurrency: 'none',
    async execute() {
      entered.resolve();
      await release.promise;
      return { changed: false, value: null };
    }
  });
  await entered.promise;
  const first = databaseService.shutdownDatabase();
  const second = databaseService.shutdownDatabase();
  let lateCallbackRan = false;
  const lateAdmission = coordinator.executeWrite({
    requestId: 'shutdown-late-admission',
    concurrency: 'none',
    execute() {
      lateCallbackRan = true;
      return { changed: false, value: null };
    }
  });

  assert.equal(first, second);
  assert.equal(coordinator.state, 'shutting_down');
  await assert.rejects(lateAdmission, (error) => error.code === 'MAINTENANCE_FENCE');
  assert.equal(lateCallbackRan, false);
  release.resolve();
  await blocker;
  await Promise.all([first, second]);

  assert.equal(coordinator.state, 'shutdown');
  assert.deepEqual(readDiskVersion(), { dataEpoch: before.dataEpoch, dataRevision: before.dataRevision + 1 });
  assert.equal(databaseService.shutdownDatabase(), first);
  await assert.rejects(
    coordinator.executeWrite({ requestId: 'after-shutdown', concurrency: 'none', execute: () => ({ changed: false, value: null }) }),
    (error) => error.code === 'MAINTENANCE_FENCE'
  );
});

test('main startup seam registers runtime IPC only after recovery and compatibility startup', async () => {
  const electron = require('electron');
  const appEvents = new Map();
  Object.assign(electron.app, {
    isPackaged: true,
    requestSingleInstanceLock: () => false,
    quit: () => undefined,
    on: (name, listener) => appEvents.set(name, listener),
    whenReady: () => Promise.resolve()
  });
  electron.BrowserWindow = class BrowserWindow { static getAllWindows() { return []; } };
  electron.dialog.showErrorBox = () => undefined;
  electron.ipcMain = { on: () => undefined, handle: () => undefined };
  electron.net = { fetch: () => undefined };
  electron.protocol = {
    registerSchemesAsPrivileged: () => undefined,
    handle: () => undefined,
    unhandle: () => undefined
  };
  const originalSetInterval = global.setInterval;
  global.setInterval = () => ({ unref() {} });
  const main = environment.requireMain('main.js');
  global.setInterval = originalSetInterval;
  const trace = [];
  await main.runMainStartup({
    initializePaths: () => trace.push('paths'),
    initializeDatabase: async () => {
      trace.push('candidate');
      trace.push('metadata');
      trace.push('coordinator');
      trace.push('journal');
      return { state: 'writable', bootstrapChanged: false, databaseRecovery: { status: 'empty' }, journalRecovery: { outcomes: [], completed: 0, compensated: 0, needsRecovery: 0 } };
    },
    assertDatabaseReadyForRuntimeIpc: () => trace.push('admission'),
    runCompatibilityStartupWriters: async () => trace.push('seed-migrate-rematch'),
    ensureDailyAutoBackup: () => trace.push('backup'),
    registerImageProtocol: () => trace.push('protocol'),
    registerWindowStateIpc: () => trace.push('window-ipc'),
    registerRuntimeIpc: () => trace.push('runtime-ipc'),
    createWindow: () => trace.push('window')
  });

  assert.deepEqual(trace, [
    'paths', 'candidate', 'metadata', 'coordinator', 'journal', 'admission',
    'seed-migrate-rematch', 'backup', 'protocol', 'window-ipc', 'runtime-ipc', 'window'
  ]);
});

function pathsDir() {
  return path.dirname(currentPaths().database);
}

function readCandidateVersion(filePath) {
  const database = new SQL.Database(fs.readFileSync(filePath));
  try {
    const row = database.exec('SELECT data_epoch, data_revision FROM control_metadata')[0].values[0];
    return { dataEpoch: row[0], dataRevision: row[1] };
  } finally {
    database.close();
  }
}

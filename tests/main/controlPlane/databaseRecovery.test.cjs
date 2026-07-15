const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const initSqlJs = require('sql.js');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const recovery = environment.requireMain('persistence/recoveryState.js');
const candidates = environment.requireMain('persistence/databaseCandidate.js');
const root = path.join(environment.dataRoot, 'database-recovery');
const livePath = path.join(root, 'mistakes.db');
let SQL;
let opener;
let nonce;

function databaseBytes(version, options = {}) {
  const db = new SQL.Database();
  if (options.legacy) {
    db.exec('CREATE TABLE legacy_data (id INTEGER PRIMARY KEY)');
  } else if (options.malformed) {
    db.exec('CREATE TABLE control_metadata (id, data_epoch, data_revision)');
    db.run("INSERT INTO control_metadata VALUES (1, 'epoch-a', 1), (2, 'epoch-a', 2)");
  } else {
    const hasControlRevision = Number.isSafeInteger(options.controlRevision);
    db.exec(`
      CREATE TABLE control_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data_epoch TEXT NOT NULL,
        data_revision INTEGER NOT NULL${hasControlRevision ? ',\n        control_revision INTEGER NOT NULL CHECK (control_revision >= 0)' : ''}
      );
      CREATE TABLE data (id INTEGER PRIMARY KEY);
    `);
    db.run(
      hasControlRevision
        ? 'INSERT INTO control_metadata VALUES (1, ?, ?, ?)'
        : 'INSERT INTO control_metadata VALUES (1, ?, ?)',
      hasControlRevision
        ? [version.dataEpoch, version.dataRevision, options.controlRevision]
        : [version.dataEpoch, version.dataRevision]
    );
  }
  const bytes = db.export();
  db.close();
  return bytes;
}

async function resetRoot() {
  await fs.promises.rm(root, { recursive: true, force: true });
  await fs.promises.mkdir(root, { recursive: true });
  nonce = 0;
}

async function write(filePath, version, options) {
  await fs.promises.writeFile(filePath, databaseBytes(version, options));
}

function tempPath(name) {
  return path.join(root, `.mistakes.db.${name}.nonce.tmp`);
}

function recover(options = {}) {
  return recovery.recoverStartupDatabase({
    livePath,
    opener,
    randomId: () => `recovery-${++nonce}`,
    ...options
  });
}

async function liveCandidate() {
  return candidates.inspectDatabaseFile(livePath, 'live', opener);
}

test.before(async () => {
  SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
  opener = candidates.createSqlJsCandidateOpener(SQL);
});
test.beforeEach(resetRoot);
test.after(() => environment.cleanupControlPlaneRoot());

test('selects and reopens a sole verified live database', async () => {
  await write(livePath, { dataEpoch: 'epoch-a', dataRevision: 2 });
  const result = await recover();
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.version, { dataEpoch: 'epoch-a', dataRevision: 2 });
  assert.equal(result.candidate.kind, 'live');
  assert.equal(result.quarantined.length, 0);
  const db = new SQL.Database(result.bytes);
  assert.deepEqual(db.exec('SELECT data_epoch, data_revision FROM control_metadata')[0].values[0], ['epoch-a', 2]);
  db.close();
});

test('promotes the highest same-epoch temp and preserves lower candidates as evidence', async () => {
  await write(livePath, { dataEpoch: 'epoch-a', dataRevision: 1 });
  await write(candidates.databasePreviousPath(livePath), { dataEpoch: 'epoch-a', dataRevision: 0 });
  const selectedTemp = tempPath('highest');
  await write(selectedTemp, { dataEpoch: 'epoch-a', dataRevision: 3 });
  const result = await recover();
  assert.equal(result.status, 'ready');
  assert.equal(result.decision.candidate.kind, 'temp');
  assert.deepEqual(result.version, { dataEpoch: 'epoch-a', dataRevision: 3 });
  assert.equal(fs.existsSync(selectedTemp), false);
  assert.equal(result.quarantined.length, 1);
  assert.deepEqual((await liveCandidate()).version, result.version);
});

test('recovers a valid previous generation when live is corrupt', async () => {
  await fs.promises.writeFile(livePath, 'corrupt live');
  const previousPath = candidates.databasePreviousPath(livePath);
  await write(previousPath, { dataEpoch: 'epoch-a', dataRevision: 4 });
  const result = await recover();
  assert.equal(result.status, 'ready');
  assert.equal(result.decision.candidate.kind, 'previous');
  assert.deepEqual(result.version, { dataEpoch: 'epoch-a', dataRevision: 4 });
  assert.equal(result.quarantined.length, 1);
  assert.equal(fs.existsSync(result.quarantined[0]), true);
});

test('quarantines corrupt and malformed non-selected candidates', async () => {
  await write(livePath, { dataEpoch: 'epoch-a', dataRevision: 5 });
  await fs.promises.writeFile(tempPath('corrupt'), 'not sqlite');
  await write(tempPath('malformed'), undefined, { malformed: true });
  const result = await recover();
  assert.equal(result.status, 'ready');
  assert.equal(result.quarantined.length, 2);
  assert.equal(result.quarantined.every((filePath) => fs.existsSync(filePath)), true);
  const scan = await candidates.scanDatabaseCandidates({ livePath, opener });
  assert.equal(scan.status, 'scanned');
  assert.equal(scan.candidates.some((candidate) => candidate.status === 'invalid'), false);
});

test('returns typed recovery fences for no valid, mixed metadata, and multiple legacy candidates', async () => {
  await fs.promises.writeFile(livePath, 'corrupt only candidate');
  let result = await recover();
  assert.equal(result.status, 'needs_recovery');
  assert.equal(result.reason, 'no_valid_candidate');
  assert.equal(result.quarantined.length, 1);
  assert.equal(fs.existsSync(result.quarantined[0]), true);

  await resetRoot();
  await fs.promises.writeFile(livePath, databaseBytes(undefined, { legacy: true }));
  await write(tempPath('versioned'), { dataEpoch: 'epoch-a', dataRevision: 0 });
  result = await recover();
  assert.equal(result.status, 'needs_recovery');
  assert.equal(result.reason, 'ambiguous_candidates');
  assert.equal(result.decision.status, 'ambiguous_metadata');

  await resetRoot();
  await fs.promises.writeFile(livePath, databaseBytes(undefined, { legacy: true }));
  await fs.promises.writeFile(tempPath('legacy'), databaseBytes(undefined, { legacy: true }));
  result = await recover();
  assert.equal(result.status, 'needs_recovery');
  assert.equal(result.decision.status, 'ambiguous_legacy');
});

test('returns a sole legacy live for A3 bootstrap without mutating metadata', async () => {
  await fs.promises.writeFile(livePath, databaseBytes(undefined, { legacy: true }));
  const result = await recover();
  assert.equal(result.status, 'legacy_ready');
  assert.equal(result.candidate.metadata, 'absent');
  const db = new SQL.Database(result.bytes);
  assert.equal(db.exec("SELECT name FROM sqlite_master WHERE name = 'control_metadata'").length, 0);
  db.close();
});

test('prefers live deterministically when same epoch and revision tie', async () => {
  const version = { dataEpoch: 'epoch-a', dataRevision: 7 };
  await write(livePath, version);
  await write(candidates.databasePreviousPath(livePath), version);
  await write(tempPath('same'), version);
  const result = await recover();
  assert.equal(result.status, 'ready');
  assert.equal(result.decision.status, 'selected');
  assert.equal(result.decision.candidate.kind, 'live');
  assert.equal(result.quarantined.length, 0);
});

test('orders same-epoch candidates by data revision then control revision', async () => {
  await write(livePath, { dataEpoch: 'epoch-a', dataRevision: 7 }, { controlRevision: 1 });
  await write(candidates.databasePreviousPath(livePath), { dataEpoch: 'epoch-a', dataRevision: 7 }, { controlRevision: 2 });
  await write(tempPath('control-newest'), { dataEpoch: 'epoch-a', dataRevision: 7 }, { controlRevision: 3 });

  const result = await recover();
  assert.equal(result.status, 'ready');
  assert.equal(result.decision.candidate.kind, 'temp');
  assert.deepEqual(result.version, { dataEpoch: 'epoch-a', dataRevision: 7 });
  assert.deepEqual(result.generation, { dataEpoch: 'epoch-a', dataRevision: 7, controlRevision: 3 });
});

test('never orders opaque epochs and requires an explicit committed transition', async () => {
  await write(livePath, { dataEpoch: 'zzz-older-by-identity-only', dataRevision: 100 });
  await write(tempPath('other-epoch'), { dataEpoch: 'aaa-newer-by-identity-only', dataRevision: 0 });
  let result = await recover();
  assert.equal(result.status, 'needs_recovery');
  assert.equal(result.decision.status, 'ambiguous_epochs');

  result = await recover({
    transitions: [{ fromEpoch: 'zzz-older-by-identity-only', toEpoch: 'aaa-newer-by-identity-only' }]
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.decision.status, 'selected_by_transition');
  assert.deepEqual(result.version, { dataEpoch: 'aaa-newer-by-identity-only', dataRevision: 0 });
});

test('transition evidence requires a fresh target control generation', async () => {
  await write(livePath, { dataEpoch: 'epoch-a', dataRevision: 5 }, { controlRevision: 9 });
  await write(tempPath('target-with-control-history'), { dataEpoch: 'epoch-b', dataRevision: 0 }, { controlRevision: 1 });
  const result = await recover({ transitions: [{ fromEpoch: 'epoch-a', toEpoch: 'epoch-b' }] });
  assert.equal(result.status, 'needs_recovery');
  assert.equal(result.decision.status, 'ambiguous_epochs');
});

test('ambiguous or conflicting transition evidence remains fenced', async () => {
  await write(livePath, { dataEpoch: 'epoch-a', dataRevision: 2 });
  await write(tempPath('epoch-b'), { dataEpoch: 'epoch-b', dataRevision: 0 });
  const decision = recovery.decideStartupDatabaseCandidate(
    (await candidates.scanDatabaseCandidates({ livePath, opener })).candidates,
    [
      { fromEpoch: 'epoch-a', toEpoch: 'epoch-b' },
      { fromEpoch: 'epoch-b', toEpoch: 'epoch-a' }
    ]
  );
  assert.equal(decision.status, 'ambiguous_epochs');
});

test('scan and publication failures become typed recovery fences', async () => {
  let result = await recover({
    files: {
      readFile: fs.promises.readFile,
      readdir: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
      rename: fs.promises.rename
    }
  });
  assert.equal(result.status, 'needs_recovery');
  assert.equal(result.reason, 'scan_failed');

  await write(livePath, { dataEpoch: 'epoch-a', dataRevision: 1 });
  await write(tempPath('newer'), { dataEpoch: 'epoch-a', dataRevision: 2 });
  result = await recover({
    files: {
      readFile: fs.promises.readFile,
      readdir: fs.promises.readdir,
      rename: async () => { throw Object.assign(new Error('rename denied'), { code: 'EACCES' }); }
    }
  });
  assert.equal(result.status, 'needs_recovery');
  assert.equal(result.reason, 'publication_failed');
});

test('runtime state leases are unforgeable and recovery is terminal for writes', () => {
  const state = new recovery.DatabaseRuntimeStateController();
  const lease = state.beginMaintenance();
  assert.equal(state.state, 'maintenance');
  assert.throws(() => state.assertWriteAdmission(), (error) => error.code === 'MAINTENANCE_FENCE');
  assert.throws(() => state.finishMaintenance({ kind: 'database-maintenance-lease' }), /unconsumed maintenance lease/);
  state.finishMaintenance(lease, 'read_only');
  assert.throws(() => state.assertWriteAdmission(), (error) => error.code === 'RECOVERY_FENCE');
  state.resumeWrites();
  state.enterRecovery(new Error('ambiguous disk'));
  assert.equal(state.state, 'needs_recovery');
  assert.throws(() => state.assertWriteAdmission(), (error) => error.code === 'RECOVERY_FENCE');
  assert.throws(() => state.assertAdmittedWriteMayStart(), (error) => error.code === 'RECOVERY_FENCE');
  assert.throws(() => state.enterReadOnly(), (error) => error.code === 'RECOVERY_FENCE');
  state.beginShutdown();
  assert.throws(() => state.assertAdmittedWriteMayStart(), (error) => error.code === 'RECOVERY_FENCE');
  state.finishShutdown();
  assert.equal(state.state, 'shutdown');

  const interruptedShutdown = new recovery.DatabaseRuntimeStateController();
  interruptedShutdown.beginShutdown();
  interruptedShutdown.enterRecovery(new Error('failure while draining'));
  assert.throws(() => interruptedShutdown.assertAdmittedWriteMayStart(), (error) => error.code === 'RECOVERY_FENCE');
  interruptedShutdown.finishShutdown();
  assert.equal(interruptedShutdown.state, 'shutdown');
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const initSqlJs = require('sql.js');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const coordinatorModule = environment.requireMain('persistence/databaseCoordinator.js');
const atomic = environment.requireMain('persistence/atomicPersist.js');
const candidates = environment.requireMain('persistence/databaseCandidate.js');
const root = path.join(environment.dataRoot, 'database-coordinator');
const livePath = path.join(root, 'mistakes.db');
const epoch = 'coordinator-epoch';
let SQL;
let opener;

function createDatabase(revision = 0) {
  const db = new SQL.Database();
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE control_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data_epoch TEXT NOT NULL,
      data_revision INTEGER NOT NULL CHECK (data_revision >= 0),
      schema_version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
  `);
  db.run('INSERT INTO control_metadata VALUES (1, ?, ?, 1, ?)', [epoch, revision, '2026-07-15T00:00:00.000Z']);
  return db;
}

async function resetLive() {
  await fs.promises.rm(root, { recursive: true, force: true });
  await fs.promises.mkdir(root, { recursive: true });
  const db = createDatabase();
  await fs.promises.writeFile(livePath, db.export());
  db.close();
}

function createCoordinator(overrides = {}) {
  const bytes = fs.readFileSync(livePath);
  const database = new SQL.Database(bytes);
  const persistFiles = overrides.persistFiles ?? atomic.defaultAtomicFileDependencies;
  const coordinatorFiles = overrides.coordinatorFiles ?? persistFiles;
  let nonce = 0;
  const coordinator = new coordinatorModule.DatabaseCoordinator({
    database,
    livePath,
    opener,
    openDatabase: (input) => new SQL.Database(input),
    files: coordinatorFiles,
    persistDependencies: {
      opener,
      files: persistFiles,
      randomId: () => `nonce-${++nonce}`,
      ...(overrides.persistDependencies ?? {})
    },
    publisher: overrides.publisher,
    replaceDatabase: overrides.replaceDatabase,
    now: () => '2026-07-15T01:00:00.000Z'
  });
  return coordinator;
}

function write(requestId, execute, options = {}) {
  return {
    requestId,
    concurrency: options.concurrency ?? 'none',
    expectedVersion: options.expectedVersion,
    conflicts: options.conflicts,
    execute
  };
}

function readDisk() {
  return new SQL.Database(fs.readFileSync(livePath));
}

function rows(db) {
  const result = db.exec('SELECT id, value FROM entries ORDER BY id');
  return result.length ? result[0].values : [];
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test.before(async () => {
  SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
  opener = candidates.createSqlJsCandidateOpener(SQL);
});

test.beforeEach(resetLive);
test.after(() => environment.cleanupControlPlaneRoot());

test('serializes admitted writes in strict FIFO order', async () => {
  const coordinator = createCoordinator();
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const trace = [];
  const first = coordinator.executeWrite(write('fifo-1', async (db, scope) => {
    coordinatorModule.assertDatabaseMutationScope(scope, db);
    trace.push('start-1');
    firstEntered.resolve();
    await releaseFirst.promise;
    db.run("INSERT INTO entries VALUES (1, 'one')");
    trace.push('end-1');
    return { changed: true, value: 1 };
  }));
  await firstEntered.promise;
  const second = coordinator.executeWrite(write('fifo-2', async (db) => {
    trace.push('start-2');
    db.run("INSERT INTO entries VALUES (2, 'two')");
    trace.push('end-2');
    return { changed: true, value: 2 };
  }));
  const third = coordinator.executeWrite(write('fifo-3', async (db) => {
    trace.push('start-3');
    db.run("INSERT INTO entries VALUES (3, 'three')");
    trace.push('end-3');
    return { changed: true, value: 3 };
  }));
  assert.equal(coordinator.pendingWrites, 3);
  releaseFirst.resolve();
  const results = await Promise.all([first, second, third]);

  assert.deepEqual(trace, ['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3']);
  assert.deepEqual(results.map((result) => result.versionAfter.dataRevision), [1, 2, 3]);
  assert.deepEqual(coordinator.currentVersion(), { dataEpoch: epoch, dataRevision: 3 });
  const disk = readDisk();
  assert.deepEqual(rows(disk), [[1, 'one'], [2, 'two'], [3, 'three']]);
  disk.close();
});

test('checks competing same-version writes only after FIFO admission', async () => {
  const coordinator = createCoordinator();
  const expectedVersion = coordinator.currentVersion();
  let secondMutated = false;
  const first = coordinator.executeWrite(write('compete-1', (db) => {
    db.run("INSERT INTO entries VALUES (1, 'winner')");
    return { changed: true, value: 'winner' };
  }, { concurrency: 'strict', expectedVersion }));
  const second = coordinator.executeWrite(write('compete-2', (db) => {
    secondMutated = true;
    db.run("INSERT INTO entries VALUES (2, 'loser')");
    return { changed: true, value: 'loser' };
  }, { concurrency: 'strict', expectedVersion, conflicts: [{ entityType: 'entry', entityId: '1' }] }));

  assert.equal((await first).value, 'winner');
  await assert.rejects(second, (error) => {
    assert.equal(error.code, 'DATA_REVISION_CONFLICT');
    assert.deepEqual(error.details.currentVersion, { dataEpoch: epoch, dataRevision: 1 });
    assert.deepEqual(error.details.conflicts, [{ entityType: 'entry', entityId: '1' }]);
    return true;
  });
  assert.equal(secondMutated, false);
});

test('rejects stale epochs before mutation and supports epoch-only admission', async () => {
  const coordinator = createCoordinator();
  let mutated = false;
  await assert.rejects(coordinator.executeWrite(write('stale-epoch', () => {
    mutated = true;
    return { changed: true, value: null };
  }, {
    concurrency: 'epoch-only',
    expectedVersion: { dataEpoch: 'other-epoch', dataRevision: 999 }
  })), (error) => error.code === 'DATA_EPOCH_MISMATCH');
  assert.equal(mutated, false);

  const result = await coordinator.executeWrite(write('epoch-only', (db) => {
    db.run("INSERT INTO entries VALUES (1, 'ok')");
    return { changed: true, value: true };
  }, {
    concurrency: 'epoch-only',
    expectedVersion: { dataEpoch: epoch, dataRevision: 999 }
  }));
  assert.equal(result.versionAfter.dataRevision, 1);
});

test('keeps mutation scopes unforgeable, database-bound, expired, and non-reentrant', async () => {
  const coordinator = createCoordinator();
  const other = createDatabase();
  let capturedScope;
  let capturedDatabase;
  await assert.rejects(coordinator.executeWrite(write('scope-1', async (db, scope) => {
    capturedScope = scope;
    capturedDatabase = db;
    assert.throws(() => coordinatorModule.assertDatabaseMutationScope({ kind: 'database-mutation-scope' }, db), /active database coordinator/);
    assert.throws(() => coordinatorModule.assertDatabaseMutationScope(scope, other), /active database coordinator/);
    await assert.rejects(
      coordinator.executeWrite(write('nested', () => ({ changed: false, value: null }))),
      /Nested or reentrant/
    );
    throw new Error('abort outer');
  })), /abort outer/);
  assert.throws(() => coordinatorModule.assertDatabaseMutationScope(capturedScope, capturedDatabase), /active database coordinator/);
  other.close();
});

test('does not publish or increment revision for a validated no-op', async () => {
  let publications = 0;
  const coordinator = createCoordinator({
    publisher: async () => { publications += 1; throw new Error('must not publish'); }
  });
  const result = await coordinator.executeWrite(write('no-op', () => ({ changed: false, value: 'same' })));
  assert.equal(result.changed, false);
  assert.deepEqual(result.versionBefore, result.versionAfter);
  assert.equal(publications, 0);
});

test('rolls back a mutation that falsely reports a no-op', async () => {
  const coordinator = createCoordinator();
  await assert.rejects(coordinator.executeWrite(write('false-no-op', (db) => {
    db.run("INSERT INTO entries VALUES (1, 'hidden-change')");
    return { changed: false, value: null };
  })), /cannot report changed: false/);
  assert.deepEqual(coordinator.currentVersion(), { dataEpoch: epoch, dataRevision: 0 });
  const disk = readDisk();
  assert.deepEqual(rows(disk), []);
  disk.close();
});

test('rolls back mutation throws and reloads the verified live generation', async () => {
  let replacements = 0;
  const coordinator = createCoordinator({ replaceDatabase: () => { replacements += 1; } });
  await assert.rejects(coordinator.executeWrite(write('mutation-throw', (db) => {
    db.run("INSERT INTO entries VALUES (1, 'rolled-back')");
    throw new Error('mutation failed');
  })), /mutation failed/);
  assert.equal(replacements, 1);
  assert.deepEqual(coordinator.currentVersion(), { dataEpoch: epoch, dataRevision: 0 });
  const disk = readDisk();
  assert.deepEqual(rows(disk), []);
  disk.close();
});

test('restores disk state after commit and definite publication faults', async () => {
  const coordinator = createCoordinator({
    persistDependencies: {
      hook(context) {
        if (context.stage === 'beforeExport') throw new Error('persist fault');
      }
    }
  });
  await assert.rejects(coordinator.executeWrite(write('persist-fault', (db) => {
    db.run("INSERT INTO entries VALUES (1, 'not-durable')");
    return { changed: true, value: true };
  })), /persist fault/);
  assert.equal(coordinator.state, 'writable');
  assert.deepEqual(coordinator.currentVersion(), { dataEpoch: epoch, dataRevision: 0 });

  const commitCoordinator = createCoordinator();
  await assert.rejects(commitCoordinator.executeWrite(write('commit-fault', (db) => {
    db.run("INSERT INTO entries VALUES (2, 'not-committed')");
    const originalRun = db.run.bind(db);
    db.run = (sql, params) => {
      if (sql === 'COMMIT') {
        db.run = originalRun;
        throw new Error('commit fault');
      }
      return originalRun(sql, params);
    };
    return { changed: true, value: true };
  })), /commit fault/);
  assert.deepEqual(commitCoordinator.currentVersion(), { dataEpoch: epoch, dataRevision: 0 });
});

test('fences post-publication indeterminate outcomes while loading verified live bytes', async () => {
  const coordinator = createCoordinator({
    persistDependencies: {
      hook(context) {
        if (context.stage === 'afterLivePublish') throw new Error('lost acknowledgement');
      }
    }
  });
  await assert.rejects(coordinator.executeWrite(write('indeterminate', (db) => {
    db.run("INSERT INTO entries VALUES (1, 'possibly-durable')");
    return { changed: true, value: true };
  })), (error) => error.code === 'PERSISTENCE_INDETERMINATE');
  assert.equal(coordinator.state, 'needs_recovery');
  assert.deepEqual(coordinator.currentVersion(), { dataEpoch: epoch, dataRevision: 1 });
  await assert.rejects(
    coordinator.executeWrite(write('fenced', () => ({ changed: false, value: null }))),
    (error) => error.code === 'RECOVERY_FENCE'
  );
});

test('recovery fence rejects an already-admitted later write before its callback starts', async () => {
  const firstEntered = deferred();
  const releaseFirst = deferred();
  let secondMutated = false;
  const coordinator = createCoordinator({
    persistDependencies: {
      hook(context) {
        if (context.stage === 'afterLivePublish') throw new Error('indeterminate first write');
      }
    }
  });
  const first = coordinator.executeWrite(write('queued-indeterminate-1', async (db) => {
    firstEntered.resolve();
    await releaseFirst.promise;
    db.run("INSERT INTO entries VALUES (1, 'indeterminate')");
    return { changed: true, value: true };
  }));
  await firstEntered.promise;
  const second = coordinator.executeWrite(write('queued-indeterminate-2', (db) => {
    secondMutated = true;
    db.run("INSERT INTO entries VALUES (2, 'must-not-run')");
    return { changed: true, value: true };
  }));
  releaseFirst.resolve();

  await assert.rejects(first, (error) => error.code === 'PERSISTENCE_INDETERMINATE');
  await assert.rejects(second, (error) => error.code === 'RECOVERY_FENCE');
  assert.equal(secondMutated, false);
  assert.equal(coordinator.state, 'needs_recovery');
});

test('a definite restored failure allows an already-admitted later write to execute', async () => {
  let injected = false;
  let secondMutated = false;
  const coordinator = createCoordinator({
    persistDependencies: {
      hook(context) {
        if (!injected && context.stage === 'beforeExport') {
          injected = true;
          throw new Error('definite first failure');
        }
      }
    }
  });
  const first = coordinator.executeWrite(write('queued-definite-1', (db) => {
    db.run("INSERT INTO entries VALUES (1, 'rolled-back-to-live')");
    return { changed: true, value: true };
  }));
  const second = coordinator.executeWrite(write('queued-definite-2', (db) => {
    secondMutated = true;
    db.run("INSERT INTO entries VALUES (2, 'durable')");
    return { changed: true, value: true };
  }));

  await assert.rejects(first, /definite first failure/);
  const secondResult = await second;
  assert.equal(secondMutated, true);
  assert.equal(coordinator.state, 'writable');
  assert.deepEqual(secondResult.versionAfter, { dataEpoch: epoch, dataRevision: 1 });
  const disk = readDisk();
  assert.deepEqual(rows(disk), [[2, 'durable']]);
  disk.close();
});

test('fences when verified-disk reload fails after publication', async () => {
  const coordinator = createCoordinator({
    coordinatorFiles: {
      readFile: async () => { throw Object.assign(new Error('reload failed'), { code: 'EIO' }); },
      readdir: atomic.defaultAtomicFileDependencies.readdir
    }
  });
  await assert.rejects(coordinator.executeWrite(write('reload-fault', (db) => {
    db.run("INSERT INTO entries VALUES (1, 'durable')");
    return { changed: true, value: true };
  })), (error) => error.code === 'PERSISTENCE_INDETERMINATE');
  assert.equal(coordinator.state, 'needs_recovery');
});

test('maintenance, read-only, shutdown, and drain transitions are deterministic', async () => {
  const coordinator = createCoordinator();
  const entered = deferred();
  const release = deferred();
  const running = coordinator.executeWrite(write('drain-1', async (db) => {
    entered.resolve();
    await release.promise;
    db.run("INSERT INTO entries VALUES (1, 'drained')");
    return { changed: true, value: true };
  }));
  await entered.promise;
  let maintenanceSecondRan = false;
  const maintenanceSecond = coordinator.executeWrite(write('drain-2', () => {
    maintenanceSecondRan = true;
    return { changed: false, value: true };
  }));
  const maintenancePromise = coordinator.beginMaintenance();
  assert.equal(coordinator.state, 'maintenance');
  await assert.rejects(coordinator.executeWrite(write('blocked-maintenance', () => ({ changed: false, value: null }))), (error) => error.code === 'MAINTENANCE_FENCE');
  release.resolve();
  await Promise.all([running, maintenanceSecond]);
  assert.equal(maintenanceSecondRan, true);
  const lease = await maintenancePromise;
  coordinator.finishMaintenance(lease);
  assert.equal(coordinator.state, 'writable');
  assert.throws(() => coordinator.finishMaintenance(lease), /unconsumed maintenance lease/);

  const readOnlyEntered = deferred();
  const releaseReadOnlyWrite = deferred();
  const readOnlyFirst = coordinator.executeWrite(write('read-only-drain-1', async () => {
    readOnlyEntered.resolve();
    await releaseReadOnlyWrite.promise;
    return { changed: false, value: true };
  }));
  await readOnlyEntered.promise;
  let readOnlySecondRan = false;
  const readOnlySecond = coordinator.executeWrite(write('read-only-drain-2', () => {
    readOnlySecondRan = true;
    return { changed: false, value: true };
  }));
  const readOnly = coordinator.enterReadOnly();
  releaseReadOnlyWrite.resolve();
  await Promise.all([readOnlyFirst, readOnlySecond, readOnly]);
  assert.equal(readOnlySecondRan, true);
  await assert.rejects(coordinator.executeWrite(write('blocked-read-only', () => ({ changed: false, value: null }))), (error) => error.code === 'RECOVERY_FENCE');
  coordinator.resumeWrites();
  await coordinator.executeWrite(write('after-read-only', () => ({ changed: false, value: true })));

  const shutdownEntered = deferred();
  const releaseShutdownWrite = deferred();
  const shutdownFirst = coordinator.executeWrite(write('shutdown-drain-1', async () => {
    shutdownEntered.resolve();
    await releaseShutdownWrite.promise;
    return { changed: false, value: true };
  }));
  await shutdownEntered.promise;
  let shutdownSecondRan = false;
  const shutdownSecond = coordinator.executeWrite(write('shutdown-drain-2', () => {
    shutdownSecondRan = true;
    return { changed: false, value: true };
  }));
  const shutdown = coordinator.shutdown();
  releaseShutdownWrite.resolve();
  await Promise.all([shutdownFirst, shutdownSecond, shutdown]);
  assert.equal(shutdownSecondRan, true);
  assert.equal(coordinator.state, 'shutdown');
  await assert.rejects(coordinator.executeWrite(write('after-shutdown', () => ({ changed: false, value: null }))), (error) => error.code === 'MAINTENANCE_FENCE');
});

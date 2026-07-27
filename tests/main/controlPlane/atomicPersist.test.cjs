const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const initSqlJs = require('sql.js');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const atomic = environment.requireMain('persistence/atomicPersist.js');
const candidates = environment.requireMain('persistence/databaseCandidate.js');
const durability = environment.requireMain('persistence/fileDurability.js');
const root = path.join(environment.dataRoot, 'atomic-persist');
const livePath = path.join(root, 'mistakes.db');
const version1 = { dataEpoch: 'epoch-main', dataRevision: 1 };
const version2 = { dataEpoch: 'epoch-main', dataRevision: 2 };
let SQL;
let opener;

function codedError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function databaseBytes(version, options = {}) {
  const db = new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');
  if (options.legacy) {
    db.exec('CREATE TABLE legacy_data (id INTEGER PRIMARY KEY, value TEXT);');
  } else if (options.malformedMetadata) {
    db.exec('CREATE TABLE control_metadata (id INTEGER, data_epoch TEXT, data_revision INTEGER);');
    db.run("INSERT INTO control_metadata VALUES (1, 'epoch-main', 1), (2, 'epoch-main', 2)");
  } else {
    db.exec(`
      CREATE TABLE control_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data_epoch TEXT NOT NULL,
        data_revision INTEGER NOT NULL CHECK (data_revision >= 0)
      );
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
    `);
    db.run('INSERT INTO control_metadata (id, data_epoch, data_revision) VALUES (1, ?, ?)', [version.dataEpoch, version.dataRevision]);
    if (options.foreignKeyViolation) {
      db.run('PRAGMA foreign_keys = OFF');
      db.run('INSERT INTO child (id, parent_id) VALUES (1, 999)');
    }
  }
  const bytes = db.export();
  db.close();
  return bytes;
}

async function writeCandidate(filePath, version, options) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, databaseBytes(version, options));
}

async function resetFiles() {
  await fs.promises.rm(root, { recursive: true, force: true });
  await fs.promises.mkdir(root, { recursive: true });
  await writeCandidate(livePath, version1);
}

function realFiles(overrides = {}) {
  return { ...atomic.defaultAtomicFileDependencies, ...overrides };
}

function successfulOptions(overrides = {}) {
  return {
    livePath,
    requestId: 'request-1',
    bytes: databaseBytes(version2),
    expectedVersion: version2,
    dependencies: {
      opener,
      randomId: () => 'nonce-1',
      ...overrides
    }
  };
}

async function inspect(filePath, kind = 'live', expectedVersion) {
  return candidates.inspectDatabaseFile(filePath, kind, opener, expectedVersion);
}

function validCandidates(outcome) {
  return outcome.candidates.filter((candidate) => candidate.status === 'valid');
}

function assertVersioned(candidate, version) {
  assert.equal(candidate.status, 'valid');
  assert.equal(candidate.metadata, 'present');
  assert.deepEqual(candidate.version, version);
}

test.before(async () => {
  SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
  opener = candidates.createSqlJsCandidateOpener(SQL);
});

test.beforeEach(resetFiles);

test.after(() => {
  environment.cleanupControlPlaneRoot();
});

test('publishes with exclusive same-directory staging, validates live, and removes previous', async () => {
  const opened = [];
  let nonce = 0;
  const files = realFiles({
    async openExclusive(filePath) {
      opened.push(filePath);
      if (opened.length === 1) throw codedError('EEXIST');
      return fs.promises.open(filePath, 'wx');
    }
  });
  const outcome = await atomic.atomicPersist(successfulOptions({ files, randomId: () => `nonce-${++nonce}` }));

  assert.equal(outcome.status, 'success');
  assertVersioned(outcome.live, version2);
  assert.equal(outcome.recovery.status, 'selected');
  assert.equal(outcome.recovery.candidate.kind, 'live');
  assert.equal(outcome.directoryFlushes.every((entry) => ['flushed', 'unsupported'].includes(entry.status)), true);
  assert.equal(opened.length, 2);
  assert.equal(opened.every((filePath) => path.dirname(filePath) === root), true);
  assert.equal(opened.every((filePath) => path.basename(filePath).startsWith('.mistakes.db.request-1.')), true);
  assert.equal(fs.existsSync(outcome.tempPath), false);
  assert.equal(fs.existsSync(candidates.databasePreviousPath(livePath)), false);
  assertVersioned(await inspect(livePath, 'live', version2), version2);
});

test('reports file and directory durability including unsupported Windows directory fsync', async () => {
  assert.deepEqual(await durability.flushFile({ sync: async () => undefined }), { status: 'flushed' });
  const fileFailure = await durability.flushFile({ sync: async () => { throw codedError('EIO'); } });
  assert.equal(fileFailure.status, 'failed');
  assert.equal(fileFailure.code, 'EIO');

  for (const code of ['EINVAL', 'EPERM']) {
    assert.deepEqual(await durability.flushDirectory(root, {
      openDirectory: async () => { throw codedError(code); }
    }), { status: 'unsupported', code });
  }
  const closeFailure = await durability.flushDirectory(root, {
    openDirectory: async () => ({ sync: async () => undefined, close: async () => { throw codedError('EIO'); } })
  });
  assert.equal(closeFailure.status, 'failed');
  assert.equal(closeFailure.code, 'EIO');
});

test('faults at every named hook without false success and leaves the expected candidate layout', async () => {
  const postLive = new Set(['afterLivePublish', 'afterLiveReopen', 'afterDirectoryFlush']);
  for (const seam of atomic.atomicPersistStages) {
    await resetFiles();
    const outcome = await atomic.atomicPersist(successfulOptions({
      hook(context) {
        if (context.stage === seam) throw new Error(`fault:${seam}`);
      }
    }));

    assert.notEqual(outcome.status, 'success', seam);
    assert.equal(outcome.stage, seam, seam);
    assert.equal(outcome.failure.code, 'hook_failed', seam);
    assert.ok(validCandidates(outcome).length >= 1, `${seam} must retain a verified candidate`);
    if (postLive.has(seam)) {
      assert.equal(outcome.status, 'indeterminate', seam);
      assertVersioned(await inspect(livePath), version2);
    } else {
      assert.equal(outcome.status, 'failed', seam);
      assertVersioned(await inspect(livePath), version1);
    }
    if (outcome.tempPath) assert.equal(fs.existsSync(outcome.tempPath), false, `${seam} temp cleanup`);
  }
});

test('returns typed definite failures for temp open, write, flush, and validation', async () => {
  const cases = [
    {
      code: 'temp_open_failed',
      overrides: { files: realFiles({ async openExclusive() { throw codedError('ENOSPC'); } }) }
    },
    {
      code: 'temp_write_failed',
      overrides: { files: realFiles({
        async openExclusive(filePath) {
          const handle = await fs.promises.open(filePath, 'wx');
          return { writeFile: async () => { throw codedError('ENOSPC'); }, sync: handle.sync.bind(handle), close: handle.close.bind(handle) };
        }
      }) }
    },
    {
      code: 'temp_flush_failed',
      overrides: { files: realFiles({
        async openExclusive(filePath) {
          const handle = await fs.promises.open(filePath, 'wx');
          return { writeFile: handle.writeFile.bind(handle), sync: async () => { throw codedError('EIO'); }, close: handle.close.bind(handle) };
        }
      }) }
    },
    { code: 'temp_validation_failed', bytes: new Uint8Array([1, 2, 3]) },
    { code: 'temp_validation_failed', bytes: databaseBytes(version2, { foreignKeyViolation: true }) },
    { code: 'temp_validation_failed', bytes: databaseBytes({ dataEpoch: 'epoch-main', dataRevision: 99 }) }
  ];

  for (const entry of cases) {
    await resetFiles();
    const outcome = await atomic.atomicPersist({
      ...successfulOptions(entry.overrides),
      ...(entry.bytes ? { bytes: entry.bytes } : {})
    });
    assert.equal(outcome.status, 'failed', entry.code);
    assert.equal(outcome.failure.code, entry.code);
    assert.equal(outcome.recovery.status, 'selected');
    assert.equal(outcome.recovery.candidate.kind, 'live');
    assertVersioned(outcome.recovery.candidate, version1);
  }
});

test('rejects invalid options before opening a temp file', async () => {
  let opens = 0;
  const outcome = await atomic.atomicPersist({
    ...successfulOptions({
      files: realFiles({
        async openExclusive(filePath) {
          opens += 1;
          return fs.promises.open(filePath, 'wx');
        }
      })
    }),
    requestId: '../escape'
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.failure.code, 'invalid_options');
  assert.equal(outcome.failure.phase, 'options_validation');
  assert.equal(opens, 0);
  assertVersioned(await inspect(livePath), version1);
});

test('restores live after failure following live-to-previous and fences temp-to-live ambiguity', async () => {
  let outcome = await atomic.atomicPersist(successfulOptions({
    hook(context) {
      if (context.stage === 'afterPreviousPublish') throw new Error('crash after old live move');
    }
  }));
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.recovery.status, 'selected');
  assertVersioned(outcome.recovery.candidate, version1);
  assert.equal(outcome.recovery.candidate.kind, 'live');
  assert.equal(fs.existsSync(candidates.databasePreviousPath(livePath)), false);

  await resetFiles();
  outcome = await atomic.atomicPersist(successfulOptions({
    files: realFiles({
      async rename(from, to) {
        if (from.endsWith('.tmp') && to === livePath) throw codedError('EIO');
        await fs.promises.rename(from, to);
      }
    })
  }));
  assert.equal(outcome.status, 'indeterminate');
  assert.equal(outcome.failure.code, 'temp_to_live_failed');
  assert.equal(outcome.recovery.status, 'selected');
  assert.equal(outcome.recovery.candidate.kind, 'temp');
  assert.ok(validCandidates(outcome).some((candidate) => candidate.kind === 'previous'));
});

test('treats live reopen, previous cleanup, and publication directory flush failures as indeterminate', async () => {
  let liveReads = 0;
  let outcome = await atomic.atomicPersist(successfulOptions({
    files: realFiles({
      async readFile(filePath) {
        if (filePath === livePath && ++liveReads === 3) throw codedError('EIO');
        return fs.promises.readFile(filePath);
      }
    })
  }));
  assert.equal(outcome.status, 'indeterminate');
  assert.equal(outcome.failure.code, 'live_validation_failed');
  assert.ok(validCandidates(outcome).some((candidate) => candidate.kind === 'previous'));

  await resetFiles();
  outcome = await atomic.atomicPersist(successfulOptions({
    files: realFiles({
      async unlink(filePath) {
        if (filePath === candidates.databasePreviousPath(livePath)) throw codedError('EACCES');
        await fs.promises.unlink(filePath);
      }
    })
  }));
  assert.equal(outcome.status, 'indeterminate');
  assert.equal(outcome.failure.code, 'previous_cleanup_failed');

  await resetFiles();
  let directoryFlush = 0;
  outcome = await atomic.atomicPersist(successfulOptions({
    directoryDurability: {
      async openDirectory(directoryPath) {
        const handle = await fs.promises.open(directoryPath, 'r');
        directoryFlush += 1;
        return {
          sync: directoryFlush === 2 ? async () => { throw codedError('EIO'); } : async () => undefined,
          close: handle.close.bind(handle)
        };
      }
    }
  }));
  assert.equal(outcome.status, 'indeterminate');
  assert.equal(outcome.failure.code, 'directory_flush_failed');
  assertVersioned(await inspect(livePath), version2);
});

test('retries only Windows sharing failures and always respects the retry deadline', async () => {
  let attempts = 0;
  let clock = 0;
  const sleeps = [];
  let outcome = await atomic.atomicPersist(successfulOptions({
    platform: 'win32',
    files: realFiles({
      async rename(from, to) {
        if (from === livePath && attempts++ < 2) throw codedError('EBUSY');
        await fs.promises.rename(from, to);
      }
    }),
    now: () => clock,
    sleep: async (delay) => { sleeps.push(delay); clock += delay; }
  }));
  assert.equal(outcome.status, 'success');
  assert.deepEqual(sleeps, [10, 20]);

  await resetFiles();
  attempts = 0;
  outcome = await atomic.atomicPersist(successfulOptions({
    platform: 'linux',
    files: realFiles({ async rename() { attempts += 1; throw codedError('EBUSY'); } }),
    sleep: async () => { throw new Error('non-Windows must not retry'); }
  }));
  assert.equal(outcome.failure.code, 'live_to_previous_failed');
  assert.equal(attempts, 1);

  await resetFiles();
  attempts = 0;
  clock = 0;
  outcome = await atomic.atomicPersist({
    ...successfulOptions({
      platform: 'win32',
      files: realFiles({ async rename() { attempts += 1; throw codedError('EPERM'); } }),
      now: () => clock,
      sleep: async (delay) => { clock += delay; }
    }),
    retry: { initialDelayMs: 4, maximumDelayMs: 8, deadlineMs: 10 }
  });
  assert.equal(outcome.failure.code, 'live_to_previous_failed');
  assert.equal(clock, 10);
  assert.equal(attempts, 3);
});

test('inspects integrity, foreign keys, optional metadata, and closes without mutating bytes', () => {
  const bytes = databaseBytes(version2);
  const original = Buffer.from(bytes);
  let closed = 0;
  const trackingOpener = {
    open(input) {
      const db = new SQL.Database(input);
      return {
        run: db.run.bind(db),
        exec: db.exec.bind(db),
        close() { closed += 1; db.close(); }
      };
    }
  };
  const valid = candidates.inspectDatabaseBytes(bytes, { path: livePath, kind: 'live' }, trackingOpener, version2);
  assertVersioned(valid, version2);
  assert.deepEqual(Buffer.from(bytes), original);
  assert.equal(closed, 1);

  const legacy = candidates.inspectDatabaseBytes(
    databaseBytes(undefined, { legacy: true }),
    { path: livePath, kind: 'live' },
    opener
  );
  assert.equal(legacy.status, 'valid');
  assert.equal(legacy.metadata, 'absent');
  assert.equal(candidates.inspectDatabaseBytes(
    databaseBytes(undefined, { legacy: true }),
    { path: livePath, kind: 'live' },
    opener,
    version2
  ).reason, 'version_mismatch');
  assert.equal(candidates.inspectDatabaseBytes(
    databaseBytes(undefined, { malformedMetadata: true }),
    { path: livePath, kind: 'live' },
    opener
  ).reason, 'metadata_error');
  assert.equal(candidates.inspectDatabaseBytes(
    databaseBytes(version2, { foreignKeyViolation: true }),
    { path: livePath, kind: 'live' },
    opener
  ).reason, 'foreign_key_error');
});

test('classifies injected quick-check and close failures precisely', () => {
  const identity = { path: livePath, kind: 'live' };
  const quickCheckFailure = candidates.inspectDatabaseBytes(new Uint8Array([1]), identity, {
    open() {
      return {
        run() {},
        exec(sql) {
          if (sql === 'PRAGMA quick_check') return [{ columns: ['quick_check'], values: [['corrupt']] }];
          return [];
        },
        close() {}
      };
    }
  });
  assert.equal(quickCheckFailure.reason, 'integrity_error');

  const closeFailure = candidates.inspectDatabaseBytes(databaseBytes(version2), identity, {
    open(input) {
      const db = new SQL.Database(input);
      return { run: db.run.bind(db), exec: db.exec.bind(db), close() { db.close(); throw codedError('EIO'); } };
    }
  });
  assert.equal(closeFailure.reason, 'close_error');
});

test('enumerates only owned candidates and selects highest revision within one epoch', async () => {
  const previousPath = candidates.databasePreviousPath(livePath);
  const validTemp = path.join(root, '.mistakes.db.request-a.valid.tmp');
  const invalidTemp = path.join(root, '.mistakes.db.request-b.invalid.tmp');
  await writeCandidate(previousPath, { dataEpoch: 'epoch-main', dataRevision: 2 });
  await writeCandidate(validTemp, { dataEpoch: 'epoch-main', dataRevision: 3 });
  await fs.promises.writeFile(invalidTemp, 'not a database');
  await fs.promises.writeFile(path.join(root, 'unowned.tmp'), databaseBytes(version2));

  const found = await candidates.enumerateDatabaseCandidates({ livePath, opener });
  assert.deepEqual(found.map(({ kind, status }) => [kind, status]), [
    ['live', 'valid'], ['previous', 'valid'], ['temp', 'valid'], ['temp', 'invalid']
  ]);
  const decision = candidates.decideDatabaseCandidate(found);
  assert.equal(decision.status, 'selected');
  assert.equal(decision.candidate.kind, 'temp');
  assert.equal(decision.candidate.version.dataRevision, 3);
});

test('never orders epochs and returns typed legacy/metadata ambiguity', async () => {
  await writeCandidate(livePath, { dataEpoch: 'epoch-main', dataRevision: 7 });
  await writeCandidate(candidates.databasePreviousPath(livePath), { dataEpoch: 'epoch-main', dataRevision: 7 });
  let decision = candidates.decideDatabaseCandidate(await candidates.enumerateDatabaseCandidates({ livePath, opener }));
  assert.equal(decision.status, 'selected');
  assert.equal(decision.candidate.kind, 'live');

  await writeCandidate(path.join(root, '.mistakes.db.request-z.other.tmp'), { dataEpoch: 'aaa-opaque', dataRevision: 999 });
  decision = candidates.decideDatabaseCandidate(await candidates.enumerateDatabaseCandidates({ livePath, opener }));
  assert.equal(decision.status, 'ambiguous_epochs');
  assert.deepEqual(decision.epochs, ['epoch-main', 'aaa-opaque']);

  await fs.promises.rm(root, { recursive: true, force: true });
  await fs.promises.mkdir(root, { recursive: true });
  await fs.promises.writeFile(livePath, databaseBytes(undefined, { legacy: true }));
  decision = candidates.decideDatabaseCandidate(await candidates.enumerateDatabaseCandidates({ livePath, opener }));
  assert.equal(decision.status, 'legacy_selected');
  await fs.promises.writeFile(path.join(root, '.mistakes.db.request-a.legacy.tmp'), databaseBytes(undefined, { legacy: true }));
  decision = candidates.decideDatabaseCandidate(await candidates.enumerateDatabaseCandidates({ livePath, opener }));
  assert.equal(decision.status, 'ambiguous_legacy');
  await writeCandidate(path.join(root, '.mistakes.db.request-b.versioned.tmp'), version2);
  decision = candidates.decideDatabaseCandidate(await candidates.enumerateDatabaseCandidates({ livePath, opener }));
  assert.equal(decision.status, 'ambiguous_metadata');
});

test('preserves unsafe previous candidates and surfaces the pre-existing recovery fence', async () => {
  const previousPath = candidates.databasePreviousPath(livePath);
  await fs.promises.writeFile(previousPath, 'invalid previous');
  let outcome = await atomic.atomicPersist(successfulOptions());
  assert.equal(outcome.failure.code, 'candidate_set_unsafe');
  assert.equal(fs.readFileSync(previousPath, 'utf8'), 'invalid previous');
  assertVersioned(await inspect(livePath), version1);

  await resetFiles();
  await writeCandidate(previousPath, { dataEpoch: 'other-epoch', dataRevision: 0 });
  outcome = await atomic.atomicPersist(successfulOptions());
  assert.equal(outcome.status, 'indeterminate');
  assert.equal(outcome.failure.code, 'candidate_set_unsafe');
  assert.equal(outcome.recovery.status, 'ambiguous_epochs');
  assertVersioned(await inspect(previousPath, 'previous'), { dataEpoch: 'other-epoch', dataRevision: 0 });
});

test('fences candidate-scan failure and preserves an unrelated owned temp candidate', async () => {
  let outcome = await atomic.atomicPersist(successfulOptions({
    files: realFiles({ async readdir() { throw codedError('EACCES'); } })
  }));
  assert.equal(outcome.status, 'indeterminate');
  assert.equal(outcome.failure.code, 'candidate_set_unsafe');
  assert.equal(outcome.recovery.status, 'scan_failed');
  assertVersioned(await inspect(livePath), version1);

  await resetFiles();
  const foreignTemp = path.join(root, '.mistakes.db.foreign.other.tmp');
  await writeCandidate(foreignTemp, { dataEpoch: 'other-epoch', dataRevision: 50 });
  outcome = await atomic.atomicPersist(successfulOptions());
  assert.equal(outcome.status, 'indeterminate');
  assert.equal(outcome.failure.code, 'candidate_set_unsafe');
  assert.equal(outcome.recovery.status, 'ambiguous_epochs');
  assert.equal(fs.existsSync(foreignTemp), true);
  assertVersioned(await inspect(livePath), version1);
});

test('cleanup failure never reports success and leaves inspectable candidates', async () => {
  const files = realFiles({
    async openExclusive(filePath) {
      const handle = await fs.promises.open(filePath, 'wx');
      return { writeFile: async () => { throw codedError('ENOSPC'); }, sync: handle.sync.bind(handle), close: handle.close.bind(handle) };
    },
    async unlink(filePath) {
      if (filePath.endsWith('.tmp')) throw codedError('EACCES');
      await fs.promises.unlink(filePath);
    }
  });
  const outcome = await atomic.atomicPersist(successfulOptions({ files }));
  assert.equal(outcome.status, 'indeterminate');
  assert.equal(outcome.failure.code, 'temp_write_failed');
  assert.ok(outcome.candidates.some((candidate) => candidate.kind === 'temp'));
  assertVersioned(await inspect(livePath), version1);
});

test('supports first publication and replacement of an integrity-valid legacy live database', async () => {
  await fs.promises.rm(livePath, { force: true });
  let outcome = await atomic.atomicPersist(successfulOptions());
  assert.equal(outcome.status, 'success');
  assertVersioned(outcome.live, version2);

  await resetFiles();
  await fs.promises.writeFile(livePath, databaseBytes(undefined, { legacy: true }));
  outcome = await atomic.atomicPersist(successfulOptions());
  assert.equal(outcome.status, 'success');
  assertVersioned(outcome.live, version2);
  assert.equal(fs.existsSync(candidates.databasePreviousPath(livePath)), false);
});

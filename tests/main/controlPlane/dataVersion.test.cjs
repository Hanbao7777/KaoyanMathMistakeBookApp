const assert = require('node:assert/strict');
const test = require('node:test');
const initSqlJs = require('sql.js');
const {
  cleanupControlPlaneRoot,
  requireMain
} = require('../helpers/controlPlaneTestEnv.cjs');

const { schemaSql } = requireMain('database/schema.js');
const { bootstrapControlMetadata } = requireMain('persistence/databaseBootstrap.js');
const {
  createRevisionMutationCapability,
  RevisionStore
} = requireMain('persistence/revisionStore.js');

let SQL;

test.before(async () => {
  SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
});

test.after(() => cleanupControlPlaneRoot());

function createDatabase(withSchema = true) {
  const db = new SQL.Database();
  if (withSchema) db.exec(schemaSql);
  return db;
}

function bootstrap(db, epoch = '00000000-0000-4000-8000-000000000001') {
  return bootstrapControlMetadata(db, {
    createEpoch: () => epoch,
    now: () => '2026-07-15T00:00:00.000Z'
  });
}

function errorCode(action) {
  try {
    action();
    return null;
  } catch (error) {
    return error.code;
  }
}

test('legacy bootstrap creates one metadata row and is idempotent', () => {
  const db = createDatabase(false);
  db.exec('CREATE TABLE legacy_data (id INTEGER PRIMARY KEY)');

  const first = bootstrap(db);
  const second = bootstrapControlMetadata(db, {
    createEpoch: () => { throw new Error('idempotent bootstrap must not generate another epoch'); },
    now: () => '2026-07-16T00:00:00.000Z'
  });

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.deepEqual(second.metadata, first.metadata);
  assert.deepEqual(new RevisionStore(db).readCurrentVersion(), {
    dataEpoch: '00000000-0000-4000-8000-000000000001',
    dataRevision: 0
  });
});

test('control revision migration is bootstrap-owned, durable, and read-pure', () => {
  const db = createDatabase(false);
  db.exec('CREATE TABLE control_metadata (id, data_epoch, data_revision, schema_version, updated_at)');
  db.run('INSERT INTO control_metadata VALUES (1, ?, 4, 1, ?)', [
    '00000000-0000-4000-8000-000000000012',
    '2026-07-15T00:00:00.000Z'
  ]);

  const beforeRead = db.exec('PRAGMA table_info(control_metadata)')[0].values.map((row) => row[1]);
  assert.deepEqual(new RevisionStore(db).readCurrentGeneration(), {
    dataEpoch: '00000000-0000-4000-8000-000000000012', dataRevision: 4, controlRevision: 0
  });
  assert.deepEqual(db.exec('PRAGMA table_info(control_metadata)')[0].values.map((row) => row[1]), beforeRead);

  const migrated = bootstrap(db, 'unused-epoch');
  assert.equal(migrated.changed, true);
  assert.deepEqual(migrated.metadata, {
    dataEpoch: '00000000-0000-4000-8000-000000000012',
    dataRevision: 4,
    controlRevision: 0,
    schemaVersion: 1,
    updatedAt: '2026-07-15T00:00:00.000Z'
  });
  const reopened = new SQL.Database(db.export());
  assert.deepEqual(new RevisionStore(reopened).readCurrentGeneration(), {
    dataEpoch: '00000000-0000-4000-8000-000000000012', dataRevision: 4, controlRevision: 0
  });
  reopened.close();
});

test('bootstrap calls injected UUID and clock exactly once only when metadata is missing', () => {
  const db = createDatabase(false);
  let epochCalls = 0;
  let clockCalls = 0;
  const first = bootstrapControlMetadata(db, {
    createEpoch: () => {
      epochCalls += 1;
      return '00000000-0000-4000-8000-000000000010';
    },
    now: () => {
      clockCalls += 1;
      return '2026-07-15T00:10:00.000Z';
    }
  });
  const second = bootstrapControlMetadata(db, {
    createEpoch: () => {
      epochCalls += 1;
      return '00000000-0000-4000-8000-000000000011';
    },
    now: () => {
      clockCalls += 1;
      return '2026-07-15T00:11:00.000Z';
    }
  });

  assert.equal(epochCalls, 1);
  assert.equal(clockCalls, 1);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.deepEqual(second.metadata, first.metadata);
});

test('increment commits once and caller rollback restores the revision', () => {
  const db = createDatabase();
  bootstrap(db);
  const store = new RevisionStore(db, () => '2026-07-15T01:00:00.000Z');
  const initial = store.readCurrentVersion();

  db.run('BEGIN');
  const committed = store.increment(createRevisionMutationCapability(db), initial);
  db.run('COMMIT');
  assert.equal(committed.dataRevision, 1);

  db.run('BEGIN');
  const rolledBack = store.increment(createRevisionMutationCapability(db), committed);
  assert.equal(rolledBack.dataRevision, 2);
  db.run('ROLLBACK');
  assert.deepEqual(store.readCurrentVersion(), committed);
});

test('mutation capabilities are database-bound, unforgeable, and one-use', () => {
  const db = createDatabase();
  const other = createDatabase();
  bootstrap(db);
  bootstrap(other, '00000000-0000-4000-8000-000000000002');
  const store = new RevisionStore(db);
  const current = store.readCurrentVersion();

  assert.throws(() => store.increment({ kind: 'revision-mutation-capability' }, current), /fresh revision mutation capability/);
  assert.throws(
    () => store.increment(createRevisionMutationCapability(other), current),
    /fresh revision mutation capability/
  );
  const capability = createRevisionMutationCapability(db);
  db.run('BEGIN');
  store.increment(capability, current);
  assert.throws(() => store.increment(capability, { ...current, dataRevision: 1 }), /fresh revision mutation capability/);
  db.run('ROLLBACK');
});

test('stale epoch and revision are rejected without mutation', () => {
  const db = createDatabase();
  bootstrap(db);
  const store = new RevisionStore(db);
  const current = store.readCurrentVersion();

  assert.equal(errorCode(() => store.assertCurrentVersion({ ...current, dataEpoch: 'stale' })), 'DATA_EPOCH_MISMATCH');
  assert.equal(errorCode(() => store.assertCurrentVersion({ ...current, dataRevision: 1 })), 'DATA_REVISION_CONFLICT');
  assert.deepEqual(store.readCurrentVersion(), current);
});

test('epoch-only comparison ignores revision but still rejects stale identity', () => {
  const db = createDatabase();
  bootstrap(db);
  const store = new RevisionStore(db);
  const current = store.readCurrentVersion();

  assert.deepEqual(store.assertCurrentEpoch({ dataEpoch: current.dataEpoch }), current);
  assert.equal(
    errorCode(() => store.assertCurrentEpoch({ dataEpoch: '00000000-0000-4000-8000-000000000099' })),
    'DATA_EPOCH_MISMATCH'
  );
  assert.deepEqual(store.readCurrentVersion(), current);
});

test('database identity reset installs a new epoch at revision zero', () => {
  const db = createDatabase();
  bootstrap(db);
  const store = new RevisionStore(db, () => '2026-07-15T02:00:00.000Z');
  db.run('BEGIN');
  store.increment(createRevisionMutationCapability(db), store.readCurrentVersion());
  db.run('COMMIT');

  db.run('BEGIN');
  const reset = store.resetDatabaseIdentity(
    createRevisionMutationCapability(db),
    '00000000-0000-4000-8000-000000000099'
  );
  db.run('COMMIT');
  assert.deepEqual(reset, {
    dataEpoch: '00000000-0000-4000-8000-000000000099',
    dataRevision: 0
  });
});

test('database identity reset rejects epoch reuse without mutation', () => {
  const db = createDatabase();
  bootstrap(db);
  const store = new RevisionStore(db);
  const current = store.readCurrentVersion();
  db.run('BEGIN');
  assert.throws(
    () => store.resetDatabaseIdentity(createRevisionMutationCapability(db), current.dataEpoch),
    /requires a new data epoch/
  );
  db.run('ROLLBACK');
  assert.deepEqual(store.readCurrentVersion(), current);
});

test('store rejects zero, duplicate, and malformed metadata rows', () => {
  const cases = [
    { rows: [], pattern: /expected one row, found 0/ },
    { rows: [[1, 'epoch-a', 0, 1, 'time'], [1, 'epoch-b', 0, 1, 'time']], pattern: /expected one row, found 2/ },
    { rows: [[1, '', 0, 1, 'time']], pattern: /data_epoch/ },
    { rows: [[1, 'epoch', -1, 1, 'time']], pattern: /data_revision/ },
    { rows: [[1, 'epoch', 1.5, 1, 'time']], pattern: /data_revision/ },
    { rows: [[1, 'epoch', 9007199254740992, 1, '2026-07-15T00:00:00.000Z']], pattern: /data_revision/ },
    { rows: [[1, 'epoch', 0, 0, '2026-07-15T00:00:00.000Z']], pattern: /schema_version/ },
    { rows: [[1, 'epoch', 0, 1, 'not-a-time']], pattern: /updated_at/ }
  ];

  for (const { rows, pattern } of cases) {
    const db = createDatabase(false);
    db.exec('CREATE TABLE control_metadata (id, data_epoch, data_revision, schema_version, updated_at)');
    for (const row of rows) db.run('INSERT INTO control_metadata VALUES (?, ?, ?, ?, ?)', row);
    assert.throws(() => new RevisionStore(db).readCurrentVersion(), pattern);
    db.close();
  }
});

test('bootstrap rejects unsupported metadata schema versions without replacing them', () => {
  const db = createDatabase(false);
  db.exec('CREATE TABLE control_metadata (id, data_epoch, data_revision, schema_version, updated_at)');
  db.run('INSERT INTO control_metadata VALUES (1, ?, 0, 2, ?)', [
    '00000000-0000-4000-8000-000000000001',
    '2026-07-15T00:00:00.000Z'
  ]);

  assert.throws(() => bootstrap(db), /Unsupported control metadata schema version/);
  assert.equal(new RevisionStore(db).readMetadata().schemaVersion, 2);
});

test('invalid injected clock values fail before revision metadata is changed', () => {
  const db = createDatabase();
  bootstrap(db);
  const store = new RevisionStore(db, () => 'not-a-time');
  const current = store.readCurrentVersion();
  db.run('BEGIN');
  assert.throws(
    () => store.increment(createRevisionMutationCapability(db), current),
    /updated_at must be an ISO timestamp/
  );
  db.run('ROLLBACK');
  assert.deepEqual(store.readCurrentVersion(), current);
});

test('revision overflow is rejected and does not wrap', () => {
  const db = createDatabase();
  bootstrap(db);
  db.run('UPDATE control_metadata SET data_revision = ?', [Number.MAX_SAFE_INTEGER]);
  const store = new RevisionStore(db);
  const current = store.readCurrentVersion();
  db.run('BEGIN');
  assert.throws(
    () => store.increment(createRevisionMutationCapability(db), current),
    /overflow requires an epoch reset/
  );
  db.run('ROLLBACK');
  assert.deepEqual(store.readCurrentVersion(), current);
});

test('exported and reopened database preserves the data version', () => {
  const db = createDatabase();
  bootstrap(db);
  const store = new RevisionStore(db);
  db.run('BEGIN');
  const expected = store.increment(createRevisionMutationCapability(db), store.readCurrentVersion());
  db.run('COMMIT');

  const reopened = new SQL.Database(db.export());
  assert.deepEqual(new RevisionStore(reopened).readCurrentVersion(), expected);
  reopened.close();
});

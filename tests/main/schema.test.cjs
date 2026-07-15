const assert = require('node:assert/strict');
const test = require('node:test');
const {
  cleanupTestRoot,
  databaseService,
  resetTestDatabase
} = require('./helpers/mainTestEnv.cjs');

test.after(cleanupTestRoot);

test.beforeEach(resetTestDatabase);

function tableExists(db, tableName) {
  const result = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [tableName]);
  return result.length > 0 && result[0].values.length === 1;
}

function indexExists(db, indexName) {
  const result = db.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?", [indexName]);
  return result.length > 0 && result[0].values.length === 1;
}

function tableColumns(db, tableName) {
  const result = db.exec(`PRAGMA table_info(${tableName})`);
  if (!result.length) return [];
  const nameIndex = result[0].columns.indexOf('name');
  return result[0].values.map((row) => row[nameIndex]);
}

test('initializeDatabase creates critical application tables', async () => {
  const db = await databaseService.getDatabase();
  const tables = [
    'questions',
    'review_logs',
    'knowledge_points',
    'control_metadata',
    'agent_control_settings',
    'agent_clients',
    'agent_client_scopes',
    'agent_sessions',
    'ticktick_lists',
    'ticktick_tasks',
    'ticktick_bridge'
  ];

  for (const table of tables) {
    assert.equal(tableExists(db, table), true, `${table} should exist`);
  }
});

test('control_metadata enforces singleton and safe metadata constraints', async () => {
  const db = await databaseService.getDatabase();
  const columns = tableColumns(db, 'control_metadata');
  assert.deepEqual(columns, ['id', 'data_epoch', 'data_revision', 'control_revision', 'schema_version', 'updated_at']);
  db.run('DELETE FROM control_metadata');

  assert.throws(
    () => db.run("INSERT INTO control_metadata VALUES (2, 'epoch', 0, 0, 1, '2026-07-15T00:00:00.000Z')"),
    /CHECK constraint failed/
  );
  assert.throws(
    () => db.run("INSERT INTO control_metadata VALUES (1, '', 0, 0, 1, '2026-07-15T00:00:00.000Z')"),
    /CHECK constraint failed/
  );
  assert.throws(
    () => db.run("INSERT INTO control_metadata VALUES (1, 'epoch', -1, 0, 1, '2026-07-15T00:00:00.000Z')"),
    /CHECK constraint failed/
  );
  assert.throws(
    () => db.run("INSERT INTO control_metadata VALUES (1, 'epoch', 1.5, 0, 1, '2026-07-15T00:00:00.000Z')"),
    /CHECK constraint failed/
  );
  assert.throws(
    () => db.run("INSERT INTO control_metadata VALUES (1, 'epoch', 9007199254740992, 0, 1, '2026-07-15T00:00:00.000Z')"),
    /CHECK constraint failed/
  );

  assert.throws(
    () => db.run("INSERT INTO control_metadata VALUES (1, 'epoch', 0, -1, 1, '2026-07-15T00:00:00.000Z')"),
    /CHECK constraint failed/
  );
  db.run("INSERT INTO control_metadata VALUES (1, 'epoch', 0, 0, 1, '2026-07-15T00:00:00.000Z')");
  assert.throws(
    () => db.run("INSERT INTO control_metadata VALUES (1, 'other', 0, 0, 1, '2026-07-15T00:00:00.000Z')"),
    /UNIQUE constraint failed/
  );
});

test('initializeDatabase creates critical TickTick task columns', async () => {
  const db = await databaseService.getDatabase();
  const columns = tableColumns(db, 'ticktick_tasks');

  for (const column of ['list_id', 'title', 'priority', 'tags', 'created_at', 'updated_at']) {
    assert.equal(columns.includes(column), true, `ticktick_tasks.${column} should exist`);
  }
});

test('initializeDatabase creates critical TickTick indexes', async () => {
  const db = await databaseService.getDatabase();

  assert.equal(indexExists(db, 'idx_ticktick_tasks_list'), true);
  assert.equal(indexExists(db, 'idx_ticktick_bridge_task'), true);
});

test('initializeDatabase creates constrained agent identity indexes', async () => {
  const db = await databaseService.getDatabase();

  assert.equal(indexExists(db, 'idx_agent_clients_revoked_active'), true);
  assert.equal(indexExists(db, 'idx_agent_client_scopes_scope'), true);
  assert.equal(indexExists(db, 'idx_agent_sessions_client_expiry'), true);
  assert.equal(indexExists(db, 'idx_agent_sessions_instance_active'), true);
});

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
    'ticktick_lists',
    'ticktick_tasks',
    'ticktick_bridge'
  ];

  for (const table of tables) {
    assert.equal(tableExists(db, table), true, `${table} should exist`);
  }
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

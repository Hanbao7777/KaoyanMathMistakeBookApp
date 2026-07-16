const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const initSqlJs = require('sql.js');
const {
  cleanupTestRoot,
  databaseService,
  requireMain,
  testRoot
} = require('./helpers/mainTestEnv.cjs');

const pathService = requireMain('services/pathService.js');
const { bootstrapControlMetadata } = requireMain('persistence/databaseBootstrap.js');

const dataRoot = path.join(testRoot, 'migration-upgrade-data-root');

async function createSqlDatabase() {
  const SQL = await initSqlJs({
    locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm')
  });
  return new SQL.Database();
}

function tableColumns(db, tableName) {
  const result = db.exec(`PRAGMA table_info(${tableName})`);
  if (!result.length) return [];
  const nameIndex = result[0].columns.indexOf('name');
  return result[0].values.map((row) => row[nameIndex]);
}

function indexExists(db, indexName) {
  const result = db.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?", [indexName]);
  return result.length > 0 && result[0].values.length === 1;
}

function tableExists(db, tableName) {
  return one(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [tableName]) !== null;
}

function one(db, sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    return stmt.step() ? stmt.getAsObject() : null;
  } finally {
    stmt.free();
  }
}

function all(db, sql, params = []) {
  const stmt = db.prepare(sql);
  const rows = [];
  try {
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

async function writeOldDatabaseSnapshot() {
  databaseService.resetDatabaseConnection();
  fs.rmSync(dataRoot, { recursive: true, force: true });
  pathService.setDataRoot(dataRoot);
  const dbPath = pathService.getPaths().database;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const oldDb = await createSqlDatabase();
  oldDb.exec(`
    CREATE TABLE questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT DEFAULT '',
      wrong_thinking TEXT DEFAULT '',
      wrong_solution TEXT DEFAULT '',
      correct_solution TEXT DEFAULT '',
      answer TEXT DEFAULT '',
      category TEXT NOT NULL,
      question_type TEXT NOT NULL,
      error_reason TEXT NOT NULL,
      source TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      mastery_level TEXT NOT NULL,
      note TEXT DEFAULT '',
      review_count INTEGER NOT NULL DEFAULT 0,
      correct_count INTEGER NOT NULL DEFAULT 0,
      wrong_count INTEGER NOT NULL DEFAULT 0,
      no_idea_count INTEGER NOT NULL DEFAULT 0,
      last_reviewed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE review_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER NOT NULL,
      result TEXT NOT NULL,
      note TEXT DEFAULT '',
      review_date TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
    );

    CREATE TABLE ticktick_lists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#4a90d9',
      icon TEXT DEFAULT 'list',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_folder INTEGER NOT NULL DEFAULT 0,
      parent_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE ticktick_tasks (
      id TEXT PRIMARY KEY,
      list_id TEXT NOT NULL,
      title TEXT NOT NULL,
      note TEXT DEFAULT '',
      due_date TEXT,
      priority TEXT CHECK(priority IN ('none','低','中','高')) DEFAULT 'none',
      is_completed INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      parent_id TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      tags TEXT DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (list_id) REFERENCES ticktick_lists(id) ON DELETE CASCADE
    );

    INSERT INTO questions (
      id, title, content, wrong_thinking, wrong_solution, correct_solution, answer,
      category, question_type, error_reason, source, difficulty, mastery_level, note,
      review_count, correct_count, wrong_count, no_idea_count, last_reviewed_at, created_at, updated_at
    ) VALUES (
      101, '旧库极限错题', '求极限', '混淆等价无穷小', '旧错误过程', '使用等价无穷小', '1',
      '函数、极限、连续', '解答题', '概念不清', '旧库导入', '中等', '有点懂', '旧错题备注',
      1, 0, 1, 0, '2025-01-03T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z'
    );

    INSERT INTO review_logs (id, question_id, result, note, review_date, created_at)
    VALUES (201, 101, 'wrong', '旧复习记录', '2025-01-03', '2025-01-03T00:00:00.000Z');

    INSERT INTO ticktick_lists (id, name, color, icon, sort_order, is_folder, parent_id, created_at, updated_at)
    VALUES ('list-old-1', '旧 TickTick 清单', '#4a90d9', 'list', 1, 0, NULL, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');

    INSERT INTO ticktick_tasks (id, list_id, title, note, due_date, priority, is_completed, completed_at, parent_id, sort_order, tags, created_at, updated_at)
    VALUES
      ('task-old-1', 'list-old-1', '旧任务一', '保留任务备注', '2025-01-04', '中', 0, NULL, NULL, 1, '["math"]', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'),
      ('task-old-2', 'list-old-1', '旧任务二', '', '2025-01-05', '低', 1, '2025-01-05T09:00:00.000Z', NULL, 2, '[]', '2025-01-01T00:00:00.000Z', '2025-01-05T09:00:00.000Z');
  `);

  fs.writeFileSync(dbPath, Buffer.from(oldDb.export()));
  oldDb.close();
}

test.after(cleanupTestRoot);

test.beforeEach(writeOldDatabaseSnapshot);

test('initializeDatabase upgrades a minimal old mistake-book and TickTick database', async () => {
  await databaseService.initializeDatabase();
  const db = await databaseService.getDatabase();
  const bootstrap = bootstrapControlMetadata(db, {
    createEpoch: () => '00000000-0000-4000-8000-000000000001',
    now: () => '2026-07-15T00:00:00.000Z'
  });

  const questionColumns = tableColumns(db, 'questions');
  for (const column of ['consecutive_correct', 'next_review_at', 'subject']) {
    assert.equal(questionColumns.includes(column), true, `questions.${column} should be backfilled`);
  }

  const reviewColumns = tableColumns(db, 'review_logs');
  assert.equal(reviewColumns.includes('reviewed_at'), true, 'review_logs.reviewed_at should be backfilled');

  assert.equal(indexExists(db, 'idx_ticktick_tasks_list'), true);
  assert.equal(indexExists(db, 'idx_review_logs_reviewed_at'), true);
  for (const tableName of [
    'agent_control_settings', 'agent_clients', 'agent_client_scopes', 'agent_sessions',
    'agent_idempotency', 'agent_r4_grants', 'agent_approvals', 'agent_changesets',
    'agent_changeset_operations', 'agent_audit_segments', 'agent_audit_events'
  ]) {
    assert.equal(tableExists(db, tableName), true, `${tableName} should be added to an upgraded database`);
  }
  assert.equal(indexExists(db, 'idx_agent_sessions_client_expiry'), true);
  assert.equal(indexExists(db, 'idx_agent_idempotency_status_updated'), true);
  assert.equal(indexExists(db, 'idx_agent_r4_grants_reserve_lookup'), true);
  assert.equal(indexExists(db, 'idx_agent_r4_grants_unique_authority'), true);
  assert.equal(indexExists(db, 'idx_agent_audit_events_receipt'), true);
  for (const column of ['r4_target_hash', 'r4_recovery', 'r4_max_affected_entities', 'r4_reservation_expires_at']) {
    assert.equal(tableColumns(db, 'agent_idempotency').includes(column), true, `agent_idempotency.${column} should be added to an upgraded database`);
  }
  assert.equal(bootstrap.changed, false);
  const metadata = one(db, 'SELECT * FROM control_metadata');
  assert.equal(metadata.id, 1);
  assert.equal(typeof metadata.data_epoch, 'string');
  assert.equal(metadata.data_epoch.length > 0, true);
  assert.equal(metadata.data_revision, 0);
  assert.equal(metadata.control_revision, 1);
  assert.equal(metadata.schema_version, 1);
  assert.equal(Number.isFinite(Date.parse(metadata.updated_at)), true);

  const questionRow = one(db, 'SELECT * FROM questions WHERE id = ?', [101]);
  assert.equal(questionRow.title, '旧库极限错题');
  assert.equal(questionRow.mastery_level, '较弱');
  assert.equal(questionRow.subject, '高等数学');
  assert.equal(questionRow.consecutive_correct, 0);
  assert.equal(questionRow.next_review_at, null);

  const reviewRow = one(db, 'SELECT * FROM review_logs WHERE id = ?', [201]);
  assert.equal(reviewRow.question_id, 101);
  assert.equal(reviewRow.result, 'wrong');
  assert.equal(reviewRow.reviewed_at, '2025-01-03');

  const listRow = one(db, 'SELECT * FROM ticktick_lists WHERE id = ?', ['list-old-1']);
  assert.equal(listRow.name, '旧 TickTick 清单');

  const taskRows = all(db, 'SELECT id, title, list_id FROM ticktick_tasks ORDER BY id');
  assert.deepEqual(taskRows, [
    { id: 'task-old-1', title: '旧任务一', list_id: 'list-old-1' },
    { id: 'task-old-2', title: '旧任务二', list_id: 'list-old-1' }
  ]);

  const question = await databaseService.getQuestion(101);
  assert.equal(question.title, '旧库极限错题');
  assert.equal(question.mastery_level, '较弱');
  assert.equal(question.subject, '高等数学');

  const reviewLogs = await databaseService.listReviewLogs(101);
  assert.equal(reviewLogs.length, 1);
  assert.equal(reviewLogs[0].id, 201);
});

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
    'agent_idempotency',
    'agent_r4_grants',
    'agent_approvals',
    'agent_changesets',
    'agent_changeset_operations',
    'agent_audit_segments',
    'agent_audit_events',
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
  assert.equal(indexExists(db, 'idx_agent_client_keys_fingerprint'), true);
  assert.deepEqual(tableColumns(db, 'agent_client_keys'), [
    'client_id', 'public_key_format', 'public_key', 'public_key_fingerprint', 'signature_algorithm',
    'key_generation', 'registry_generation', 'created_at', 'updated_at'
  ]);
  assert.equal(indexExists(db, 'idx_agent_sessions_client_expiry'), true);
  assert.equal(indexExists(db, 'idx_agent_sessions_instance_active'), true);
  assert.equal(indexExists(db, 'idx_agent_idempotency_status_updated'), true);
  assert.equal(indexExists(db, 'idx_agent_r4_grants_client_status_expiry'), true);
  assert.equal(indexExists(db, 'idx_agent_r4_grants_reserve_lookup'), true);
  assert.equal(indexExists(db, 'idx_agent_r4_grants_unique_authority'), true);
  assert.equal(indexExists(db, 'idx_agent_r4_grants_reserved_request'), true);
  assert.equal(indexExists(db, 'idx_agent_approvals_status_expiry'), true);
  assert.equal(indexExists(db, 'idx_agent_changesets_client_status_expiry'), true);
  assert.equal(indexExists(db, 'idx_agent_audit_segments_open'), true);
  assert.equal(indexExists(db, 'idx_agent_audit_events_search'), true);
  assert.equal(indexExists(db, 'idx_agent_audit_events_receipt'), true);
});

test('agent durability tables enforce terminal and append-only workflow constraints', async () => {
  const db = await databaseService.getDatabase();
  assert.deepEqual(tableColumns(db, 'agent_idempotency').slice(0, 6), [
    'receipt_id', 'client_id', 'request_id', 'operation', 'payload_json', 'payload_hash'
  ]);
  for (const column of ['r4_target_hash', 'r4_recovery', 'r4_max_affected_entities', 'r4_reservation_expires_at']) {
    assert.equal(tableColumns(db, 'agent_idempotency').includes(column), true, `agent_idempotency.${column} should exist`);
  }
  assert.throws(() => db.run(`INSERT INTO agent_idempotency (
    receipt_id, client_id, request_id, operation, payload_json, payload_hash, catalog_version, catalog_hash,
    risk, status, terminal_outcome_json, created_at, updated_at
  ) VALUES (?, 'client', ?, 'questions.create', '{}', ?, 'agent-catalog-v1@1', ?, 'R2', 'admitted', '{}', ?, ?)`, [
    '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
    `sha256-v1:${'a'.repeat(64)}`, `sha256-v1:${'b'.repeat(64)}`,
    '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z'
  ]), /CHECK constraint failed/);
  assert.throws(() => db.run(`INSERT INTO agent_idempotency (
    receipt_id, client_id, request_id, operation, payload_json, payload_hash, catalog_version, catalog_hash,
    risk, status, grant_id, created_at, updated_at
  ) VALUES (?, 'client', ?, 'questions.clear_all', '{}', ?, 'agent-catalog-v1@1', ?, 'R4', 'admitted', ?, ?, ?)`, [
    '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000012',
    `sha256-v1:${'a'.repeat(64)}`, `sha256-v1:${'b'.repeat(64)}`, '00000000-0000-4000-8000-000000000013',
    '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z'
  ]), /CHECK constraint failed/);
});

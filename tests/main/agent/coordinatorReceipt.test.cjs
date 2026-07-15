const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const initSqlJs = require('sql.js');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const application = environment.requireMain('application/index.js');
const atomic = environment.requireMain('persistence/atomicPersist.js');
const candidates = environment.requireMain('persistence/databaseCandidate.js');
const coordinatorModule = environment.requireMain('persistence/databaseCoordinator.js');
const root = path.join(environment.dataRoot, 'coordinator-receipt');
const livePath = path.join(root, 'mistakes.db');
const epoch = 'coordinator-receipt-epoch';
const timestamp = '2026-07-16T00:00:00.000Z';
let SQL;
let opener;
let sequence = 0;

function uuid() {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function createDatabase() {
  const database = new SQL.Database();
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE control_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data_epoch TEXT NOT NULL,
      data_revision INTEGER NOT NULL CHECK (data_revision >= 0),
      control_revision INTEGER NOT NULL DEFAULT 0 CHECK (control_revision >= 0),
      schema_version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE agent_receipts (id TEXT PRIMARY KEY, status TEXT NOT NULL);
  `);
  database.run('INSERT INTO control_metadata VALUES (1, ?, 0, 0, 1, ?)', [epoch, timestamp]);
  return database;
}

async function resetLive() {
  sequence = 0;
  await fs.promises.rm(root, { recursive: true, force: true });
  await fs.promises.mkdir(root, { recursive: true });
  const database = createDatabase();
  await fs.promises.writeFile(livePath, database.export());
  database.close();
}

function createCoordinator(overrides = {}) {
  const database = new SQL.Database(fs.readFileSync(livePath));
  overrides.captureDatabase?.(database);
  let nonce = 0;
  return new coordinatorModule.DatabaseCoordinator({
    database,
    livePath,
    opener,
    openDatabase: (bytes) => new SQL.Database(bytes),
    files: atomic.defaultAtomicFileDependencies,
    persistDependencies: {
      opener,
      files: atomic.defaultAtomicFileDependencies,
      randomId: () => `receipt-${++nonce}`,
      ...(overrides.persistDependencies ?? {})
    },
    publisher: overrides.publisher,
    replaceDatabase: overrides.replaceDatabase,
    now: () => timestamp
  });
}

function envelope(requestId = uuid()) {
  return {
    apiVersion: 1,
    kind: 'command',
    context: application.createInternalExecutionContext({
      requestId,
      traceId: uuid(),
      concurrency: 'none'
    }, { randomUUID: uuid, now: () => timestamp }),
    command: { type: 'questions.mark_mastery', payload: { questionId: 1, mastery: '一般' } }
  };
}

function diskRows(sql) {
  const database = new SQL.Database(fs.readFileSync(livePath));
  try {
    const result = database.exec(sql);
    return result.length ? result[0].values : [];
  } finally {
    database.close();
  }
}

test.before(async () => {
  SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
  opener = candidates.createSqlJsCandidateOpener(SQL);
});
test.beforeEach(resetLive);
test.after(() => environment.cleanupControlPlaneRoot());

test('commits semantic domain data and terminal receipt in one durable generation', async () => {
  const coordinator = createCoordinator();
  const eventBus = new application.DomainEventBus({ randomUUID: uuid, now: () => timestamp });
  const commandBus = new application.CommandBus(coordinator, eventBus);
  const receiptCapability = application.createCommandBusExecutionReceiptCapability(commandBus);
  commandBus.register('questions.mark_mastery', {
    handler(_command, _context, database) {
      database.run("INSERT INTO entries VALUES (1, 'domain')");
      return { changed: true, value: 'domain', events: [{ type: 'entry.changed', payload: { id: 1 } }] };
    }
  });

  const result = await commandBus.executeWithExecutionReceipt(receiptCapability, envelope(), {
    execute(database, scope, context) {
      coordinatorModule.assertDatabaseMutationScope(scope, database);
      assert.equal(context.semanticChanged, true);
      assert.deepEqual(context.versionAfter, { dataEpoch: epoch, dataRevision: 1 });
      database.run("INSERT INTO agent_receipts VALUES ('receipt-1', 'completed')");
      return { changed: true, value: undefined };
    }
  });

  assert.deepEqual(result.dataVersion, { dataEpoch: epoch, dataRevision: 1 });
  assert.deepEqual(coordinator.currentGeneration(), { dataEpoch: epoch, dataRevision: 1, controlRevision: 1 });
  assert.deepEqual(diskRows('SELECT id, value FROM entries'), [[1, 'domain']]);
  assert.deepEqual(diskRows('SELECT id, status FROM agent_receipts'), [['receipt-1', 'completed']]);
  assert.deepEqual(diskRows('SELECT data_revision, control_revision FROM control_metadata'), [[1, 1]]);
});

test('receipt-only semantic no-op preserves the public version and advances control once', async () => {
  const coordinator = createCoordinator();
  const commandBus = new application.CommandBus(coordinator, new application.DomainEventBus());
  const receiptCapability = application.createCommandBusExecutionReceiptCapability(commandBus);
  commandBus.register('questions.mark_mastery', { handler: () => ({ changed: false, value: 'same' }) });

  const result = await commandBus.executeWithExecutionReceipt(receiptCapability, envelope(), {
    execute(database) {
      database.run("INSERT INTO agent_receipts VALUES ('receipt-noop', 'completed')");
      return { changed: true, value: undefined };
    }
  });

  assert.equal(result.changed, false);
  assert.deepEqual(result.dataVersion, { dataEpoch: epoch, dataRevision: 0 });
  assert.deepEqual(coordinator.currentGeneration(), { dataEpoch: epoch, dataRevision: 0, controlRevision: 1 });
  assert.deepEqual(diskRows('SELECT id, status FROM agent_receipts'), [['receipt-noop', 'completed']]);
});

test('hook failure rolls back the domain mutation and emits no event', async () => {
  const coordinator = createCoordinator();
  const delivered = [];
  const eventBus = new application.DomainEventBus();
  eventBus.subscribe((event) => delivered.push(event));
  const commandBus = new application.CommandBus(coordinator, eventBus);
  const receiptCapability = application.createCommandBusExecutionReceiptCapability(commandBus);
  commandBus.register('questions.mark_mastery', {
    handler(_command, _context, database) {
      database.run("INSERT INTO entries VALUES (1, 'rolled-back')");
      return { changed: true, value: true, events: [{ type: 'entry.changed', payload: { id: 1 } }] };
    }
  });

  await assert.rejects(commandBus.executeWithExecutionReceipt(receiptCapability, envelope(), {
    execute() { throw new Error('receipt materialization failed'); }
  }), (error) => error.code === 'INTERNAL_ERROR');
  assert.deepEqual(coordinator.currentGeneration(), { dataEpoch: epoch, dataRevision: 0, controlRevision: 0 });
  assert.deepEqual(diskRows('SELECT id, value FROM entries'), []);
  assert.deepEqual(diskRows('SELECT id, status FROM agent_receipts'), []);
  assert.deepEqual(delivered, []);
});

test('capability modes reject table-family violations and nested writes', async () => {
  const coordinator = createCoordinator();
  const business = coordinatorModule.createDatabaseCoordinatorBusinessCapability(coordinator);
  const control = coordinatorModule.createDatabaseCoordinatorControlCapability(coordinator);

  await assert.rejects(coordinator.executeBusinessWrite(business, {
    requestId: 'business-control-row', concurrency: 'none',
    execute(database) {
      database.run("INSERT INTO agent_receipts VALUES ('forbidden', 'completed')");
      return { changed: true, value: null };
    }
  }), /Business handlers may mutate only domain tables/);
  await assert.rejects(coordinator.executeControlWrite(control, {
    requestId: 'control-domain-row',
    execute(database) {
      database.run("INSERT INTO entries VALUES (1, 'forbidden')");
      return { changed: true, value: null };
    }
  }), /Control writes may mutate only control-plane tables/);
  const controlResult = await coordinator.executeControlWrite(control, {
    requestId: 'nested-control',
    async execute(database) {
      await assert.rejects(coordinator.executeControlWrite(control, {
        requestId: 'nested-control-inner', execute: () => ({ changed: false, value: null })
      }), /Nested or reentrant/);
      database.run("INSERT INTO agent_receipts VALUES ('control-only', 'completed')");
      return { changed: true, value: null };
    }
  });
  assert.equal(controlResult.changed, true);
  assert.deepEqual(coordinator.currentVersion(), { dataEpoch: epoch, dataRevision: 0 });
  assert.deepEqual(coordinator.currentGeneration(), { dataEpoch: epoch, dataRevision: 0, controlRevision: 1 });
  assert.deepEqual(diskRows('SELECT id, value FROM entries'), []);
  assert.deepEqual(diskRows('SELECT id, status FROM agent_receipts'), [['control-only', 'completed']]);
});

test('reconciles tracker triggers after an authorized table-set change', async () => {
  let database;
  let activeDatabase;
  const coordinator = createCoordinator({
    captureDatabase: (value) => { database = activeDatabase = value; },
    replaceDatabase(next) { activeDatabase = next; }
  });
  const business = coordinatorModule.createDatabaseCoordinatorBusinessCapability(coordinator);

  await coordinator.executeBusinessWrite(business, {
    requestId: 'establish-trackers', concurrency: 'none', execute: () => ({ changed: false, value: null })
  });
  database.run('CREATE TABLE agent_added_after_tracking (id TEXT PRIMARY KEY)');

  await assert.rejects(coordinator.executeBusinessWrite(business, {
    requestId: 'forbidden-new-control-table', concurrency: 'none',
    execute(connection) {
      connection.run("INSERT INTO agent_added_after_tracking VALUES ('forbidden')");
      return { changed: true, value: null };
    }
  }), /Business handlers may mutate only domain tables/);
  assert.deepEqual(activeDatabase.exec("SELECT name FROM sqlite_master WHERE name = 'agent_added_after_tracking'"), []);
  assert.deepEqual(coordinator.currentGeneration(), { dataEpoch: epoch, dataRevision: 0, controlRevision: 0 });
});

test('definite post-commit publication failure restores the prior domain and receipt generation', async () => {
  const coordinator = createCoordinator({
    persistDependencies: { hook(context) { if (context.stage === 'beforeExport') throw new Error('before publish'); } }
  });
  const commandBus = new application.CommandBus(coordinator, new application.DomainEventBus());
  const receiptCapability = application.createCommandBusExecutionReceiptCapability(commandBus);
  commandBus.register('questions.mark_mastery', {
    handler(_command, _context, database) {
      database.run("INSERT INTO entries VALUES (1, 'not-published')");
      return { changed: true, value: true };
    }
  });

  await assert.rejects(commandBus.executeWithExecutionReceipt(receiptCapability, envelope(), {
    execute(database) {
      database.run("INSERT INTO agent_receipts VALUES ('receipt-definite', 'completed')");
      return { changed: true, value: undefined };
    }
  }), (error) => error.code === 'INTERNAL_ERROR');
  assert.deepEqual(coordinator.currentGeneration(), { dataEpoch: epoch, dataRevision: 0, controlRevision: 0 });
  assert.deepEqual(diskRows('SELECT id, value FROM entries'), []);
  assert.deepEqual(diskRows('SELECT id, status FROM agent_receipts'), []);
});

test('post-publication indeterminacy retains the complete receipt image and fences retries', async () => {
  const coordinator = createCoordinator({
    persistDependencies: { hook(context) { if (context.stage === 'afterLivePublish') throw new Error('response lost'); } }
  });
  let handlerCalls = 0;
  const commandBus = new application.CommandBus(coordinator, new application.DomainEventBus());
  const receiptCapability = application.createCommandBusExecutionReceiptCapability(commandBus);
  commandBus.register('questions.mark_mastery', {
    handler(_command, _context, database) {
      handlerCalls += 1;
      database.run("INSERT INTO entries VALUES (1, 'published')");
      return { changed: true, value: true };
    }
  });
  const receipt = {
    execute(database) {
      database.run("INSERT INTO agent_receipts VALUES ('receipt-indeterminate', 'completed')");
      return { changed: true, value: undefined };
    }
  };

  await assert.rejects(commandBus.executeWithExecutionReceipt(receiptCapability, envelope(), receipt),
    (error) => error.code === 'PERSISTENCE_INDETERMINATE');
  assert.equal(coordinator.state, 'needs_recovery');
  assert.equal(handlerCalls, 1);
  assert.deepEqual(diskRows('SELECT id, value FROM entries'), [[1, 'published']]);
  assert.deepEqual(diskRows('SELECT id, status FROM agent_receipts'), [['receipt-indeterminate', 'completed']]);
  const candidate = await candidates.inspectDatabaseFile(livePath, 'live', opener);
  assert.deepEqual(candidate.generation, { dataEpoch: epoch, dataRevision: 1, controlRevision: 1 });
  await assert.rejects(commandBus.executeWithExecutionReceipt(receiptCapability, envelope(), receipt),
    (error) => error.code === 'RECOVERY_FENCE');
  assert.equal(handlerCalls, 1);
});

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
const errors = environment.requireMain('../shared/agent/errors.js');
const root = path.join(environment.dataRoot, 'application-bus');
const livePath = path.join(root, 'mistakes.db');
const epoch = 'application-bus-epoch';
const fixedTime = '2026-07-15T08:09:10.123Z';
let SQL;
let opener;
let uuidCounter = 0;

function nextUuid() {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
}

function createDatabase(revision = 0) {
  const database = new SQL.Database();
  database.exec(`
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
  database.run('INSERT INTO control_metadata VALUES (1, ?, ?, 1, ?)', [epoch, revision, fixedTime]);
  return database;
}

async function resetLive() {
  uuidCounter = 0;
  await fs.promises.rm(root, { recursive: true, force: true });
  await fs.promises.mkdir(root, { recursive: true });
  const database = createDatabase();
  await fs.promises.writeFile(livePath, database.export());
  database.close();
}

function createCoordinator(overrides = {}) {
  let activeDatabase = new SQL.Database(fs.readFileSync(livePath));
  let nonce = 0;
  const coordinator = new coordinatorModule.DatabaseCoordinator({
    database: activeDatabase,
    livePath,
    opener,
    openDatabase: (bytes) => new SQL.Database(bytes),
    persistDependencies: {
      opener,
      files: atomic.defaultAtomicFileDependencies,
      randomId: () => `application-${++nonce}`,
      ...(overrides.persistDependencies ?? {})
    },
    publisher: overrides.publisher,
    replaceDatabase(next) {
      activeDatabase = next;
    },
    now: () => fixedTime,
    initialState: overrides.initialState
  });
  return { coordinator, database: () => activeDatabase };
}

function context(options = {}) {
  return application.createInternalExecutionContext({
    concurrency: options.concurrency ?? 'none',
    expectedVersion: options.expectedVersion,
    requestId: options.requestId ?? nextUuid(),
    traceId: options.traceId ?? nextUuid()
  }, { randomUUID: nextUuid, now: () => fixedTime });
}

function commandEnvelope(executionContext, questionId = 1) {
  return {
    apiVersion: 1,
    kind: 'command',
    context: executionContext,
    command: {
      type: 'questions.mark_mastery',
      payload: { questionId, mastery: '一般' }
    }
  };
}

function queryEnvelope(executionContext, questionId = 1) {
  return {
    apiVersion: 1,
    kind: 'query',
    context: executionContext,
    query: { type: 'questions.get', payload: { questionId } }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function diskRows() {
  const database = new SQL.Database(fs.readFileSync(livePath));
  try {
    const result = database.exec('SELECT id, value FROM entries ORDER BY id');
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

test('trusted context factories normalize metadata and prevent identity escalation', () => {
  const requestId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  const traceId = 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB';
  const renderer = application.createRendererExecutionContext({
    requestId,
    traceId,
    expectedVersion: { dataEpoch: epoch, dataRevision: 3 }
  }, { now: () => '2026-07-15T08:09:10.123+00:00' });

  assert.deepEqual(renderer, {
    trust: 'trusted',
    requestId: requestId.toLowerCase(),
    traceId: traceId.toLowerCase(),
    source: 'renderer',
    actor: { actorId: 'local-user', actorType: 'user' },
    client: { clientId: 'renderer', clientName: 'Kaoyan Renderer' },
    timestamp: fixedTime,
    concurrency: 'strict',
    expectedVersion: { dataEpoch: epoch, dataRevision: 3 }
  });
  assert.equal(Object.isFrozen(renderer), true);
  assert.equal(Object.isFrozen(renderer.actor), true);
  assert.equal(Object.isFrozen(renderer.expectedVersion), true);
  assert.throws(
    () => application.createRendererExecutionContext({ source: 'mcp' }),
    (error) => error.code === 'VALIDATION_ERROR' && error.details.field === 'options.source'
  );
  assert.throws(
    () => application.createInternalExecutionContext({
      concurrency: 'none',
      expectedVersion: { dataEpoch: epoch, dataRevision: 0 }
    }),
    (error) => error.code === 'VALIDATION_ERROR'
  );
  assert.throws(
    () => application.createInternalExecutionContext(null),
    (error) => error.code === 'VALIDATION_ERROR' && error.details.field === 'options'
  );
});

test('registries reject duplicates and valid envelopes without handlers deterministically', async () => {
  const { coordinator, database } = createCoordinator();
  const eventBus = new application.DomainEventBus();
  const commandBus = new application.CommandBus(coordinator, eventBus);
  const queryBus = new application.QueryBus(application.createReadOnlyDatabaseFacade(database), coordinator);
  const commandHandler = () => ({ changed: false, value: null });
  const queryHandler = () => null;

  commandBus.register('questions.mark_mastery', { handler: commandHandler });
  assert.throws(
    () => commandBus.register('questions.mark_mastery', { handler: commandHandler }),
    (error) => error.code === 'HANDLER_ALREADY_REGISTERED'
  );
  queryBus.register('questions.get', queryHandler);
  assert.throws(
    () => queryBus.register('questions.get', queryHandler),
    (error) => error.code === 'HANDLER_ALREADY_REGISTERED'
  );
  await assert.rejects(
    commandBus.execute({ ...commandEnvelope(context()), command: { type: 'questions.delete', payload: { questionId: 1, deleteImages: false } } }),
    (error) => error.code === 'HANDLER_NOT_FOUND'
  );
  assert.throws(
    () => queryBus.execute({ ...queryEnvelope(context()), query: { type: 'questions.review_buckets', payload: {} } }),
    (error) => error.code === 'HANDLER_NOT_FOUND'
  );
});

test('validates command envelopes and trusted contexts before coordinator execution', async () => {
  const { coordinator } = createCoordinator();
  const commandBus = new application.CommandBus(coordinator, new application.DomainEventBus());
  let handlerCalls = 0;
  commandBus.register('questions.mark_mastery', {
    handler() {
      handlerCalls += 1;
      return { changed: false, value: null };
    }
  });

  const malformed = commandEnvelope(context());
  malformed.command.payload.questionId = 0;
  await assert.rejects(commandBus.execute(malformed), (error) => error.code === 'VALIDATION_ERROR');
  const callerContext = {
    trust: 'caller',
    requestId: nextUuid(),
    traceId: nextUuid(),
    source: 'mcp',
    actor: { actorId: 'agent-1', actorType: 'agent' },
    client: { clientId: 'mcp-client' },
    timestamp: fixedTime,
    expectedVersion: { dataEpoch: epoch, dataRevision: 0 }
  };
  await assert.rejects(
    commandBus.execute(commandEnvelope(callerContext)),
    (error) => error.code === 'VALIDATION_ERROR' && error.details.field === 'envelope.context.trust'
  );
  assert.equal(handlerCalls, 0);
  assert.equal(coordinator.pendingWrites, 0);
});

test('serializes durable commands and publishes immutable events in command order', async () => {
  const { coordinator } = createCoordinator();
  const delivery = [];
  const eventBus = new application.DomainEventBus({ randomUUID: nextUuid, now: () => fixedTime });
  eventBus.subscribe((event) => {
    delivery.push({ type: event.type, rows: diskRows(), event });
  });
  const commandBus = new application.CommandBus(coordinator, eventBus);
  commandBus.register('questions.mark_mastery', {
    handler(command, executionContext, database, scope) {
      coordinatorModule.assertDatabaseMutationScope(scope, database);
      database.run('INSERT INTO entries VALUES (?, ?)', [command.payload.questionId, executionContext.requestId]);
      return {
        changed: true,
        value: { id: command.payload.questionId },
        events: [
          { type: 'entry.changed', payload: { id: command.payload.questionId, nested: { order: 1 } } },
          { type: 'entry.indexed', payload: { id: command.payload.questionId } }
        ]
      };
    }
  });
  const firstContext = context();
  const secondContext = context();
  const [first, second] = await Promise.all([
    commandBus.execute(commandEnvelope(firstContext, 1)),
    commandBus.execute(commandEnvelope(secondContext, 2))
  ]);

  assert.deepEqual(delivery.map((entry) => entry.type), [
    'entry.changed', 'entry.indexed', 'entry.changed', 'entry.indexed'
  ]);
  assert.deepEqual(delivery.map((entry) => entry.rows.length), [1, 1, 2, 2]);
  assert.deepEqual(first.dataVersion, { dataEpoch: epoch, dataRevision: 1 });
  assert.deepEqual(second.dataVersion, { dataEpoch: epoch, dataRevision: 2 });
  assert.deepEqual(first.events[0].versionBefore, { dataEpoch: epoch, dataRevision: 0 });
  assert.deepEqual(first.events[0].versionAfter, { dataEpoch: epoch, dataRevision: 1 });
  assert.equal(first.events[0].requestId, firstContext.requestId);
  assert.equal(first.events[0].traceId, firstContext.traceId);
  assert.equal(first.events[0].source, 'internal');
  assert.equal(Object.isFrozen(first.events), true);
  assert.equal(Object.isFrozen(first.events[0]), true);
  assert.equal(Object.isFrozen(first.events[0].payload), true);
  assert.equal(Object.isFrozen(first.events[0].payload.nested), true);
});

test('preserves coordinator concurrency conflicts through the command boundary', async () => {
  const { coordinator } = createCoordinator();
  const commandBus = new application.CommandBus(coordinator, new application.DomainEventBus({ randomUUID: nextUuid }));
  let handlerCalls = 0;
  commandBus.register('questions.mark_mastery', {
    conflicts: (command) => [{ entityType: 'question', entityId: String(command.payload.questionId) }],
    handler(command, _context, database) {
      handlerCalls += 1;
      database.run('INSERT INTO entries VALUES (?, ?)', [command.payload.questionId, 'changed']);
      return { changed: true, value: null };
    }
  });
  const expectedVersion = coordinator.currentVersion();
  const first = commandBus.execute(commandEnvelope(context({ concurrency: 'strict', expectedVersion }), 1));
  const second = commandBus.execute(commandEnvelope(context({ concurrency: 'strict', expectedVersion }), 2));

  await first;
  await assert.rejects(second, (error) => {
    assert.equal(error.code, 'DATA_REVISION_CONFLICT');
    assert.deepEqual(error.details.currentVersion, { dataEpoch: epoch, dataRevision: 1 });
    assert.deepEqual(error.details.conflicts, [{ entityType: 'question', entityId: '2' }]);
    return true;
  });
  assert.equal(handlerCalls, 1);
});

test('preserves application errors and maps unexpected command failures', async () => {
  const { coordinator } = createCoordinator();
  const commandBus = new application.CommandBus(coordinator, new application.DomainEventBus());
  commandBus.register('questions.mark_mastery', {
    handler(command) {
      if (command.payload.questionId === 1) throw new errors.AgentError('REQUEST_CONFLICT');
      throw new Error('secret internal detail');
    }
  });

  await assert.rejects(commandBus.execute(commandEnvelope(context(), 1)), (error) => error.code === 'REQUEST_CONFLICT');
  await assert.rejects(commandBus.execute(commandEnvelope(context(), 2)), (error) => {
    assert.equal(error.code, 'INTERNAL_ERROR');
    assert.equal(error.message.includes('secret'), false);
    return true;
  });
});

test('rolls back before persistence when event UUID preparation fails', async () => {
  let publications = 0;
  const { coordinator } = createCoordinator({
    publisher: async () => {
      publications += 1;
      throw new Error('publisher must not run');
    }
  });
  const delivered = [];
  const eventBus = new application.DomainEventBus({
    randomUUID() {
      throw new Error('uuid unavailable');
    }
  });
  eventBus.subscribe((event) => delivered.push(event));
  const commandBus = new application.CommandBus(coordinator, eventBus);
  commandBus.register('questions.mark_mastery', {
    handler(command, _context, database) {
      database.run('INSERT INTO entries VALUES (?, ?)', [command.payload.questionId, 'rolled back']);
      return { changed: true, value: true, events: [{ type: 'entry.changed', payload: { id: command.payload.questionId } }] };
    }
  });

  await assert.rejects(commandBus.execute(commandEnvelope(context())), (error) => error.code === 'INTERNAL_ERROR');
  assert.equal(publications, 0);
  assert.equal(delivered.length, 0);
  assert.deepEqual(coordinator.currentVersion(), { dataEpoch: epoch, dataRevision: 0 });
  assert.deepEqual(diskRows(), []);
});

test('rolls back before persistence when event timestamp preparation fails', async () => {
  let publications = 0;
  const { coordinator } = createCoordinator({
    publisher: async () => {
      publications += 1;
      throw new Error('publisher must not run');
    }
  });
  const delivered = [];
  const eventBus = new application.DomainEventBus({ randomUUID: nextUuid, now: () => 'invalid timestamp' });
  eventBus.subscribe((event) => delivered.push(event));
  const commandBus = new application.CommandBus(coordinator, eventBus);
  commandBus.register('questions.mark_mastery', {
    handler(command, _context, database) {
      database.run('INSERT INTO entries VALUES (?, ?)', [command.payload.questionId, 'rolled back']);
      return { changed: true, value: true, events: [{ type: 'entry.changed', payload: { id: command.payload.questionId } }] };
    }
  });

  await assert.rejects(commandBus.execute(commandEnvelope(context())), (error) => error.code === 'INTERNAL_ERROR');
  assert.equal(publications, 0);
  assert.equal(delivered.length, 0);
  assert.deepEqual(coordinator.currentVersion(), { dataEpoch: epoch, dataRevision: 0 });
  assert.deepEqual(diskRows(), []);
});

test('does not call event UUID or clock dependencies after durable publication starts', async () => {
  let publicationStarted = false;
  let uuidCalls = 0;
  let clockCalls = 0;
  const { coordinator } = createCoordinator({
    publisher(options) {
      publicationStarted = true;
      return atomic.atomicPersist(options);
    }
  });
  const eventBus = new application.DomainEventBus({
    randomUUID() {
      if (publicationStarted) throw new Error('late UUID call');
      uuidCalls += 1;
      return 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    },
    now() {
      if (publicationStarted) throw new Error('late clock call');
      clockCalls += 1;
      return fixedTime;
    }
  });
  const commandBus = new application.CommandBus(coordinator, eventBus);
  commandBus.register('questions.mark_mastery', {
    handler(command, _context, database) {
      database.run('INSERT INTO entries VALUES (?, ?)', [command.payload.questionId, 'durable']);
      return { changed: true, value: true, events: [{ type: 'entry.changed', payload: { id: command.payload.questionId } }] };
    }
  });

  const result = await commandBus.execute(commandEnvelope(context()));
  assert.equal(publicationStarted, true);
  assert.equal(uuidCalls, 1);
  assert.equal(clockCalls, 1);
  assert.deepEqual(result.events[0].versionBefore, { dataEpoch: epoch, dataRevision: 0 });
  assert.deepEqual(result.events[0].versionAfter, { dataEpoch: epoch, dataRevision: 1 });
  assert.deepEqual(diskRows(), [[1, 'durable']]);
});

test('isolates listener and diagnostic failures from durable results and later listeners', async () => {
  const { coordinator } = createCoordinator();
  const trace = [];
  const diagnostics = [];
  const eventBus = new application.DomainEventBus({
    randomUUID: nextUuid,
    diagnosticSink(diagnostic) {
      diagnostics.push(diagnostic);
      throw new Error('diagnostic sink failed');
    }
  });
  eventBus.subscribe(() => {
    trace.push('listener-1');
    throw new Error('listener failed');
  });
  eventBus.subscribe(() => { trace.push('listener-2'); });
  const commandBus = new application.CommandBus(coordinator, eventBus);
  commandBus.register('questions.mark_mastery', {
    handler(command, _context, database) {
      database.run('INSERT INTO entries VALUES (?, ?)', [command.payload.questionId, 'durable']);
      return { changed: true, value: 'ok', events: [{ type: 'entry.changed', payload: { id: command.payload.questionId } }] };
    }
  });

  const result = await commandBus.execute(commandEnvelope(context()));
  assert.equal(result.value, 'ok');
  assert.deepEqual(trace, ['listener-1', 'listener-2']);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].listenerIndex, 0);
  assert.deepEqual(diskRows(), [[1, 'durable']]);
});

test('publishes no events for no-op commands or failed persistence', async () => {
  const noOpSetup = createCoordinator({
    publisher: async () => { throw new Error('publisher must not run'); }
  });
  const delivered = [];
  const noOpEvents = new application.DomainEventBus({ randomUUID: nextUuid });
  noOpEvents.subscribe((event) => delivered.push(event));
  const noOpBus = new application.CommandBus(noOpSetup.coordinator, noOpEvents);
  noOpBus.register('questions.mark_mastery', {
    handler: () => ({ changed: false, value: 'same', events: [{ type: 'must.not.publish', payload: {} }] })
  });
  const noOp = await noOpBus.execute(commandEnvelope(context()));
  assert.equal(noOp.changed, false);
  assert.deepEqual(noOp.events, []);
  assert.equal(delivered.length, 0);

  const failedSetup = createCoordinator({
    persistDependencies: {
      hook(stage) {
        if (stage.stage === 'beforeExport') throw new Error('persistence failed');
      }
    }
  });
  const failedBus = new application.CommandBus(failedSetup.coordinator, noOpEvents);
  failedBus.register('questions.mark_mastery', {
    handler(command, _context, database) {
      database.run('INSERT INTO entries VALUES (?, ?)', [command.payload.questionId, 'not durable']);
      return { changed: true, value: true, events: [{ type: 'must.not.publish', payload: {} }] };
    }
  });
  await assert.rejects(failedBus.execute(commandEnvelope(context())), (error) => error.code === 'INTERNAL_ERROR');
  assert.equal(delivered.length, 0);
  assert.deepEqual(diskRows(), []);
});

test('query handlers receive only a select-only facade and return the observed version', () => {
  const { coordinator, database } = createCoordinator();
  database().run("INSERT INTO entries VALUES (1, 'one')");
  const facade = application.createReadOnlyDatabaseFacade(database);
  const queryBus = new application.QueryBus(facade, coordinator);
  let exposedKeys;
  queryBus.register('questions.get', (query, _context, readOnlyDatabase) => {
    exposedKeys = Object.keys(readOnlyDatabase).sort();
    const rows = readOnlyDatabase.select('SELECT id, value FROM entries WHERE id = ?', [query.payload.questionId]);
    return rows[0] ?? null;
  });

  const result = queryBus.execute(queryEnvelope(context()));
  assert.deepEqual(exposedKeys, ['kind', 'select']);
  assert.deepEqual(result.value, { id: 1, value: 'one' });
  assert.deepEqual(result.dataVersion, { dataEpoch: epoch, dataRevision: 0 });
  assert.equal(Object.isFrozen(result.value), true);
  assert.throws(() => facade.select("DELETE FROM entries WHERE id = 1"), (error) => error.code === 'VALIDATION_ERROR');
  assert.deepEqual(database().exec('SELECT id FROM entries')[0].values, [[1]]);
});

test('query validation, missing handlers, and unexpected errors are stable', () => {
  const { coordinator, database } = createCoordinator();
  const queryBus = new application.QueryBus(application.createReadOnlyDatabaseFacade(database), coordinator);
  let calls = 0;
  queryBus.register('questions.get', () => {
    calls += 1;
    throw new Error('private query detail');
  });
  const malformed = queryEnvelope(context(), 0);
  assert.throws(() => queryBus.execute(malformed), (error) => error.code === 'VALIDATION_ERROR');
  assert.equal(calls, 0);
  assert.throws(() => queryBus.execute(queryEnvelope(context())), (error) => {
    assert.equal(error.code, 'INTERNAL_ERROR');
    assert.equal(error.message.includes('private'), false);
    return true;
  });
});

test('queries reject pending writes and unsafe recovery, maintenance, and shutdown states', async () => {
  const { coordinator, database } = createCoordinator();
  const queryBus = new application.QueryBus(application.createReadOnlyDatabaseFacade(database), coordinator);
  queryBus.register('questions.get', () => null);
  const eventBus = new application.DomainEventBus();
  const commandBus = new application.CommandBus(coordinator, eventBus);
  const entered = deferred();
  const release = deferred();
  commandBus.register('questions.mark_mastery', {
    async handler() {
      entered.resolve();
      await release.promise;
      return { changed: false, value: null };
    }
  });
  const write = commandBus.execute(commandEnvelope(context()));
  await entered.promise;
  assert.throws(() => queryBus.execute(queryEnvelope(context())), (error) => error.code === 'MAINTENANCE_FENCE');
  release.resolve();
  await write;

  await coordinator.enterReadOnly();
  assert.equal(queryBus.execute(queryEnvelope(context())).value, null);
  coordinator.resumeWrites();
  const lease = await coordinator.beginMaintenance();
  assert.throws(() => queryBus.execute(queryEnvelope(context())), (error) => error.code === 'MAINTENANCE_FENCE');
  coordinator.finishMaintenance(lease, 'needs_recovery');
  assert.throws(() => queryBus.execute(queryEnvelope(context())), (error) => error.code === 'RECOVERY_FENCE');

  const shutdownSetup = createCoordinator();
  const shutdownBus = new application.QueryBus(
    application.createReadOnlyDatabaseFacade(shutdownSetup.database),
    shutdownSetup.coordinator
  );
  shutdownBus.register('questions.get', () => null);
  await shutdownSetup.coordinator.shutdown();
  assert.throws(() => shutdownBus.execute(queryEnvelope(context())), (error) => error.code === 'MAINTENANCE_FENCE');
});

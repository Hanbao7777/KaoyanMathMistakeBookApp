const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { constants, generateKeyPairSync, sign } = require('node:crypto');
const initSqlJs = require('sql.js');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const { AgentGateway } = environment.requireMain('agent/agentGateway.js');
const bootstrap = environment.requireMain('agent/bootstrap.js');
const authentication = environment.requireMain('agent/clientAuthenticator.js');
const application = environment.requireMain('application/index.js');
const coordinatorModule = environment.requireMain('persistence/databaseCoordinator.js');
const { AuditLedger } = environment.requireMain('agent/auditLedger.js');
const { WorkflowStore } = environment.requireMain('agent/workflows.js');
const { IdempotencyStore } = environment.requireMain('agent/idempotencyStore.js');
const { ExecutionReceipts } = environment.requireMain('agent/executionReceipts.js');
const { ClientRegistry } = environment.requireMain('agent/clientRegistry.js');
const stdioAuth = environment.requireMain('mcp/auth/stdioAuthenticator.js');
const atomic = environment.requireMain('persistence/atomicPersist.js');
const candidates = environment.requireMain('persistence/databaseCandidate.js');
const persistenceBootstrap = environment.requireMain('persistence/databaseBootstrap.js');
const { schemaSql } = environment.requireMain('database/schema.js');
const agent = require(`${environment.projectRoot}/dist/main/shared/agent/index.js`);

const now = '2026-07-16T14:00:00.000Z';
let sequence = 0;
const uuid = () => `50000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;

function settings(enabled = true) {
  return Object.freeze({
    externalControlEnabled: enabled,
    catalog: agent.operationCatalogIdentity,
    policyVersion: 'agent-policy-v1@1',
    overrides: Object.freeze([]),
    policyHash: agent.hashCanonicalJson([]),
    privacyRevision: 1
  });
}

function commandEnvelope(overrides = {}) {
  return {
    apiVersion: 1,
    kind: 'agent-command',
    operation: 'questions.mark_mastery',
    payload: { questionId: 1, mastery: '一般' },
    requestId: uuid(),
    expectedVersion: { dataEpoch: 'epoch-gateway', dataRevision: 2 },
    catalog: agent.operationCatalogIdentity,
    ...overrides
  };
}

function queryEnvelope(overrides = {}) {
  return {
    apiVersion: 1,
    kind: 'agent-query',
    operation: 'questions.review_buckets',
    payload: {},
    requestId: uuid(),
    catalog: agent.operationCatalogIdentity,
    ...overrides
  };
}

function managementCommand(operation, payload, overrides = {}) {
  return {
    apiVersion: 1, kind: 'agent-command', operation, payload, requestId: uuid(),
    catalog: agent.operationCatalogIdentity, ...overrides
  };
}

function managementQuery(operation, payload, overrides = {}) {
  return {
    apiVersion: 1, kind: 'agent-query', operation, payload, requestId: uuid(),
    catalog: agent.operationCatalogIdentity, ...overrides
  };
}

function fakePrincipal() {
  return Object.freeze({
    apiVersion: 1,
    kind: 'agent-principal',
    clientId: 'client-gateway',
    subjectId: 'subject-gateway',
    displayName: 'Gateway Client',
    scopes: Object.freeze(['questions.read', 'questions.write']),
    trust: 'full_control',
    credentialBinding: 'sha256-v1:'.concat('1'.repeat(64)),
    authenticatedAt: now,
    renderer: false
  });
}

function fakeDependencies(trace, overrides = {}) {
  const result = Object.freeze({
    changed: false,
    value: Object.freeze({ exact: 'result' }),
    events: Object.freeze([]),
    dataVersion: Object.freeze({ dataEpoch: 'epoch-gateway', dataRevision: 2 })
  });
  const dependencies = {
    async authorize() { trace.push('authorize'); return { settings: settings() }; },
    async resolveState() {
      trace.push('resolve');
      return {
        affectedEntityCount: 1,
        affectedEntities: [{ entityType: 'question', entityId: '1' }],
        affectedSetHash: agent.hashCanonicalJson([{ entityType: 'question', entityId: '1' }]),
        dataVersion: { dataEpoch: 'epoch-gateway', dataRevision: 2 }
      };
    },
    async resolveCommand(envelope) {
      const state = await dependencies.resolveState();
      return {
        descriptor: agent.resolveOperationDescriptor(envelope.operation),
        payload: envelope.payload,
        state,
        dispatch: 'business',
        operation: envelope.operation,
        expectedVersion: envelope.expectedVersion
      };
    },
    evaluatePolicy(input) {
      trace.push('policy');
      return {
        apiVersion: 1,
        disposition: 'execute',
        risk: input.descriptor.kind === 'query' ? 'R1' : 'R2',
        reasonCode: 'POLICY_EXECUTE',
        requiredScopes: input.descriptor.requiredScopes,
        catalog: agent.operationCatalogIdentity,
        policyVersion: 'agent-policy-v1@1'
      };
    },
    validateCommand() { trace.push('validate'); },
    validateQuery() { trace.push('validate'); },
    async admit(request) {
      trace.push('admit');
      return {
        kind: 'admitted',
        prepared: {
          receiptId: uuid(), clientId: request.clientId, requestId: request.requestId,
          operation: request.operation, payloadHash: agent.hashCanonicalJson(request.payload),
          baseVersion: request.baseVersion, catalog: request.catalog, risk: request.risk,
          policyVersion: request.policyVersion, createdAt: now
        }
      };
    },
    async dispatchCommand() { trace.push('dispatch'); return result; },
    async dispatchManagement() { trace.push('management-dispatch'); return result; },
    async dispatchQuery() { trace.push('query-bus'); return { value: { exact: 'query' }, dataVersion: result.dataVersion }; },
    async terminalizeKnownFailure() { trace.push('terminalize'); },
    workflows: {
      async getR4Grant() { return undefined; },
      async authorizeApproval() { return { approvalId: uuid(), binding: {} }; },
      async authorizeChangeSet() { return {}; },
      async createApproval() { throw new Error('not expected'); },
      async createChangeSet() { throw new Error('not expected'); },
      async queryManagement() { throw new Error('not expected'); }
    },
    audit: {
      async denial() { trace.push('denial-audit'); },
      async query() { trace.push('query-audit'); }
    },
    now: () => now,
    randomUUID: uuid,
  };
  return { ...dependencies, ...overrides };
}

async function realComposition(options = {}) {
  const coordinator = await environment.databaseService.getDatabaseCoordinator();
  const commandBus = new application.CommandBus(coordinator, new application.DomainEventBus({ now: () => now, randomUUID: uuid }));
  let executions = 0;
  commandBus.register('questions.mark_mastery', { handler: () => {
    executions += 1;
    if (options.handlerError) throw options.handlerError;
    return { changed: false, value: Object.freeze({ exact: 'terminal' }) };
  } });
  const queryBus = new application.QueryBus(await environment.databaseService.getReadOnlyDatabase(), coordinator);
  queryBus.register('questions.review_buckets', () => Object.freeze({ due: 0 }));
  const gatewayComposition = await bootstrap.bootstrapAgentGateway({
    coordinator,
    commandBus,
    queryBus,
    selectedCandidateEvidence: true,
    appInstanceId: 'gateway-instance',
    credentialVerifier: {
      verify(raw) {
        return {
          credentialFingerprint: authentication.fingerprintCredential(raw.credential),
          sessionFingerprint: authentication.fingerprintCredential(raw.session)
        };
      }
    },
    cursorSecret: 'g'.repeat(32),
    now: () => now,
    randomUUID: uuid
  });
  const b3 = await bootstrap.bootstrapAgentB3({
    coordinator,
    appInstanceId: 'gateway-instance',
    credentialVerifier: {
      verify(raw) {
        return {
          credentialFingerprint: authentication.fingerprintCredential(raw.credential),
          sessionFingerprint: authentication.fingerprintCredential(raw.session)
        };
      }
    },
    cursorSecret: 'g'.repeat(32),
    now: () => now,
    randomUUID: uuid
  });
  const credential = authentication.fingerprintCredential('credential');
  const session = authentication.fingerprintCredential('session');
  await b3.registry.registerClient({
    clientId: 'client-gateway', subjectId: 'subject-gateway', displayName: 'Gateway Client',
    credentialFingerprint: credential, scopes: options.scopes ?? ['questions.read', 'questions.write'], trust: options.trust ?? 'full_control'
  });
  await b3.registry.setExternalControlEnabled(true);
  await b3.registry.createSession('client-gateway', credential, session, '2026-07-16T14:30:00.000Z');
  const principal = await gatewayComposition.authenticator.authenticate({ credential: 'credential', session: 'session' });
  return { ...gatewayComposition, b3, principal, executions: () => executions, coordinator };
}

async function isolatedManagementRuntime(livePath, shouldFailPublication = () => false) {
  const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
  const opener = candidates.createSqlJsCandidateOpener(SQL);
  let database;
  if (fs.existsSync(livePath)) database = new SQL.Database(fs.readFileSync(livePath));
  else {
    database = new SQL.Database();
    database.exec(schemaSql);
    persistenceBootstrap.bootstrapControlMetadata(database, { createEpoch: () => 'management-lost-epoch', now: () => now });
    fs.mkdirSync(path.dirname(livePath), { recursive: true });
    fs.writeFileSync(livePath, database.export());
  }
  let nonce = 0;
  const coordinator = new coordinatorModule.DatabaseCoordinator({
    database, livePath, opener, openDatabase: (bytes) => new SQL.Database(bytes),
    files: atomic.defaultAtomicFileDependencies,
    persistDependencies: {
      opener, files: atomic.defaultAtomicFileDependencies, randomId: () => `management-lost-${++nonce}`,
      hook(context) { if (context.stage === 'afterLivePublish' && shouldFailPublication()) throw new Error('lost management response'); }
    },
    now: () => now
  });
  const commandBus = new application.CommandBus(coordinator, new application.DomainEventBus({ now: () => now, randomUUID: uuid }));
  const readOnly = application.createReadOnlyDatabaseFacade(() => database);
  const queryBus = new application.QueryBus(readOnly, coordinator);
  const composition = await bootstrap.bootstrapAgentGateway({
    coordinator, commandBus, queryBus, selectedCandidateEvidence: true, appInstanceId: 'management-lost-instance',
    credentialVerifier: { verify() { throw new Error('unused'); } }, cursorSecret: 'l'.repeat(32), now: () => now, randomUUID: uuid
  });
  return { coordinator, composition };
}

test.beforeEach(async () => { sequence = 0; await environment.resetControlPlaneEnvironment(); });
test.after(() => environment.cleanupControlPlaneRoot());

test('exposes only execute/query and performs one authorization, policy, admission, and receipt dispatch', async () => {
  const trace = [];
  const gateway = new AgentGateway(fakeDependencies(trace));
  const callable = Object.getOwnPropertyNames(Object.getPrototypeOf(gateway))
    .filter((name) => name !== 'constructor' && typeof gateway[name] === 'function');
  assert.deepEqual(callable.sort(), ['execute', 'query']);
  assert.deepEqual(Object.keys(gateway).filter((name) => typeof gateway[name] === 'function'), []);
  const outcome = await gateway.execute(commandEnvelope(), fakePrincipal());
  assert.equal(outcome.kind, 'completed');
  assert.deepEqual(trace, ['authorize', 'validate', 'resolve', 'policy', 'admit', 'dispatch']);
});

test('terminal replay and pending admission never dispatch the command bus', async () => {
  const replayTrace = [];
  const replayResult = Object.freeze({ changed: false, value: { exact: 'first' }, events: [], dataVersion: { dataEpoch: 'epoch-gateway', dataRevision: 2 } });
  const replayGateway = new AgentGateway(fakeDependencies(replayTrace, {
    async admit() {
      replayTrace.push('admit');
      return { kind: 'replayed', receipt: { status: 'completed', receiptId: uuid() }, outcome: replayResult };
    }
  }));
  assert.equal((await replayGateway.execute(commandEnvelope(), fakePrincipal())).kind, 'replayed');
  assert.equal(replayTrace.includes('dispatch'), false);

  const pendingTrace = [];
  const pendingGateway = new AgentGateway(fakeDependencies(pendingTrace, {
    async admit() { pendingTrace.push('admit'); return { kind: 'pending', receipt: { status: 'admitted' } }; }
  }));
  const pending = await pendingGateway.execute(commandEnvelope(), fakePrincipal());
  assert.equal(pending.error.code, 'RECOVERY_FENCE');
  assert.equal(pendingTrace.includes('dispatch'), false);
});

test('known precommit failure terminalizes, while publication ambiguity stays fenced and reserved', async () => {
  const knownTrace = [];
  const known = new AgentGateway(fakeDependencies(knownTrace, {
    async dispatchCommand() { knownTrace.push('dispatch'); throw new agent.AgentError('INTERNAL_ERROR'); }
  }));
  assert.equal((await known.execute(commandEnvelope(), fakePrincipal())).error.code, 'INTERNAL_ERROR');
  assert.deepEqual(knownTrace.slice(-2), ['dispatch', 'terminalize']);

  const ambiguousTrace = [];
  const ambiguous = new AgentGateway(fakeDependencies(ambiguousTrace, {
    async dispatchCommand() { ambiguousTrace.push('dispatch'); throw new agent.AgentError('PERSISTENCE_INDETERMINATE'); }
  }));
  assert.equal((await ambiguous.execute(commandEnvelope(), fakePrincipal())).error.code, 'PERSISTENCE_INDETERMINATE');
  assert.equal(ambiguousTrace.includes('terminalize'), false);
});

test('query data is returned only after durable audit and audit failure replaces the result', async () => {
  const trace = [];
  const gateway = new AgentGateway(fakeDependencies(trace));
  assert.equal((await gateway.query(queryEnvelope(), fakePrincipal())).kind, 'completed');
  assert.deepEqual(trace.slice(-2), ['query-bus', 'query-audit']);

  const failureTrace = [];
  const auditFailure = new AgentGateway(fakeDependencies(failureTrace, {
    audit: { async denial() {}, async query() { throw new Error('disk unavailable'); } }
  }));
  const outcome = await auditFailure.query(queryEnvelope(), fakePrincipal());
  assert.equal(outcome.error.code, 'AUDIT_UNAVAILABLE');
});

test('production composition replays exact terminal results and rechecks revocation on every call', async () => {
  const current = await realComposition();
  const version = current.coordinator.currentVersion();
  const envelope = commandEnvelope({ expectedVersion: version });
  assert.equal((await current.gateway.execute(envelope, current.principal)).kind, 'completed');
  assert.equal((await current.gateway.execute(envelope, current.principal)).kind, 'replayed');
  assert.equal(current.executions(), 1);

  const copied = { ...current.principal };
  assert.equal((await current.gateway.query(queryEnvelope(), copied)).error.code, 'POLICY_DENIED');
  await current.b3.registry.revokeClient(current.principal.clientId);
  assert.equal((await current.gateway.query(queryEnvelope(), current.principal)).error.code, 'CLIENT_REVOKED');
});

test('terminating a session through the Gateway revokes its issued principal immediately', async () => {
  const current = await realComposition();
  const sessions = await current.gateway.query(managementQuery('agent.sessions.list', { pageSize: 10 }), current.renderer.principal());
  assert.equal(sessions.kind, 'completed');
  const sessionId = sessions.result.value.items.find((item) => item.clientId === current.principal.clientId).sessionId;
  const terminated = await current.gateway.execute(
    managementCommand('agent.sessions.terminate', { sessionId }),
    current.renderer.principal()
  );
  assert.equal(terminated.kind, 'completed');
  assert.equal((await current.gateway.query(queryEnvelope(), current.principal)).error.code, 'CLIENT_REVOKED');
});

test('disabled control denies external principals while renderer keeps recovery management and migrated questions', async () => {
  const current = await realComposition();
  await current.b3.registry.setExternalControlEnabled(false);
  const external = await current.gateway.query(queryEnvelope(), current.principal);
  assert.equal(external.error.code, 'EXTERNAL_CONTROL_DISABLED');
  const renderer = current.renderer.principal();
  const status = await current.gateway.query(queryEnvelope({ operation: 'agent.status.get' }), renderer);
  assert.equal(status.kind, 'completed');
  const business = await current.gateway.query(queryEnvelope(), renderer);
  assert.equal(business.kind, 'completed');
});

test('database restart verifies audit then reconciles orphan admission before Gateway readiness', async () => {
  const coordinator = await environment.databaseService.getDatabaseCoordinator();
  const capability = coordinatorModule.createDatabaseCoordinatorControlCapability(coordinator);
  const executeControlWrite = (request) => coordinator.executeControlWrite(capability, request);
  const audit = new AuditLedger({ executeControlWrite, catalog: agent.operationCatalogIdentity, now: () => now, randomUUID: uuid });
  const workflows = new WorkflowStore({ executeControlWrite, audit, now: () => now, randomUUID: uuid });
  const idempotency = new IdempotencyStore({ executeControlWrite, audit, workflows, now: () => now, randomUUID: uuid });
  const requestId = uuid();
  await idempotency.admit({
    clientId: 'restart-client', requestId, operation: 'questions.mark_mastery',
    payload: { questionId: 1, mastery: '一般' }, affectedEntities: [{ entityType: 'question', entityId: '1' }],
    baseVersion: coordinator.currentVersion(), catalog: agent.operationCatalogIdentity, risk: 'R2'
  });

  environment.databaseService.resetDatabaseConnection();
  const trace = [];
  await environment.databaseService.initializeDatabase({
    now: () => now,
    randomId: uuid,
    onStage: (stage) => trace.push(stage),
    agent: { appInstanceId: 'restart-instance', cursorSecret: 'r'.repeat(32) }
  });
  assert.ok(trace.indexOf('audit_ledger_verified') < trace.indexOf('agent_receipts_reconciled'));
  assert.ok(trace.indexOf('agent_receipts_reconciled') < trace.indexOf('agent_gateway_ready'));

  const reopened = await environment.databaseService.getDatabaseCoordinator();
  const reopenedCapability = coordinatorModule.createDatabaseCoordinatorControlCapability(reopened);
  const reopenedWrite = (request) => reopened.executeControlWrite(reopenedCapability, request);
  const reopenedAudit = new AuditLedger({ executeControlWrite: reopenedWrite, catalog: agent.operationCatalogIdentity, now: () => now, randomUUID: uuid });
  const reopenedWorkflows = new WorkflowStore({ executeControlWrite: reopenedWrite, audit: reopenedAudit, now: () => now, randomUUID: uuid });
  const reopenedIdempotency = new IdempotencyStore({ executeControlWrite: reopenedWrite, audit: reopenedAudit, workflows: reopenedWorkflows, now: () => now, randomUUID: uuid });
  assert.equal((await reopenedIdempotency.get('restart-client', requestId)).receipt.status, 'interrupted_precommit');
});

test('management commands admit once, replay exactly, conflict on mismatch, and return verified export data', async () => {
  const composition = await environment.databaseService.getAgentControlPlane();
  const renderer = composition.renderer.principal();
  const request = managementCommand('agent.control.set_enabled', { enabled: true });
  const first = await composition.gateway.execute(request, renderer);
  const replay = await composition.gateway.execute(request, renderer);
  assert.equal(first.kind, 'completed');
  assert.equal(first.result.value.enabled, true);
  assert.equal(replay.kind, 'replayed');
  assert.deepEqual(replay.result, first.result);
  const mismatch = await composition.gateway.execute({ ...request, payload: { enabled: false } }, renderer);
  assert.equal(mismatch.error.code, 'IDEMPOTENCY_CONFLICT');

  const exported = await composition.gateway.execute(managementCommand('agent.audit.export', {
    redaction: { apiVersion: 1, kind: 'redaction-profile', detail: 'standard', includeUserContent: false, includeAffectedEntities: true, fields: [] },
    pageSize: 20
  }), renderer);
  assert.equal(exported.kind, 'completed');
  assert.equal(exported.result.value.valid, true);
  assert.ok(exported.result.value.records.some((record) => record.kind === 'success' && record.operation === 'agent.control.set_enabled'));
  assert.equal(exported.result.value.page.pageSize, 20);
});

test('lost management response replays the terminal receipt after selected-candidate restart', async () => {
  const root = environment.assertOwnedPath(path.join(environment.dataRoot, 'management-lost-response'));
  const livePath = path.join(root, 'mistakes.db');
  let armed = false;
  let publications = 0;
  const first = await isolatedManagementRuntime(livePath, () => armed && ++publications === 2);
  const request = managementCommand('agent.control.set_enabled', { enabled: true });
  armed = true;
  const ambiguous = await first.composition.gateway.execute(request, first.composition.renderer.principal());
  assert.equal(ambiguous.error.code, 'PERSISTENCE_INDETERMINATE');
  const recovered = await isolatedManagementRuntime(livePath);
  const replay = await recovered.composition.gateway.execute(request, recovered.composition.renderer.principal());
  assert.equal(replay.kind, 'replayed');
  assert.equal(replay.result.value.enabled, true);
});

test('management terminal audit failure rolls back mutation and leaves only the admitted receipt', async () => {
  const coordinator = await environment.databaseService.getDatabaseCoordinator();
  const capability = coordinatorModule.createDatabaseCoordinatorControlCapability(coordinator);
  const executeControlWrite = (request) => coordinator.executeControlWrite(capability, request);
  let randomCalls = 0;
  const failingUuid = () => (++randomCalls === 4 ? 'invalid-audit-id' : uuid());
  const audit = new AuditLedger({ executeControlWrite, catalog: agent.operationCatalogIdentity, now: () => now, randomUUID: failingUuid });
  const workflows = new WorkflowStore({ executeControlWrite, audit, now: () => now, randomUUID: failingUuid });
  const idempotency = new IdempotencyStore({ executeControlWrite, audit, workflows, now: () => now, randomUUID: failingUuid });
  const registry = new ClientRegistry({ executeControlWrite, appInstanceId: 'audit-rollback-instance', catalog: agent.operationCatalogIdentity, now: () => now, randomUUID: failingUuid });
  const receipts = new ExecutionReceipts({ audit, workflows, now: () => now });
  const requestId = uuid();
  const admitted = await idempotency.admit({
    clientId: 'local-renderer-management', requestId, operation: 'agent.control.set_enabled', payload: { enabled: true },
    affectedEntities: [{ entityType: 'operation', entityId: 'bounded-target' }], catalog: agent.operationCatalogIdentity, risk: 'R2'
  });
  await assert.rejects(executeControlWrite({ requestId: `control-${requestId}`, execute(database, scope) {
    const mutation = registry.setExternalControlEnabledInTransaction(database, scope, true);
    const result = receipts.finalizeControlSuccessInTransaction(database, scope, admitted.prepared, { changed: mutation.changed, value: { enabled: true } });
    return { changed: true, value: result };
  } }));
  assert.equal((await registry.getSettings()).externalControlEnabled, false);
  assert.equal((await idempotency.get('local-renderer-management', requestId)).receipt.status, 'admitted');
});

test('client and session management lists are bounded, cursor-bound, redacted, and visibility-scoped', async () => {
  const current = await realComposition({ scopes: ['clients.read', 'questions.read', 'questions.write', 'sessions.read'] });
  const credentialTwo = authentication.fingerprintCredential('credential-two');
  await current.b3.registry.registerClient({
    clientId: 'client-second', subjectId: 'subject-second', displayName: 'Second Client',
    credentialFingerprint: credentialTwo, scopes: ['questions.read'], trust: 'observer'
  });
  const renderer = current.renderer.principal();
  const firstPage = await current.gateway.query(managementQuery('agent.clients.list', { pageSize: 1 }), renderer);
  assert.equal(firstPage.kind, 'completed');
  assert.equal(firstPage.result.value.items.length, 1);
  assert.equal(firstPage.result.value.page.hasMore, true);
  assert.equal('credentialFingerprint' in firstPage.result.value.items[0], false);
  const secondPage = await current.gateway.query(managementQuery('agent.clients.list', {
    pageSize: 1, cursor: firstPage.result.value.page.nextCursor
  }), renderer);
  assert.equal(secondPage.kind, 'completed', JSON.stringify(secondPage));
  assert.equal(secondPage.result.value.items.length, 1);
  const rebound = await current.gateway.query(managementQuery('agent.clients.list', {
    pageSize: 2, cursor: firstPage.result.value.page.nextCursor
  }), renderer);
  assert.equal(rebound.error.code, 'CURSOR_INVALID');

  const ownClients = await current.gateway.query(managementQuery('agent.clients.list', { pageSize: 10 }), current.principal);
  assert.deepEqual(ownClients.result.value.items.map((item) => item.clientId), ['client-gateway']);
  const ownSessions = await current.gateway.query(managementQuery('agent.sessions.list', { pageSize: 10 }), current.principal);
  assert.equal(ownSessions.result.value.items.length, 1);
  assert.equal(ownSessions.result.value.items[0].clientId, 'client-gateway');
  assert.equal('sessionFingerprint' in ownSessions.result.value.items[0], false);
});

test('external audit export is client-scoped and its cursor cannot cross principals', async () => {
  const current = await realComposition({ scopes: ['audit.export', 'questions.read', 'questions.write'] });
  const capability = coordinatorModule.createDatabaseCoordinatorControlCapability(current.coordinator);
  const executeControlWrite = (request) => current.coordinator.executeControlWrite(capability, request);
  const audit = new AuditLedger({ executeControlWrite, catalog: agent.operationCatalogIdentity, now: () => now, randomUUID: uuid });
  await audit.recordControlChange({
    clientId: 'client-second', operation: 'agent.control.set_enabled', risk: 'R2',
    summary: { action: 'other_client_event' }
  });
  const redaction = { apiVersion: 1, kind: 'redaction-profile', detail: 'standard', includeUserContent: false, includeAffectedEntities: true, fields: [] };
  const own = await current.gateway.execute(managementCommand('agent.audit.export', { redaction, pageSize: 20 }), current.principal);
  assert.equal(own.kind, 'completed');
  assert.ok(own.result.value.records.length > 0);
  assert.ok(own.result.value.records.every((record) => record.clientId === current.principal.clientId));

  const rendererPage = await current.gateway.execute(managementCommand('agent.audit.export', { redaction, pageSize: 1 }), current.renderer.principal());
  assert.equal(rendererPage.kind, 'completed');
  assert.equal(rendererPage.result.value.page.hasMore, true);
  const rebound = await current.gateway.execute(managementCommand('agent.audit.export', {
    redaction, pageSize: 1, cursor: { apiVersion: 1, kind: 'audit-cursor', value: rendererPage.result.value.page.nextCursor }
  }), current.principal);
  assert.equal(rebound.error.code, 'CURSOR_INVALID');
});

test('external changeset get cannot read another client plan', async () => {
  const current = await realComposition({ scopes: ['changesets.read', 'questions.read', 'questions.write'] });
  const capability = coordinatorModule.createDatabaseCoordinatorControlCapability(current.coordinator);
  const executeControlWrite = (request) => current.coordinator.executeControlWrite(capability, request);
  const audit = new AuditLedger({ executeControlWrite, catalog: agent.operationCatalogIdentity, now: () => now, randomUUID: uuid });
  const workflows = new WorkflowStore({ executeControlWrite, audit, now: () => now, randomUUID: uuid });
  const payload = { questionId: 1, mastery: '一般' };
  const affected = [{ entityType: 'question', entityId: '1' }];
  const changeSetId = uuid();
  await workflows.createChangeSet({
    apiVersion: 1, changeSetId, clientId: 'client-second', status: 'approved', catalog: agent.operationCatalogIdentity,
    baseVersion: current.coordinator.currentVersion(), risk: 'R2', summary: 'Other client plan',
    operations: [{ operation: 'questions.mark_mastery', payload, payloadHash: agent.hashCanonicalJson(payload), affectedEntities: affected }],
    affectedSetHash: agent.hashCanonicalJson(affected), recovery: 'inverse', createdAt: now, expiresAt: '2026-07-16T15:00:00.000Z'
  });
  const denied = await current.gateway.query(managementQuery('agent.changesets.get', { changeSetId }), current.principal);
  assert.equal(denied.error.code, 'SCOPE_DENIED');
});

test('approved one-operation change set applies through CommandBus once and terminal replay never re-executes', async () => {
  const current = await realComposition({ scopes: ['changesets.manage', 'questions.write'] });
  const capability = coordinatorModule.createDatabaseCoordinatorControlCapability(current.coordinator);
  const executeControlWrite = (request) => current.coordinator.executeControlWrite(capability, request);
  const audit = new AuditLedger({ executeControlWrite, catalog: agent.operationCatalogIdentity, now: () => now, randomUUID: uuid });
  const workflows = new WorkflowStore({ executeControlWrite, audit, now: () => now, randomUUID: uuid });
  const baseVersion = current.coordinator.currentVersion();
  const affected = [{ entityType: 'question', entityId: '1' }];
  const payload = { questionId: 1, mastery: '一般' };
  const changeSetId = uuid();
  await workflows.createChangeSet({
    apiVersion: 1, changeSetId, clientId: current.principal.clientId, status: 'approved', catalog: agent.operationCatalogIdentity,
    baseVersion, risk: 'R2', summary: 'Apply mastery',
    operations: [{ operation: 'questions.mark_mastery', payload, payloadHash: agent.hashCanonicalJson(payload), affectedEntities: affected }],
    affectedSetHash: agent.hashCanonicalJson(affected), recovery: 'inverse', createdAt: now, expiresAt: '2026-07-16T15:00:00.000Z'
  });
  const request = managementCommand('agent.changesets.apply', { changeSetId });
  assert.equal((await current.gateway.execute(request, current.principal)).kind, 'completed');
  const replay = await current.gateway.execute(request, current.principal);
  assert.equal(replay.kind, 'replayed', JSON.stringify(replay));
  assert.equal(current.executions(), 1);
  assert.equal((await workflows.getChangeSet(changeSetId)).status, 'applied');
});

test('renderer applies an approved external change set outside migrated renderer operations exactly once', async () => {
  const current = await realComposition({ scopes: ['questions.read', 'questions.write'] });
  const capability = coordinatorModule.createDatabaseCoordinatorControlCapability(current.coordinator);
  const executeControlWrite = (request) => current.coordinator.executeControlWrite(capability, request);
  const audit = new AuditLedger({ executeControlWrite, catalog: agent.operationCatalogIdentity, now: () => now, randomUUID: uuid });
  const workflows = new WorkflowStore({ executeControlWrite, audit, now: () => now, randomUUID: uuid });
  await current.b3.registry.registerClient({
    clientId: 'external-change-set-client', subjectId: 'external-change-set-client', displayName: 'External change set client',
    credentialFingerprint: authentication.fingerprintCredential('external-change-set-client'), scopes: ['questions.write'], trust: 'full_control'
  });
  const baseVersion = current.coordinator.currentVersion();
  const payload = { questionId: 1, mastery: '一般' };
  const affected = [{ entityType: 'question', entityId: '1' }];
  const changeSetId = uuid();
  await workflows.createChangeSet({
    apiVersion: 1, changeSetId, clientId: 'external-change-set-client', status: 'approved', catalog: agent.operationCatalogIdentity,
    baseVersion, risk: 'R2', summary: 'Renderer applies external plan',
    operations: [{ operation: 'questions.mark_mastery', payload, payloadHash: agent.hashCanonicalJson(payload), affectedEntities: affected }],
    affectedSetHash: agent.hashCanonicalJson(affected), recovery: 'inverse', createdAt: now, expiresAt: '2026-07-16T15:00:00.000Z'
  });
  const request = managementCommand('agent.changesets.apply', { changeSetId });
  assert.equal((await current.gateway.execute(request, current.renderer.principal())).kind, 'completed');
  assert.equal((await current.gateway.execute(request, current.renderer.principal())).kind, 'replayed');
  assert.equal(current.executions(), 1);
  assert.equal((await workflows.getChangeSet(changeSetId)).status, 'applied');
});

test('change-set apply denies narrowed, revoked, observer, and cross-client authority without side effects', async () => {
  const current = await realComposition({ scopes: ['changesets.manage', 'questions.write'] });
  const capability = coordinatorModule.createDatabaseCoordinatorControlCapability(current.coordinator);
  const executeControlWrite = (request) => current.coordinator.executeControlWrite(capability, request);
  const audit = new AuditLedger({ executeControlWrite, catalog: agent.operationCatalogIdentity, now: () => now, randomUUID: uuid });
  const workflows = new WorkflowStore({ executeControlWrite, audit, now: () => now, randomUUID: uuid });
  const payload = { questionId: 1, mastery: '一般' };
  const affected = [{ entityType: 'question', entityId: '1' }];
  async function ownerChangeSet(clientId) {
    await current.b3.registry.registerClient({
      clientId, subjectId: clientId, displayName: clientId,
      credentialFingerprint: authentication.fingerprintCredential(clientId), scopes: ['questions.write'], trust: 'full_control'
    });
    const changeSetId = uuid();
    await workflows.createChangeSet({
      apiVersion: 1, changeSetId, clientId, status: 'approved', catalog: agent.operationCatalogIdentity,
      baseVersion: current.coordinator.currentVersion(), risk: 'R2', summary: `Denied ${clientId}`,
      operations: [{ operation: 'questions.mark_mastery', payload, payloadHash: agent.hashCanonicalJson(payload), affectedEntities: affected }],
      affectedSetHash: agent.hashCanonicalJson(affected), recovery: 'inverse', createdAt: now, expiresAt: '2026-07-16T15:00:00.000Z'
    });
    return changeSetId;
  }

  const narrowed = await ownerChangeSet('changeset-narrowed');
  await current.b3.registry.updateClientAccess('changeset-narrowed', ['audit.read'], 'full_control');
  assert.equal((await current.gateway.execute(managementCommand('agent.changesets.apply', { changeSetId: narrowed }), current.renderer.principal())).error.code, 'SCOPE_DENIED');
  assert.equal((await workflows.getChangeSet(narrowed)).status, 'approved');

  const revoked = await ownerChangeSet('changeset-revoked');
  await current.b3.registry.revokeClient('changeset-revoked');
  assert.equal((await current.gateway.execute(managementCommand('agent.changesets.apply', { changeSetId: revoked }), current.renderer.principal())).error.code, 'CLIENT_REVOKED');
  assert.equal((await workflows.getChangeSet(revoked)).status, 'approved');

  const observer = await ownerChangeSet('changeset-observer');
  await current.b3.registry.updateClientAccess('changeset-observer', ['questions.write'], 'observer');
  assert.equal((await current.gateway.execute(managementCommand('agent.changesets.apply', { changeSetId: observer }), current.renderer.principal())).error.code, 'POLICY_DENIED');
  assert.equal((await workflows.getChangeSet(observer)).status, 'approved');

  const crossClient = await ownerChangeSet('changeset-cross-client');
  assert.equal((await current.gateway.execute(managementCommand('agent.changesets.apply', { changeSetId: crossClient }), current.principal)).error.code, 'APPROVAL_INVALID');
  assert.equal((await workflows.getChangeSet(crossClient)).status, 'approved');
  assert.equal(current.executions(), 0);
});

test('failed change-set business dispatch terminalizes failure without marking the change set applied', async () => {
  const current = await realComposition({ scopes: ['changesets.manage', 'questions.write'], handlerError: new agent.AgentError('INTERNAL_ERROR') });
  const capability = coordinatorModule.createDatabaseCoordinatorControlCapability(current.coordinator);
  const executeControlWrite = (request) => current.coordinator.executeControlWrite(capability, request);
  const audit = new AuditLedger({ executeControlWrite, catalog: agent.operationCatalogIdentity, now: () => now, randomUUID: uuid });
  const workflows = new WorkflowStore({ executeControlWrite, audit, now: () => now, randomUUID: uuid });
  const payload = { questionId: 1, mastery: '一般' };
  const affected = [{ entityType: 'question', entityId: '1' }];
  const changeSetId = uuid();
  await workflows.createChangeSet({
    apiVersion: 1, changeSetId, clientId: current.principal.clientId, status: 'approved', catalog: agent.operationCatalogIdentity,
    baseVersion: current.coordinator.currentVersion(), risk: 'R2', summary: 'Fail mastery',
    operations: [{ operation: 'questions.mark_mastery', payload, payloadHash: agent.hashCanonicalJson(payload), affectedEntities: affected }],
    affectedSetHash: agent.hashCanonicalJson(affected), recovery: 'inverse', createdAt: now, expiresAt: '2026-07-16T15:00:00.000Z'
  });
  const request = managementCommand('agent.changesets.apply', { changeSetId });
  const outcome = await current.gateway.execute(request, current.principal);
  assert.equal(outcome.error.code, 'INTERNAL_ERROR');
  const replay = await current.gateway.execute(request, current.principal);
  assert.equal(replay.error.code, 'INTERNAL_ERROR');
  assert.equal(current.executions(), 1);
  assert.equal((await workflows.getChangeSet(changeSetId)).status, 'approved');
});

test('change-set storage rejects mismatched payload and affected-set hashes', async () => {
  const current = await realComposition({ scopes: ['changesets.manage', 'questions.write'] });
  const capability = coordinatorModule.createDatabaseCoordinatorControlCapability(current.coordinator);
  const executeControlWrite = (request) => current.coordinator.executeControlWrite(capability, request);
  const audit = new AuditLedger({ executeControlWrite, catalog: agent.operationCatalogIdentity, now: () => now, randomUUID: uuid });
  const workflows = new WorkflowStore({ executeControlWrite, audit, now: () => now, randomUUID: uuid });
  const payload = { questionId: 1, mastery: '一般' };
  const affected = [{ entityType: 'question', entityId: '1' }];
  const baseVersion = current.coordinator.currentVersion();
  await assert.rejects(workflows.createChangeSet({
    apiVersion: 1, changeSetId: uuid(), clientId: current.principal.clientId, status: 'approved', catalog: agent.operationCatalogIdentity,
    baseVersion, risk: 'R2', summary: 'Tampered payload hash',
    operations: [{ operation: 'questions.mark_mastery', payload, payloadHash: agent.hashCanonicalJson({ ...payload, mastery: '较好' }), affectedEntities: affected }],
    affectedSetHash: agent.hashCanonicalJson(affected), recovery: 'inverse', createdAt: now, expiresAt: '2026-07-16T15:00:00.000Z'
  }), (error) => error?.code === 'APPROVAL_INVALID');

  await assert.rejects(workflows.createChangeSet({
    apiVersion: 1, changeSetId: uuid(), clientId: current.principal.clientId, status: 'approved', catalog: agent.operationCatalogIdentity,
    baseVersion, risk: 'R2', summary: 'Tampered affected set',
    operations: [{ operation: 'questions.mark_mastery', payload, payloadHash: agent.hashCanonicalJson(payload), affectedEntities: affected }],
    affectedSetHash: agent.hashCanonicalJson([{ entityType: 'question', entityId: '999' }]), recovery: 'inverse', createdAt: now, expiresAt: '2026-07-16T15:00:00.000Z'
  }), (error) => error?.code === 'APPROVAL_INVALID');
  assert.equal(current.executions(), 0);
});

test('stale change-set base is rejected before admission or business dispatch', async () => {
  const current = await realComposition({ scopes: ['changesets.manage', 'questions.write'] });
  const capability = coordinatorModule.createDatabaseCoordinatorControlCapability(current.coordinator);
  const executeControlWrite = (request) => current.coordinator.executeControlWrite(capability, request);
  const audit = new AuditLedger({ executeControlWrite, catalog: agent.operationCatalogIdentity, now: () => now, randomUUID: uuid });
  const workflows = new WorkflowStore({ executeControlWrite, audit, now: () => now, randomUUID: uuid });
  const baseVersion = current.coordinator.currentVersion();
  const payload = { questionId: 1, mastery: '一般' };
  const affected = [{ entityType: 'question', entityId: '1' }];
  const changeSetId = uuid();
  await workflows.createChangeSet({
    apiVersion: 1, changeSetId, clientId: current.principal.clientId, status: 'approved', catalog: agent.operationCatalogIdentity,
    baseVersion, risk: 'R2', summary: 'Stale mastery',
    operations: [{ operation: 'questions.mark_mastery', payload, payloadHash: agent.hashCanonicalJson(payload), affectedEntities: affected }],
    affectedSetHash: agent.hashCanonicalJson(affected), recovery: 'inverse', createdAt: now, expiresAt: '2026-07-16T15:00:00.000Z'
  });
  await current.coordinator.executeWrite({
    requestId: uuid(), concurrency: 'none',
    execute(database) {
      database.run("INSERT INTO tags (name, created_at) VALUES ('stale-base', ?)", [now]);
      return { changed: true, value: undefined };
    }
  });
  const outcome = await current.gateway.execute(managementCommand('agent.changesets.apply', { changeSetId }), current.principal);
  assert.equal(outcome.error.code, 'APPROVAL_INVALID');
  assert.equal(current.executions(), 0);
  assert.equal((await workflows.getChangeSet(changeSetId)).status, 'approved');
});

test('public-key registration and rotation are durable Gateway mutations and invalidate old stdio sessions', async () => {
  const current = await realComposition({ scopes: ['clients.manage', 'system.read'] });
  const firstPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const firstPublicKey = firstPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const firstBinding = {
    clientId: 'stdio-client', publicKeyFormat: 'spki-der-base64url', publicKey: firstPublicKey,
    publicKeyFingerprint: agent.publicKeyFingerprintForSpki(firstPublicKey), signatureAlgorithm: 'rsa-pss-sha256',
    expectedRegistryGeneration: 0
  };
  const registerEnvelope = managementCommand('agent.clients.register_key', firstBinding);
  const registered = await current.gateway.execute(registerEnvelope, current.principal);
  assert.equal(registered.kind, 'completed');
  assert.deepEqual(
    { status: registered.result.value.status, keyGeneration: registered.result.value.keyGeneration, registryGeneration: registered.result.value.registryGeneration },
    { status: 'registered', keyGeneration: 1, registryGeneration: 1 }
  );
  assert.equal(await current.stdioAuthenticator.ready(), true);
  const duplicate = await current.gateway.execute(managementCommand('agent.clients.register_key', { ...firstBinding, clientId: 'stdio-client-two' }), current.principal);
  assert.equal(duplicate.error.code, 'IDEMPOTENCY_CONFLICT');
  const receipt = await current.gateway.query(managementQuery('agent.receipts.get_status', {
    clientId: current.principal.clientId, requestId: registerEnvelope.requestId
  }), current.principal);
  assert.equal(receipt.kind, 'completed');
  assert.equal(receipt.result.value.status, 'completed');
  assert.equal(receipt.result.value.terminal.kind, 'command-result');

  const challenge = await current.stdioAuthenticator.issueChallenge({ clientId: 'stdio-client', mcpProtocolVersion: '2025-11-25', launcherVersion: '1.0.0' });
  const signature = sign('sha256', stdioAuth.canonicalStdioChallengeBytes(challenge), {
    key: firstPair.privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32
  }).toString('base64url');
  const admission = await current.stdioAuthenticator.admitInitialize({
    protocolVersion: '2025-11-25',
    headers: { 'x-kaoyan-challenge-id': challenge.challengeId, 'x-kaoyan-challenge-signature': signature }
  });
  assert.ok(admission);
  assert.equal((await current.stdioAuthenticator.validateSession(admission.sessionId, '2025-11-25')).clientId, 'stdio-client');

  const secondPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const secondPublicKey = secondPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const rotated = await current.gateway.execute(managementCommand('agent.clients.rotate_key', {
    ...firstBinding, publicKey: secondPublicKey, publicKeyFingerprint: agent.publicKeyFingerprintForSpki(secondPublicKey), expectedRegistryGeneration: 1
  }), current.principal);
  assert.equal(rotated.kind, 'completed');
  assert.deepEqual(
    { status: rotated.result.value.status, keyGeneration: rotated.result.value.keyGeneration, registryGeneration: rotated.result.value.registryGeneration },
    { status: 'rotated', keyGeneration: 2, registryGeneration: 2 }
  );
  assert.equal(await current.stdioAuthenticator.validateSession(admission.sessionId, '2025-11-25'), null);
  const stale = await current.gateway.execute(managementCommand('agent.clients.rotate_key', {
    ...firstBinding, publicKey: firstPublicKey, publicKeyFingerprint: agent.publicKeyFingerprintForSpki(firstPublicKey), expectedRegistryGeneration: 1
  }), current.principal);
  assert.equal(stale.error.code, 'IDEMPOTENCY_CONFLICT');
});

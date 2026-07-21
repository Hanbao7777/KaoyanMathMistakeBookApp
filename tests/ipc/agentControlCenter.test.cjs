const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const environment = require('../main/helpers/controlPlaneTestEnv.cjs');

const adapterModule = environment.requireMain('ipc/adapters/agentControlCenterIpc.js');
const bootstrap = environment.requireMain('agent/bootstrap.js');
const authentication = environment.requireMain('agent/clientAuthenticator.js');
const coordinatorModule = environment.requireMain('persistence/databaseCoordinator.js');
const { AuditLedger } = environment.requireMain('agent/auditLedger.js');
const { WorkflowStore } = environment.requireMain('agent/workflows.js');
const agent = require(`${environment.projectRoot}/dist/main/shared/agent/index.js`);

function assertNoPrivateFields(value) {
  if (value === null || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    assert.equal(['credentialBinding', 'credentialFingerprint', 'sessionFingerprint', 'nonce', 'recoveryAssetId', 'recoveryPath', 'absolutePath'].includes(key), false, key);
    assertNoPrivateFields(nested);
  }
}

async function runtime() {
  const coordinator = await environment.databaseService.getDatabaseCoordinator();
  const questions = await environment.databaseService.getQuestionsApplication();
  const tickTick = await environment.databaseService.getTickTickApplication();
  const verifier = {
    verify(raw) {
      return {
        credentialFingerprint: authentication.fingerprintCredential(raw.credential),
        sessionFingerprint: authentication.fingerprintCredential(raw.session)
      };
    }
  };
  const appInstanceId = `b8-ipc-${crypto.randomUUID()}`;
  const plane = await bootstrap.bootstrapAgentGateway({
    coordinator,
    commandBus: questions.gateway.commandBus,
    queryBus: questions.gateway.queryBus,
    selectedCandidateEvidence: true,
    appInstanceId,
    credentialVerifier: verifier,
    cursorSecret: crypto.randomBytes(32),
    jobResultRoot: environment.resultRoot,
    randomUUID: crypto.randomUUID,
    resolveState: (envelope, descriptor) => descriptor.domain === 'questions'
      ? questions.gateway.resolveState(envelope, descriptor)
      : tickTick.resolveState(envelope, descriptor),
    executeBusinessCommand: (command, context, dispatch) => questions.gateway.execute(command, context, dispatch),
    tickTickApplication: tickTick
  });
  const registry = await bootstrap.bootstrapAgentB3({
    coordinator,
    appInstanceId,
    credentialVerifier: verifier,
    cursorSecret: crypto.randomBytes(32),
    randomUUID: crypto.randomUUID
  });
  const credentials = new Map();
  async function register(clientId, scopes, trust = 'full_control') {
    const credential = crypto.randomUUID();
    const session = crypto.randomUUID();
    const credentialFingerprint = authentication.fingerprintCredential(credential);
    await registry.registry.registerClient({
      clientId,
      subjectId: clientId,
      displayName: clientId,
      credentialFingerprint,
      scopes,
      trust
    });
    await registry.registry.createSession(
      clientId,
      credentialFingerprint,
      authentication.fingerprintCredential(session),
      new Date(Date.now() + 60_000).toISOString()
    );
    credentials.set(clientId, { credential, session });
  }
  return {
    coordinator,
    plane,
    registry: registry.registry,
    api: adapterModule.createAgentControlCenterIpc(async () => plane),
    register,
    authenticate: (clientId) => plane.authenticator.authenticate(credentials.get(clientId))
  };
}

function externalQuery(plane, principal) {
  return plane.gateway.query({
    apiVersion: 1,
    kind: 'agent-query',
    operation: 'questions.review_buckets',
    payload: {},
    requestId: crypto.randomUUID(),
    catalog: agent.operationCatalogIdentity
  }, principal);
}

function workflowsFor(current) {
  const capability = coordinatorModule.createDatabaseCoordinatorControlCapability(current.coordinator);
  const executeControlWrite = (request) => current.coordinator.executeControlWrite(capability, request);
  const audit = new AuditLedger({ executeControlWrite, catalog: agent.operationCatalogIdentity, randomUUID: crypto.randomUUID });
  return new WorkflowStore({ executeControlWrite, audit, randomUUID: crypto.randomUUID });
}

async function createApproval(current, clientId) {
  const workflows = workflowsFor(current);
  const createdAt = new Date().toISOString();
  const payload = { questionId: 1, mastery: '一般' };
  const affectedEntities = [{ entityType: 'question', entityId: '1' }];
  const approval = await workflows.createApproval({
    apiVersion: 1,
    approvalId: crypto.randomUUID(),
    nonce: crypto.randomUUID(),
    clientId,
    credentialBinding: authentication.fingerprintCredential(`approval-${clientId}-${crypto.randomUUID()}`),
    operation: 'questions.mark_mastery',
    payloadHash: agent.hashCanonicalJson(payload),
    affectedSetHash: agent.hashCanonicalJson(affectedEntities),
    baseVersion: current.coordinator.currentVersion(),
    catalog: agent.operationCatalogIdentity,
    policyVersion: 'agent.policy.v1',
    risk: 'R2',
    requiredScopes: ['questions.write'],
    recovery: 'inverse',
    status: 'pending',
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 60_000).toISOString()
  });
  return { workflows, approval };
}

async function createChangeSet(current, clientId) {
  const workflows = workflowsFor(current);
  const createdAt = new Date().toISOString();
  const payload = { questionId: 1, mastery: '一般' };
  const affectedEntities = [{ entityType: 'question', entityId: '1' }];
  const changeSet = await workflows.createChangeSet({
    apiVersion: 1,
    changeSetId: crypto.randomUUID(),
    clientId,
    status: 'approved',
    catalog: agent.operationCatalogIdentity,
    baseVersion: current.coordinator.currentVersion(),
    risk: 'R2',
    summary: 'B8 runtime change set',
    operations: [{ operation: 'questions.mark_mastery', payload, payloadHash: agent.hashCanonicalJson(payload), affectedEntities }],
    affectedSetHash: agent.hashCanonicalJson(affectedEntities),
    recovery: 'inverse',
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 60_000).toISOString()
  });
  return { workflows, changeSet };
}

test.beforeEach(() => {
  adapterModule.configureExternalControlLifecycle(undefined);
  adapterModule.configureDirectHttpsStatus(undefined);
  return environment.resetControlPlaneEnvironment();
});
test.after(() => environment.cleanupControlPlaneRoot());

test('built adapter drives the Gateway with fixed DTOs and immediate client/session enforcement', async () => {
  const current = await runtime();
  assert.equal((await current.api.getStatus()).settings.externalControlEnabled, false);
  assert.equal((await current.api.setExternalControlEnabled(true)).enabled, true);

  await current.register('b8-client', ['questions.read', 'reviews.read']);
  const clients = await current.api.listClients({ pageSize: 100 });
  assert.ok(clients.items.some((client) => client.clientId === 'b8-client'));
  const principal = await current.authenticate('b8-client');
  assert.equal((await externalQuery(current.plane, principal)).kind, 'completed');

  await current.api.updateClientAccess('b8-client', ['audit.read'], 'observer');
  assert.equal((await externalQuery(current.plane, principal)).error.code, 'CLIENT_REVOKED');

  await current.register('b8-session-client', ['questions.read']);
  const sessionPrincipal = await current.authenticate('b8-session-client');
  const sessions = await current.api.listSessions({ clientId: 'b8-session-client', pageSize: 10 });
  assert.equal(sessions.items.length, 1);
  await current.api.terminateSession(sessions.items[0].sessionId);
  assert.equal((await externalQuery(current.plane, sessionPrincipal)).error.code, 'CLIENT_REVOKED');

  await current.api.revokeClient('b8-client');
  assert.equal((await externalQuery(current.plane, principal)).error.code, 'CLIENT_REVOKED');
});

test('external-control mutations drive the composed MCP host lifecycle after durability', async () => {
  const current = await runtime();
  const transitions = [];
  adapterModule.configureExternalControlLifecycle(async (enabled) => { transitions.push(enabled); });
  assert.equal((await current.api.setExternalControlEnabled(true)).enabled, true);
  assert.equal((await current.api.setExternalControlEnabled(false)).enabled, false);
  assert.deepEqual(transitions, [true, false]);
  assert.equal((await current.api.getStatus()).settings.externalControlEnabled, false);
});

test('built adapter creates server-owned R4 grants and maps only safe audit DTOs', async () => {
  const current = await runtime();
  await current.api.setExternalControlEnabled(true);
  await current.register('b8-r4-client', ['operations.batch', 'questions.archive']);
  const request = {
    clientId: 'b8-r4-client',
    operation: 'questions.replace_all',
    payloadHash: agent.hashCanonicalJson({ questions: [] }),
    targetHash: agent.hashCanonicalJson({ operation: 'questions.replace_all', affectedEntities: [{ entityType: 'operation', entityId: 'bounded-target' }] }),
    maxAffectedEntities: 500,
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  const grant = await current.api.createR4Grant(request);
  assert.equal(grant.clientId, request.clientId);
  assert.equal(grant.operation, request.operation);
  assert.equal('catalog' in grant, false);
  assert.equal('maxUses' in grant, false);
  assert.equal('grantId' in grant, true);
  const grantCount = (await current.api.listR4Grants({ clientId: request.clientId, pageSize: 100 })).items.length;
  await assert.rejects(current.api.createR4Grant({ ...request, operation: 'questions.mark_mastery' }));
  assert.equal((await current.api.listR4Grants({ clientId: request.clientId, pageSize: 100 })).items.length, grantCount);
  await assert.rejects(current.api.createR4Grant({ ...request, expiresAt: '2020-01-01T00:00:00.000Z' }));
  assert.equal((await current.api.listR4Grants({ clientId: request.clientId, pageSize: 100 })).items.length, grantCount);
  await current.register('b8-r4-missing-scope', ['questions.archive']);
  await assert.rejects(current.api.createR4Grant({ ...request, clientId: 'b8-r4-missing-scope' }), (error) => error?.code === 'SCOPE_DENIED');
  assert.equal((await current.api.listR4Grants({ clientId: 'b8-r4-missing-scope', pageSize: 100 })).items.length, 0);
  const grants = await current.api.listR4Grants({ clientId: request.clientId, pageSize: 100 });
  assert.equal(grants.items.length, 1);
  await current.api.revokeR4Grant(grant.grantId);
  assert.equal((await current.api.listR4Grants({ clientId: request.clientId, pageSize: 100 })).items[0].status, 'revoked');

  const audit = await current.api.searchAudit({ pageSize: 100 });
  assert.ok(audit.items.length > 0);
  assertNoPrivateFields(audit);
  assertNoPrivateFields(await current.api.exportAudit({ pageSize: 100 }));
  assertNoPrivateFields(await current.api.verifyAudit());
});

test('built adapter lists and decides approvals with safe durable DTOs', async () => {
  const current = await runtime();
  await current.register('b8-approval-client', ['questions.write']);
  const first = await createApproval(current, 'b8-approval-client');
  const listed = await current.api.listApprovals({ pageSize: 100 });
  const summary = listed.items.find((item) => item.approvalId === first.approval.approvalId);
  assert.equal(summary.status, 'pending');
  assertNoPrivateFields(listed);
  await current.api.approve(first.approval.approvalId);
  assert.equal((await first.workflows.getApproval(first.approval.approvalId)).status, 'approved');

  const second = await createApproval(current, 'b8-approval-client');
  await current.api.rejectApproval(second.approval.approvalId, 'user_rejected');
  assert.equal((await second.workflows.getApproval(second.approval.approvalId)).status, 'rejected');
  assertNoPrivateFields(await current.api.listApprovals({ pageSize: 100 }));
});

test('built adapter lists, gets, and rejects approved external change sets with safe DTOs', async () => {
  const current = await runtime();
  await current.register('b8-change-owner', ['questions.write']);
  const rejected = await createChangeSet(current, 'b8-change-owner');
  const listed = await current.api.listChangeSets({ pageSize: 100 });
  assert.ok(listed.items.some((item) => item.changeSetId === rejected.changeSet.changeSetId));
  assertNoPrivateFields(listed);
  assert.equal((await current.api.getChangeSet(rejected.changeSet.changeSetId)).status, 'approved');
  await current.api.rejectChangeSet(rejected.changeSet.changeSetId, 'user_rejected');
  assert.equal((await rejected.workflows.getChangeSet(rejected.changeSet.changeSetId)).status, 'rejected');

  assertNoPrivateFields(await current.api.getChangeSet(rejected.changeSet.changeSetId));
});

test('adapter rejects oversized pages before Gateway dispatch', async () => {
  const current = await runtime();
  let calls = 0;
  const api = adapterModule.createAgentControlCenterIpc(async () => ({
    ...current.plane,
    gateway: {
      execute: (...args) => current.plane.gateway.execute(...args),
      query: (...args) => { calls += 1; return current.plane.gateway.query(...args); }
    }
  }));
  await assert.rejects(api.listClients({ pageSize: 101 }), (error) => error?.code === 'VALIDATION_ERROR');
  assert.equal(calls, 0);
});

test('pairing IPC adapter composes one stable service and validates exact requests and results', async () => {
  const current = await runtime(); let loads = 0; const calls = [];
  const status = (request, state = 'healthy') => ({
    apiVersion: 'kaoyan-pairing-v1@1', product: request.product, clientId: request.clientId, state,
    message: 'ok', requestedScopes: ['system.read'], requestedTrust: 'observer',
    grantedScopes: ['system.read'], grantedTrust: 'observer', generation: state === 'disconnected' ? 0 : 1
  });
  const service = {
    async connect(request) { calls.push(['connect', request]); return status(request); },
    async health(request) { calls.push(['health', request]); return status(request); },
    async repair(request) { calls.push(['repair', request]); return status(request); },
    async rotate(request) { calls.push(['rotate', request]); return status(request); },
    async disconnect(request) { calls.push(['disconnect', request]); return status(request, 'disconnected'); }
  };
  const api = adapterModule.createAgentControlCenterIpc(async () => current.plane, async () => { loads += 1; return service; });
  const connect = { product: 'codex', clientId: 'codex-ipc-client', requestedScopes: ['system.read'], trust: 'observer', disclosureAccepted: true, authorityConfirmed: false };
  await api.connectClient(connect); await api.getClientConnection({ product: 'codex', clientId: connect.clientId }); await api.repairClientConnection({ product: 'codex', clientId: connect.clientId });
  assert.equal(loads, 1); assert.deepEqual(calls.map(([name]) => name), ['connect', 'health', 'repair']);
  await assert.rejects(api.connectClient({ ...connect, extra: true }), /fields/); assert.equal(calls.length, 3);
  await assert.rejects(api.rotateClientKey({ product: 'codex', clientId: '../unsafe' }), /clientId/); assert.equal(calls.length, 3);
  service.health = async (request) => ({ ...status(request), secret: 'not-allowed' });
  await assert.rejects(api.getClientConnection({ product: 'codex', clientId: connect.clientId }), /fields/);
});

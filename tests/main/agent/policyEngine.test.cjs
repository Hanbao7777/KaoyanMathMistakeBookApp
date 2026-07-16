const assert = require('node:assert/strict');
const test = require('node:test');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const bootstrap = environment.requireMain('agent/bootstrap.js');
const authentication = environment.requireMain('agent/clientAuthenticator.js');
const { AgentGateway } = environment.requireMain('agent/agentGateway.js');
const agent = require(`${environment.projectRoot}/dist/main/shared/agent/index.js`);
const timestamp = '2026-07-16T10:00:00.000Z';
const credential = 'policy credential';
const session = 'policy session';

async function setup(
  scopes = ['questions.read', 'questions.write', 'questions.archive', 'operations.batch'],
  trust = 'full_control',
  now = () => timestamp
) {
  const credentialFingerprint = authentication.fingerprintCredential(credential);
  const sessionFingerprint = authentication.fingerprintCredential(session);
  const composition = await bootstrap.bootstrapAgentB3({
    coordinator: await environment.databaseService.getDatabaseCoordinator(), appInstanceId: 'policy-instance',
    credentialVerifier: { verify: (raw) => ({ credentialFingerprint: authentication.fingerprintCredential(raw.credential), sessionFingerprint: authentication.fingerprintCredential(raw.session) }) },
    cursorSecret: 'p'.repeat(32), now,
    randomUUID: () => '00000000-0000-4000-8000-000000000001'
  });
  await composition.registry.registerClient({
    clientId: 'policy-client', subjectId: 'policy-subject', displayName: 'Policy Client', credentialFingerprint, scopes, trust
  });
  await composition.registry.createSession('policy-client', credentialFingerprint, sessionFingerprint, '2026-07-16T10:15:00.000Z');
  return composition;
}

async function external(composition) {
  await composition.registry.setExternalControlEnabled(true);
  return composition.authenticator.authenticate({ credential, session });
}

function evaluate(composition, principal, operation, overrides = {}) {
  return composition.policy.evaluate({
    principal,
    descriptor: agent.resolveOperationDescriptor(operation),
    input: {},
    state: { affectedEntityCount: 1 },
    settings: overrides.settings,
    ...overrides
  });
}

test.beforeEach(() => environment.resetControlPlaneEnvironment());
test.after(() => environment.cleanupControlPlaneRoot());

test('renderer admits only migrated B6-B7 operations while preserving the recovery allowlist and catalog fence', async () => {
  const composition = await setup();
  const settings = await composition.registry.getSettings();
  const forged = { ...composition.renderer.principal(), renderer: false };
  assert.throws(() => evaluate(composition, forged, 'questions.list', { settings }), (error) => error.code === 'POLICY_DENIED');
  const renderer = composition.renderer.principal();
  assert.equal(evaluate(composition, renderer, 'agent.status.get', { settings }).disposition, 'execute');
  assert.equal(evaluate(composition, renderer, 'questions.list', { settings }).disposition, 'execute');
  assert.equal(evaluate(composition, renderer, 'questions.submit_review', { settings }).disposition, 'execute');
  assert.equal(evaluate(composition, renderer, 'tasks.create', { settings }).disposition, 'execute');
  for (const operation of authentication.migratedRendererBusinessOperations) {
    assert.notEqual(evaluate(composition, renderer, operation, { settings }).disposition, 'deny', operation);
  }
  for (const operation of [
    'questions.undo_review', 'questions.link_knowledge', 'questions.migrate_categories', 'questions.rematch_knowledge',
    'questions.bulk_upsert', 'questions.import', 'questions.replace_all', 'questions.clear_all'
  ]) {
    assert.equal(evaluate(composition, renderer, operation, { settings }).disposition, 'deny', operation);
  }
  const mismatched = { ...settings, catalog: { ...settings.catalog, hash: agent.hashCanonicalJson({ catalog: 'old' }) } };
  assert.equal(evaluate(composition, renderer, 'agent.status.get', { settings: mismatched }).disposition, 'execute');
  assert.throws(() => evaluate(composition, renderer, 'questions.list', { settings: mismatched }), (error) => error.code === 'CATALOG_VERSION_MISMATCH');
  assert.throws(() => evaluate(composition, renderer, 'tasks.list', { settings: mismatched }), (error) => error.code === 'CATALOG_VERSION_MISMATCH');
});

test('external principals are denied outside the B6-B7 business boundary despite scopes, policy, or R4 grants', async () => {
  const composition = await setup([
    'questions.write', 'questions.archive', 'reviews.submit', 'knowledge.write', 'operations.batch'
  ]);
  const principal = await external(composition);
  const settings = await composition.registry.getSettings();
  const r4Grant = {
    apiVersion: 1,
    grantId: '00000000-0000-4000-8000-000000000011',
    clientId: 'policy-client', operation: 'questions.clear_all', payloadHash: agent.hashCanonicalJson({}),
    targetHash: agent.hashCanonicalJson({ target: 'all' }), catalog: agent.operationCatalogIdentity,
    recovery: 'consistency_bundle', maxAffectedEntities: 500, maxUses: 1, status: 'active',
    issuedAt: timestamp, expiresAt: '2026-07-16T10:15:00.000Z'
  };
  for (const operation of [
    'questions.undo_review', 'questions.link_knowledge', 'questions.migrate_categories', 'questions.rematch_knowledge',
    'questions.bulk_upsert', 'questions.import', 'questions.replace_all', 'questions.clear_all'
  ]) {
    const decision = evaluate(composition, principal, operation, {
      settings,
      state: { affectedEntityCount: 1, targetHash: r4Grant.targetHash },
      ...(operation === 'questions.clear_all' ? { r4Grant } : {})
    });
    assert.equal(decision.disposition, 'deny', operation);
    assert.equal(decision.reasonCode, 'EXTERNAL_PHASE_B_BOUNDARY', operation);
  }
});

test('external boundary denial reaches no workflow, admission, receipt, or business dispatch', async () => {
  const composition = await setup(['questions.write', 'reviews.submit', 'knowledge.write', 'operations.batch']);
  const principal = await external(composition);
  const settings = await composition.registry.getSettings();
  const trace = [];
  const gateway = new AgentGateway({
    async authorize() { return { settings }; },
    async resolveState() { trace.push('resolve-state'); return { affectedEntityCount: 1, affectedEntities: [] }; },
    async resolveCommand(envelope, descriptor) {
      trace.push('resolve-command');
      return {
        descriptor, payload: envelope.payload, state: { affectedEntityCount: 1, affectedEntities: [] },
        dispatch: 'business', operation: envelope.operation
      };
    },
    evaluatePolicy(input) { trace.push('policy'); return composition.policy.evaluate(input); },
    validateCommand() {},
    validateQuery() {},
    async admit() { trace.push('admit'); throw new Error('must not admit'); },
    async dispatchCommand() { trace.push('dispatch'); throw new Error('must not dispatch'); },
    async dispatchManagement() { trace.push('management-dispatch'); throw new Error('must not dispatch'); },
    async dispatchQuery() { trace.push('query-dispatch'); throw new Error('must not dispatch'); },
    async terminalizeKnownFailure() { trace.push('terminalize'); },
    workflows: {
      async getR4Grant() { trace.push('grant'); return undefined; },
      async authorizeApproval() { trace.push('approval-authorize'); throw new Error('must not authorize'); },
      async authorizeChangeSet() { trace.push('changeset-authorize'); throw new Error('must not authorize'); },
      async createApproval() { trace.push('approval-create'); throw new Error('must not create'); },
      async createChangeSet() { trace.push('changeset-create'); throw new Error('must not create'); },
      async queryManagement() { trace.push('management-query'); throw new Error('must not query'); }
    },
    audit: {
      async denial() { trace.push('denial-audit'); },
      async query() { trace.push('query-audit'); }
    }
  });
  const outcome = await gateway.execute({
    apiVersion: 1, kind: 'agent-command', operation: 'questions.migrate_categories', payload: { limit: 1 },
    requestId: '00000000-0000-4000-8000-000000000020',
    expectedVersion: { dataEpoch: 'policy-boundary', dataRevision: 0 }, catalog: agent.operationCatalogIdentity
  }, principal);
  assert.equal(outcome.error.code, 'POLICY_DENIED');
  assert.deepEqual(trace, ['resolve-command', 'grant', 'policy', 'denial-audit']);
});

test('renderer physical image risk remains authoritative without changing external R4 grants', async () => {
  const composition = await setup();
  const settings = await composition.registry.getSettings();
  const renderer = composition.renderer.principal();
  const local = evaluate(composition, renderer, 'questions.remove_image', {
    settings, input: { deleteFile: true }, state: { affectedEntityCount: 1, managedFileCount: 1 }
  });
  assert.equal(local.risk, 'R4');
  assert.equal(local.reasonCode, 'LOCAL_RENDERER_USER_ACTION');

  const principal = await external(composition);
  const externalSettings = await composition.registry.getSettings();
  assert.throws(() => evaluate(composition, principal, 'questions.remove_image', {
    settings: externalSettings, input: { deleteFile: true }, state: { affectedEntityCount: 1, managedFileCount: 1 }
  }), (error) => error.code === 'R4_GRANT_REQUIRED');
});

test('enforces live scopes, descriptor resource bounds, page bounds, and resolved risk', async () => {
  const composition = await setup(['questions.archive'], 'full_control');
  const principal = await external(composition);
  const settings = await composition.registry.getSettings();
  assert.throws(() => evaluate(composition, principal, 'questions.list', { settings }), (error) => error.code === 'SCOPE_DENIED');
  assert.throws(() => evaluate(composition, principal, 'questions.delete', {
    settings, input: { physicalDelete: true }, state: { affectedEntityCount: 1 }
  }), (error) => error.code === 'R4_GRANT_REQUIRED');
  assert.equal(evaluate(composition, principal, 'questions.delete', {
    settings, input: {}, state: { affectedEntityCount: 2 }
  }).reasonCode, 'AFFECTED_RESOURCE_LIMIT');
  assert.equal(evaluate(composition, principal, 'questions.delete', {
    settings, pageSize: 2, state: { affectedEntityCount: 1 }
  }).reasonCode, 'PAGE_SIZE_LIMIT');
});

test('persisted policy can tighten but cannot weaken descriptor invariants', async () => {
  const composition = await setup();
  const descriptor = agent.resolveOperationDescriptor('questions.create');
  await composition.registry.updatePolicy('strict-policy', [{
    apiVersion: 1, operation: descriptor.name, catalog: agent.operationCatalogIdentity,
    minimumRisk: 'R3', maxAffectedEntities: 1, requireApproval: true
  }]);
  const principal = await external(composition);
  const settings = await composition.registry.getSettings();
  const decision = evaluate(composition, principal, 'questions.create', { settings });
  assert.equal(decision.risk, 'R3');
  assert.equal(decision.disposition, 'requires_approval');
  const r4 = agent.resolveOperationDescriptor('questions.clear_all');
  await assert.rejects(composition.registry.updatePolicy('weak-policy', [{
    apiVersion: 1, operation: r4.name, catalog: agent.operationCatalogIdentity, requireChangeSet: false
  }]), (error) => error.code === 'POLICY_INVARIANT_VIOLATION');
});

test('rejects copied descriptors that weaken any catalog policy surface', async () => {
  const composition = await setup();
  const principal = await external(composition);
  const settings = await composition.registry.getSettings();
  const query = agent.resolveOperationDescriptor('questions.list');
  const command = agent.resolveOperationDescriptor('questions.delete');
  const forgeries = [
    { ...query, requiredScopes: [] },
    { ...command, policyBounds: { ...command.policyBounds, maxAffectedEntities: command.policyBounds.maxAffectedEntities + 1 } },
    { ...command, policyBounds: { ...command.policyBounds, minimumRisk: 'R1' } },
    { ...query, rendererManagement: true, allowedWhenExternalControlDisabled: true }
  ];
  for (const descriptor of forgeries) {
    assert.throws(
      () => composition.policy.evaluate({ principal, descriptor, input: {}, state: { affectedEntityCount: 1 }, settings }),
      (error) => error.code === 'POLICY_INVARIANT_VIOLATION'
    );
  }
});

test('samples and validates the policy clock exactly once per evaluation', async () => {
  let clockValue = timestamp;
  let calls = 0;
  const composition = await setup(undefined, undefined, () => { calls += 1; return clockValue; });
  const principal = await external(composition);
  const settings = await composition.registry.getSettings();
  calls = 0;
  assert.equal(evaluate(composition, principal, 'questions.list', { settings }).disposition, 'execute');
  assert.equal(calls, 1);
  clockValue = '2026-07-16T10:00:00Z';
  assert.throws(() => evaluate(composition, principal, 'questions.list', { settings }), (error) => error.code === 'POLICY_INVARIANT_VIOLATION');
  assert.equal(calls, 2);
});

test('R4 rejects wildcard, permanent, payload-mismatched, and descriptor-mismatched authority; external Phase B boundary precedes grant evaluation', async () => {
  const composition = await setup();
  const principal = await external(composition);
  const settings = await composition.registry.getSettings();
  const input = { confirmation: 'clear' };
  const payloadHash = agent.hashCanonicalJson(input);
  const targetHash = agent.hashCanonicalJson({ target: 'all-questions' });
  const grant = {
    apiVersion: 1,
    grantId: '00000000-0000-4000-8000-000000000010',
    clientId: 'policy-client', operation: 'questions.clear_all', payloadHash, targetHash,
    catalog: agent.operationCatalogIdentity, recovery: 'consistency_bundle', maxAffectedEntities: 500,
    maxUses: 1, status: 'active', issuedAt: timestamp, expiresAt: '2026-07-16T10:15:00.000Z'
  };
  assert.equal(evaluate(composition, principal, 'questions.clear_all', {
    settings, input, state: { affectedEntityCount: 10, targetHash }, r4Grant: grant
  }).reasonCode, 'EXTERNAL_PHASE_B_BOUNDARY');
  assert.equal(evaluate(composition, principal, 'questions.clear_all', {
    settings, input: { confirmation: 'different' }, state: { affectedEntityCount: 10, targetHash }, r4Grant: grant
  }).reasonCode, 'EXTERNAL_PHASE_B_BOUNDARY');
  assert.throws(() => agent.validateR4Grant({ ...grant, targetHash: '*' }), /request is invalid/i);
  assert.throws(() => agent.validateR4Grant({ ...grant, expiresAt: '2026-07-16T10:15:00.001Z' }), /request is invalid/i);
  assert.equal(evaluate(composition, principal, 'questions.clear_all', {
    settings, input, state: { affectedEntityCount: 10, targetHash },
    r4Grant: { ...grant, issuedAt: '2026-07-16T09:44:59.999Z', expiresAt: '2026-07-16T09:59:59.999Z' }
  }).reasonCode, 'EXTERNAL_PHASE_B_BOUNDARY');
  assert.equal(evaluate(composition, principal, 'questions.replace_all', {
    settings, input, state: { affectedEntityCount: 10, targetHash }, r4Grant: grant
  }).reasonCode, 'EXTERNAL_PHASE_B_BOUNDARY');
});

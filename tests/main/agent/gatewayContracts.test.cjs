const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '../../..');
const agent = require(path.join(projectRoot, 'dist/main/shared/agent/index.js'));
const mcp = require(path.join(projectRoot, 'dist/main/shared/mcp/v1/index.js'));

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const timestamp = '2026-07-16T10:00:00.000Z';
const hash = 'sha256-v1:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function command(overrides = {}) {
  return {
    apiVersion: 1,
    kind: 'agent-command',
    operation: 'agent.control.set_enabled',
    payload: { enabled: true },
    requestId,
    catalog: agent.operationCatalogIdentity,
    ...overrides
  };
}

function grant(overrides = {}) {
  return {
    apiVersion: 1,
    grantId: '123e4567-e89b-42d3-a456-426614174010',
    clientId: 'trusted-client',
    operation: 'questions.clear_all',
    payloadHash: hash,
    targetHash: hash,
    catalog: agent.operationCatalogIdentity,
    recovery: 'consistency_bundle',
    maxAffectedEntities: 500,
    maxUses: 1,
    status: 'active',
    issuedAt: timestamp,
    expiresAt: '2026-07-16T10:15:00.000Z',
    ...overrides
  };
}

test('exports an immutable, exhaustive, versioned catalog', () => {
  assert.doesNotThrow(() => agent.validateOperationCatalog(agent.operationCatalog));
  assert.equal(agent.operationCatalog.version, 'agent-catalog-v1@2');
  assert.deepEqual(
    agent.operationCatalog.operations.map((descriptor) => descriptor.name),
    [...agent.operationNames].sort()
  );
  assert.deepEqual(agent.disabledRendererManagementOperations, [
    'agent.approvals.approve', 'agent.approvals.list', 'agent.approvals.reject', 'agent.audit.export',
    'agent.audit.search', 'agent.audit.verify', 'agent.catalog.get', 'agent.changesets.apply',
    'agent.changesets.get', 'agent.changesets.list', 'agent.changesets.reject', 'agent.clients.list',
    'agent.clients.register_key', 'agent.clients.revoke', 'agent.clients.rotate_key', 'agent.clients.update_access', 'agent.control.set_enabled', 'agent.policy.get',
    'agent.privacy.get', 'agent.r4_grants.create', 'agent.r4_grants.list', 'agent.r4_grants.revoke',
    'agent.sessions.list', 'agent.sessions.terminate', 'agent.status.get'
  ]);
  assert.equal(Object.isFrozen(agent.operationCatalog), true);
  assert.equal(Object.isFrozen(agent.operationCatalog.operations), true);
  assert.equal(Object.isFrozen(mcp.mcpExternalBusinessOperations), true);
  assert.deepEqual(mcp.mcpExternalBusinessOperations, [
    'questions.create', 'questions.update', 'questions.delete', 'questions.remove_image', 'questions.mark_mastery',
    'questions.submit_review', 'questions.list', 'questions.get', 'questions.review_logs', 'questions.review_buckets',
    'tasks.create', 'tasks.update', 'tasks.complete', 'tasks.uncomplete', 'tasks.delete', 'tasks.list', 'tasks.get',
    'focus.sessions.create', 'focus.sessions.list'
  ]);
  assert.equal(mcp.isMcpExternalBusinessOperation('questions.migrate_categories'), false);
  assert.equal(mcp.isMcpExternalBusinessOperation('tasks.create'), true);
  assert.equal(agent.resolveOperationDescriptor('questions.clear_all').policyBounds.approval, 'r4_grant');
});

test('defines the Gateway as exactly the two admitted operations', () => {
  assert.deepEqual(agent.agentGatewayMethodNames, ['execute', 'query']);
  assert.equal(Object.isFrozen(agent.agentGatewayMethodNames), true);
  assert.equal(Object.hasOwn(agent, 'AgentGateway'), false);
  assert.equal(Object.hasOwn(agent, 'ClientAuthenticator'), false);
});

test('canonicalization and catalog identity are deterministic and tamper-evident', () => {
  const first = { z: [3, { b: false, a: 'x' }], a: 1 };
  const second = { a: 1, z: [3, { a: 'x', b: false }] };
  assert.equal(agent.canonicalizeJson(first), agent.canonicalizeJson(second));
  assert.equal(agent.hashCanonicalJson(first), agent.hashCanonicalJson(second));
  assert.equal(agent.sha256Utf8('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.doesNotThrow(() => agent.assertCatalogIdentity(agent.operationCatalogIdentity, agent.operationCatalogIdentity));
  assert.throws(
    () => agent.assertCatalogIdentity({ ...agent.operationCatalogIdentity, hash }, agent.operationCatalogIdentity),
    (error) => error.code === 'CATALOG_VERSION_MISMATCH'
  );
  const tampered = { ...agent.operationCatalog, hash, operations: [...agent.operationCatalog.operations] };
  assert.throws(() => agent.validateOperationCatalog(tampered), (error) => error.code === 'CATALOG_VERSION_MISMATCH');
});

test('command and query boundaries reject unknown fields and caller authority material', () => {
  assert.doesNotThrow(() => agent.validateAgentCommandEnvelope(command()));
  assert.throws(() => agent.validateAgentCommandEnvelope(command({ unexpected: true })), /request is invalid/i);
  assert.throws(() => agent.validateAgentCommandEnvelope(command({ payload: { enabled: true, principal: {} } })), /request is invalid/i);
  assert.throws(() => agent.validateAgentCommandEnvelope(command({ payload: { enabled: true, accessToken: 'secret' } })), /request is invalid/i);
  assert.throws(() => agent.validateAgentCommandEnvelope(command({ requestId: 'not-a-uuid' })), /request is invalid/i);
  assert.doesNotThrow(() => agent.validateAgentCommandEnvelope(command({ catalog: { ...agent.operationCatalogIdentity, hash } })));
  assert.throws(
    () => agent.assertCatalogIdentity({ ...agent.operationCatalogIdentity, hash }, agent.operationCatalogIdentity),
    (error) => error.code === 'CATALOG_VERSION_MISMATCH'
  );
  const query = {
    apiVersion: 1, kind: 'agent-query', operation: 'agent.audit.search', payload: {}, requestId,
    page: { pageSize: 200, detail: 'summary', fields: ['clientId', 'occurredAt'] }, catalog: agent.operationCatalogIdentity
  };
  assert.doesNotThrow(() => agent.validateAgentQueryEnvelope(query));
  assert.throws(() => agent.validateAgentQueryEnvelope({ ...query, page: { ...query.page, pageSize: 201 } }), /request is invalid/i);
  assert.throws(() => agent.validateAgentQueryEnvelope({ ...query, page: { ...query.page, cursor: 'forged' } }), (error) => error.code === 'CURSOR_INVALID');
  let deepPayload = {};
  for (let index = 0; index <= agent.gatewayMaxJsonDepth; index += 1) deepPayload = { nested: deepPayload };
  assert.throws(() => agent.canonicalizeJson(deepPayload), /request is invalid/i);
  assert.throws(() => agent.canonicalizeJson({ body: 'x'.repeat(agent.gatewayMaxJsonStringLength + 1) }), /request is invalid/i);
  assert.throws(() => agent.canonicalizeJson({ ['x'.repeat(agent.gatewayMaxJsonKeyLength + 1)]: true }), /request is invalid/i);
  assert.throws(() => agent.canonicalizeJson(new Array(agent.gatewayMaxJsonNodes + 1).fill(0)), /request is invalid/i);
  assert.throws(() => agent.canonicalizeJson(new Array(agent.gatewayMaxJsonEntries + 1).fill(0)), /request is invalid/i);
});

test('principal, grants, receipts, and policy overrides keep authority bounded', () => {
  const principal = {
    apiVersion: 1, kind: 'agent-principal', clientId: 'trusted-client', subjectId: 'subject-1', displayName: 'Trusted client',
    scopes: ['questions.read'], trust: 'full_control', credentialBinding: 'binding-1', sessionId: requestId, authenticatedAt: timestamp, renderer: false
  };
  assert.doesNotThrow(() => agent.validateAgentPrincipalClaims(principal));
  assert.equal(Object.getOwnPropertySymbols(principal).length, 0);
  assert.equal(Object.hasOwn(agent, 'validateAgentPrincipal'), false);
  assert.throws(() => agent.validateAgentPrincipalClaims({ ...principal, token: 'secret' }), /request is invalid/i);
  assert.throws(() => agent.validateAgentCommandEnvelope(command({ payload: { enabled: true, principal } })), /request is invalid/i);
  assert.doesNotThrow(() => agent.validateR4Grant(grant()));
  assert.throws(() => agent.validateR4Grant(grant({ maxUses: 2 })), /request is invalid/i);
  assert.throws(() => agent.validateR4Grant(grant({ targetHash: '*' })), /request is invalid/i);
  assert.throws(() => agent.validateR4Grant(grant({ expiresAt: timestamp })), /request is invalid/i);
  assert.throws(
    () => agent.validateR4Grant(grant({ expiresAt: '2026-07-16T10:15:00.001Z' })),
    /request is invalid/i
  );
  const r4Descriptor = agent.resolveOperationDescriptor('questions.clear_all');
  const binding = {
    catalog: agent.operationCatalogIdentity,
    operation: 'questions.clear_all',
    payloadHash: hash,
    targetHash: hash,
    resolvedRisk: 'R4',
    recovery: 'consistency_bundle',
    maxAffectedEntities: 500
  };
  assert.doesNotThrow(() => agent.assertR4GrantBinding(grant(), r4Descriptor, binding));
  const variableR4Descriptor = agent.resolveOperationDescriptor('questions.delete');
  const variableR4Grant = grant({ operation: 'questions.delete', recovery: 'quarantine', maxAffectedEntities: 1 });
  const variableR4Binding = { ...binding, operation: 'questions.delete', recovery: 'quarantine', maxAffectedEntities: 1 };
  assert.doesNotThrow(() => agent.assertR4GrantBinding(variableR4Grant, variableR4Descriptor, variableR4Binding));
  assert.throws(
    () => agent.assertR4GrantBinding(variableR4Grant, variableR4Descriptor, { ...variableR4Binding, resolvedRisk: 'R3' }),
    (error) => error.code === 'R4_GRANT_INVALID'
  );
  assert.throws(
    () => agent.assertR4GrantBinding(grant(), r4Descriptor, { ...binding, payloadHash: agent.hashCanonicalJson({ payload: 'other' }) }),
    (error) => error.code === 'R4_GRANT_INVALID'
  );
  const nonR4Descriptor = agent.resolveOperationDescriptor('questions.create');
  const nonR4Grant = grant({ operation: 'questions.create', recovery: 'inverse', maxAffectedEntities: 1 });
  const nonR4Binding = { ...binding, operation: 'questions.create', recovery: 'inverse', maxAffectedEntities: 1 };
  assert.throws(
    () => agent.assertR4GrantBinding(nonR4Grant, nonR4Descriptor, nonR4Binding),
    (error) => error.code === 'R4_GRANT_INVALID'
  );
  assert.throws(
    () => agent.assertR4GrantBinding(grant(), agent.resolveOperationDescriptor('questions.delete'), binding),
    (error) => error.code === 'R4_GRANT_INVALID'
  );
  assert.throws(
    () => agent.assertR4GrantBinding(grant(), r4Descriptor, { ...binding, catalog: { ...binding.catalog, hash } }),
    (error) => error.code === 'CATALOG_VERSION_MISMATCH'
  );
  assert.throws(
    () => agent.assertR4GrantBinding(grant(), r4Descriptor, { ...binding, operation: 'questions.replace_all' }),
    (error) => error.code === 'R4_GRANT_INVALID'
  );
  assert.throws(
    () => agent.assertR4GrantBinding(grant(), r4Descriptor, { ...binding, targetHash: agent.hashCanonicalJson({ target: 'other' }) }),
    (error) => error.code === 'R4_GRANT_INVALID'
  );
  assert.throws(
    () => agent.assertR4GrantBinding(grant({ recovery: 'inverse' }), r4Descriptor, { ...binding, recovery: 'inverse' }),
    (error) => error.code === 'R4_GRANT_INVALID'
  );
  const limitedDescriptor = { ...r4Descriptor, policyBounds: { ...r4Descriptor.policyBounds, maxAffectedEntities: 400 } };
  assert.throws(
    () => agent.assertR4GrantBinding(grant(), limitedDescriptor, binding),
    (error) => error.code === 'R4_GRANT_INVALID'
  );
  assert.equal(agent.isReceiptTransitionAllowed(null, 'admitted'), true);
  assert.equal(agent.isReceiptTransitionAllowed('admitted', 'completed'), true);
  assert.equal(agent.isReceiptTransitionAllowed('completed', 'failed'), false);
  assert.throws(() => agent.assertReceiptTransition('completed', 'failed'), (error) => error.code === 'INVALID_RECEIPT_TRANSITION');
  const descriptor = agent.resolveOperationDescriptor('questions.clear_all');
  const override = { apiVersion: 1, operation: descriptor.name, catalog: agent.operationCatalogIdentity, minimumRisk: 'R3' };
  assert.throws(
    () => agent.validateOperationPolicyOverride(override, descriptor, agent.operationCatalogIdentity),
    (error) => error.code === 'POLICY_INVARIANT_VIOLATION'
  );
});

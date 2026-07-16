const assert = require('node:assert/strict');
const test = require('node:test');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const { AgentGateway } = environment.requireMain('agent/agentGateway.js');
const agent = require(`${environment.projectRoot}/dist/main/shared/agent/index.js`);

const now = '2026-07-16T15:00:00.000Z';
let sequence = 0;
const uuid = () => `60000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
const principal = Object.freeze({
  apiVersion: 1, kind: 'agent-principal', clientId: 'workflow-client', subjectId: 'workflow-subject',
  displayName: 'Workflow Client', scopes: Object.freeze(['questions.write']), trust: 'collaborator',
  credentialBinding: 'sha256-v1:'.concat('2'.repeat(64)), authenticatedAt: now, renderer: false
});

function envelope(overrides = {}) {
  return {
    apiVersion: 1, kind: 'agent-command', operation: 'questions.mark_mastery',
    payload: { questionId: 1, mastery: '一般' }, requestId: uuid(),
    expectedVersion: { dataEpoch: 'workflow-epoch', dataRevision: 3 },
    catalog: agent.operationCatalogIdentity, ...overrides
  };
}

function dependencies(trace, workflowOverrides = {}) {
  const result = {
    async authorize() {
      trace.push('live-authority');
      return { settings: {
        externalControlEnabled: true, catalog: agent.operationCatalogIdentity, policyVersion: 'policy-workflow-v1',
        overrides: [], policyHash: agent.hashCanonicalJson([]), privacyRevision: 1
      } };
    },
    async resolveState() {
      trace.push('resolve-current-state');
      return {
        affectedEntityCount: 1,
        affectedEntities: [{ entityType: 'question', entityId: '1' }],
        affectedSetHash: agent.hashCanonicalJson([{ entityType: 'question', entityId: '1' }]),
        dataVersion: { dataEpoch: 'workflow-epoch', dataRevision: 3 }
      };
    },
    async resolveCommand(request) {
      const state = await result.resolveState();
      return {
        descriptor: agent.resolveOperationDescriptor(request.operation), payload: request.payload, state,
        dispatch: 'business', operation: request.operation, expectedVersion: request.expectedVersion
      };
    },
    evaluatePolicy(input) {
      trace.push('policy');
      return {
        apiVersion: 1, disposition: 'requires_approval', risk: 'R2', reasonCode: 'APPROVAL_REQUIRED',
        requiredScopes: input.descriptor.requiredScopes, catalog: agent.operationCatalogIdentity, policyVersion: 'policy-workflow-v1'
      };
    },
    validateCommand() { trace.push('validate'); },
    validateQuery() {},
    async admit() { trace.push('admit'); throw new Error('admission must follow valid workflow authority'); },
    async dispatchCommand() { throw new Error('not expected'); },
    async dispatchManagement() { throw new Error('not expected'); },
    async dispatchQuery() { throw new Error('not expected'); },
    async terminalizeKnownFailure() {},
    workflows: {
      async getR4Grant() { return undefined; },
      async authorizeApproval() { trace.push('approval-authorized'); return { approvalId: uuid(), binding: {} }; },
      async authorizeChangeSet() { trace.push('changeset-authorized'); return {}; },
      async createApproval() {
        trace.push('approval-created');
        return {
          apiVersion: 1, approvalId: uuid(), nonce: uuid(), clientId: principal.clientId,
          credentialBinding: principal.credentialBinding, operation: 'questions.mark_mastery',
          payloadHash: agent.hashCanonicalJson({ questionId: 1, mastery: '一般' }),
          affectedSetHash: agent.hashCanonicalJson([{ entityType: 'question', entityId: '1' }]),
          baseVersion: { dataEpoch: 'workflow-epoch', dataRevision: 3 }, catalog: agent.operationCatalogIdentity,
          policyVersion: 'policy-workflow-v1', risk: 'R2', requiredScopes: ['questions.write'], recovery: 'inverse',
          status: 'pending', createdAt: now, expiresAt: '2026-07-16T15:15:00.000Z'
        };
      },
      async createChangeSet() { throw new Error('not expected'); },
      async queryManagement() { throw new Error('not expected'); },
      ...workflowOverrides
    },
    audit: {
      async denial(input) { trace.push(`denial:${input.error.code}`); },
      async query() {}
    },
    now: () => now,
    randomUUID: uuid
  };
  return result;
}

test.beforeEach(() => { sequence = 0; });

test('creates a durable pending approval without business admission', async () => {
  const trace = [];
  const gateway = new AgentGateway(dependencies(trace));
  const outcome = await gateway.execute(envelope(), principal);
  assert.equal(outcome.kind, 'pending_approval');
  assert.equal(outcome.workflow.kind, 'approval');
  assert.deepEqual(trace, ['live-authority', 'validate', 'resolve-current-state', 'policy', 'approval-created']);
});

test('revalidates supplied approval immediately before admission and rejects stale authority', async () => {
  const trace = [];
  const gateway = new AgentGateway(dependencies(trace, {
    async authorizeApproval() { trace.push('approval-revalidated'); throw new agent.AgentError('APPROVAL_INVALID'); }
  }));
  const outcome = await gateway.execute(envelope({ workflow: { kind: 'approval', id: uuid() } }), principal);
  assert.equal(outcome.error.code, 'APPROVAL_INVALID');
  assert.equal(trace.includes('admit'), false);
  assert.deepEqual(trace.slice(-2), ['approval-revalidated', 'denial:APPROVAL_INVALID']);
});

test('rejects stale catalog before policy, workflow, or admission and durably audits the denial', async () => {
  const trace = [];
  const gateway = new AgentGateway(dependencies(trace));
  const outcome = await gateway.execute(envelope({
    catalog: { ...agent.operationCatalogIdentity, hash: agent.hashCanonicalJson({ stale: true }) }
  }), principal);
  assert.equal(outcome.error.code, 'CATALOG_VERSION_MISMATCH');
  assert.deepEqual(trace, ['live-authority', 'denial:CATALOG_VERSION_MISMATCH']);
});

test('change-set authority is revalidated and cannot bypass the single canonical policy decision', async () => {
  const trace = [];
  const gatewayWithChangeSet = new AgentGateway({
    ...dependencies(trace, {
      async authorizeChangeSet() { trace.push('changeset-revalidated'); throw new agent.AgentError('APPROVAL_INVALID'); }
    }),
    evaluatePolicy(input) {
      trace.push('policy');
      return {
        apiVersion: 1, disposition: 'requires_changeset', risk: 'R3', reasonCode: 'CHANGESET_REQUIRED',
        requiredScopes: input.descriptor.requiredScopes, catalog: agent.operationCatalogIdentity, policyVersion: 'policy-workflow-v1'
      };
    }
  });
  const outcome = await gatewayWithChangeSet.execute(envelope({ workflow: { kind: 'changeset', id: uuid() } }), principal);
  assert.equal(outcome.error.code, 'APPROVAL_INVALID');
  assert.equal(trace.filter((entry) => entry === 'policy').length, 1);
  assert.equal(trace.includes('admit'), false);
});

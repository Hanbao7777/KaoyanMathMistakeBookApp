const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const protocol = require(path.join(root, 'dist/main/main/mcp/protocol.js'));
const projection = require(path.join(root, 'dist/main/main/mcp/jobs/projection.js'));
const agent = require(path.join(root, 'dist/main/shared/agent/index.js'));
const exposure = require(path.join(root, 'dist/main/shared/mcp/v1/exposureManifest.js'));

const sessionId = '123e4567-e89b-42d3-a456-426614174000';
const jobId = '123e4567-e89b-42d3-a456-426614174001';
const requestId = '123e4567-e89b-42d3-a456-426614174002';

function principal(scopes, overrides = {}) {
  return Object.freeze({ apiVersion: 1, kind: 'agent-principal', clientId: 'client', subjectId: 'subject', displayName: 'Client',
    scopes: Object.freeze(scopes), trust: 'full_control', credentialBinding: 'binding', sessionId,
    authenticatedAt: '2026-07-18T00:00:00.000Z', renderer: false, ...overrides });
}

function job(status) {
  return { apiVersion: 1, jobId, ownerClientId: 'client', creatingSessionId: sessionId, operation: 'questions.review_buckets', operationKind: 'query',
    catalog: agent.operationCatalogIdentity, inputHash: `sha256-v1:${'a'.repeat(64)}`, gatewayRequestId: requestId, status,
    progress: ['completed', 'failed', 'cancelled', 'interrupted'].includes(status) ? 100 : status === 'running' ? 25 : 0, attempt: 1, createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
    ...(['completed', 'failed', 'cancelled', 'interrupted'].includes(status) ? { terminalAt: '2026-07-18T00:00:00.000Z' } : {}),
    ...(status === 'failed' ? { error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred.', retryable: false } } : {}),
    retentionClass: 'ordinary_7d', retainUntil: '2026-07-25T00:00:00.000Z' };
}

test('C8 projects every App job state exactly to MCP Tasks', () => {
  assert.equal(projection.projectJobStatus('queued'), 'working');
  assert.equal(projection.projectJobStatus('running'), 'working');
  assert.equal(projection.projectJobStatus('waiting_approval'), 'input_required');
  assert.equal(projection.projectJobStatus('completed'), 'completed');
  assert.equal(projection.projectJobStatus('failed'), 'failed');
  assert.equal(projection.projectJobStatus('interrupted'), 'failed');
  assert.equal(projection.projectJobStatus('cancelled'), 'cancelled');
});

test('C8 advertises Tasks only on the experimental protocol version', () => {
  assert.equal(Object.hasOwn(protocol.createMcpInitializeResult('2025-06-18').capabilities, 'tasks'), false);
  assert.deepEqual(protocol.createMcpInitializeResult('2025-11-25').capabilities.tasks.requests.tools.call, {});
});

test('C8 rejects Tasks methods when the session did not negotiate Tasks', async () => {
  const current = principal(['jobs.read']);
  const handler = protocol.createMcpProtocolHandler({ gateway: { async execute() { throw new Error('unexpected'); }, async query() { throw new Error('unexpected'); } } });
  const response = await handler({ principal: current, tasksNegotiated: false, request: { id: 1, method: 'tasks/get', params: { taskId: jobId } } });
  assert.equal(response.body.error.code, -32601);
});

test('C8 preserves the exact C6/C9 business exposures with and without Tasks', async () => {
  assert.equal(exposure.mcpExternalBusinessOperations.length, 40);
  const current = principal(agent.agentScopes);
  const handler = protocol.createMcpProtocolHandler({ gateway: { async execute() { throw new Error('unexpected'); }, async query() { throw new Error('unexpected'); } } });
  const ordinary = await handler({ principal: current, tasksNegotiated: false, request: { id: 1, method: 'tools/list', params: {} } });
  const augmented = await handler({ principal: current, tasksNegotiated: true, request: { id: 2, method: 'tools/list', params: {} } });
  const business = (response) => response.body.result.tools.map((tool) => tool.name).filter((name) => exposure.mcpExternalBusinessOperations.includes(name)).sort();
  assert.deepEqual(business(ordinary), [...exposure.mcpExternalBusinessOperations].sort());
  assert.deepEqual(business(augmented), [...exposure.mcpExternalBusinessOperations].sort());
});

test('C8 task-augmented tools and task APIs preserve owner-bound ordinary-job parity', async () => {
  let status = 'queued';
  const gateway = {
    async execute(envelope) {
      if (envelope.operation === 'jobs.create') return { kind: 'completed', result: { changed: true, value: job(status), events: [], dataVersion: { dataEpoch: 'epoch', dataRevision: 1 } } };
      if (envelope.operation === 'jobs.cancel') { status = 'cancelled'; return { kind: 'completed', result: { changed: true, value: job(status), events: [], dataVersion: { dataEpoch: 'epoch', dataRevision: 1 } } }; }
      throw new Error('unexpected execute');
    },
    async query(envelope) {
      if (envelope.operation === 'jobs.get') return { kind: 'completed', result: { value: job(status), dataVersion: { dataEpoch: 'epoch', dataRevision: 1 } } };
      if (envelope.operation === 'jobs.list') return { kind: 'completed', result: { value: { items: [job(status)], pageSize: 100, hasMore: false }, dataVersion: { dataEpoch: 'epoch', dataRevision: 1 } } };
      if (envelope.operation === 'jobs.result') return { kind: 'completed', result: { value: { job: job('completed'), result: { kind: 'completed', result: { value: { due: 0 }, dataVersion: { dataEpoch: 'epoch', dataRevision: 1 } } }, resultHash: `sha256-v1:${'b'.repeat(64)}`, resultSize: 1 }, dataVersion: { dataEpoch: 'epoch', dataRevision: 1 } } };
      throw new Error('unexpected query');
    }
  };
  const current = principal(['jobs.cancel', 'jobs.execute', 'jobs.read', 'questions.read', 'reviews.read']);
  const handler = protocol.createMcpProtocolHandler({ gateway, randomUUID: () => requestId });
  const ordinary = await handler({ principal: current, tasksNegotiated: false, request: { id: 0, method: 'tools/list', params: {} } });
  const listed = await handler({ principal: current, tasksNegotiated: true, request: { id: 1, method: 'tools/list', params: {} } });
  assert.deepEqual(listed.body.result.tools.map((tool) => tool.name), ordinary.body.result.tools.map((tool) => tool.name));
  assert.equal(listed.body.result.tools.find((tool) => tool.name === 'questions.review_buckets').execution.taskSupport, 'optional');
  assert.equal(Object.hasOwn(ordinary.body.result.tools.find((tool) => tool.name === 'questions.review_buckets'), 'execution'), false);
  const created = await handler({ principal: current, tasksNegotiated: true, request: { id: 2, method: 'tools/call', params: {
    name: 'questions.review_buckets', arguments: { apiVersion: 1, kind: 'mcp-tool-arguments', operation: 'questions.review_buckets', requestId, payload: {} }, task: { ttl: 60_000 }
  } } });
  assert.equal(created.body.result.task.taskId, jobId);
  assert.equal(created.body.result.task.status, 'working');
  const got = await handler({ principal: current, tasksNegotiated: true, request: { id: 3, method: 'tasks/get', params: { taskId: jobId } } });
  assert.equal(got.body.result.status, 'working');
  status = 'completed';
  const result = await handler({ principal: current, tasksNegotiated: true, request: { id: 4, method: 'tasks/result', params: { taskId: jobId } } });
  assert.equal(result.body.result.structuredContent.ok, true);
  assert.deepEqual(result.body.result._meta['io.modelcontextprotocol/related-task'], { taskId: jobId });
});

test('C8 accepts deferred post-dispatch cancellation and projects authoritative working state', async () => {
  let currentJob = { ...job('running'), cancellationRequestedAt: undefined };
  const gateway = {
    async execute(envelope) {
      assert.equal(envelope.operation, 'jobs.cancel');
      currentJob = { ...currentJob, cancellationRequestedAt: '2026-07-18T00:00:01.000Z' };
      return { kind: 'completed', result: { changed: true, value: currentJob, events: [], dataVersion: { dataEpoch: 'epoch', dataRevision: 1 } } };
    },
    async query(envelope) {
      assert.equal(envelope.operation, 'jobs.get');
      return { kind: 'completed', result: { value: currentJob, dataVersion: { dataEpoch: 'epoch', dataRevision: 1 } } };
    }
  };
  const handler = protocol.createMcpProtocolHandler({ gateway, randomUUID: () => requestId });
  const response = await handler({ principal: principal(['jobs.cancel', 'jobs.read']), tasksNegotiated: true,
    request: { id: 1, method: 'tasks/cancel', params: { taskId: jobId } } });
  assert.equal(response.body.result.status, 'working');
  assert.equal(currentJob.cancellationRequestedAt, '2026-07-18T00:00:01.000Z');
});

test('C8 Tasks isolate creating sessions and failed results without artifacts are bounded errors', async () => {
  const failed = job('failed');
  const gateway = {
    async execute() { throw new Error('unexpected'); },
    async query(envelope) {
      if (envelope.operation === 'jobs.get') return { kind: 'completed', result: { value: failed, dataVersion: { dataEpoch: 'epoch', dataRevision: 1 } } };
      if (envelope.operation === 'jobs.result') return { kind: 'completed', result: { value: {
        job: failed, result: { kind: 'rejected', error: failed.error }, resultHash: `sha256-v1:${'c'.repeat(64)}`, resultSize: 96
      }, dataVersion: { dataEpoch: 'epoch', dataRevision: 1 } } };
      if (envelope.operation === 'jobs.list') {
        assert.equal(envelope.payload.sessionId, sessionId);
        return { kind: 'completed', result: { value: { items: [failed], pageSize: 100, hasMore: false }, dataVersion: { dataEpoch: 'epoch', dataRevision: 1 } } };
      }
      throw new Error('unexpected query');
    }
  };
  const handler = protocol.createMcpProtocolHandler({ gateway, randomUUID: () => requestId });
  const owner = principal(['jobs.read']);
  const denied = await handler({ principal: principal(['jobs.read'], { sessionId: '123e4567-e89b-42d3-a456-426614174099' }), tasksNegotiated: true,
    request: { id: 1, method: 'tasks/get', params: { taskId: jobId } } });
  assert.ok(denied.body.error);
  const listed = await handler({ principal: owner, tasksNegotiated: true, request: { id: 2, method: 'tasks/list', params: {} } });
  assert.equal(listed.body.result.tasks.length, 1);
  const result = await handler({ principal: owner, tasksNegotiated: true, request: { id: 3, method: 'tasks/result', params: { taskId: jobId } } });
  assert.equal(result.body.result.isError, true);
  assert.equal(result.body.result.structuredContent.code, 'INTERNAL_ERROR');
  assert.ok(JSON.stringify(result.body.result).length < 2_000);
});

test('C8 Tasks paginate within the creating session before applying cursors', async () => {
  const otherSessionId = '123e4567-e89b-42d3-a456-426614174099';
  const jobs = Array.from({ length: 202 }, (_, index) => ({ ...job('queued'),
    jobId: `123e4567-e89b-42d3-a456-${String(index + 1000).padStart(12, '0')}`,
    creatingSessionId: index % 2 === 0 ? sessionId : otherSessionId
  }));
  const gateway = {
    async execute() { throw new Error('unexpected'); },
    async query(envelope) {
      assert.equal(envelope.operation, 'jobs.list');
      const visible = jobs.filter((item) => item.creatingSessionId === envelope.payload.sessionId && (!envelope.payload.cursor || item.jobId > envelope.payload.cursor));
      const items = visible.slice(0, envelope.payload.pageSize);
      return { kind: 'completed', result: { value: { items, pageSize: envelope.payload.pageSize, hasMore: visible.length > items.length,
        ...(visible.length > items.length ? { nextCursor: items.at(-1).jobId } : {}) }, dataVersion: { dataEpoch: 'epoch', dataRevision: 1 } } };
    }
  };
  const handler = protocol.createMcpProtocolHandler({ gateway, randomUUID: () => requestId });
  for (const activeSessionId of [sessionId, otherSessionId]) {
    const active = principal(['jobs.read'], { sessionId: activeSessionId });
    const first = await handler({ principal: active, tasksNegotiated: true, request: { id: 1, method: 'tasks/list', params: {} } });
    assert.equal(first.body.result.tasks.length, 100);
    assert.ok(first.body.result.tasks.every((task) => jobs.find((item) => item.jobId === task.taskId).creatingSessionId === activeSessionId));
    const second = await handler({ principal: active, tasksNegotiated: true, request: { id: 2, method: 'tasks/list', params: { cursor: first.body.result.nextCursor } } });
    assert.equal(second.body.result.tasks.length, 1);
    assert.equal(Object.hasOwn(second.body.result, 'nextCursor'), false);
  }
});

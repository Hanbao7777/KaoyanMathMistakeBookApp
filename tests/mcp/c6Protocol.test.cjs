const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const protocol = require(path.join(root, 'dist/main/main/mcp/protocol.js'));
const agent = require(path.join(root, 'dist/main/shared/agent/v1/operationCatalog.js'));

const ids = {
  create: '123e4567-e89b-42d3-a456-426614174000',
  query: '123e4567-e89b-42d3-a456-426614174001',
  resource: '123e4567-e89b-42d3-a456-426614174002'
};

function principal(scopes) {
  return Object.freeze({ apiVersion: 1, kind: 'agent-principal', clientId: 'client-one', subjectId: 'subject-one', displayName: 'Test',
    scopes, trust: 'full_control', credentialBinding: 'binding', authenticatedAt: '2026-07-18T00:00:00.000Z', renderer: false });
}

function createGateway(trace) {
  return {
    async execute(envelope) {
      trace.push({ method: 'execute', envelope });
      return { kind: 'completed', result: { changed: true, value: { id: 7, content: 'untrusted text', question_images: [{ id: 1, file_path: 'C:\\private\\image.png', mimeType: 'image/png', width: 100, height: 100, sizeBytes: 10 }], events: [] }, events: [], dataVersion: { dataEpoch: 'epoch', dataRevision: 2 } } };
    },
    async query(envelope) {
      trace.push({ method: 'query', envelope });
      if (envelope.operation === 'agent.receipts.get_status') return { kind: 'completed', result: { value: { apiVersion: 1, kind: 'receipt-status', clientId: 'client-one', requestId: ids.create, status: 'admitted', receipt: { apiVersion: 1, receiptId: '123e4567-e89b-42d3-a456-426614174003', clientId: 'client-one', requestId: ids.create, operation: 'questions.create', payloadHash: 'sha256-v1:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', catalog: agent.operationCatalogIdentity, status: 'admitted', createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z' } }, dataVersion: { dataEpoch: 'epoch', dataRevision: 2 } } };
      return { kind: 'completed', result: { value: { id: 7, content: 'full text', question_images: [{ id: 1, file_path: 'C:\\private\\image.png', mimeType: 'image/png', width: 100, height: 100, sizeBytes: 10 }] }, dataVersion: { dataEpoch: 'epoch', dataRevision: 2 } }, page: { pageSize: 50, hasMore: false } };
    }
  };
}

function handler(trace) {
  return protocol.createMcpProtocolHandler({ gateway: createGateway(trace), randomUUID: () => ids.resource });
}

test('C6 exposes only authorized business tools and bounded support primitives', async () => {
  const trace = [];
  const call = handler(trace);
  const readOnly = principal(['questions.read', 'reviews.read', 'tasks.read', 'focus.read']);
  const listed = await call({ principal: readOnly, request: { id: 1, method: 'tools/list', params: {} } });
  const names = listed.body.result.tools.map(({ name }) => name);
  assert.deepEqual(names.sort(), ['focus.sessions.list', 'questions.get', 'questions.list', 'questions.review_buckets', 'questions.review_logs', 'tasks.get', 'tasks.list'].sort());
  assert.equal(names.some((name) => /generic|execute|query/.test(name)), false);
  const resources = await call({ principal: readOnly, request: { id: 2, method: 'resources/list', params: {} } });
  assert.deepEqual(resources.body.result.resources.map(({ name }) => name).sort(), ['capabilities.summary', 'reviews.today', 'tasks.today'].sort());
  const templates = await call({ principal: readOnly, request: { id: 3, method: 'resources/templates/list', params: {} } });
  assert.deepEqual(templates.body.result.resourceTemplates.map(({ name }) => name).sort(), ['questions.view', 'tasks.view'].sort());
  const prompts = await call({ principal: readOnly, request: { id: 4, method: 'prompts/list', params: {} } });
  assert.deepEqual(prompts.body.result.prompts.map(({ name }) => name).sort(), ['review.daily.zh_en', 'review.weekly.zh_en'].sort());
  const prompt = await call({ principal: readOnly, request: { id: 5, method: 'prompts/get', params: { name: 'review.daily.zh_en', arguments: { focus: 'today' } } } });
  assert.match(prompt.body.result.messages[0].content.text, /untrusted|不可信/);
});

test('C6 tool calls bind canonical request ids, pass only through Gateway, and filter images', async () => {
  const trace = [];
  const call = handler(trace);
  const full = principal(['questions.read', 'questions.write', 'reviews.read', 'reviews.submit', 'tasks.read', 'tasks.write', 'tasks.execute', 'focus.read', 'focus.control']);
  const result = await call({ principal: full, request: { id: 6, method: 'tools/call', params: { name: 'questions.create', arguments: {
    apiVersion: 1, kind: 'mcp-tool-arguments', operation: 'questions.create', requestId: ids.create, idempotencyKey: ids.create,
    expectedVersion: { dataEpoch: 'epoch', dataRevision: 1 }, payload: { input: { title: 'T', content: 'C', wrong_thinking: '', wrong_solution: '', correct_solution: 'S', answer: 'A', category: 'calculus', question_type: 'single', error_reason: 'careless', source: 'test', difficulty: '简单', mastery_level: '未掌握', note: '', tags: [], questionImageSources: [], solutionImageSources: [] } }
  } } } });
  assert.equal(result.body.result.structuredContent.ok, true);
  assert.equal(result.body.result.structuredContent.receiptId, undefined);
  assert.equal(trace.length, 1);
  assert.equal(trace[0].method, 'execute');
  assert.deepEqual(trace[0].envelope.catalog, agent.operationCatalogIdentity);
  const noImages = await call({ principal: principal(['questions.read']), request: { id: 7, method: 'resources/read', params: { uri: 'kaoyan://questions/7' } } });
  const noImageData = JSON.parse(noImages.body.result.contents[0].text).data;
  assert.equal(noImageData.question_images, '[REDACTED]');
  const receipt = await call({ principal: full, request: { id: 8, method: 'agent.receipts.get_status', params: { clientId: 'client-one', requestId: ids.create } } });
  assert.equal(receipt.body.result.kind, 'receipt-status');
  assert.equal(trace.at(-1).envelope.operation, 'agent.receipts.get_status');
});

test('C6 invalid arguments are tool correction errors and unauthorized calls never reach Gateway', async () => {
  const trace = [];
  const call = handler(trace);
  const result = await call({ principal: principal(['questions.read']), request: { id: 9, method: 'tools/call', params: { name: 'questions.list', arguments: { apiVersion: 1, kind: 'mcp-tool-arguments', operation: 'questions.list', requestId: ids.query, payload: { filters: {} } } } } });
  assert.equal(result.body.result.structuredContent.ok, false);
  assert.equal(result.body.result.structuredContent.kind, 'tool-error');
  assert.equal(result.body.result.structuredContent.code, 'VALIDATION_ERROR');
  assert.equal(trace.length, 0);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '../../..');
const agent = require(path.join(projectRoot, 'dist/main/shared/agent/index.js'));

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const traceId = '123e4567-e89b-42d3-a456-426614174001';
const eventId = '123e4567-e89b-42d3-a456-426614174002';
const version = { dataEpoch: 'opaque-epoch', dataRevision: 4 };
const context = {
  trust: 'trusted', requestId, traceId, source: 'renderer',
  actor: { actorId: 'local-user', actorType: 'user' },
  client: { clientId: 'renderer-main' }, timestamp: '2026-07-15T10:00:00.000Z',
  concurrency: 'strict', expectedVersion: version
};
const input = {
  title: '', content: '', wrong_thinking: '', wrong_solution: '', correct_solution: '', answer: '',
  category: '高等数学', question_type: '计算题', error_reason: '', source: '', difficulty: '中等',
  mastery_level: '未掌握', note: '', tags: [], questionImageSources: [], solutionImageSources: []
};

const commands = [
  { type: 'questions.create', payload: { input } },
  { type: 'questions.update', payload: { questionId: 1, input } },
  { type: 'questions.delete', payload: { questionId: 1, deleteImages: false } },
  { type: 'questions.remove_image', payload: { imageId: 1, deleteFile: false } },
  { type: 'questions.mark_mastery', payload: { questionId: 1, mastery: '一般' } },
  { type: 'questions.submit_review', payload: { questionId: 1, result: 'correct' } },
  { type: 'questions.link_knowledge', payload: { questionId: 1, knowledgeNodeIds: ['node-1'], matchType: 'manual' } },
  { type: 'questions.migrate_categories', payload: { limit: 100 } },
  { type: 'questions.rematch_knowledge', payload: { limit: 100, questionIds: [1] } },
  { type: 'questions.bulk_upsert', payload: { items: [{ input }] } },
  { type: 'questions.import', payload: { batchId: 'batch-1', items: [{ input, knowledgeNodeIds: [] }] } },
  { type: 'questions.replace_all', payload: { questions: [input] } },
  { type: 'questions.clear_all', payload: { deleteImages: false, maxQuestions: 100 } }
];

test('exports an explicit stable v1 identity', () => {
  assert.equal(agent.agentApiVersion, 1);
  assert.equal(agent.agentContractNamespace, 'kaoyan.agent.v1');
  assert.match(agent.agentContractVersion, /v1@1$/);
  assert.deepEqual(agent.questionCommandTypes, commands.map(({ type }) => type));
  assert.deepEqual(agent.questionQueryTypes, ['questions.list', 'questions.get', 'questions.review_logs', 'questions.review_buckets']);
});

test('validates every question command discriminator', () => {
  for (const command of commands) {
    assert.doesNotThrow(() => agent.validateCommandEnvelope({ apiVersion: 1, kind: 'command', context, command }), command.type);
  }
});

test('validates the core question query matrix', () => {
  const queries = [
    { type: 'questions.list', payload: { filters: {}, limit: 50 } },
    { type: 'questions.get', payload: { questionId: 1 } },
    { type: 'questions.review_logs', payload: { questionId: 1, limit: 50 } },
    { type: 'questions.review_buckets', payload: {} }
  ];
  for (const query of queries) assert.doesNotThrow(() => agent.validateQueryEnvelope({ apiVersion: 1, kind: 'query', context, query }));
});

test('rejects unknown fields, discriminators, malformed ids, dates, and revisions', () => {
  const invalid = [
    { ...commands[0], extra: true },
    { type: 'questions.unknown', payload: {} },
    { type: 'questions.delete', payload: { questionId: 0, deleteImages: false } },
    { type: 'questions.create', payload: { input: { ...input, unexpected: true } } }
  ];
  for (const command of invalid) assert.throws(() => agent.validateQuestionCommand(command), /request is invalid/i);
  for (const bad of [{ dataEpoch: '', dataRevision: 0 }, { dataEpoch: 'e', dataRevision: -1 }, { dataEpoch: 'e', dataRevision: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => agent.validateDataVersion(bad), /request is invalid/i);
  }
  assert.throws(() => agent.validateExecutionContext({ ...context, timestamp: 'not-a-date' }), /request is invalid/i);
  assert.throws(() => agent.validateExecutionContext({ ...context, requestId: 'not-a-uuid' }), /request is invalid/i);
  assert.throws(() => agent.validateCommandEnvelope({ apiVersion: 2, kind: 'command', context, command: commands[0] }), /version is not supported/i);
});

test('distinguishes caller metadata from trusted concurrency policy', () => {
  const caller = { ...context, trust: 'caller', source: 'mcp' };
  delete caller.concurrency;
  const callerWithoutVersion = { ...caller };
  delete callerWithoutVersion.expectedVersion;
  assert.doesNotThrow(() => agent.validateExecutionContext(caller));
  assert.doesNotThrow(() => agent.validateExecutionContext(callerWithoutVersion));
  assert.throws(() => agent.validateExecutionContext({ ...caller, concurrency: 'none' }), /request is invalid/i);
  assert.throws(() => agent.validateExecutionContext({ ...context, concurrency: 'none' }), /request is invalid/i);
  assert.throws(() => agent.validateExecutionContext({ ...context, concurrency: 'epoch-only', expectedVersion: undefined }), /request is invalid/i);
  assert.throws(() => agent.validateExecutionContext({ ...context, actor: { actorId: '', actorType: 'user' } }), /request is invalid/i);

  const query = { apiVersion: 1, kind: 'query', context: callerWithoutVersion, query: { type: 'questions.get', payload: { questionId: 1 } } };
  assert.doesNotThrow(() => agent.validateQueryEnvelope(query));
  assert.throws(
    () => agent.validateCommandEnvelope({ apiVersion: 1, kind: 'command', context: callerWithoutVersion, command: commands[0] }),
    /request is invalid/i
  );
  assert.doesNotThrow(() => agent.validateCommandEnvelope({ apiVersion: 1, kind: 'command', context: caller, command: commands[0] }));

  const trustedStrictWithoutVersion = { ...context };
  delete trustedStrictWithoutVersion.expectedVersion;
  assert.doesNotThrow(() => agent.validateExecutionContext(trustedStrictWithoutVersion));
  assert.throws(
    () => agent.validateCommandEnvelope({ apiVersion: 1, kind: 'command', context: trustedStrictWithoutVersion, command: commands[0] }),
    /request is invalid/i
  );
});

test('validates event identity and before/after version semantics', () => {
  const event = { apiVersion: 1, eventId, type: 'question.updated', occurredAt: context.timestamp, requestId, traceId,
    source: 'renderer', versionBefore: version, versionAfter: { ...version, dataRevision: 5 }, payload: { questionId: 1 } };
  assert.doesNotThrow(() => agent.validateDomainEvent(event));
  assert.throws(() => agent.validateDomainEvent({ ...event, secret: 'x' }), /request is invalid/i);
  for (const dataRevision of [3, 4, 6]) {
    assert.throws(() => agent.validateDomainEvent({ ...event, versionAfter: { ...version, dataRevision } }), /request is invalid/i);
  }
  assert.doesNotThrow(() => agent.validateDomainEvent({ ...event, versionAfter: { dataEpoch: 'new', dataRevision: 0 } }));
  assert.throws(() => agent.validateDomainEvent({ ...event, versionAfter: { dataEpoch: 'new', dataRevision: 1 } }), /request is invalid/i);
  assert.throws(() => agent.validateDomainEvent({
    ...event,
    versionBefore: { dataEpoch: 'opaque-epoch', dataRevision: Number.MAX_SAFE_INTEGER },
    versionAfter: { dataEpoch: 'opaque-epoch', dataRevision: Number.MAX_SAFE_INTEGER }
  }), /request is invalid/i);
});

test('serializes known and unknown errors without sensitive exception data', () => {
  const known = new agent.AgentError('DATA_REVISION_CONFLICT', { currentVersion: version, safeToReplan: true });
  known.stack = 'SECRET_STACK';
  known.cause = { apiKey: 'SECRET_KEY' };
  const serialized = agent.serializeAgentError(known);
  assert.deepEqual(serialized.details.currentVersion, version);
  assert.equal(serialized.retryable, true);
  assert.doesNotMatch(JSON.stringify(serialized), /SECRET|stack|cause|apiKey/);
  const unknown = agent.serializeAgentError(new Error('token=SECRET'));
  assert.deepEqual(unknown, { code: 'INTERNAL_ERROR', message: 'An internal error occurred.', retryable: false });
  const unsafeDetails = agent.serializeAgentError(new agent.AgentError('DATA_REVISION_CONFLICT', {
    conflicts: [{ entityType: 'question', entityId: 'token=SECRET VALUE' }]
  }));
  assert.doesNotMatch(JSON.stringify(unsafeDetails), /SECRET/);
});

test('exports every stable error code and fixed safe serialization', () => {
  for (const code of agent.agentErrorCodes) {
    const serialized = agent.serializeAgentError(new agent.AgentError(code));
    assert.equal(serialized.code, code);
    assert.equal(typeof serialized.message, 'string');
    assert.equal(Object.hasOwn(serialized, 'stack'), false);
  }
});

test('routes envelopes only through their matching discriminator', () => {
  assert.equal(agent.isCommandEnvelope({ apiVersion: 1, kind: 'command', context, command: commands[0] }), true);
  assert.equal(agent.isCommandEnvelope({ apiVersion: 1, kind: 'query', context, command: commands[0] }), false);
  assert.equal(agent.isQueryEnvelope({ apiVersion: 1, kind: 'query', context, query: { type: 'questions.get', payload: { questionId: 1 } } }), true);
});

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '../..');
const agent = require(path.join(projectRoot, 'dist/main/shared/agent/index.js'));
const mcp = require(path.join(projectRoot, 'dist/main/shared/mcp/v1/index.js'));
const registry = require(path.join(projectRoot, 'dist/main/main/mcp/registry.js'));
const mapping = require(path.join(projectRoot, 'dist/main/main/mcp/resultMapping.js'));

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const hash = 'sha256-v1:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

test('measured protocol compatibility is exact and Tasks are disabled', () => {
  assert.deepEqual(mcp.mcpProtocolVersions, ['2025-06-18', '2025-11-25']);
  assert.equal(mcp.mcpCurrentProtocolVersion, '2025-11-25');
  assert.equal(mcp.mcpTasksEnabled, false);
  assert.equal(mcp.negotiateMcpProtocol(['2025-06-18']), '2025-06-18');
  assert.equal(mcp.negotiateMcpProtocol(['2025-11-25', '2025-06-18']), '2025-11-25');
  assert.throws(() => mcp.negotiateMcpProtocol(['2024-11-05']), /negotiation failed/i);
  assert.deepEqual(mcp.mcpMeasuredClientCompatibility.map(({ client, protocol, tasks }) => ({ client, protocol, tasks })), [
    { client: 'codex-cli', protocol: '2025-06-18', tasks: false },
    { client: 'claude-code', protocol: '2025-11-25', tasks: false }
  ]);
});

test('instructions and shared contracts are bounded and dependency-free', () => {
  assert.ok(mcp.mcpServerInstructionsValue.length <= 512);
  assert.doesNotThrow(() => mcp.validateMcpServerInstructions(mcp.mcpServerInstructionsValue));
  assert.doesNotThrow(() => mcp.validateMcpPageRequest({ pageSize: 200 }));
  assert.throws(() => mcp.validateMcpPageRequest({ pageSize: 201 }), /invalid/i);
  assert.throws(() => mcp.validateMcpPageRequest({ pageSize: 1, extra: true }), /invalid/i);
  assert.throws(() => mcp.validateMcpJson({ privateKey: 'nope' }), /invalid/i);
  assert.throws(() => mcp.validateMcpJson({ nested: { value: 'C:\\secret\\file.db' } }), /invalid/i);
  const schemas = fs.readFileSync(path.join(projectRoot, 'src/shared/mcp/v1/schemas.ts'), 'utf8');
  assert.doesNotMatch(schemas, /from ['"](?:node:|@modelcontextprotocol)/);
});

test('external manifest and registry expose exactly the accepted 19 operations', () => {
  assert.equal(mcp.mcpExternalExposureManifest.version, 'mcp-external-exposure-v1@1');
  assert.equal(Object.isFrozen(mcp.mcpExternalExposureManifest), true);
  assert.equal(Object.isFrozen(mcp.mcpExternalExposureManifest.businessOperations), true);
  assert.equal(mcp.mcpExternalBusinessOperations.length, 19);
  assert.equal(new Set(mcp.mcpExternalBusinessOperations).size, 19);
  assert.equal(registry.mcpV1BusinessRegistry.length, 19);
  assert.deepEqual(
    registry.mcpV1BusinessRegistry.map(({ operation }) => operation).sort(),
    [...mcp.mcpExternalBusinessOperations].sort()
  );
  assert.equal(registry.mcpV1Registry.some(({ operation }) => operation === 'execute'), false);
  assert.equal(registry.mcpV1Registry.some(({ name }) => /generic|execute|query/.test(name)), false);
  for (const descriptor of registry.mcpV1Registry) {
    assert.doesNotThrow(() => mcp.validateMcpRegistryDescriptor(descriptor));
    assert.equal(descriptor.handler.operation, descriptor.operation);
    assert.ok(descriptor.resultMapperId.startsWith('mcp.result.'));
    assert.equal(typeof descriptor.inputValidator, 'function');
    assert.equal(descriptor.outputValidator, mcp.validateMcpStructuredOutcome);
    assert.deepEqual(descriptor.catalog, agent.operationCatalogIdentity);
  }
  assert.equal(registry.mcpV1CapabilitySummary.tasks, false);
  assert.equal(registry.mcpV1ServerMetadata.currentProtocolVersion, '2025-11-25');
});

test('launcher contract is an exact projection of the external manifest and catalog', () => {
  assert.equal(mcp.launcherOperationManifest.exposureVersion, mcp.mcpExternalExposureManifest.version);
  assert.deepEqual(mcp.launcherOperationManifest.catalog, agent.operationCatalogIdentity);
  assert.deepEqual(mcp.launcherOperationManifest.operations.map(({ name }) => name).sort(), [...mcp.mcpExternalBusinessOperations].sort());
  for (const operation of mcp.launcherOperationManifest.operations) {
    const descriptor = agent.resolveOperationDescriptor(operation.name);
    assert.deepEqual({ kind: operation.kind, idempotency: operation.idempotency }, { kind: descriptor.kind, idempotency: descriptor.idempotency });
  }
});

test('every business tool has an exact runtime envelope and payload validator', () => {
  const questionInput = {
    title: 'T', content: 'C', wrong_thinking: '', wrong_solution: '', correct_solution: 'S', answer: 'A',
    category: 'calculus', question_type: 'single', error_reason: 'careless', source: 'test', difficulty: '简单', mastery_level: '未掌握',
    note: '', tags: [], questionImageSources: [], solutionImageSources: []
  };
  const payloads = {
    'questions.create': { input: questionInput }, 'questions.update': { questionId: 1, input: questionInput },
    'questions.delete': { questionId: 1, deleteImages: false }, 'questions.remove_image': { imageId: 1, deleteFile: false },
    'questions.mark_mastery': { questionId: 1, mastery: '已掌握' }, 'questions.submit_review': { questionId: 1, result: 'correct' },
    'questions.list': { filters: {}, limit: 1 }, 'questions.get': { questionId: 1 }, 'questions.review_logs': { questionId: 1, limit: 1 }, 'questions.review_buckets': {},
    'tasks.create': { input: { list_id: 'list', title: 'Task' } }, 'tasks.update': { taskId: 'task', input: { title: 'Task' } },
    'tasks.complete': { taskId: 'task' }, 'tasks.uncomplete': { taskId: 'task' }, 'tasks.delete': { taskId: 'task' },
    'tasks.list': { filters: {} }, 'tasks.get': { taskId: 'task' },
    'focus.sessions.create': { input: { start_time: '2026-07-16T09:00:00.000Z', duration_minutes: 25 } }, 'focus.sessions.list': { filters: {} }
  };
  for (const descriptor of registry.mcpV1BusinessRegistry) {
    const command = descriptor.handler.gatewayMethod === 'execute';
    const argumentsValue = {
      apiVersion: 1, kind: 'mcp-tool-arguments', operation: descriptor.operation, requestId, payload: payloads[descriptor.operation],
      ...(command ? { idempotencyKey: requestId, expectedVersion: { dataEpoch: 'epoch', dataRevision: 1 } } : {})
    };
    assert.doesNotThrow(() => descriptor.inputValidator(argumentsValue), descriptor.operation);
    assert.throws(() => descriptor.inputValidator({ ...argumentsValue, extra: true }), /invalid/i, descriptor.operation);
    assert.throws(() => descriptor.inputValidator({ ...argumentsValue, payload: { ...argumentsValue.payload, extra: true } }), /invalid/i, descriptor.operation);
  }
});

test('Gateway management seams accept only public keys and owner-bound receipt queries', () => {
  const publicKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const command = {
    type: 'agent.clients.register_key',
    payload: { clientId: 'client-one', publicKeyFormat: 'spki-der-base64url', publicKey, publicKeyFingerprint: agent.publicKeyFingerprintForSpki(publicKey), signatureAlgorithm: 'rsa-pss-sha256', expectedRegistryGeneration: 3 }
  };
  assert.doesNotThrow(() => agent.validateGatewayManagementCommand(command));
  assert.doesNotThrow(() => agent.validateGatewayManagementCommand({ ...command, type: 'agent.clients.rotate_key' }));
  assert.throws(() => agent.validateGatewayManagementCommand({ ...command, payload: { ...command.payload, privateKey: publicKey } }), /invalid/i);
  assert.throws(() => agent.validateGatewayManagementCommand({ ...command, payload: { ...command.payload, expectedRegistryGeneration: -1 } }), /invalid/i);
  assert.throws(() => agent.validateGatewayManagementCommand({ ...command, payload: { ...command.payload, publicKey: `${publicKey}=` } }), /invalid/i);
  assert.throws(() => agent.validateGatewayManagementCommand({ ...command, payload: { ...command.payload, publicKey: publicKey.replace(/A/, '+') } }), /invalid/i);
  assert.throws(() => agent.validateGatewayManagementCommand({ ...command, payload: { ...command.payload, signatureAlgorithm: 'rsa-sha256' } }), /invalid/i);
  assert.throws(() => agent.validateGatewayManagementCommand({ ...command, payload: { ...command.payload, publicKeyFingerprint: hash } }), /invalid/i);
  assert.doesNotThrow(() => agent.validateGatewayManagementQuery({
    type: 'agent.receipts.get_status', payload: { clientId: 'client-one', requestId }
  }));
  assert.throws(() => agent.validateGatewayManagementQuery({
    type: 'agent.receipts.get_status', payload: { clientId: 'client-one', requestId, operation: 'questions.create' }
  }), /invalid/i);
  const names = agent.operationCatalog.operations.map(({ name }) => name);
  assert.ok(names.includes('agent.clients.register_key'));
  assert.ok(names.includes('agent.clients.rotate_key'));
  assert.ok(names.includes('agent.receipts.get_status'));
  assert.equal(agent.resolveOperationDescriptor('agent.clients.register_key').visibility, 'owner-or-admin');
  assert.equal(agent.resolveOperationDescriptor('agent.clients.rotate_key').visibility, 'owner-or-admin');
  assert.equal(agent.resolveOperationDescriptor('agent.receipts.get_status').visibility, 'owner-or-admin');
});

test('receipt status returns only exact authoritative terminal replay', () => {
  const receipt = {
    apiVersion: 1, receiptId: '123e4567-e89b-42d3-a456-426614174001', clientId: 'client-one', requestId,
    operation: 'questions.create', payloadHash: hash, catalog: agent.operationCatalogIdentity, status: 'completed',
    dataVersion: { dataEpoch: 'epoch', dataRevision: 1 }, outcomeHash: hash,
    createdAt: '2026-07-16T09:00:00.000Z', updatedAt: '2026-07-16T09:00:01.000Z'
  };
  const status = {
    apiVersion: 1, kind: 'receipt-status', clientId: 'client-one', requestId, status: 'completed', receipt,
    terminal: { kind: 'command-result', result: { changed: true, value: { ok: true }, events: [], dataVersion: receipt.dataVersion } }
  };
  assert.doesNotThrow(() => agent.validateSafeReceiptStatusResult(status));
  assert.throws(() => agent.validateSafeReceiptStatusResult({ ...status, terminal: { kind: 'serialized-agent-error', error: { code: 'VALIDATION_ERROR', message: 'x', retryable: false } } }), /invalid/i);
  assert.throws(() => agent.validateSafeReceiptStatusResult({ ...status, status: 'failed' }), /invalid/i);
});

test('result mapping separates tool correction from transport failures and redacts secrets', () => {
  const base = { operation: 'questions.create', requestId, outcome: null };
  const invalid = mapping.mapMcpError(new agent.AgentError('VALIDATION_ERROR', { field: 'payload.title' }));
  assert.equal(invalid.kind, 'tool-error');
  assert.equal(invalid.code, 'VALIDATION_ERROR');
  assert.equal(invalid.field, 'payload.title');
  const auth = mapping.mapMcpError(new agent.AgentError('SCOPE_DENIED'));
  assert.deepEqual({ kind: auth.kind, category: auth.category, code: auth.code }, { kind: 'transport-error', category: 'authentication', code: 'SCOPE_DENIED' });
  const result = mapping.mapMcpGatewayResult({
    ...base,
    outcome: { kind: 'completed', result: { changed: true, value: { Secret: 'x', path: 'quoted C:\\private\\data.db', unc: 'see \\\\server\\share\\file', unix: 'open /private/data.db', safe: true }, dataVersion: { dataEpoch: 'epoch', dataRevision: 1 } } }
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.Secret, undefined);
  assert.equal(result.data.path, '[REDACTED]');
  assert.equal(result.data.safe, true);
  assert.doesNotThrow(() => mcp.validateMcpStructuredOutcome(result));
  const replay = mapping.mapMcpGatewayResult({ ...base, outcome: { kind: 'replayed', receiptId: requestId, result: { changed: true, value: { safe: true }, events: [], dataVersion: { dataEpoch: 'epoch', dataRevision: 1 } } } });
  const terminalReplay = mcp.mapGatewayTerminalToMcpOutcome('questions.create', requestId, { kind: 'command-result', result: { changed: true, value: { safe: true }, events: [], dataVersion: { dataEpoch: 'epoch', dataRevision: 1 } } });
  assert.equal(replay.receiptId, requestId);
  assert.equal(terminalReplay.receiptId, undefined);
  const replayWithoutReceipt = { ...replay }; delete replayWithoutReceipt.receiptId; delete replayWithoutReceipt.recovery;
  const terminalWithoutRecovery = { ...terminalReplay }; delete terminalWithoutRecovery.recovery;
  assert.deepEqual(replayWithoutReceipt, terminalWithoutRecovery);
  assert.equal(typeof mapping.resolveMcpResultMapper('questions.create'), 'function');
  assert.throws(() => mapping.resolveMcpResultMapper('questions.undo_review'), /No MCP result mapper/);
});

test('C1 main MCP files have no forbidden runtime bypass imports', () => {
  for (const file of ['src/main/mcp/registry.ts', 'src/main/mcp/resultMapping.ts']) {
    const source = fs.readFileSync(path.join(projectRoot, file), 'utf8');
    assert.doesNotMatch(source, /(?:DatabaseCoordinator|ClientRegistry|CommandBus|QueryBus|sql\.js|node:fs|node:path|coordinator)/i, file);
    assert.doesNotMatch(source, /execute\s*\(\s*operation|query\s*\(\s*operation/i, file);
  }
  const contracts = fs.readFileSync(path.join(projectRoot, 'src/shared/agent/v1/gatewayContracts.ts'), 'utf8');
  const gatewayMethods = contracts.match(/export interface AgentGateway \{([\s\S]*?)\n\}/)[1];
  assert.deepEqual([...gatewayMethods.matchAll(/^\s*(\w+)\(/gm)].map((match) => match[1]), ['execute', 'query']);
});

'use strict';

const { constants, createPublicKey, randomBytes, randomUUID, verify } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '../../..');
const protocol = require(path.join(projectRoot, 'dist/main/main/mcp/protocol.js'));
const agent = require(path.join(projectRoot, 'dist/main/shared/agent/index.js'));
const mcp = require(path.join(projectRoot, 'dist/main/shared/mcp/v1/index.js'));
const launcherContracts = require(path.join(projectRoot, 'dist/launcher-build/src/shared/mcp/v1/launcherContracts.js'));

const root = path.resolve(process.env.KAOYAN_C7_ROOT || '');
const publicKeyFile = path.resolve(process.env.KAOYAN_C7_PUBLIC_KEY_FILE || '');
const clientId = process.env.KAOYAN_C7_CLIENT_ID;
const discoveryPath = path.join(root, 'mcp-loopback.discovery.json');
const statePath = path.join(root, 'protocol-app-state.json');
const controlPath = path.join(root, 'protocol-app-control.json');
const tracePath = path.join(root, 'protocol-app-last-response.json');
const toolTracePath = path.join(root, 'protocol-app-last-tool-response.json');
const authTracePath = path.join(root, 'protocol-app-auth-trace.json');
const requestTracePath = path.join(root, 'protocol-app-request-trace.json');
const instanceId = randomUUID();
const challenges = new Map();
const sessions = new Map();

if (!root || !root.startsWith(path.resolve(os.tmpdir())) || !path.basename(root).startsWith('kaoyan-c7-real-') || !publicKeyFile.startsWith(root) || !clientId) {
  throw new Error('Unsafe C7 protocol fixture root');
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function hash(value) { return launcherContracts.hashLauncherJson(value); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}
function currentState() {
  return readJson(statePath, { epoch: 'c7-protocol-epoch', revision: 0, nextQuestionId: 1, questions: {}, receipts: {}, lossConsumed: false });
}
function control() { return readJson(controlPath, {}); }
function error(id, code, message) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }
function exactKeys(value, keys) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function dataVersion(state) { return { dataEpoch: state.epoch, dataRevision: state.revision }; }
function completedValue(operation, requestId, value, version) { return { apiVersion: 1, kind: 'mcp-structured-outcome', schemaVersion: mcp.mcpSchemaVersion, ok: true, operation, requestId, data: value, dataVersion: version, recovery: 'none' }; }

function principal() {
  return Object.freeze({
    apiVersion: 1, kind: 'agent-principal', clientId, subjectId: clientId, displayName: `C7 ${clientId}`,
    scopes: Object.freeze([...agent.agentScopes]), trust: 'full_control', credentialBinding: 'c7-binding',
    authenticatedAt: new Date().toISOString(), renderer: false
  });
}

function commandOutcome(state, envelope) {
  const existing = state.receipts[`${clientId}:${envelope.requestId}`];
  if (existing) {
    if (existing.receipt.operation !== envelope.operation || existing.receipt.payloadHash !== hash(envelope.payload)) {
      return { kind: 'rejected', error: { code: 'IDEMPOTENCY_CONFLICT', message: 'The request binding conflicts.', retryable: false, details: {} } };
    }
    return { kind: 'replayed', receiptId: existing.receipt.receiptId, result: existing.terminal.result };
  }
  if (envelope.expectedVersion && (envelope.expectedVersion.dataEpoch !== state.epoch || envelope.expectedVersion.dataRevision !== state.revision)) {
    return { kind: 'rejected', error: { code: 'DATA_REVISION_CONFLICT', message: 'The data revision is stale.', retryable: false, details: { currentVersion: dataVersion(state) } } };
  }
  if (!['questions.create', 'questions.update'].includes(envelope.operation)) {
    return { kind: 'rejected', error: { code: 'HANDLER_NOT_FOUND', message: 'The operation is unavailable.', retryable: false, details: {} } };
  }
  const payload = envelope.payload;
  const id = envelope.operation === 'questions.create' ? state.nextQuestionId++ : Number(payload.questionId);
  const previous = state.questions[String(id)] || {};
  const input = payload.input;
  state.questions[String(id)] = { ...previous, ...input, id, title: input.title, content: input.content, updatedAt: new Date().toISOString() };
  state.revision += 1;
  const result = { changed: true, value: state.questions[String(id)], events: [{
    apiVersion: 1, eventId: randomUUID(), type: envelope.operation, occurredAt: new Date().toISOString(), requestId: envelope.requestId,
    traceId: randomUUID(), source: 'mcp', versionBefore: { dataEpoch: state.epoch, dataRevision: state.revision - 1 },
    versionAfter: dataVersion(state), payload: { questionId: id }
  }], dataVersion: dataVersion(state) };
  const terminal = { kind: 'command-result', result };
  state.receipts[`${clientId}:${envelope.requestId}`] = {
    apiVersion: 1, kind: 'receipt-status', clientId, requestId: envelope.requestId, status: 'completed',
    receipt: { apiVersion: 1, receiptId: randomUUID(), clientId, requestId: envelope.requestId, operation: envelope.operation,
      payloadHash: hash(envelope.payload), catalog: agent.operationCatalogIdentity, status: 'completed', dataVersion: result.dataVersion,
      outcomeHash: hash(result), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, terminal
  };
  writeJson(statePath, state);
  return { kind: 'completed', result };
}

function queryOutcome(state, envelope) {
  if (envelope.operation === 'agent.receipts.get_status') {
    const found = state.receipts[`${envelope.payload.clientId}:${envelope.payload.requestId}`];
    if (!found) return { kind: 'rejected', error: { code: 'HANDLER_NOT_FOUND', message: 'The receipt is unavailable.', retryable: false, details: {} } };
    return { kind: 'completed', result: { value: found, dataVersion: dataVersion(state) } };
  }
  let value;
  if (envelope.operation === 'questions.get') value = state.questions[String(envelope.payload.questionId)] || null;
  else if (envelope.operation === 'questions.list') value = { items: Object.values(state.questions), page: { pageSize: 50, hasMore: false } };
  else if (envelope.operation === 'tasks.list') value = { items: [], page: { pageSize: 50, hasMore: false } };
  else if (envelope.operation === 'tasks.get') value = null;
  else if (envelope.operation === 'questions.review_buckets') value = { due: [], overdue: [], weak: [], upcoming: [] };
  else if (envelope.operation === 'questions.review_logs') value = { items: [], page: { pageSize: 50, hasMore: false } };
  else if (envelope.operation === 'focus.sessions.list') value = { items: [], page: { pageSize: 50, hasMore: false } };
  else value = { items: [], page: { pageSize: 50, hasMore: false } };
  return { kind: 'completed', result: { value, dataVersion: dataVersion(state) }, page: value?.page };
}

const gateway = {
  async execute(envelope) {
    const state = currentState();
    const outcome = commandOutcome(state, envelope);
    return outcome;
  },
  async query(envelope) {
    return queryOutcome(currentState(), envelope);
  }
};
const handler = protocol.createMcpProtocolHandler({ gateway, randomUUID });

function challengeFor(protocolVersion) {
  const challenge = Object.freeze({
    version: 'kaoyan-stdio-auth-v1', challengeId: randomUUID(), nonce: randomBytes(32).toString('base64url'), appInstanceId: instanceId,
    clientId, mcpProtocolVersion: protocolVersion, launcherVersion: '1.0.0', audience: 'kaoyan-mcp-loopback', transport: 'stdio-bridge',
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  challenges.set(challenge.challengeId, challenge);
  return challenge;
}
function validateSession(request) {
  const sessionId = request.headers['mcp-session-id'];
  const protocolVersion = request.headers['mcp-protocol-version'];
  const session = sessions.get(sessionId);
  const revoked = control().revoke === true;
  if (revoked || !session || session.protocolVersion !== protocolVersion || session.expiresAt <= Date.now()) return null;
  return session;
}
function respond(response, status, body, headers = {}) {
  response.setHeader('mcp-instance-id', instanceId);
  if (body === undefined) { response.writeHead(status, { connection: 'close', ...headers }); response.end(); return; }
  const encoded = JSON.stringify(body);
  response.writeHead(status, { connection: 'close', 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded), ...headers });
  response.end(encoded);
}
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); } });
    request.on('error', reject);
  });
}

const server = http.createServer(async (request, response) => {
  const port = server.address()?.port;
  const requestTrace = readJson(requestTracePath, []);
  if (request.url !== '/mcp' || request.headers.host !== `127.0.0.1:${port}`) { respond(response, 404); return; }
  if (request.method === 'GET') { respond(response, 401); return; }
  if (request.method !== 'POST' || request.headers['content-type'] !== 'application/json') { respond(response, 415); return; }
  let message;
  try { message = await readBody(request); } catch { respond(response, 400); return; }
  requestTrace.push({ method: request.method, url: request.url, rpcMethod: message.method || null, session: request.headers['mcp-session-id'] || null, protocol: request.headers['mcp-protocol-version'] || null });
  writeJson(requestTracePath, requestTrace);
  if (message.method === 'initialize') {
    const authTrace = readJson(authTracePath, []);
    authTrace.push({ instanceId, clientHeader: request.headers['x-kaoyan-client-id'], launcherHeader: request.headers['x-kaoyan-launcher-version'], challengeId: request.headers['x-kaoyan-challenge-id'] || null, revoked: control().revoke === true });
    writeJson(authTracePath, authTrace);
    if (request.headers['x-kaoyan-client-id'] !== clientId || request.headers['x-kaoyan-launcher-version'] !== '1.0.0') { respond(response, 401); return; }
    const challengeId = request.headers['x-kaoyan-challenge-id'];
    if (!challengeId) {
      respond(response, 401, { ...error(message.id, -32002, 'Authentication challenge required'), error: { code: -32002, message: 'Authentication challenge required', data: { challenge: challengeFor(message.params.protocolVersion) } } });
      return;
    }
    const challenge = challenges.get(challengeId); challenges.delete(challengeId);
    const signature = request.headers['x-kaoyan-challenge-signature'];
    const publicKey = fs.readFileSync(publicKeyFile, 'utf8').trim();
    const valid = challenge && challenge.mcpProtocolVersion === message.params.protocolVersion && Date.parse(challenge.expiresAt) > Date.now() && typeof signature === 'string' && verify('sha256', Buffer.from(canonical(challenge), 'utf8'), {
      key: createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' }), padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32
    }, Buffer.from(signature, 'base64url'));
    const proofTrace = readJson(authTracePath, []);
    proofTrace.push({ instanceId, challengeId, signatureLength: typeof signature === 'string' ? signature.length : 0, valid: Boolean(valid), publicKeyLength: publicKey.length });
    writeJson(authTracePath, proofTrace);
    if (!valid || control().revoke === true) { respond(response, 401); return; }
    const sessionId = randomUUID();
    sessions.set(sessionId, { sessionId, protocolVersion: message.params.protocolVersion, initialized: false, expiresAt: Date.now() + 5 * 60_000 });
    respond(response, 200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, ...protocol.mcpInitializeResult } }, { 'mcp-session-id': sessionId, 'mcp-protocol-version': message.params.protocolVersion });
    return;
  }
  const session = validateSession(request);
  if (!session) { respond(response, 401); return; }
  if (message.method === 'notifications/initialized') { session.initialized = true; respond(response, 202); return; }
  if (!session.initialized) { respond(response, 409, error(message.id, -32001, 'MCP session is not initialized')); return; }
  const result = await handler({
    principal: principal(),
    headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? undefined : value])),
    request: message
  });
  const current = control();
  const isWrite = message.method === 'tools/call' && ['questions.create', 'questions.update'].includes(message.params?.name);
  if (isWrite && current.loseResponseOnce === true) {
    const state = currentState();
    if (!state.lossConsumed) { state.lossConsumed = true; writeJson(statePath, state); response.socket.destroy(); return; }
  }
  if (message.method === 'tools/call') writeJson(toolTracePath, result);
  writeJson(tracePath, result);
  respond(response, 200, result.body ?? result);
});

function publishDiscovery() {
  const now = new Date();
  writeJson(discoveryPath, { schemaVersion: 1, pid: process.pid, instanceId, port: server.address().port, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(), protocolVersions: ['2025-06-18', '2025-11-25'], launcherRange: '>=1 <2' });
}
function shutdown() {
  try { const discovery = readJson(discoveryPath, {}); if (discovery.instanceId === instanceId) fs.rmSync(discoveryPath, { force: true }); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2_000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, publishDiscovery);

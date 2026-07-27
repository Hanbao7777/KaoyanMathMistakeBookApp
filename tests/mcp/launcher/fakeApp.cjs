'use strict';

const { constants, createHash, createPublicKey, randomBytes, randomUUID, verify } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const MAX_BODY = 64 * 1024;
const root = path.resolve(process.env.KAOYAN_FAKE_ROOT || '');
const publicKeyPath = path.resolve(process.env.KAOYAN_FAKE_PUBLIC_KEY_FILE || '');
const catalog = Object.freeze({ version: process.env.KAOYAN_FAKE_CATALOG_VERSION, hash: process.env.KAOYAN_FAKE_CATALOG_HASH });
const schemaVersion = process.env.KAOYAN_FAKE_SCHEMA_VERSION;
const clientId = process.env.KAOYAN_FAKE_CLIENT_ID;
const discoveryPath = path.join(root, 'mcp-loopback.discovery.json');
const statePath = path.join(root, 'fake-app-state.json');
const controlPath = path.join(root, 'fake-app-control.json');
const instanceId = randomUUID();
const challenges = new Map();
const sessions = new Map();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalized(value) { return process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value); }
function descendant(base, target) { const relative = path.relative(normalized(base), normalized(target)); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
if (!root || !root.startsWith(path.resolve(require('node:os').tmpdir())) || !path.basename(root).startsWith('kaoyan-c4-real-') || !descendant(root, publicKeyPath)) throw new Error('Unsafe fake App root');
for (const value of [catalog.version, catalog.hash, schemaVersion, clientId]) if (!value) throw new Error('Missing fake App contract');

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function hash(value) { return `sha256-v1:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`; }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function state() { return readJson(statePath, { executorCount: 0, lossConsumed: false, receipts: {}, requests: 0, initialized: 0 }); }
function control() { return readJson(controlPath, {}); }
function durable(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(handle, `${JSON.stringify(value)}\n`); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  fs.renameSync(temporary, file);
}
function respond(response, status, body, headers = {}) {
  response.setHeader('mcp-instance-id', instanceId);
  if (body === undefined) { response.writeHead(status, { connection: 'close', ...headers }); response.end(); return; }
  const encoded = JSON.stringify(body);
  response.writeHead(status, { connection: 'close', 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded), ...headers });
  response.end(encoded);
}
function error(id, code, message) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }
function exactKeys(value, keys) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function challengeFor(protocolVersion) {
  const challenge = Object.freeze({
    version: 'kaoyan-stdio-auth-v1', challengeId: randomUUID(), nonce: randomBytes(32).toString('base64url'), appInstanceId: instanceId,
    clientId, mcpProtocolVersion: protocolVersion, launcherVersion: '1.0.0', audience: 'kaoyan-mcp-loopback', transport: 'stdio-bridge',
    expiresAt: new Date(Date.now() + 30_000).toISOString()
  });
  challenges.set(challenge.challengeId, challenge);
  return challenge;
}
function structuredSuccess(operation, requestId, data, dataVersion) {
  return { schemaVersion, ok: true, operation, requestId, data, ...(dataVersion ? { dataVersion } : {}) };
}
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => { bytes += chunk.length; if (bytes > MAX_BODY) { request.destroy(); reject(new Error('too large')); } else chunks.push(chunk); });
    request.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); } });
    request.on('error', reject);
  });
}
function validateSession(request) {
  const sessionId = request.headers['mcp-session-id'];
  const protocol = request.headers['mcp-protocol-version'];
  const found = sessions.get(sessionId);
  const current = control();
  if (current.revoke === true || !found || found.protocol !== protocol || found.instanceId !== instanceId || found.expiresAt <= Date.now()) return null;
  if (current.expireSessionsOnce === true) {
    durable(controlPath, { ...current, expireSessionsOnce: false });
    sessions.delete(sessionId);
    return null;
  }
  return found;
}

const server = http.createServer(async (request, response) => {
  if (request.url !== '/mcp' || request.headers.host !== `127.0.0.1:${server.address().port}`) { respond(response, 404); return; }
  if (request.method === 'GET') { respond(response, 401); return; }
  if (request.method !== 'POST' || request.headers['content-type'] !== 'application/json') { respond(response, 415); return; }
  let message;
  try { message = await readBody(request); } catch { respond(response, 400); return; }
  if (message.method === 'initialize') {
    const authState = state(); authState.initializeAttempts = (authState.initializeAttempts || 0) + 1; durable(statePath, authState);
    if (control().revoke === true || request.headers['x-kaoyan-client-id'] !== clientId || request.headers['x-kaoyan-launcher-version'] !== '1.0.0') { respond(response, 401); return; }
    const challengeId = request.headers['x-kaoyan-challenge-id'];
    if (!challengeId) {
      const challengedState = state(); challengedState.challengesIssued = (challengedState.challengesIssued || 0) + 1; durable(statePath, challengedState);
      respond(response, 401, { ...error(message.id, -32002, 'Authentication challenge required'), error: { code: -32002, message: 'Authentication challenge required', data: { challenge: challengeFor(message.params.protocolVersion) } } });
      return;
    }
    const challenge = challenges.get(challengeId);
    challenges.delete(challengeId);
    const signature = request.headers['x-kaoyan-challenge-signature'];
    const publicKey = fs.readFileSync(publicKeyPath, 'utf8').trim();
    const valid = challenge && challenge.clientId === request.headers['x-kaoyan-client-id'] && challenge.mcpProtocolVersion === message.params.protocolVersion &&
      Date.parse(challenge.expiresAt) > Date.now() && typeof signature === 'string' && verify('sha256', Buffer.from(canonical(challenge), 'utf8'), {
        key: createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' }), padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32
      }, Buffer.from(signature, 'base64url'));
    if (!valid) { respond(response, 401); return; }
    const admittedState = state(); admittedState.sessionsAdmitted = (admittedState.sessionsAdmitted || 0) + 1; durable(statePath, admittedState);
    const sessionId = randomUUID();
    sessions.set(sessionId, { protocol: message.params.protocolVersion, instanceId, initialized: false, expiresAt: Date.now() + 5 * 60_000 });
    respond(response, 200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'kaoyan-fake-app', version: '1' } } }, { 'mcp-session-id': sessionId, 'mcp-protocol-version': message.params.protocolVersion });
    return;
  }
  const session = validateSession(request);
  if (!session) { respond(response, 401); return; }
  if (message.method === 'notifications/initialized') {
    session.initialized = true;
    const current = state(); current.initialized += 1; durable(statePath, current);
    respond(response, 202); return;
  }
  if (!session.initialized) { respond(response, 409, error(message.id, -32001, 'Session is not initialized')); return; }
  const current = state(); current.requests += 1;
  if (message.method === 'agent.receipts.get_status') {
    if (!exactKeys(message.params, ['clientId', 'requestId']) || message.params.clientId !== clientId || !UUID.test(message.params.requestId)) {
      durable(statePath, current);
      respond(response, 200, error(message.id, -32602, 'Invalid receipt binding'));
      return;
    }
    const found = current.receipts[`${message.params.clientId}:${message.params.requestId}`];
    durable(statePath, current);
    respond(response, 200, found ? { jsonrpc: '2.0', id: message.id, result: found } : error(message.id, -32004, 'Receipt not found'));
    return;
  }
  if (message.method === 'tools/list') {
    durable(statePath, current);
    respond(response, 200, { jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'questions.create' }, { name: 'questions.list' }] } });
    return;
  }
  if (message.method !== 'tools/call') { durable(statePath, current); respond(response, 501, error(message.id, -32601, 'Not implemented')); return; }
  const args = message.params?.arguments;
  const commandKeys = ['apiVersion', 'kind', 'operation', 'requestId', 'idempotencyKey', 'expectedVersion', 'payload'];
  const queryKeys = ['apiVersion', 'kind', 'operation', 'requestId', 'payload'];
  const isCommand = args?.operation === 'questions.create';
  const validArguments = args && args.apiVersion === 1 && args.kind === 'mcp-tool-arguments' && args.catalog === undefined &&
    message.params.name === args.operation && UUID.test(args.requestId) && exactKeys(args, isCommand ? commandKeys : queryKeys) &&
    (!isCommand || (args.idempotencyKey === args.requestId && exactKeys(args.expectedVersion, ['dataEpoch', 'dataRevision'])));
  if (!validArguments) { durable(statePath, current); respond(response, 400, error(message.id, -32602, 'Invalid tool arguments')); return; }
  if (args.operation === 'questions.list') {
    durable(statePath, current);
    respond(response, 200, { jsonrpc: '2.0', id: message.id, result: structuredSuccess(args.operation, args.requestId, { items: [], executorCount: current.executorCount }) });
    return;
  }
  const key = `${clientId}:${args.requestId}`;
  const payloadHash = hash(args.payload);
  const existing = current.receipts[key];
  if (existing) {
    if (existing.receipt.operation !== args.operation || existing.receipt.payloadHash !== payloadHash) {
      durable(statePath, current);
      respond(response, 200, { jsonrpc: '2.0', id: message.id, result: { schemaVersion, ok: false, kind: 'tool-error', code: 'REQUEST_CONFLICT', message: 'The request binding conflicts.', retryable: false } });
      return;
    }
    durable(statePath, current);
    const outcome = structuredSuccess(args.operation, args.requestId, existing.terminal.result.value, existing.terminal.result.dataVersion);
    respond(response, 200, { jsonrpc: '2.0', id: message.id, result: outcome });
    return;
  }
  current.executorCount += 1;
  const version = { dataEpoch: 'fake-epoch', dataRevision: current.executorCount };
  const result = { changed: true, value: { accepted: true, executorCount: current.executorCount }, events: [], dataVersion: version };
  const terminal = { kind: 'command-result', result };
  const completed = {
    apiVersion: 1, kind: 'receipt-status', clientId, requestId: args.requestId, status: 'completed',
    receipt: { apiVersion: 1, receiptId: randomUUID(), clientId, requestId: args.requestId, operation: args.operation, payloadHash, catalog, status: 'completed', dataVersion: version, outcomeHash: hash(result), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    terminal
  };
  current.receipts[key] = completed;
  const shouldLose = control().loseResponseOnce === true && current.lossConsumed === false;
  if (shouldLose) current.lossConsumed = true;
  durable(statePath, current);
  if (shouldLose) { response.socket.destroy(); return; }
  respond(response, 200, { jsonrpc: '2.0', id: message.id, result: structuredSuccess(args.operation, args.requestId, result.value, version) });
});

function publishDiscovery() {
  const now = new Date();
  durable(discoveryPath, { schemaVersion: 1, pid: process.pid, instanceId, port: server.address().port, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(), protocolVersions: ['2025-06-18', '2025-11-25'], launcherRange: '>=1 <2' });
  const current = state(); current.pid = process.pid; current.instanceId = instanceId; current.port = server.address().port; durable(statePath, current);
}
function removeDiscovery() { try { const found = readJson(discoveryPath, {}); if (found.instanceId === instanceId) fs.rmSync(discoveryPath, { force: true }); } catch {} }
function shutdown() { removeDiscovery(); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 2_000).unref(); }
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, publishDiscovery);

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..', '..');
const realDataRoot = 'D:\\KaoyanMathMistakeBook';
const hostModule = require(path.join(projectRoot, 'dist/main/main/mcp/server.js'));
const discovery = require(path.join(projectRoot, 'dist/main/main/mcp/discovery.js'));

const roots = new Set();
function root(label) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), `kaoyan-c2-${label}-`));
  assert.notEqual(path.resolve(value).toLowerCase(), path.resolve(realDataRoot).toLowerCase());
  roots.add(value);
  return value;
}
function request(port, options = {}, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', agent: false, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...(options.headers || {}) } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(body);
  });
}
function authenticator() {
  const sessions = new Set();
  return {
    async admitInitialize({ protocolVersion }) { const sessionId = '00000000-0000-4000-8000-000000000777'; sessions.add(sessionId); return { sessionId, protocolVersion, expiresAt: new Date(Date.now() + 60_000).toISOString() }; },
    async validateSession(sessionId, protocolVersion) { return sessions.has(sessionId) && protocolVersion === '2025-11-25' ? Object.freeze({ clientId: 'test-client' }) : null; },
    async invalidateAll() { sessions.clear(); }
  };
}
test.after(() => { for (const value of roots) fs.rmSync(value, { recursive: true, force: true }); });

test('disabled control publishes neither listener discovery nor session admission', async () => {
  const discoveryRoot = root('disabled');
  const host = new hostModule.McpLoopbackHost({ discoveryRoot, externalControlEnabled: () => false, authenticatedReady: () => true });
  assert.equal((await host.start()).state, 'disabled');
  assert.equal(fs.existsSync(discovery.getMcpDiscoveryPath(discoveryRoot)), false);
  await host.stop();
});

test('ready host binds IPv4 dynamically only after authenticated readiness and publishes validated discovery', async () => {
  const discoveryRoot = root('ready');
  const trace = [];
  const host = new hostModule.McpLoopbackHost({ discoveryRoot, externalControlEnabled: () => { trace.push('enabled'); return true; }, authenticatedReady: () => { trace.push('authenticated'); return true; }, authenticator: authenticator(), discoveryOwnershipCheck: () => true });
  try {
    const status = await host.start();
    assert.equal(status.state, 'ready');
    assert.deepEqual(trace, ['enabled', 'authenticated', 'enabled', 'authenticated', 'enabled']);
    const record = await discovery.readValidatedMcpDiscovery({ root: discoveryRoot, ownershipCheck: () => true, handshake: async (candidate) => candidate.instanceId === status.instanceId && candidate.port === status.port });
    assert.equal(record.port, status.port);
    assert.equal(record.protocolVersions.includes('2025-11-25'), true);
    assert.equal(JSON.stringify(record).includes('secret'), false);
  } finally {
    await host.stop();
  }
  assert.equal(fs.existsSync(discovery.getMcpDiscoveryPath(discoveryRoot)), false);
});

test('malformed stale and failed-handshake discovery is removed and never trusted', async () => {
  const discoveryRoot = root('discovery');
  fs.writeFileSync(discovery.getMcpDiscoveryPath(discoveryRoot), '{broken', 'utf8');
  assert.equal(await discovery.readValidatedMcpDiscovery({ root: discoveryRoot, handshake: async () => true }), null);
  const now = new Date();
  fs.writeFileSync(discovery.getMcpDiscoveryPath(discoveryRoot), JSON.stringify({ schemaVersion: 1, pid: process.pid, instanceId: '00000000-0000-4000-8000-000000000701', port: 12345, createdAt: new Date(now.getTime() - 120_000).toISOString(), expiresAt: new Date(now.getTime() - 1_000).toISOString(), protocolVersions: ['2025-11-25'], launcherRange: '>=1 <2' }), 'utf8');
  assert.equal(await discovery.readValidatedMcpDiscovery({ root: discoveryRoot, handshake: async () => true }), null);
  assert.equal(fs.existsSync(discovery.getMcpDiscoveryPath(discoveryRoot)), false);
});

test('host closes and removes discovery when Windows ACL validation cannot establish safe ownership', async () => {
  const discoveryRoot = root('unsafe-acl');
  const host = new hostModule.McpLoopbackHost({
    discoveryRoot,
    externalControlEnabled: () => true,
    authenticatedReady: () => true,
    authenticator: authenticator(),
    discoveryOwnershipCheck: () => false
  });
  await assert.rejects(host.start(), /publication failed security validation/);
  assert.equal(host.status().state, 'stopped');
  assert.equal(fs.existsSync(discovery.getMcpDiscoveryPath(discoveryRoot)), false);
  await host.stop();
});

test('strict boundary rejects Host Origin content type size and unauthenticated business messages', async () => {
  const discoveryRoot = root('boundary');
  const host = new hostModule.McpLoopbackHost({ discoveryRoot, externalControlEnabled: () => true, authenticatedReady: () => true, authenticator: authenticator(), discoveryOwnershipCheck: () => true });
  const status = await host.start();
  const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  assert.equal((await request(status.port, { headers: { host: 'localhost' } }, initialize)).status, 404);
  assert.equal((await request(status.port, { headers: { origin: 'https://example.invalid' } }, initialize)).status, 404);
  assert.equal((await request(status.port, { headers: { origin: 'null' } }, initialize)).status, 404);
  assert.equal((await request(status.port, { headers: { 'content-type': 'text/plain' } }, initialize)).status, 415);
  assert.equal((await request(status.port, {}, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} }))).status, 401);
  assert.equal((await request(status.port, { headers: { 'content-length': '999999' } }, initialize)).status, 413);
  const accepted = await request(status.port, {}, initialize);
  assert.equal(accepted.status, 200);
  assert.equal(typeof accepted.headers['mcp-session-id'], 'string');
  await host.stop();
});

test('challenge discovery is bounded and authenticated requests receive the live principal only', async () => {
  const discoveryRoot = root('challenge');
  const challenge = Object.freeze({
    version: 'kaoyan-stdio-auth-v1', challengeId: '00000000-0000-4000-8000-000000000778', nonce: 'A'.repeat(43),
    appInstanceId: 'instance', clientId: 'test-client', mcpProtocolVersion: '2025-11-25', launcherVersion: '1.0.0',
    audience: 'kaoyan-mcp-loopback', transport: 'stdio-bridge', expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  const auth = authenticator();
  auth.challengeInitialize = async ({ headers }) => headers['x-kaoyan-client-id'] === 'test-client' ? challenge : null;
  let seenPrincipal;
  const host = new hostModule.McpLoopbackHost({
    discoveryRoot, externalControlEnabled: () => true, authenticatedReady: () => true, authenticator: auth,
    discoveryOwnershipCheck: () => true,
    onAuthenticatedRequest(input) { seenPrincipal = input.principal; return { body: { jsonrpc: '2.0', id: input.request.id, result: { ok: true } } }; }
  });
  const status = await host.start();
  const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  const challenged = await request(status.port, { headers: { 'x-kaoyan-client-id': 'test-client', 'x-kaoyan-launcher-version': '1.0.0' } }, initialize);
  assert.equal(challenged.status, 401);
  assert.deepEqual(JSON.parse(challenged.body).error.data.challenge, challenge);
  assert.equal(JSON.stringify(challenged.body).includes('private'), false);

  const accepted = await request(status.port, { headers: { 'x-kaoyan-challenge-id': challenge.challengeId, 'x-kaoyan-challenge-signature': 'A'.repeat(64) } }, initialize);
  assert.equal(accepted.status, 200);
  const sessionHeaders = { 'mcp-session-id': accepted.headers['mcp-session-id'], 'mcp-protocol-version': '2025-11-25' };
  assert.equal((await request(status.port, { headers: sessionHeaders }, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).status, 202);
  const called = await request(status.port, { headers: sessionHeaders }, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
  assert.equal(called.status, 200);
  assert.equal(seenPrincipal.clientId, 'test-client');
  await host.stop();
});

test('port races remain isolated and emergency stop immediately invalidates discovery and listener', async () => {
  const first = new hostModule.McpLoopbackHost({ discoveryRoot: root('race-a'), externalControlEnabled: () => true, authenticatedReady: () => true, authenticator: authenticator(), discoveryOwnershipCheck: () => true });
  const second = new hostModule.McpLoopbackHost({ discoveryRoot: root('race-b'), externalControlEnabled: () => true, authenticatedReady: () => true, authenticator: authenticator(), discoveryOwnershipCheck: () => true });
  const [a, b] = await Promise.all([first.start(), second.start()]);
  assert.notEqual(a.port, b.port);
  await first.stop();
  await assert.rejects(request(a.port, {}, '{}'));
  await second.stop();
});

test('an external-control transition disables the host without waiting on its current request', async () => {
  const discoveryRoot = root('emergency-stop');
  let enabled = true;
  const host = new hostModule.McpLoopbackHost({
    discoveryRoot,
    externalControlEnabled: () => enabled,
    authenticatedReady: () => true,
    authenticator: authenticator(),
    discoveryOwnershipCheck: () => true
  });
  const status = await host.start();
  enabled = false;
  const response = await new Promise((resolve, reject) => {
    const probe = http.request({ host: '127.0.0.1', port: status.port, path: '/mcp', method: 'GET', agent: false, headers: { host: `127.0.0.1:${status.port}` } }, (result) => {
      result.resume();
      result.once('end', () => resolve(result.statusCode));
    });
    probe.once('error', reject);
    probe.end();
  });
  assert.equal(response, 503);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.status().state, 'disabled');
  assert.equal(fs.existsSync(discovery.getMcpDiscoveryPath(discoveryRoot)), false);
  await host.stop();
});

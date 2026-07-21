const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const transport = require(path.join(root, 'dist/main/main/mcp/transport/loopbackHttp.js'));

function request(port, method, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); if (body !== undefined) req.end(body); else req.end();
  });
}

test('C14 direct transport requires HTTPS Origin, bearer auth, Accept negotiation, and binds sessions to the bearer token', async () => {
  const sessionId = '00000000-0000-4000-8000-000000000111';
  const token = `Bearer ${'A'.repeat(40)}`;
  const auth = {
    async admitInitialize({ headers, protocolVersion }) { return headers.authorization === token ? { sessionId, protocolVersion, expiresAt: new Date(Date.now() + 60_000).toISOString() } : null; },
    async validateSession(id, version, headers) { return id === sessionId && version === '2025-11-25' && headers.authorization === token ? Object.freeze({ clientId: 'http-client' }) : null; },
    async invalidateAll() {}
  };
  const handler = transport.createLoopbackMcpRequestHandler({
    getPort: () => port,
    instanceId: '00000000-0000-4000-8000-000000000112',
    authenticator: auth,
    allowedOrigins: ['https://127.0.0.1:39458'],
    allowDefaultOrigin: false,
    requireOrigin: true,
    requireAccept: true,
    unauthorizedHeaders: { 'www-authenticate': 'Bearer resource_metadata="https://127.0.0.1:39458/.well-known/oauth-protected-resource/mcp"' },
    initializeResult: { capabilities: {} }
  });
  const server = http.createServer(handler); let port;
  await new Promise((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, () => { port = server.address().port; resolve(); }));
  try {
    const base = { origin: 'https://127.0.0.1:39458', authorization: token, accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
    assert.equal((await request(port, 'POST', { ...base, origin: 'https://example.invalid' }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }))).status, 404);
    const denied = await request(port, 'POST', { origin: base.origin, accept: base.accept, 'content-type': base['content-type'] }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }));
    assert.equal(denied.status, 401); assert.match(denied.headers['www-authenticate'], /^Bearer resource_metadata=/);
    const initialized = await request(port, 'POST', base, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }));
    assert.equal(initialized.status, 200);
    const sessionHeaders = { ...base, 'mcp-session-id': initialized.headers['mcp-session-id'], 'mcp-protocol-version': '2025-11-25' };
    assert.equal((await request(port, 'POST', sessionHeaders, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).status, 202);
    assert.equal((await request(port, 'GET', sessionHeaders)).status, 200);
    assert.equal((await request(port, 'POST', { ...sessionHeaders, authorization: 'Bearer BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' }, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping', params: {} }))).status, 401);
    assert.equal((await request(port, 'POST', sessionHeaders, JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'notifications/initialized' }))).status, 401);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

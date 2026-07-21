const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const transport = require(path.join(root, 'dist/main/main/mcp/transport/loopbackHttp.js'));
const httpsTransport = require(path.join(root, 'dist/main/main/mcp/transport/httpsOAuthHttp.js'));
const hostModule = require(path.join(root, 'dist/main/main/mcp/server.js'));

function unusedPort() {
  const server = http.createServer();
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  }));
}

function encryptedPfx(directory, passphrase) {
  const file = path.join(directory, 'server.pfx');
  const escaped = file.replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference='Stop'",
    '$key=[System.Security.Cryptography.RSA]::Create(2048)',
    "$request=[System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost',$key,[System.Security.Cryptography.HashAlgorithmName]::SHA256,[System.Security.Cryptography.RSASignaturePadding]::Pkcs1)",
    "$cert=$request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-1),[DateTimeOffset]::UtcNow.AddMinutes(5))",
    `[IO.File]::WriteAllBytes('${escaped}',$cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx,'${passphrase}'))`
  ].join(';');
  childProcess.execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  return fs.readFileSync(file);
}

function httpsRequest(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = https.get({ host: '127.0.0.1', port, path: pathname, rejectUnauthorized: false, headers: { host: `127.0.0.1:${port}` } }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
  });
}

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

test('C14 direct HTTPS host passes the transient PFX passphrase to Node TLS', () => {
  const passphrase = 'test-only-passphrase-that-is-long-enough';
  const options = httpsTransport.localHttpsServerOptions({
    pfx: Uint8Array.from([1, 2, 3]),
    passphrase,
    thumbprint: 'A'.repeat(40),
    notAfter: new Date(Date.now() + 60_000).toISOString(),
    dnsNames: ['localhost'],
    ipAddresses: ['127.0.0.1']
  });
  assert.deepEqual(options.pfx, Buffer.from([1, 2, 3]));
  assert.equal(options.passphrase, passphrase);
  assert.throws(() => httpsTransport.localHttpsServerOptions({ pfx: Uint8Array.from([1]), passphrase: '', dnsNames: ['localhost'], ipAddresses: ['127.0.0.1'] }), /key material is invalid/);
});

test('C14 OAuth continuation accepts browser GET headers without Origin and rejects cross-origin referers', () => {
  const authority = 'https://127.0.0.1:39458';
  assert.equal(httpsTransport.isSameOriginOAuthContinuation({ 'sec-fetch-site': 'same-origin', referer: `${authority}/oauth/authorize?client_id=test` }, authority), true);
  assert.equal(httpsTransport.isSameOriginOAuthContinuation({ 'sec-fetch-site': 'same-origin', origin: authority }, authority), true);
  assert.equal(httpsTransport.isSameOriginOAuthContinuation({ 'sec-fetch-site': 'same-origin', referer: 'https://example.invalid/oauth/authorize' }, authority), false);
  assert.equal(httpsTransport.isSameOriginOAuthContinuation({ 'sec-fetch-site': 'cross-site', origin: authority }, authority), false);
  assert.equal(httpsTransport.isSameOriginOAuthContinuation({ 'sec-fetch-site': 'same-origin' }, authority), false);
});

test('C14 configured direct HTTPS lifecycle verifies the CNG handle and starts Node TLS with an encrypted PFX', { skip: process.platform !== 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-c14-pfx-'));
  const passphrase = 'test-only-passphrase-that-is-long-enough';
  const port = await unusedPort();
  const authority = Object.freeze({ port, authority: `https://127.0.0.1:${port}`, resource: `https://127.0.0.1:${port}/mcp`, issuer: `https://127.0.0.1:${port}`, appInstanceId: '00000000-0000-4000-8000-000000000201', enabled: true, rootCaThumbprint: 'A'.repeat(40), currentUserKeyHandle: 'kaoyan-http-root-test-c14' });
  let verified = 0;
  const controlPlane = {
    httpOAuthAuthority: authority,
    httpOAuthTokens: {},
    registry: { getHttpClient: async () => null, isHttpClientActive: async () => false, getHttpClientScopes: async () => [] },
    externalControlEnabled: async () => true,
    httpAuthenticator: { admitInitialize: async () => null, validateSession: async () => null, invalidateAll: async () => {} }
  };
  const host = hostModule.createConfiguredDirectHttpsOAuthResourceHost({
    controlPlane,
    keyStore: { verify: async (keyName) => { verified += 1; return { keyName, provider: 'Microsoft Software Key Storage Provider', scope: 'CurrentUser', algorithm: 'RSA', exportable: false }; } },
    issueCertificate: async (input) => {
      assert.equal(input.rootThumbprint, authority.rootCaThumbprint);
      assert.equal(input.rootKeyName, authority.currentUserKeyHandle);
      return { pfx: encryptedPfx(directory, passphrase), passphrase, thumbprint: 'B'.repeat(40), notAfter: new Date(Date.now() + 60_000).toISOString(), dnsNames: ['localhost'], ipAddresses: ['127.0.0.1'] };
    }
  });
  assert.ok(host);
  try {
    assert.equal((await host.start()).state, 'ready');
    assert.equal(verified, 1);
    assert.equal(await httpsRequest(port, '/.well-known/oauth-authorization-server'), 200);
  } finally {
    await host.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('C14 direct HTTPS lifecycle stays absent without explicit enabled trust metadata', () => {
  const base = { authority: 'https://127.0.0.1:39458', resource: 'https://127.0.0.1:39458/mcp', issuer: 'https://127.0.0.1:39458', port: 39458, appInstanceId: '00000000-0000-4000-8000-000000000202', enabled: false };
  const controlPlane = { httpOAuthAuthority: base };
  assert.equal(hostModule.createConfiguredDirectHttpsOAuthResourceHost({ controlPlane }), undefined);
  assert.equal(hostModule.directHttpsDisabledReason(base), 'not_enabled');
  assert.equal(hostModule.directHttpsDisabledReason({ ...base, enabled: true }), 'trust_not_authorized');
});

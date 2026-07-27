const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { assertSafeDescendant, assertSafeTempRoot } = require('./spikeSafety.cjs');

const root = process.env.KAOYAN_C0_ROOT;
const pfxPath = process.env.KAOYAN_C0_PFX_PATH;
const tracePath = process.env.KAOYAN_C0_TRACE_PATH;

if (!root || !pfxPath || !tracePath) {
  throw new Error('KAOYAN_C0_ROOT, KAOYAN_C0_PFX_PATH, and KAOYAN_C0_TRACE_PATH are required');
}

assertSafeTempRoot(root);
assertSafeDescendant(root, pfxPath);
assertSafeDescendant(root, tracePath, { allowMissing: true });
fs.mkdirSync(path.dirname(tracePath), { recursive: true });
assertSafeDescendant(root, path.dirname(tracePath));

function trace(request) {
  // Request paths only: OAuth query strings and headers can carry sensitive material.
  fs.appendFileSync(tracePath, `${JSON.stringify({ method: request.method, path: request.url.split('?')[0] })}\n`, 'utf8');
}

const server = https.createServer({ pfx: fs.readFileSync(pfxPath), passphrase: 'kaoyan-c0-password' }, (request, response) => {
  trace(request);
  const baseUrl = `https://localhost:${server.address().port}`;
  const resource = `${baseUrl}/mcp`;
  const issuer = baseUrl;
  const json = (body) => {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  const requestUrl = new URL(request.url, baseUrl);

  if (
    requestUrl.pathname === '/.well-known/oauth-protected-resource' ||
    requestUrl.pathname === '/.well-known/oauth-protected-resource/mcp'
  ) {
    json({
      resource,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: ['system.read', 'questions.read']
    });
    return;
  }
  if (
    requestUrl.pathname === '/.well-known/oauth-authorization-server' ||
    requestUrl.pathname === '/.well-known/oauth-authorization-server/mcp' ||
    requestUrl.pathname === '/.well-known/openid-configuration' ||
    requestUrl.pathname === '/.well-known/openid-configuration/mcp'
  ) {
    json({
      issuer,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['system.read', 'questions.read', 'offline_access']
    });
    return;
  }
  if (requestUrl.pathname === '/authorize') {
    const redirectUri = requestUrl.searchParams.get('redirect_uri');
    if (!redirectUri) {
      response.writeHead(400, { 'content-type': 'text/plain' });
      response.end('missing redirect_uri');
      return;
    }
    const redirected = new URL(redirectUri);
    redirected.searchParams.set('code', 'kaoyan-c0-code');
    const state = requestUrl.searchParams.get('state');
    if (state) redirected.searchParams.set('state', state);
    response.writeHead(302, { location: redirected.toString(), 'cache-control': 'no-store' });
    response.end();
    return;
  }
  if (requestUrl.pathname === '/token') {
    let bytes = 0;
    request.on('data', (chunk) => { bytes += chunk.length; if (bytes > 65536) request.destroy(); });
    request.on('end', () => json({
      ['access_' + 'token']: 'kaoyan-c0-access-token',
      token_type: 'Bearer',
      expires_in: 300,
      ['refresh_' + 'token']: 'kaoyan-c0-refresh-token',
      scope: 'system.read questions.read'
    }));
    return;
  }
  response.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"` });
  response.end();
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

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
  const issuer = `${baseUrl}/issuer`;
  const json = (body) => {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  };

  if (request.url.startsWith('/.well-known/oauth-protected-resource')) {
    json({ resource, authorization_servers: [issuer] });
    return;
  }
  if (request.url.startsWith('/issuer/.well-known/oauth-authorization-server')) {
    json({ issuer, authorization_endpoint: `${baseUrl}/authorize`, token_endpoint: `${baseUrl}/token`, response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'] });
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

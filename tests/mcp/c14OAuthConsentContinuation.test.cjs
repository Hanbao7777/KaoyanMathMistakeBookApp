const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const contracts = require(path.join(root, 'dist/main/shared/mcp/v1/oauthContracts.js'));
const metadataModule = require(path.join(root, 'dist/main/main/mcp/auth/oauthMetadata.js'));
const tokenModule = require(path.join(root, 'dist/main/main/mcp/auth/oauthTokenStore.js'));
const oauthModule = require(path.join(root, 'dist/main/main/mcp/auth/oauthAuthorizationServer.js'));

function cookieValue(setCookie) { return /^[^=]+=([^;]+)/.exec(setCookie)[1]; }

test('C14 consent continuation requires its capability, delays code delivery, and consumes exactly once', async () => {
  const authority = contracts.directHttpsAuthority(39458);
  const client = { clientId: 'kaoyan-codex-local', product: 'codex', versionEvidence: 'test', redirectMode: 'codex-loopback', resource: authority.resource, issuer: authority.issuer, allowedScopes: ['system.read'], trust: 'observer', refreshTokensAllowed: false };
  const server = new oauthModule.LocalOAuthAuthorizationServer({ metadata: metadataModule.createOAuthMetadata({ authority }), tokenStore: new tokenModule.OAuthTokenStore(), clients: { getHttpClient: async () => client, isHttpClientActive: async () => true }, appInstanceId: 'app' });
  const verifier = crypto.randomBytes(32).toString('base64url');
  const result = await server.authorize(new URLSearchParams({ response_type: 'code', client_id: client.clientId, redirect_uri: 'http://127.0.0.1:39111/callback/test', scope: 'system.read', state: 'opaque-state', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: authority.resource }));
  assert.equal(result.status, 202);
  const requestId = server.listPending()[0].requestId;
  const capability = cookieValue(result.headers['set-cookie']);
  assert.equal(server.status(requestId, 'wrong').status, 404);
  assert.equal(server.status(requestId, capability).body.status, 'pending');
  await server.decidePending(requestId, 'approve');
  assert.equal(server.status(requestId, capability).body.status, 'ready');
  const continuation = server.continue(requestId, capability);
  assert.equal(continuation.status, 302);
  assert.equal(new URL(continuation.headers.location).searchParams.get('state'), 'opaque-state');
  assert.equal(server.continue(requestId, capability).status, 410);
});

test('C14 concurrent consent decisions are one-use and audit failure leaves no authorization code', async () => {
  const authority = contracts.directHttpsAuthority(39458);
  const client = { clientId: 'kaoyan-codex-local', product: 'codex', versionEvidence: 'test', redirectMode: 'codex-loopback', resource: authority.resource, issuer: authority.issuer, allowedScopes: ['system.read'], trust: 'observer', refreshTokensAllowed: false };
  const store = new tokenModule.OAuthTokenStore();
  const server = new oauthModule.LocalOAuthAuthorizationServer({ metadata: metadataModule.createOAuthMetadata({ authority }), tokenStore: store, clients: { getHttpClient: async () => client, isHttpClientActive: async () => true }, appInstanceId: 'app' });
  server.setConsentObserver({ pending: async () => {}, decided: async () => { throw new Error('audit unavailable'); }, invalidated: async () => {} });
  const request = new URLSearchParams({ response_type: 'code', client_id: client.clientId, redirect_uri: 'http://127.0.0.1:39111/callback/test', scope: 'system.read', state: 'opaque-state', code_challenge: 'A'.repeat(43), code_challenge_method: 'S256', resource: authority.resource });
  const result = await server.authorize(request);
  const requestId = server.listPending()[0].requestId;
  await assert.rejects(server.decidePending(requestId, 'approve'), /audit unavailable/);
  assert.equal(store.snapshot().codes.length, 0);
  assert.equal(server.status(requestId, cookieValue(result.headers['set-cookie'])).body.status, 'pending');

  server.setConsentObserver(undefined);
  const decisions = await Promise.allSettled([server.decidePending(requestId, 'approve'), server.decidePending(requestId, 'approve')]);
  assert.equal(decisions.filter((value) => value.status === 'fulfilled').length, 1);
  assert.equal(store.snapshot().codes.length, 1);
});

test('C14 concurrent browser authorizations keep request-scoped capability cookies', async () => {
  const authority = contracts.directHttpsAuthority(39458);
  const client = { clientId: 'kaoyan-codex-local', product: 'codex', versionEvidence: 'test', redirectMode: 'codex-loopback', resource: authority.resource, issuer: authority.issuer, allowedScopes: ['system.read'], trust: 'observer', refreshTokensAllowed: false };
  const server = new oauthModule.LocalOAuthAuthorizationServer({ metadata: metadataModule.createOAuthMetadata({ authority }), tokenStore: new tokenModule.OAuthTokenStore(), clients: { getHttpClient: async () => client, isHttpClientActive: async () => true }, appInstanceId: 'app' });
  const authorize = (suffix) => server.authorize(new URLSearchParams({ response_type: 'code', client_id: client.clientId, redirect_uri: `http://127.0.0.1:39111/callback/${suffix}`, scope: 'system.read', state: `state-${suffix}`, code_challenge: 'A'.repeat(43), code_challenge_method: 'S256', resource: authority.resource }));
  const first = await authorize('first');
  const second = await authorize('second');
  assert.notEqual(first.headers['set-cookie'].split('=')[0], second.headers['set-cookie'].split('=')[0]);
  const [firstPending, secondPending] = server.listPending();
  await server.decidePending(firstPending.requestId, 'approve');
  await server.decidePending(secondPending.requestId, 'deny');
  assert.equal(server.continue(firstPending.requestId, cookieValue(first.headers['set-cookie'])).status, 302);
  assert.equal(server.continue(secondPending.requestId, cookieValue(second.headers['set-cookie'])).status, 302);
});

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const contracts = require(path.join(root, 'dist/main/shared/mcp/v1/oauthContracts.js'));
const metadataModule = require(path.join(root, 'dist/main/main/mcp/auth/oauthMetadata.js'));
const authServerModule = require(path.join(root, 'dist/main/main/mcp/auth/oauthAuthorizationServer.js'));
const tokenModule = require(path.join(root, 'dist/main/main/mcp/auth/oauthTokenStore.js'));

const authority = contracts.directHttpsAuthority(39458);
const redirect = 'http://127.0.0.1:1/callback/nonce_1';
const client = {
  clientId: 'kaoyan-codex-local', product: 'codex', versionEvidence: 'codex-cli 0.144.3',
  redirectMode: 'codex-loopback', resource: authority.resource, issuer: authority.issuer,
  allowedScopes: ['system.read'], trust: 'observer', refreshTokensAllowed: true
};

test('C14 metadata and authority values are exact and secret-free', () => {
  const metadata = metadataModule.createOAuthMetadata({ authority });
  assert.equal(metadata.authority.resource, 'https://127.0.0.1:39458/mcp');
  assert.equal(metadata.authorizationServer.issuer, authority.issuer);
  assert.deepEqual(metadata.authorizationServer.code_challenge_methods_supported, ['S256']);
  assert.equal(metadataModule.bearerChallenge(metadata).includes('resource_metadata="'), true);
  assert.doesNotThrow(() => contracts.validateProtectedResourceMetadata(metadata.protectedResource));
  assert.doesNotThrow(() => contracts.validateAuthorizationServerMetadata(metadata.authorizationServer));
  assert.equal(JSON.stringify(metadata).match(/privateKey|code_verifier|client_secret/i), null);
});

test('C14 metadata can advertise a bounded initial OAuth scope lane', () => {
  const metadata = metadataModule.createOAuthMetadata({ authority, scopes: ['system.read'] });
  assert.deepEqual(metadata.protectedResource.scopes_supported, ['system.read']);
  assert.deepEqual(metadata.authorizationServer.scopes_supported, ['system.read']);
});

test('C14 validators reject unknown fields, duplicate scopes, weak PKCE, missing resource, and malformed redirects', () => {
  const base = { response_type: 'code', client_id: client.clientId, redirect_uri: redirect, scope: 'system.read', state: 'state', code_challenge: 'A'.repeat(43), code_challenge_method: 'S256', resource: authority.resource };
  assert.doesNotThrow(() => contracts.validateAuthorizationRequest(base));
  assert.throws(() => contracts.validateAuthorizationRequest({ ...base, extra: true }), /invalid/i);
  assert.throws(() => contracts.validateAuthorizationRequest({ ...base, scope: 'system.read system.read' }), /invalid/i);
  assert.throws(() => contracts.validateAuthorizationRequest({ ...base, code_challenge_method: 'plain' }), /invalid/i);
  assert.throws(() => contracts.validateAuthorizationRequest({ ...base, resource: undefined }), /invalid/i);
  for (const value of ['http://127.0.0.1:0/callback/x', 'http://127.0.0.1:65536/callback/x', 'http://localhost:1/callback/x', 'http://127.0.0.1:1/callback/x/extra', 'http://127.0.0.1:1/callback/%2Fx', 'https://127.0.0.1:1/callback/x']) assert.throws(() => contracts.validateCodexRedirectUri(value), /invalid/i);
  assert.doesNotThrow(() => contracts.validateCodexRedirectUri('http://127.0.0.1:65535/callback/x'));
  assert.throws(() => contracts.validateHttpOAuthClientRegistration({ ...client, redirectMode: 'claude-exact', exactRedirectUri: 'http://localhost:39457/callback?extra=1' }), /invalid/i);
});

test('C14 authorization code, PKCE S256, resource binding, refresh rotation, and reuse detection are enforced', async () => {
  let counter = 0;
  const store = new tokenModule.OAuthTokenStore({ now: () => new Date('2026-07-21T00:00:00.000Z'), randomUUID: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`, randomBytes: (size) => Buffer.alloc(size, counter) });
  const clients = { getHttpClient: async (id) => id === client.clientId ? client : null, isHttpClientActive: async () => true, currentScopes: async () => client.allowedScopes };
  const metadata = metadataModule.createOAuthMetadata({ authority });
  const server = new authServerModule.LocalOAuthAuthorizationServer({ metadata, tokenStore: store, clients, appInstanceId: 'app-one', consent: () => true, now: () => new Date('2026-07-21T00:00:00.000Z') });
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorization = await server.authorize(new URLSearchParams({ response_type: 'code', client_id: client.clientId, redirect_uri: redirect, scope: 'system.read', state: 'state-1', code_challenge: challenge, code_challenge_method: 'S256', resource: authority.resource }));
  assert.equal(authorization.status, 302);
  const location = new URL(authorization.headers.location);
  assert.equal(location.searchParams.get('state'), 'state-1');
  const token = await server.token(new URLSearchParams({ grant_type: 'authorization_code', code: location.searchParams.get('code'), client_id: client.clientId, redirect_uri: redirect, code_verifier: verifier, resource: authority.resource }));
  assert.equal(token.status, 200);
  assert.equal(token.body.token_type, 'Bearer');
  assert.equal(token.body.scope, 'system.read');
  assert.ok(token.body.refresh_token);
  assert.notEqual(store.snapshot().accessTokens[0].tokenHash, token.body.access_token);
  assert.equal((await server.token(new URLSearchParams({ grant_type: 'authorization_code', code: location.searchParams.get('code'), client_id: client.clientId, redirect_uri: redirect, code_verifier: verifier, resource: authority.resource }))).body.error, 'invalid_grant');
  const rotated = await server.token(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.body.refresh_token, client_id: client.clientId, resource: authority.resource }));
  assert.equal(rotated.status, 200);
  const reused = await server.token(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.body.refresh_token, client_id: client.clientId, resource: authority.resource }));
  assert.equal(reused.body.error, 'invalid_grant');
  assert.throws(() => store.validateAccessToken(rotated.body.access_token, { resource: 'https://127.0.0.1:39459/mcp', issuer: authority.issuer, appInstanceId: 'app-one' }), /invalid_token/);
});

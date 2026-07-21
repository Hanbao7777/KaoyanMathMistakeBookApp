const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../..');
const authModule = require(path.join(root, 'dist/main/main/mcp/auth/httpBearerAuthenticator.js'));
const tokenModule = require(path.join(root, 'dist/main/main/mcp/auth/oauthTokenStore.js'));
const contracts = require(path.join(root, 'dist/main/shared/mcp/v1/oauthContracts.js'));

test('C14 HTTP bearer authenticator emits only an immutable AgentPrincipal and rejects token/session mixing', async () => {
  const authority = contracts.directHttpsAuthority(39458); let uuid = 0;
  const store = new tokenModule.OAuthTokenStore({ randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` });
  const verifier = 'A'.repeat(43); const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const code = await store.createAuthorizationCode({ clientId: 'kaoyan-codex-local', redirectUri: 'http://127.0.0.1:1/callback/x', resource: authority.resource, issuer: authority.issuer, scopes: ['system.read'], codeChallenge: challenge, appInstanceId: 'instance', refreshTokensAllowed: false });
  const issued = await store.redeemAuthorizationCode({ grant_type: 'authorization_code', code: code.code, client_id: 'kaoyan-codex-local', redirect_uri: 'http://127.0.0.1:1/callback/x', code_verifier: verifier, resource: authority.resource });
  const clients = { getHttpClient: async () => ({ clientId: 'kaoyan-codex-local', subjectId: 'subject', displayName: 'Codex', scopes: ['system.read'], trust: 'observer' }) };
  const authenticator = new authModule.HttpBearerAuthenticator({ tokenStore: store, clients, authority, appInstanceId: 'instance', randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` });
  const headers = { authorization: `Bearer ${issued.response.access_token}` };
  const admission = await authenticator.admitInitialize({ headers, protocolVersion: '2025-11-25' });
  assert.ok(admission);
  const principal = await authenticator.validateSession(admission.sessionId, '2025-11-25', headers);
  assert.equal(principal.clientId, 'kaoyan-codex-local'); assert.equal(principal.credentialBinding.startsWith('sha256-v1:'), true); assert.equal(Object.isFrozen(principal), true); assert.equal(principal.renderer, false);
  assert.equal(await authenticator.validateSession(admission.sessionId, '2025-11-25', { authorization: 'Bearer BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' }), null);
  assert.equal(await authenticator.validateSession(admission.sessionId, '2025-11-25', headers), null);
});

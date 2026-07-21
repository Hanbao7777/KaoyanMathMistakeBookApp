const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const test = require('node:test');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const bootstrap = environment.requireMain('agent/bootstrap.js');
const tokenModule = environment.requireMain('mcp/auth/oauthTokenStore.js');
const contracts = require(`${environment.projectRoot}/dist/main/shared/mcp/v1/oauthContracts.js`);

test.beforeEach(() => environment.resetControlPlaneEnvironment());
test.after(() => environment.cleanupControlPlaneRoot());

test('C14 OAuth authorization and token state survives registry persistence without raw OAuth material', async () => {
  const registry = (await bootstrap.bootstrapAgentB3({ coordinator: await environment.databaseService.getDatabaseCoordinator(), appInstanceId: 'c14-persist', credentialVerifier: { verify: () => ({ credentialFingerprint: 'sha256-v1:' + 'c'.repeat(64), sessionFingerprint: 'sha256-v1:' + 'd'.repeat(64) }) }, cursorSecret: 'p'.repeat(32), now: () => '2026-07-21T00:00:00.000Z' })).registry;
  const authority = contracts.directHttpsAuthority(39458);
  await registry.registerHttpClient({ clientId: 'kaoyan-codex-local', product: 'codex', versionEvidence: 'codex-cli 0.144.3', redirectMode: 'codex-loopback', resource: authority.resource, issuer: authority.issuer, allowedScopes: ['system.read'], trust: 'observer', refreshTokensAllowed: true });
  const store = new tokenModule.OAuthTokenStore({ randomBytes: (size) => Buffer.alloc(size, 7), persist: (snapshot) => registry.persistOAuthTokenSnapshot(snapshot) });
  const verifier = 'B'.repeat(43); const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const code = await store.createAuthorizationCode({ clientId: 'kaoyan-codex-local', redirectUri: 'http://127.0.0.1:1/callback/x', resource: authority.resource, issuer: authority.issuer, scopes: ['system.read'], codeChallenge: challenge, appInstanceId: 'c14-persist', refreshTokensAllowed: true });
  const database = await environment.databaseService.getDatabase();
  const rawDatabase = Buffer.from(database.export()).toString('utf8');
  assert.equal(rawDatabase.includes(code.code), false); assert.equal(rawDatabase.includes(verifier), false); assert.match(rawDatabase, /sha256-v1:/);
  const snapshot = await registry.loadOAuthTokenSnapshot();
  assert.equal(snapshot.codes.length, 1); assert.equal(snapshot.codes[0].codeHash.includes(code.code), false);
  const reopened = new tokenModule.OAuthTokenStore({ load: () => snapshot });
  assert.equal(reopened.snapshot().codes.length, 1);
});

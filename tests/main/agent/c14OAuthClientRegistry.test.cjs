const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const bootstrap = environment.requireMain('agent/bootstrap.js');
const contracts = require(`${environment.projectRoot}/dist/main/shared/mcp/v1/oauthContracts.js`);

test.beforeEach(() => environment.resetControlPlaneEnvironment());
test.after(() => environment.cleanupControlPlaneRoot());

test('C14 HTTP client registration persists exact product bindings and rejects scope widening by the client', async () => {
  const composition = await bootstrap.bootstrapAgentB3({ coordinator: await environment.databaseService.getDatabaseCoordinator(), appInstanceId: 'c14-registry', credentialVerifier: { verify: () => ({ credentialFingerprint: 'sha256-v1:' + 'a'.repeat(64), sessionFingerprint: 'sha256-v1:' + 'b'.repeat(64) }) }, cursorSecret: 'x'.repeat(32), now: () => '2026-07-21T00:00:00.000Z' });
  const authority = contracts.directHttpsAuthority(39458);
  const registration = { clientId: 'kaoyan-codex-local', product: 'codex', versionEvidence: 'codex-cli 0.144.3', redirectMode: 'codex-loopback', resource: authority.resource, issuer: authority.issuer, allowedScopes: ['system.read'], trust: 'observer', refreshTokensAllowed: true };
  assert.deepEqual(await composition.registry.registerHttpClient(registration), registration);
  assert.deepEqual(await composition.registry.getHttpClient(registration.clientId), registration);
  await assert.rejects(composition.registry.registerHttpClient({ ...registration, clientId: 'kaoyan-codex-second', allowedScopes: ['system.read', 'not-a-real-scope'] }), (error) => error.code === 'VALIDATION_ERROR');
  await composition.registry.updateClientAccess(registration.clientId, ['system.read'], 'observer');
  await composition.registry.initializeHttpOAuthAuthority({ appInstanceId: 'c14-registry' });
  assert.equal((await composition.registry.getHttpOAuthAuthority()).port, 39458);
});

test('C14 fixed HTTP client registration is idempotent and never revives revoked clients', async () => {
  const composition = await bootstrap.bootstrapAgentB3({ coordinator: await environment.databaseService.getDatabaseCoordinator(), appInstanceId: 'c14-fixed-registry', credentialVerifier: { verify: () => ({ credentialFingerprint: 'sha256-v1:' + 'a'.repeat(64), sessionFingerprint: 'sha256-v1:' + 'b'.repeat(64) }) }, cursorSecret: 'x'.repeat(32), now: () => '2026-07-21T00:00:00.000Z' });
  const authority = contracts.directHttpsAuthority(39458);
  const registration = { clientId: 'kaoyan-claude-local', product: 'claude_code', versionEvidence: '2.1.216 (Claude Code)', redirectMode: 'claude-exact', exactRedirectUri: 'http://localhost:39457/callback', resource: authority.resource, issuer: authority.issuer, allowedScopes: ['system.read'], trust: 'observer', refreshTokensAllowed: true };
  await composition.registry.ensureHttpClient(registration);
  await composition.registry.ensureHttpClient(registration);
  assert.deepEqual(await composition.registry.getHttpClient(registration.clientId), registration);
  const userConfiguredAccess = {
    allowedScopes: ['questions.read', 'questions.write', 'system.read'],
    trust: 'full_control'
  };
  await composition.registry.updateClientAccess(registration.clientId, userConfiguredAccess.allowedScopes, userConfiguredAccess.trust);
  await composition.registry.ensureHttpClient(registration);
  assert.deepEqual(await composition.registry.getHttpClient(registration.clientId), {
    ...registration,
    ...userConfiguredAccess
  });
  await assert.rejects(composition.registry.ensureHttpClient({ ...registration, exactRedirectUri: 'http://localhost:39456/callback' }), (error) => error.code === 'RECOVERY_FENCE');
  await composition.registry.revokeClient(registration.clientId);
  await composition.registry.ensureHttpClient(registration);
  assert.equal(await composition.registry.getHttpClient(registration.clientId), null);
});

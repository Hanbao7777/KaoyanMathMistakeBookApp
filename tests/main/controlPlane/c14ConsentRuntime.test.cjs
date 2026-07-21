const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const bootstrap = environment.requireMain('agent/bootstrap.js');
const coordinatorModule = environment.requireMain('persistence/databaseCoordinator.js');
const controllerModule = environment.requireMain('mcp/runtime/directHttpsOAuthController.js');
const oauthModule = environment.requireMain('mcp/auth/oauthAuthorizationServer.js');
const tokenModule = environment.requireMain('mcp/auth/oauthTokenStore.js');
const metadataModule = environment.requireMain('mcp/auth/oauthMetadata.js');
const contracts = require(path.join(environment.projectRoot, 'dist/main/shared/mcp/v1/oauthContracts.js'));

test.beforeEach(() => environment.resetControlPlaneEnvironment());
test.after(() => environment.cleanupControlPlaneRoot());

async function composition() {
  const coordinator = await environment.databaseService.getDatabaseCoordinator();
  const value = await bootstrap.bootstrapAgentB3({
    coordinator,
    appInstanceId: 'c14-runtime-test',
    credentialVerifier: { verify: () => ({ credentialFingerprint: `sha256-v1:${'c'.repeat(64)}`, sessionFingerprint: `sha256-v1:${'d'.repeat(64)}` }) },
    cursorSecret: 'c'.repeat(32),
    now: () => '2026-01-01T00:00:00.000Z'
  });
  const capability = coordinatorModule.createDatabaseCoordinatorControlCapability(coordinator);
  return { ...value, executeControlWrite: (request) => coordinator.executeControlWrite(capability, request) };
}

function auditStub() {
  const append = () => ({ sequence: 0 });
  return {
    appendAdmissionInTransaction: append,
    appendWorkflowControlInTransaction: append,
    appendTerminalSuccessInTransaction: append,
    appendTerminalFailureInTransaction: append,
    appendReconciliationInTransaction: append,
    appendIndeterminateInTransaction: append
  };
}

test('C14 trust saga persists issued metadata, finalizes atomically, and removes the exact root', async () => {
  const controlPlane = await composition();
  const authority = await controlPlane.registry.getHttpOAuthAuthority();
  const keyName = 'kaoyan-http-root-00000000000040008000000000000001';
  const thumbprint = 'A'.repeat(40);
  const material = { der: Buffer.alloc(256, 7), thumbprint, notAfter: '2099-01-01T00:00:00.000Z', subject: 'CN=Kaoyan Local HTTPS Root 00000000' };
  let rootCount = 0;
  let started = 0;
  let stopped = 0;
  const key = { keyName, provider: 'Microsoft Software Key Storage Provider', scope: 'CurrentUser', algorithm: 'RSA', exportable: false };
  await controlPlane.registry.registerHttpClient({ clientId: 'kaoyan-codex-local', product: 'codex', versionEvidence: 'test', redirectMode: 'codex-loopback', resource: authority.resource, issuer: authority.issuer, allowedScopes: ['system.read'], trust: 'observer', refreshTokensAllowed: false });
  const tokenStore = new tokenModule.OAuthTokenStore({ persistAuthorizationCode: (code) => controlPlane.registry.persistOAuthAuthorizationCode(code), deleteAuthorizationCode: (codeHash) => controlPlane.registry.deleteOAuthAuthorizationCode(codeHash) });
  const oauth = new oauthModule.LocalOAuthAuthorizationServer({ metadata: metadataModule.createOAuthMetadata({ authority }), tokenStore, appInstanceId: authority.appInstanceId, clients: { getHttpClient: (clientId) => controlPlane.registry.getHttpClient(clientId), isHttpClientActive: (clientId) => controlPlane.registry.isHttpClientActive(clientId) } });
  const controller = new controllerModule.DirectHttpsOAuthController({
    authority: () => controlPlane.registry.getHttpOAuthAuthority(),
    updateAuthority: (value) => controlPlane.registry.updateHttpOAuthAuthority(value),
    updateAuthorityInTransaction: (db, scope, value) => controlPlane.registry.updateHttpOAuthAuthorityInTransaction(db, scope, value),
    executeControlWrite: controlPlane.executeControlWrite,
    audit: auditStub(),
    keyStore: { async create() { return key; }, async verify() { return key; } },
    issuer: { async issue() { return material; }, async verify() {} },
    roots: { async install() { rootCount += 1; }, async remove() { rootCount -= 1; }, async count() { return rootCount; } },
    oauth,
    createHost: () => ({ async start() { started += 1; }, async stop() { stopped += 1; }, status() { return { state: 'ready', authority, resource: authority.resource, issuer: authority.issuer, appInstanceId: authority.appInstanceId }; } })
  });
  const context = { webContentsId: 42, navigationGeneration: 0 };
  const intent = await controller.prepareTrustInstall(context);
  const database = await environment.databaseService.getDatabase();
  const statement = database.prepare('SELECT certificate_der, certificate_not_after, subject, status FROM agent_https_trust_intents WHERE intent_id = ?');
  statement.bind([intent.intentId]);
  assert.equal(statement.step(), true);
  const row = statement.getAsObject();
  statement.free();
  assert.equal(Buffer.from(row.certificate_der).length, material.der.length);
  assert.equal(row.certificate_not_after, material.notAfter);
  assert.equal(row.subject, material.subject);
  assert.equal(row.status, 'pending');
  await controller.confirmTrustInstall(intent.intentId, true, context);
  assert.equal(rootCount, 1);
  assert.equal(started, 1);
  assert.equal((await controlPlane.registry.getHttpOAuthAuthority()).enabled, true);
  const authorization = await oauth.authorize(new URLSearchParams({ response_type: 'code', client_id: 'kaoyan-codex-local', redirect_uri: 'http://127.0.0.1:39111/callback/test', scope: 'system.read', state: 'consent-state', code_challenge: 'A'.repeat(43), code_challenge_method: 'S256', resource: authority.resource }));
  assert.equal(authorization.status, 202);
  const consent = controller.listPendingConsent()[0];
  await controller.decideConsent(consent.requestId, 'approve', context);
  const consentDatabase = await environment.databaseService.getDatabase();
  assert.equal(consentDatabase.exec('SELECT status FROM agent_oauth_pending_consents WHERE request_id = "' + consent.requestId + '"')[0].values[0][0], 'approved');
  assert.equal(consentDatabase.exec('SELECT COUNT(*) FROM agent_oauth_authorization_codes')[0].values[0][0], 1);
  const removal = await controller.prepareTrustRemoval(context);
  await controller.confirmTrustRemoval(removal.intentId, true, context);
  assert.equal(rootCount, 0);
  assert.equal((await controlPlane.registry.getHttpOAuthAuthority()).enabled, false);
  assert.ok(stopped >= 1);
});

test('C14 trust confirmation rejects a stale navigation generation before any root mutation', async () => {
  const controlPlane = await composition();
  const authority = await controlPlane.registry.getHttpOAuthAuthority();
  const oauth = new oauthModule.LocalOAuthAuthorizationServer({ metadata: metadataModule.createOAuthMetadata({ authority }), tokenStore: controlPlane.httpOAuthTokens, appInstanceId: authority.appInstanceId, clients: { getHttpClient: () => null } });
  let installs = 0;
  const controller = new controllerModule.DirectHttpsOAuthController({
    authority: () => controlPlane.registry.getHttpOAuthAuthority(),
    updateAuthority: (value) => controlPlane.registry.updateHttpOAuthAuthority(value),
    updateAuthorityInTransaction: (db, scope, value) => controlPlane.registry.updateHttpOAuthAuthorityInTransaction(db, scope, value),
    executeControlWrite: controlPlane.executeControlWrite,
    audit: auditStub(),
    keyStore: { async create(keyName) { return { keyName, provider: 'Microsoft Software Key Storage Provider', scope: 'CurrentUser', algorithm: 'RSA', exportable: false }; }, async verify(keyName) { return { keyName, provider: 'Microsoft Software Key Storage Provider', scope: 'CurrentUser', algorithm: 'RSA', exportable: false }; } },
    issuer: { async issue() { return { der: Buffer.alloc(256), thumbprint: 'B'.repeat(40), notAfter: '2099-01-01T00:00:00.000Z', subject: 'CN=Kaoyan Local HTTPS Root 00000000' }; }, async verify() {} },
    roots: { async install() { installs += 1; }, async remove() {}, async count() { return 0; } },
    oauth,
    createHost: () => undefined
  });
  const intent = await controller.prepareTrustInstall({ webContentsId: 7, navigationGeneration: 3 });
  await assert.rejects(controller.confirmTrustInstall(intent.intentId, true, { webContentsId: 7, navigationGeneration: 4 }), /trust_intent_invalid/);
  assert.equal(installs, 0);
});

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
  let createdKeyName = '';
  const thumbprint = 'A'.repeat(40);
  const material = { der: Buffer.alloc(256, 7), thumbprint, notAfter: '2099-01-01T00:00:00.000Z', subject: 'CN=Kaoyan Local HTTPS Root 00000000' };
  let rootCount = 0;
  let started = 0;
  let stopped = 0;
  const removedMyCertificates = [];
  const removedKeys = [];
  const key = () => ({ keyName: createdKeyName, provider: 'Microsoft Software Key Storage Provider', scope: 'CurrentUser', algorithm: 'RSA', exportable: false });
  await controlPlane.registry.registerHttpClient({ clientId: 'kaoyan-codex-local', product: 'codex', versionEvidence: 'test', redirectMode: 'codex-loopback', resource: authority.resource, issuer: authority.issuer, allowedScopes: ['system.read'], trust: 'observer', refreshTokensAllowed: false });
  const tokenStore = new tokenModule.OAuthTokenStore({ persistAuthorizationCode: (code) => controlPlane.registry.persistOAuthAuthorizationCode(code), deleteAuthorizationCode: (codeHash) => controlPlane.registry.deleteOAuthAuthorizationCode(codeHash) });
  const oauth = new oauthModule.LocalOAuthAuthorizationServer({ metadata: metadataModule.createOAuthMetadata({ authority }), tokenStore, appInstanceId: authority.appInstanceId, clients: { getHttpClient: (clientId) => controlPlane.registry.getHttpClient(clientId), isHttpClientActive: (clientId) => controlPlane.registry.isHttpClientActive(clientId) } });
  const controller = new controllerModule.DirectHttpsOAuthController({
    authority: () => controlPlane.registry.getHttpOAuthAuthority(),
    updateAuthority: (value) => controlPlane.registry.updateHttpOAuthAuthority(value),
    updateAuthorityInTransaction: (db, scope, value) => controlPlane.registry.updateHttpOAuthAuthorityInTransaction(db, scope, value),
    executeControlWrite: controlPlane.executeControlWrite,
    audit: auditStub(),
    keyStore: { async create(value) { createdKeyName = value; return key(); }, async verify() { return key(); }, async remove(value) { removedKeys.push(value); } },
    issuer: { async issue() { return material; }, async verify() {}, async remove(value) { removedMyCertificates.push(value); } },
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
  assert.deepEqual(removedMyCertificates, [thumbprint]);
  assert.deepEqual(removedKeys, [createdKeyName]);
  assert.equal((await controlPlane.registry.getHttpOAuthAuthority()).enabled, false);
  assert.ok(stopped >= 1);
});

test('C14 trust removal fails closed when My or CNG cleanup fails', async () => {
  const controlPlane = await composition();
  const initial = await controlPlane.registry.getHttpOAuthAuthority();
  const thumbprint = 'E'.repeat(40);
  const keyName = 'kaoyan-http-root-removal-failure';
  await controlPlane.registry.updateHttpOAuthAuthority({ ...initial, rootCaThumbprint: thumbprint, currentUserKeyHandle: keyName, enabled: true });
  const oauth = new oauthModule.LocalOAuthAuthorizationServer({ metadata: metadataModule.createOAuthMetadata({ authority: initial }), tokenStore: controlPlane.httpOAuthTokens, appInstanceId: initial.appInstanceId, clients: { getHttpClient: () => null } });
  let failKeyCleanup = true;
  const removedKeys = [];
  const controller = new controllerModule.DirectHttpsOAuthController({
    authority: () => controlPlane.registry.getHttpOAuthAuthority(),
    updateAuthority: (value) => controlPlane.registry.updateHttpOAuthAuthority(value),
    updateAuthorityInTransaction: (db, scope, value) => controlPlane.registry.updateHttpOAuthAuthorityInTransaction(db, scope, value),
    executeControlWrite: controlPlane.executeControlWrite,
    audit: auditStub(),
    keyStore: { async create() { throw new Error('unused'); }, async verify() { throw new Error('unused'); }, async remove(value) { if (failKeyCleanup) throw new Error('cng_cleanup_failed'); removedKeys.push(value); } },
    issuer: { async issue() { throw new Error('unused'); }, async verify() {}, async remove() {} },
    roots: { async install() {}, async remove() {}, async count() { return 0; } },
    oauth,
    createHost: () => undefined
  });
  const context = { webContentsId: 11, navigationGeneration: 0 };
  const removal = await controller.prepareTrustRemoval(context);
  await assert.rejects(controller.confirmTrustRemoval(removal.intentId, true, context), /cng_cleanup_failed/);
  const authority = await controlPlane.registry.getHttpOAuthAuthority();
  assert.equal(authority.enabled, true);
  assert.equal(authority.rootCaThumbprint, thumbprint);
  assert.equal(authority.currentUserKeyHandle, keyName);
  const database = await environment.databaseService.getDatabase();
  assert.equal(database.exec(`SELECT status FROM agent_https_trust_intents WHERE intent_id = '${removal.intentId}'`)[0].values[0][0], 'recovery_required');

  failKeyCleanup = false;
  await controller.reconcile();
  const recoveredAuthority = await controlPlane.registry.getHttpOAuthAuthority();
  assert.equal(recoveredAuthority.enabled, false);
  assert.equal(recoveredAuthority.rootCaThumbprint ?? null, null);
  assert.equal(recoveredAuthority.currentUserKeyHandle ?? null, null);
  assert.deepEqual(removedKeys, [keyName]);
  const recoveredDatabase = await environment.databaseService.getDatabase();
  assert.equal(recoveredDatabase.exec(`SELECT status FROM agent_https_trust_intents WHERE intent_id = '${removal.intentId}'`)[0].values[0][0], 'completed');
});

test('C14 recovery resolves one legacy removal key only from the completed install with the same thumbprint', async () => {
  const controlPlane = await composition();
  const initial = await controlPlane.registry.getHttpOAuthAuthority();
  const thumbprint = 'F'.repeat(40);
  const keyName = 'kaoyan-http-root-legacy-recovery';
  const now = '2026-01-01T00:00:00.000Z';
  await controlPlane.executeControlWrite({ requestId: 'legacy-removal-fixture', execute: (db) => {
    db.run(`INSERT INTO agent_https_trust_intents
      (intent_id,kind,status,renderer_web_contents_id,navigation_generation,key_name,thumbprint,authority,expires_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, ['10000000-0000-4000-8000-000000000001', 'install', 'completed', 1, 0, keyName, thumbprint, initial.authority, '2099-01-01T00:00:00.000Z', now, now]);
    db.run(`INSERT INTO agent_https_trust_intents
      (intent_id,kind,status,renderer_web_contents_id,navigation_generation,key_name,thumbprint,authority,expires_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, ['10000000-0000-4000-8000-000000000002', 'remove', 'recovery_required', 1, 0, null, thumbprint, initial.authority, '2099-01-01T00:00:00.000Z', now, now]);
    return { changed: true, value: undefined };
  }});
  await controlPlane.registry.updateHttpOAuthAuthority({ ...initial, rootCaThumbprint: null, currentUserKeyHandle: null, enabled: false });
  const removedKeys = [];
  const removedMy = [];
  const oauth = new oauthModule.LocalOAuthAuthorizationServer({ metadata: metadataModule.createOAuthMetadata({ authority: initial }), tokenStore: controlPlane.httpOAuthTokens, appInstanceId: initial.appInstanceId, clients: { getHttpClient: () => null } });
  const controller = new controllerModule.DirectHttpsOAuthController({
    authority: () => controlPlane.registry.getHttpOAuthAuthority(),
    updateAuthority: (value) => controlPlane.registry.updateHttpOAuthAuthority(value),
    updateAuthorityInTransaction: (db, scope, value) => controlPlane.registry.updateHttpOAuthAuthorityInTransaction(db, scope, value),
    executeControlWrite: controlPlane.executeControlWrite,
    audit: auditStub(),
    keyStore: { async create() { throw new Error('unused'); }, async verify() { throw new Error('unused'); }, async remove(value) { removedKeys.push(value); } },
    issuer: { async issue() { throw new Error('unused'); }, async verify() {}, async remove(value) { removedMy.push(value); } },
    roots: { async install() {}, async remove() {}, async count() { return 0; } },
    oauth,
    createHost: () => undefined
  });
  await controller.reconcile();
  assert.deepEqual(removedMy, [thumbprint]);
  assert.deepEqual(removedKeys, [keyName]);
  const database = await environment.databaseService.getDatabase();
  assert.equal(database.exec(`SELECT status FROM agent_https_trust_intents WHERE intent_id = '10000000-0000-4000-8000-000000000002'`)[0].values[0][0], 'completed');
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

test('C14 cancelled and expired trust intents clean the exact My certificate and CNG key', async () => {
  const controlPlane = await composition();
  const authority = await controlPlane.registry.getHttpOAuthAuthority();
  const oauth = new oauthModule.LocalOAuthAuthorizationServer({ metadata: metadataModule.createOAuthMetadata({ authority }), tokenStore: controlPlane.httpOAuthTokens, appInstanceId: authority.appInstanceId, clients: { getHttpClient: () => null } });
  const material = { der: Buffer.alloc(256, 9), thumbprint: 'C'.repeat(40), notAfter: '2099-01-01T00:00:00.000Z', subject: 'CN=Kaoyan Local HTTPS Root cleanup' };
  let now = new Date('2026-01-01T00:00:00.000Z');
  const removedKeys = [];
  const removedCertificates = [];
  const controller = new controllerModule.DirectHttpsOAuthController({
    authority: () => controlPlane.registry.getHttpOAuthAuthority(),
    updateAuthority: (value) => controlPlane.registry.updateHttpOAuthAuthority(value),
    updateAuthorityInTransaction: (db, scope, value) => controlPlane.registry.updateHttpOAuthAuthorityInTransaction(db, scope, value),
    executeControlWrite: controlPlane.executeControlWrite,
    audit: auditStub(),
    keyStore: { async create(keyName) { return { keyName, provider: 'Microsoft Software Key Storage Provider', scope: 'CurrentUser', algorithm: 'RSA', exportable: false }; }, async verify(keyName) { return { keyName, provider: 'Microsoft Software Key Storage Provider', scope: 'CurrentUser', algorithm: 'RSA', exportable: false }; }, async remove(keyName) { removedKeys.push(keyName); } },
    issuer: { async issue() { return material; }, async verify() {}, async remove(thumbprint) { removedCertificates.push(thumbprint); } },
    roots: { async install() {}, async remove() {}, async count() { return 0; } },
    oauth,
    createHost: () => undefined,
    now: () => now
  });
  const context = { webContentsId: 9, navigationGeneration: 1 };
  const cancelled = await controller.prepareTrustInstall(context);
  await controller.confirmTrustInstall(cancelled.intentId, false, context);
  assert.equal(removedKeys.length, 1);
  assert.deepEqual(removedCertificates, [material.thumbprint]);

  const expired = await controller.prepareTrustInstall(context);
  now = new Date(now.getTime() + 6 * 60_000);
  await controller.reconcile();
  assert.equal(removedKeys.length, 2);
  assert.deepEqual(removedCertificates, [material.thumbprint, material.thumbprint]);
  const database = await environment.databaseService.getDatabase();
  assert.equal(database.exec('SELECT status FROM agent_https_trust_intents WHERE intent_id = "' + expired.intentId + '"')[0].values[0][0], 'expired');
});

test('C14 fixed-port bind failure stays visible and does not abort controller startup', async () => {
  const controlPlane = await composition();
  const initial = await controlPlane.registry.getHttpOAuthAuthority();
  const authority = await controlPlane.registry.updateHttpOAuthAuthority({ ...initial, rootCaThumbprint: 'D'.repeat(40), currentUserKeyHandle: 'kaoyan-http-root-bindfailure', enabled: true });
  const oauth = new oauthModule.LocalOAuthAuthorizationServer({ metadata: metadataModule.createOAuthMetadata({ authority }), tokenStore: controlPlane.httpOAuthTokens, appInstanceId: authority.appInstanceId, clients: { getHttpClient: () => null } });
  const controller = new controllerModule.DirectHttpsOAuthController({
    authority: () => controlPlane.registry.getHttpOAuthAuthority(),
    updateAuthority: (value) => controlPlane.registry.updateHttpOAuthAuthority(value),
    updateAuthorityInTransaction: (db, scope, value) => controlPlane.registry.updateHttpOAuthAuthorityInTransaction(db, scope, value),
    executeControlWrite: controlPlane.executeControlWrite,
    audit: auditStub(),
    keyStore: { async create() { throw new Error('unused'); }, async verify() { throw new Error('unused'); } },
    issuer: { async issue() { throw new Error('unused'); }, async verify() {} },
    roots: { async install() {}, async remove() {}, async count() { return 1; } },
    oauth,
    createHost: () => ({ async start() { throw new Error('EADDRINUSE'); }, async stop() {}, status() { return { state: 'disabled', reason: 'bind_failed', authority, resource: authority.resource, issuer: authority.issuer, appInstanceId: authority.appInstanceId }; } })
  });
  await controller.startIfAuthorized();
  assert.equal((await controller.status()).reason, 'bind_failed');
  assert.equal((await controlPlane.registry.getHttpOAuthAuthority()).enabled, true);
});

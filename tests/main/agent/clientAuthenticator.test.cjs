const assert = require('node:assert/strict');
const test = require('node:test');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const bootstrap = environment.requireMain('agent/bootstrap.js');
const authentication = environment.requireMain('agent/clientAuthenticator.js');
const rendererAdapter = environment.requireMain('agent/rendererAdapter.js');
const credential = 'credential must never escape';
const session = 'session must never escape';
const timestamp = '2026-07-16T10:00:00.000Z';

async function setup() {
  const credentialFingerprint = authentication.fingerprintCredential(credential);
  const sessionFingerprint = authentication.fingerprintCredential(session);
  const composition = await bootstrap.bootstrapAgentB3({
    coordinator: await environment.databaseService.getDatabaseCoordinator(),
    appInstanceId: 'auth-instance',
    credentialVerifier: {
      verify(raw) {
        if (typeof raw.credential !== 'string' || typeof raw.session !== 'string') throw new Error(`invalid ${raw.credential}`);
        return {
          credentialFingerprint: authentication.fingerprintCredential(raw.credential),
          sessionFingerprint: authentication.fingerprintCredential(raw.session)
        };
      }
    },
    cursorSecret: 'a'.repeat(32),
    now: () => timestamp,
    randomUUID: () => '00000000-0000-4000-8000-000000000001'
  });
  await composition.registry.registerClient({
    clientId: 'auth-client', subjectId: 'auth-subject', displayName: 'Auth Client', credentialFingerprint,
    scopes: ['questions.read'], trust: 'observer'
  });
  await composition.registry.createSession('auth-client', credentialFingerprint, sessionFingerprint, '2026-07-16T10:15:00.000Z');
  return composition;
}

test.beforeEach(() => environment.resetControlPlaneEnvironment());
test.after(() => environment.cleanupControlPlaneRoot());

test('disabled and invalid credentials deny without reflecting raw material', async () => {
  const composition = await setup();
  await assert.rejects(composition.authenticator.authenticate({ credential, session }), (error) => {
    assert.equal(error.code, 'EXTERNAL_CONTROL_DISABLED');
    assert.equal(JSON.stringify(error).includes(credential), false);
    return true;
  });
  await composition.registry.setExternalControlEnabled(true);
  await assert.rejects(composition.authenticator.authenticate({ credential: 'wrong credential', session }), (error) => {
    assert.equal(error.code, 'CLIENT_REVOKED');
    assert.equal(error.message.includes('wrong credential'), false);
    return true;
  });
});

test('issues opaque frozen principals only from current registry and session state', async () => {
  const composition = await setup();
  await composition.registry.setExternalControlEnabled(true);
  const principal = await composition.authenticator.authenticate({ credential, session });
  assert.equal(Object.isFrozen(principal), true);
  assert.equal(Object.isFrozen(principal.scopes), true);
  assert.equal(Object.getOwnPropertySymbols(principal).length, 0);
  assert.doesNotThrow(() => authentication.assertIssuedAgentPrincipal(principal));
  assert.throws(() => authentication.assertIssuedAgentPrincipal({ ...principal }), (error) => error.code === 'POLICY_DENIED');
  assert.throws(() => { principal.scopes.push('questions.write'); }, TypeError);
});

test('renderer adapter returns one fixed first-party identity and accepts no caller identity input', async () => {
  const composition = await setup();
  const first = composition.renderer.principal({ clientId: 'forged' });
  const second = composition.renderer.principal();
  assert.equal(first, second);
  assert.equal(first.clientId, 'local-renderer-management');
  assert.equal(first.renderer, true);
  assert.deepEqual(first.scopes, [
    'approvals.manage', 'approvals.read', 'audit.export', 'audit.read', 'changesets.manage', 'changesets.read',
    'clients.manage', 'clients.read', 'control.manage', 'policy.read', 'questions.archive', 'questions.read', 'questions.write', 'r4.manage', 'r4.read',
    'reviews.read', 'reviews.submit', 'tasks.execute', 'tasks.read', 'tasks.write', 'focus.control', 'focus.read',
    'jobs.read', 'jobs.execute', 'jobs.cancel', 'jobs.admin',
    'sessions.manage', 'sessions.read', 'system.read'
  ]);
  assert.equal(first.scopes.includes('tasks.write'), true);
  assert.doesNotThrow(() => authentication.assertIssuedAgentPrincipal(first));
  assert.equal(Object.hasOwn(authentication, 'issueFixedRendererPrincipal'), false);
  assert.deepEqual(Object.keys(authentication).filter((name) => /^issue/i.test(name)), []);
  assert.deepEqual(Object.keys(rendererAdapter), []);
  const constructed = Object.freeze({
    ...first,
    scopes: Object.freeze(['questions.write']),
    trust: 'full_control',
    renderer: true
  });
  assert.throws(() => authentication.assertIssuedAgentPrincipal(constructed), (error) => error.code === 'POLICY_DENIED');
});

test('renderer business allowlist is exact, frozen, and module-owned', () => {
  assert.deepEqual(authentication.migratedRendererBusinessOperations, [
    'questions.create', 'questions.update', 'questions.delete', 'questions.remove_image',
    'questions.mark_mastery', 'questions.submit_review',
    'questions.list', 'questions.get', 'questions.review_logs', 'questions.review_buckets',
    'tasks.create', 'tasks.update', 'tasks.complete', 'tasks.uncomplete', 'tasks.delete',
    'tasks.list', 'tasks.get', 'focus.sessions.create', 'focus.sessions.list'
  ]);
  assert.equal(Object.isFrozen(authentication.migratedRendererBusinessOperations), true);
  assert.equal(authentication.isMigratedRendererBusinessOperation('questions.create'), true);
  assert.equal(authentication.isMigratedRendererBusinessOperation('tasks.create'), true);
  assert.equal(authentication.isMigratedRendererBusinessOperation('questions.undo_review'), false);
});

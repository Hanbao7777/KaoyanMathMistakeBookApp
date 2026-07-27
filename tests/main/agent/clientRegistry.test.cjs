const assert = require('node:assert/strict');
const test = require('node:test');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const bootstrap = environment.requireMain('agent/bootstrap.js');
const authentication = environment.requireMain('agent/clientAuthenticator.js');
const agent = require(`${environment.projectRoot}/dist/main/shared/agent/index.js`);
const timestamp = '2026-07-16T10:00:00.000Z';
const credential = 'test credential material';
const session = 'test session material';
const credentialFingerprint = authentication.fingerprintCredential(credential);
const sessionFingerprint = authentication.fingerprintCredential(session);
let sequence = 0;

function verifier() {
  return {
    verify(raw) {
      return {
        credentialFingerprint: authentication.fingerprintCredential(raw.credential),
        sessionFingerprint: authentication.fingerprintCredential(raw.session)
      };
    }
  };
}

async function composition(instanceId = 'instance-one', now = () => timestamp) {
  const coordinator = await environment.databaseService.getDatabaseCoordinator();
  return bootstrap.bootstrapAgentB3({
    coordinator,
    appInstanceId: instanceId,
    credentialVerifier: verifier(),
    cursorSecret: 'c'.repeat(32),
    now,
    randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`
  });
}

async function register(registry, overrides = {}) {
  return registry.registerClient({
    clientId: 'client-one',
    subjectId: 'subject-one',
    displayName: 'Client One',
    credentialFingerprint,
    scopes: ['questions.read', 'questions.write'],
    trust: 'full_control',
    ...overrides
  });
}

test.beforeEach(async () => {
  sequence = 0;
  await environment.resetControlPlaneEnvironment();
});
test.after(() => environment.cleanupControlPlaneRoot());

test('bootstraps disabled settings and stores only unique nonreversible fingerprints', async () => {
  const { registry } = await composition();
  assert.equal((await registry.getSettings()).externalControlEnabled, false);
  const client = await register(registry);
  assert.equal(Object.isFrozen(client), true);
  assert.equal(client.credentialFingerprint, credentialFingerprint);
  await assert.rejects(register(registry, { clientId: 'client-two', subjectId: 'subject-two' }), /UNIQUE constraint failed/);

  const database = await environment.databaseService.getDatabase();
  const exported = Buffer.from(database.export()).toString('utf8');
  assert.equal(exported.includes(credential), false);
  assert.equal(exported.includes(session), false);
  assert.equal(exported.includes(credentialFingerprint), true);
});

test('rejects duplicate or unknown scopes and malformed policy JSON', async () => {
  const { registry } = await composition();
  await assert.rejects(register(registry, { scopes: ['questions.read', 'questions.read'] }), (error) => error.code === 'VALIDATION_ERROR');
  await assert.rejects(register(registry, { scopes: ['unknown.scope'] }), (error) => error.code === 'VALIDATION_ERROR');
  const database = await environment.databaseService.getDatabase();
  assert.throws(() => database.run("UPDATE agent_control_settings SET policy_json = 'not-json' WHERE id = 1"), /CHECK constraint failed/);
  const descriptor = agent.resolveOperationDescriptor('questions.clear_all');
  await assert.rejects(registry.updatePolicy('weakened', [{
    apiVersion: 1,
    operation: descriptor.name,
    catalog: agent.operationCatalogIdentity,
    minimumRisk: 'R3'
  }]), (error) => error.code === 'POLICY_INVARIANT_VIOLATION');
});

test('scope narrowing, revocation, termination, and restart affect the next authentication', async () => {
  const first = await composition();
  await register(first.registry);
  await first.registry.setExternalControlEnabled(true);
  const active = await first.registry.createSession('client-one', credentialFingerprint, sessionFingerprint, '2026-07-16T10:15:00.000Z');
  assert.equal((await first.authenticator.authenticate({ credential, session })).scopes.includes('questions.write'), true);

  await first.registry.updateClientAccess('client-one', ['questions.read'], 'observer');
  const narrowed = await first.authenticator.authenticate({ credential, session });
  assert.deepEqual(narrowed.scopes, ['questions.read']);
  assert.equal(narrowed.trust, 'observer');

  await first.registry.terminateSession(active.sessionId);
  await assert.rejects(first.authenticator.authenticate({ credential, session }), (error) => error.code === 'CLIENT_REVOKED');
  const nextSession = authentication.fingerprintCredential('next session material');
  await first.registry.createSession('client-one', credentialFingerprint, nextSession, '2026-07-16T10:15:00.000Z');
  await composition('instance-two');
  await assert.rejects(first.authenticator.authenticate({ credential, session: 'next session material' }), (error) => error.code === 'CLIENT_REVOKED');

  const replacementSession = authentication.fingerprintCredential('replacement session material');
  await first.registry.createSession('client-one', credentialFingerprint, replacementSession, '2026-07-16T10:15:00.000Z');
  await first.registry.revokeClient('client-one');
  await assert.rejects(first.authenticator.authenticate({ credential, session: 'replacement session material' }), (error) => error.code === 'CLIENT_REVOKED');
});

test('session expiry requires canonical UTC milliseconds and denies at the exact boundary', async () => {
  let currentTime = timestamp;
  const current = await composition('time-instance', () => currentTime);
  await register(current.registry);
  await current.registry.setExternalControlEnabled(true);
  const invalidDates = [
    'July 16, 2026 10:15:00 UTC',
    '2026-07-16T18:15:00.000+08:00',
    '2026-07-16T10:15:00Z',
    timestamp
  ];
  for (const expiresAt of invalidDates) {
    await assert.rejects(
      current.registry.createSession('client-one', credentialFingerprint, authentication.fingerprintCredential(expiresAt), expiresAt),
      (error) => error.code === 'VALIDATION_ERROR' && error.details.field === 'expiresAt'
    );
  }

  const boundarySession = 'boundary session material';
  await current.registry.createSession(
    'client-one', credentialFingerprint, authentication.fingerprintCredential(boundarySession), '2026-07-16T10:00:00.001Z'
  );
  assert.equal((await current.authenticator.authenticate({ credential, session: boundarySession })).clientId, 'client-one');
  currentTime = '2026-07-16T10:00:00.001Z';
  await assert.rejects(current.authenticator.authenticate({ credential, session: boundarySession }), (error) => error.code === 'CLIENT_REVOKED');

  currentTime = timestamp;
  const malformedSession = 'malformed persisted session';
  const malformedFingerprint = authentication.fingerprintCredential(malformedSession);
  await current.registry.createSession('client-one', credentialFingerprint, malformedFingerprint, '2026-07-16T10:15:00.000Z');
  const database = await environment.databaseService.getDatabase();
  database.run("UPDATE agent_sessions SET expires_at = '2026-07-16T18:15:00+08:00' WHERE session_fingerprint = ?", [malformedFingerprint]);
  await assert.rejects(current.authenticator.authenticate({ credential, session: malformedSession }), (error) => error.code === 'CLIENT_REVOKED');
});

test('session lifecycle rejects a noncanonical injected clock', async () => {
  await assert.rejects(
    composition('bad-clock-instance', () => '2026-07-16T10:00:00Z'),
    (error) => error.code === 'VALIDATION_ERROR' && error.details.field === 'now'
  );
});

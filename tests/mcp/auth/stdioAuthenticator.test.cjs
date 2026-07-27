const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '../../..');
const auth = require(path.join(projectRoot, 'dist/main/main/mcp/auth/stdioAuthenticator.js'));

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const fingerprint = 'sha256-v1:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const now = new Date('2026-07-16T10:00:00.000Z');

function registry() {
  const sessions = new Map();
  let live = true;
  return {
    setLive(value) { live = value; },
    async getActivePublicKey(clientId) { if (!live || clientId !== 'stdio-client') throw new Error('revoked'); return { clientId, publicKey, publicKeyFingerprint: fingerprint, keyGeneration: 1, registryGeneration: 1 }; },
    async hasActivePublicKeys() { return live; },
    async createSession(clientId, credentialFingerprint, sessionFingerprint, expiresAt) { const sessionId = '123e4567-e89b-42d3-a456-426614174000'; sessions.set(sessionId, { clientId, credentialFingerprint, sessionFingerprint, expiresAt }); return { sessionId }; },
    async authenticate(credentialFingerprint, sessionFingerprint) { const found = [...sessions.values()].find((session) => session.credentialFingerprint === credentialFingerprint && session.sessionFingerprint === sessionFingerprint); if (!live || !found) throw new Error('revoked'); return { apiVersion: 1, kind: 'agent-principal', clientId: found.clientId, subjectId: found.clientId, displayName: found.clientId, scopes: Object.freeze(['system.read']), trust: 'observer', credentialBinding: fingerprint, authenticatedAt: now.toISOString(), renderer: false }; }
  };
}

function principalAuthenticator(port) {
  return async (credentialFingerprint, sessionFingerprint) => Object.freeze(await port.authenticate(credentialFingerprint, sessionFingerprint));
}

test('stdio challenge is deterministic, single-use, and session validation observes revocation', async () => {
  const port = registry();
  const instance = new auth.StdioPublicKeyAuthenticator({ registry: port, authenticatePrincipal: principalAuthenticator(port), appInstanceId: 'app-instance', now: () => now, randomUUID: () => '123e4567-e89b-42d3-a456-426614174001', randomBytes: (size) => Buffer.alloc(size, 7) });
  const challenge = await instance.issueChallenge({ clientId: 'stdio-client', mcpProtocolVersion: '2025-11-25', launcherVersion: '1.0.0' });
  const signature = sign('sha256', auth.canonicalStdioChallengeBytes(challenge), { key: keyPair.privateKey, padding: require('node:crypto').constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString('base64url');
  const admission = await instance.admitInitialize({ protocolVersion: '2025-11-25', headers: { 'x-kaoyan-challenge-id': challenge.challengeId, 'x-kaoyan-challenge-signature': signature } });
  assert.equal(admission.sessionId, '123e4567-e89b-42d3-a456-426614174000');
  assert.equal(await instance.admitInitialize({ protocolVersion: '2025-11-25', headers: { 'x-kaoyan-challenge-id': challenge.challengeId, 'x-kaoyan-challenge-signature': signature } }), null);
  assert.equal((await instance.validateSession(admission.sessionId, '2025-11-25')).clientId, 'stdio-client');
  port.setLive(false);
  assert.equal(await instance.validateSession(admission.sessionId, '2025-11-25'), null);
});

test('wrong protocol and altered proof do not admit', async () => {
  const port = registry();
  const instance = new auth.StdioPublicKeyAuthenticator({ registry: port, authenticatePrincipal: principalAuthenticator(port), appInstanceId: 'app-instance', now: () => now });
  const challenge = await instance.issueChallenge({ clientId: 'stdio-client', mcpProtocolVersion: '2025-11-25', launcherVersion: '1.0.0' });
  assert.equal(await instance.admitInitialize({ protocolVersion: '2025-06-18', headers: { 'x-kaoyan-challenge-id': challenge.challengeId, 'x-kaoyan-challenge-signature': 'A'.repeat(64) } }), null);
  const tampered = { ...challenge, audience: 'wrong-audience', appInstanceId: 'wrong-instance', launcherVersion: '1.0.1' };
  const tamperedSignature = sign('sha256', auth.canonicalStdioChallengeBytes(tampered), { key: keyPair.privateKey, padding: require('node:crypto').constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString('base64url');
  assert.equal(await instance.admitInitialize({ protocolVersion: '2025-11-25', headers: { 'x-kaoyan-challenge-id': challenge.challengeId, 'x-kaoyan-challenge-signature': tamperedSignature } }), null);
  assert.equal(await instance.admitInitialize({ protocolVersion: '2025-11-25', headers: { 'x-kaoyan-challenge-id': challenge.challengeId, 'x-kaoyan-challenge-signature': tamperedSignature } }), null);
  await assert.rejects(instance.issueChallenge({ clientId: 'stdio-client', mcpProtocolVersion: '2024-11-05', launcherVersion: '1.0.0' }));
  await assert.rejects(instance.issueChallenge({ clientId: 'stdio-client', mcpProtocolVersion: '2025-11-25', launcherVersion: '2.0.0' }));
  await assert.rejects(instance.issueChallenge({ clientId: 'another-client', mcpProtocolVersion: '2025-11-25', launcherVersion: '1.0.0' }));
});

test('expired challenge and copied session identifiers deny without issuing a principal', async () => {
  let clock = now;
  const port = registry();
  let principalCalls = 0;
  const instance = new auth.StdioPublicKeyAuthenticator({
    registry: port,
    authenticatePrincipal: async (...args) => { principalCalls += 1; return principalAuthenticator(port)(...args); },
    appInstanceId: 'app-instance', now: () => clock, challengeTtlMs: 1_000
  });
  const challenge = await instance.issueChallenge({ clientId: 'stdio-client', mcpProtocolVersion: '2025-11-25', launcherVersion: '1.0.0' });
  const signature = sign('sha256', auth.canonicalStdioChallengeBytes(challenge), { key: keyPair.privateKey, padding: require('node:crypto').constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString('base64url');
  clock = new Date(now.getTime() + 1_000);
  assert.equal(await instance.admitInitialize({ protocolVersion: '2025-11-25', headers: { 'x-kaoyan-challenge-id': challenge.challengeId, 'x-kaoyan-challenge-signature': signature } }), null);
  assert.equal(await instance.validateSession('123e4567-e89b-42d3-a456-426614174999', '2025-11-25'), null);
  assert.equal(principalCalls, 0);
});

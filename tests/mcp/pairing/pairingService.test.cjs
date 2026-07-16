const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../..');
const pairing = require(path.join(root, 'dist/main/main/mcp/pairing/pairingService.js'));
const contracts = require(path.join(root, 'dist/main/shared/mcp/v1/pairingContracts.js'));

function fingerprint(publicKey) {
  const canonical = JSON.stringify({ publicKey, publicKeyFormat: 'spki-der-base64url' });
  return `sha256-v1:${crypto.createHash('sha256').update(canonical).digest('hex')}`;
}

function createBinding() {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const encoded = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  return { publicKey: encoded, publicKeyFormat: 'spki-der-base64url', publicKeyFingerprint: fingerprint(encoded), signatureAlgorithm: 'rsa-pss-sha256' };
}

function request(product = 'codex', clientId = `${product}-test-client`) {
  return { product, clientId, requestedScopes: ['system.read'], trust: 'observer', disclosureAccepted: true, authorityConfirmed: false };
}

async function harness(options = {}) {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kaoyan-c5-pairing-'));
  const resources = path.join(temp, 'resources'); const local = path.join(temp, 'local'); const userData = path.join(temp, 'user-data');
  await Promise.all([fsp.mkdir(resources), fsp.mkdir(local), fsp.mkdir(userData)]);
  const source = path.join(resources, 'kaoyan-mcp.exe'); const sourceBytes = Buffer.from('deterministic-c5-launcher'); await fsp.writeFile(source, sourceBytes);
  const artifact = { root: resources, path: source, version: '1.0.0', sha256: crypto.createHash('sha256').update(sourceBytes).digest('hex'), compatibility: { pairingApiVersion: contracts.pairingApiVersion, launcherVersion: '1.0.0' } };
  const keys = new Map(); const configs = new Map([['unrelated-server', { product: 'codex', command: 'unrelated.exe', args: ['--keep'] }]]);
  const clients = new Map(); const requests = new Map(); const calls = []; let failConfigAdd = false; let failConfigRemove = false; let failKeyDelete = false; let failGateway = options.failGateway; let selfTestFailure = false;
  function keyResult(clientId, binding, keyGeneration, registryGeneration, status) { return { apiVersion: 1, kind: 'client-key-binding', clientId, publicKeyFormat: binding.publicKeyFormat, publicKeyFingerprint: binding.publicKeyFingerprint, signatureAlgorithm: binding.signatureAlgorithm, keyGeneration, registryGeneration, status }; }
  const gateway = {
    async execute(envelope) {
      calls.push(['gateway', envelope.operation, envelope.requestId]);
      if (requests.has(envelope.requestId)) return requests.get(envelope.requestId);
      if (failGateway === envelope.operation) return { kind: 'rejected', error: { code: 'AUDIT_UNAVAILABLE' } };
      let value;
      if (envelope.operation === 'agent.clients.register_key') {
        if (clients.has(envelope.payload.clientId)) return { kind: 'rejected', error: { code: 'IDEMPOTENCY_CONFLICT' } };
        const entry = { binding: envelope.payload, keyGeneration: 1, registryGeneration: 1, scopes: ['system.read'], trust: 'observer', revoked: false };
        clients.set(envelope.payload.clientId, entry); value = keyResult(envelope.payload.clientId, envelope.payload, 1, 1, 'registered');
      } else if (envelope.operation === 'agent.clients.rotate_key') {
        const entry = clients.get(envelope.payload.clientId);
        if (!entry || entry.revoked || entry.registryGeneration !== envelope.payload.expectedRegistryGeneration) return { kind: 'rejected', error: { code: 'IDEMPOTENCY_CONFLICT' } };
        entry.binding = envelope.payload; entry.keyGeneration += 1; entry.registryGeneration += 1;
        value = keyResult(envelope.payload.clientId, envelope.payload, entry.keyGeneration, entry.registryGeneration, 'rotated');
      } else if (envelope.operation === 'agent.clients.update_access') {
        const entry = clients.get(envelope.payload.clientId); if (!entry || entry.revoked) return { kind: 'rejected', error: { code: 'CLIENT_REVOKED' } };
        entry.scopes = [...envelope.payload.scopes]; entry.trust = envelope.payload.trust; value = { clientId: envelope.payload.clientId };
      } else if (envelope.operation === 'agent.clients.revoke') {
        const entry = clients.get(envelope.payload.clientId); if (entry) entry.revoked = true; value = { clientId: envelope.payload.clientId, revoked: true };
      } else throw new Error(`unexpected Gateway operation ${envelope.operation}`);
      const outcome = { kind: 'completed', result: { value } }; requests.set(envelope.requestId, outcome); return outcome;
    }
  };
  async function run(file, args) {
    calls.push([file, ...args]);
    if (args.length === 1 && args[0] === '--self-test') return selfTestFailure ? { stdout: '{}\n', stderr: '', exitCode: 0 } : { stdout: '{"ok":true,"kind":"kaoyan-mcp-self-test-v1","launcherVersion":"1.0.0"}\n', stderr: '', exitCode: 0 };
    if (args[0] === '--pairing-control') {
      const operation = args[1]; const keyName = args[3];
      if (operation === 'create') { if (keys.has(keyName)) return { stdout: '', stderr: 'failed', exitCode: 1 }; const binding = createBinding(); keys.set(keyName, binding); return { stdout: `${JSON.stringify({ version: 1, kind: 'cng-public-key-binding', ...binding })}\n`, stderr: '', exitCode: 0 }; }
      if (operation === 'get') { const binding = keys.get(keyName); return binding ? { stdout: `${JSON.stringify({ version: 1, kind: 'cng-public-key-binding', ...binding })}\n`, stderr: '', exitCode: 0 } : { stdout: '', stderr: 'missing', exitCode: 1 }; }
      if (failKeyDelete) { failKeyDelete = false; return { stdout: '', stderr: 'injected delete failure', exitCode: 1 }; }
      keys.delete(keyName); return { stdout: `${JSON.stringify({ version: 1, kind: 'cng-key-deleted', keyName })}\n`, stderr: '', exitCode: 0 };
    }
    const product = file === 'codex' ? 'codex' : 'claude_code'; const verb = args[1];
    if (verb === 'add') {
      if (failConfigAdd) { failConfigAdd = false; return { stdout: '', stderr: 'injected add failure', exitCode: 1 }; }
      const separator = args.indexOf('--'); const name = product === 'codex' ? args[2] : args[4]; configs.set(name, { product, command: args[separator + 1], args: args.slice(separator + 2) }); return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (verb === 'get') {
      const name = product === 'codex' ? args[3] : args[2]; const entry = configs.get(name);
      if (!entry) return { stdout: `No MCP server named "${name}".`, stderr: '', exitCode: 1 };
      if (product === 'codex') return { stdout: JSON.stringify({ name, enabled: true, transport: { type: 'stdio', command: entry.command, args: entry.args } }), stderr: '', exitCode: 0 };
      return { stdout: `${name}:\n  Scope: User config\n  Command: ${entry.command}\n  Args: ${entry.args.join(' ')}\n`, stderr: '', exitCode: 0 };
    }
    if (verb === 'remove') {
      if (failConfigRemove) { failConfigRemove = false; return { stdout: '', stderr: 'injected remove failure', exitCode: 1 }; }
      const name = product === 'codex' ? args[2] : args[4]; configs.delete(name); return { stdout: '', stderr: '', exitCode: 0 };
    }
    throw new Error(`unexpected executable invocation ${file} ${args.join(' ')}`);
  }
  const base = { localAppData: local, discoveryRoot: userData, journalRoot: path.join(userData, 'mcp-journal'), launcherArtifact: artifact, principal: () => ({}), gateway, run };
  return {
    temp, artifact, base, keys, configs, clients, calls,
    service(extra = {}) { return new pairing.PairingService({ ...base, ...extra }); },
    set failConfigAdd(value) { failConfigAdd = value; }, set failConfigRemove(value) { failConfigRemove = value; }, set failKeyDelete(value) { failKeyDelete = value; }, set failGateway(value) { failGateway = value; }, set selfTestFailure(value) { selfTestFailure = value; },
    async cleanup() { await fsp.rm(temp, { recursive: true, force: true }); }
  };
}

test('pairing contracts reject unknown fields, enum values, duplicates, unsorted scopes, and unconfirmed authority', () => {
  const valid = request(); assert.doesNotThrow(() => contracts.validatePairingRequest(valid));
  for (const invalid of [
    { ...valid, extra: true }, { ...valid, product: 'other' }, { ...valid, trust: 'root' },
    { ...valid, requestedScopes: ['system.read', 'system.read'] }, { ...valid, requestedScopes: ['tasks.read', 'system.read'] },
    { ...valid, requestedScopes: ['tasks.write'], trust: 'collaborator' },
    { ...valid, requestedScopes: ['clients.manage'], authorityConfirmed: true },
    { ...valid, requestedScopes: ['tasks.write'], trust: 'observer', authorityConfirmed: true }
  ]) assert.throws(() => contracts.validatePairingRequest(invalid));
  assert.doesNotThrow(() => contracts.validatePairingRequest({ ...valid, requestedScopes: ['system.read', 'tasks.write'], trust: 'collaborator', authorityConfirmed: true }));
  assert.throws(() => contracts.validatePairingTargetRequest({ product: 'codex', clientId: valid.clientId, extra: true }));
});

for (const product of ['codex', 'claude_code']) test(`${product} connect, health, rotate, and disconnect preserve unrelated configuration`, async () => {
  const current = await harness(); try {
    const target = request(product); const service = current.service();
    assert.equal((await service.connect(target)).state, 'healthy'); assert.equal(current.configs.has('unrelated-server'), true);
    const firstKey = [...current.keys.keys()][0]; const firstGeneration = current.clients.get(target.clientId).registryGeneration;
    assert.equal((await service.health({ product, clientId: target.clientId })).state, 'healthy');
    assert.equal((await service.rotate({ product, clientId: target.clientId })).state, 'healthy');
    assert.equal(current.keys.has(firstKey), false); assert.equal(current.clients.get(target.clientId).registryGeneration, firstGeneration + 1);
    assert.equal((await service.disconnect({ product, clientId: target.clientId })).state, 'disconnected');
    assert.equal(current.clients.get(target.clientId).revoked, true); assert.equal(current.keys.size, 0); assert.equal(current.configs.has('unrelated-server'), true);
  } finally { await current.cleanup(); }
});

test('explicit requested authority is granted only through audited Gateway management', async () => {
  const current = await harness(); try {
    const elevated = { ...request(), requestedScopes: ['system.read', 'tasks.write'], trust: 'collaborator', authorityConfirmed: true };
    const result = await current.service().connect(elevated); assert.equal(result.state, 'healthy');
    assert.deepEqual(result.grantedScopes, elevated.requestedScopes); assert.equal(result.grantedTrust, elevated.trust);
    assert.ok(current.calls.some((call) => call[1] === 'agent.clients.update_access'));
  } finally { await current.cleanup(); }
});

test('Gateway and config failures compensate key, registry, config, state, and launcher', async () => {
  const gatewayFailure = await harness({ failGateway: 'agent.clients.register_key' }); try {
    assert.equal((await gatewayFailure.service().connect(request())).state, 'failed'); assert.equal(gatewayFailure.keys.size, 0);
    assert.equal(gatewayFailure.clients.get(request().clientId)?.revoked ?? true, true); assert.equal(gatewayFailure.configs.size, 1);
  } finally { await gatewayFailure.cleanup(); }
  const configFailure = await harness(); try {
    configFailure.failConfigAdd = true; assert.equal((await configFailure.service().connect(request())).state, 'failed');
    assert.equal(configFailure.keys.size, 0); assert.equal(configFailure.clients.get(request().clientId).revoked, true); assert.equal(configFailure.configs.size, 1);
  } finally { await configFailure.cleanup(); }
});

test('failed compensation remains journaled until Gateway revoke and CNG cleanup both succeed', async () => {
  const revokeFailure = await harness(); try {
    revokeFailure.failConfigAdd = true; revokeFailure.failGateway = 'agent.clients.revoke';
    await assert.rejects(revokeFailure.service().connect(request()), (error) => error?.code === 'AUDIT_UNAVAILABLE');
    assert.equal(revokeFailure.keys.size, 1); assert.equal(revokeFailure.clients.get(request().clientId).revoked, false);
    revokeFailure.failGateway = undefined;
    assert.equal((await revokeFailure.service().health({ product: 'codex', clientId: request().clientId })).state, 'disconnected');
    assert.equal(revokeFailure.keys.size, 0); assert.equal(revokeFailure.clients.get(request().clientId).revoked, true);
  } finally { await revokeFailure.cleanup(); }

  const keyFailure = await harness(); try {
    keyFailure.failConfigAdd = true; keyFailure.failKeyDelete = true;
    await assert.rejects(keyFailure.service().connect(request()), /Launcher key delete failed/);
    assert.equal(keyFailure.keys.size, 1); assert.equal(keyFailure.clients.get(request().clientId).revoked, true);
    assert.equal((await keyFailure.service().health({ product: 'codex', clientId: request().clientId })).state, 'disconnected');
    assert.equal(keyFailure.keys.size, 0);
  } finally { await keyFailure.cleanup(); }
});

for (const phase of ['state:connect:registering', 'state:connect:config_added']) test(`connect recovers after restart at ${phase}`, async () => {
  const current = await harness(); let fired = false; try {
    const crashing = current.service({ fault(point) { if (!fired && point === phase) { fired = true; throw new pairing.PairingSimulatedCrash(point); } } });
    await assert.rejects(crashing.connect(request()), pairing.PairingSimulatedCrash);
    assert.equal((await current.service().health({ product: 'codex', clientId: request().clientId })).state, 'healthy');
    assert.equal(current.keys.size, 1); assert.equal(current.clients.get(request().clientId).revoked, false);
  } finally { await current.cleanup(); }
});

test('rotation failure restores registry/config, deletes the new key, and retains a usable generation', async () => {
  const current = await harness(); try {
    const service = current.service(); await service.connect(request()); const oldKey = [...current.keys.keys()][0];
    current.failConfigAdd = true; const result = await service.rotate({ product: 'codex', clientId: request().clientId });
    assert.equal(result.state, 'healthy'); assert.equal(current.keys.has(oldKey), true); assert.equal(current.keys.size, 1);
    assert.equal((await service.rotate({ product: 'codex', clientId: request().clientId })).state, 'healthy');
  } finally { await current.cleanup(); }
});

test('rotation restart recovery publishes the new generation before deleting the old CNG key', async () => {
  const current = await harness(); let fired = false; try {
    const service = current.service(); await service.connect(request()); const oldKey = [...current.keys.keys()][0];
    const crashing = current.service({ fault(point) { if (!fired && point === 'state:rotate:state_published') { fired = true; throw new pairing.PairingSimulatedCrash(point); } } });
    await assert.rejects(crashing.rotate({ product: 'codex', clientId: request().clientId }), pairing.PairingSimulatedCrash);
    assert.equal(current.keys.has(oldKey), true);
    assert.equal((await current.service().health({ product: 'codex', clientId: request().clientId })).state, 'healthy'); assert.equal(current.keys.has(oldKey), false);
  } finally { await current.cleanup(); }
});

test('disconnect revokes and deletes the key but never deletes an externally modified name', async () => {
  const current = await harness(); try {
    const service = current.service(); await service.connect(request()); const name = `kaoyan-mcp-${request().clientId}`;
    current.configs.set(name, { product: 'codex', command: 'external.exe', args: ['--foreign'] });
    const result = await service.disconnect({ product: 'codex', clientId: request().clientId });
    assert.equal(result.state, 'disconnected'); assert.equal(current.configs.get(name).command, 'external.exe'); assert.equal(current.keys.size, 0); assert.equal(current.clients.get(request().clientId).revoked, true);
  } finally { await current.cleanup(); }
});

test('corrupt state fences all lifecycle operations and preserves the previous generation', async () => {
  const current = await harness(); try {
    const service = current.service(); await service.connect(request()); const statePath = path.join(path.dirname(current.base.localAppData), 'unused');
    const actualState = path.join(current.base.localAppData, 'KaoyanMathMistakeBook', 'mcp-pairings-v1.json');
    assert.equal(fs.existsSync(`${actualState}.previous`), true); await fsp.writeFile(actualState, '{broken');
    await assert.rejects(current.service().health({ product: 'codex', clientId: request().clientId }), /corrupt/); assert.equal(fs.existsSync(`${actualState}.previous`), true); void statePath;
  } finally { await current.cleanup(); }
});

test('artifact hash/self-test failures and protected or junction roots fail before client configuration', async () => {
  const hashFailure = await harness(); try { hashFailure.artifact.sha256 = '0'.repeat(64); assert.equal((await hashFailure.service().connect(request())).state, 'failed'); assert.equal(hashFailure.configs.size, 1); } finally { await hashFailure.cleanup(); }
  const selfTestFailure = await harness(); try { selfTestFailure.selfTestFailure = true; assert.equal((await selfTestFailure.service().connect(request())).state, 'failed'); assert.equal(selfTestFailure.keys.size, 0); } finally { await selfTestFailure.cleanup(); }
  assert.throws(() => new pairing.PairingService({ localAppData: 'D:\\KaoyanMathMistakeBook', discoveryRoot: 'C:\\safe', journalRoot: 'C:\\safe', launcherArtifact: { root: 'C:\\safe', path: 'C:\\safe\\launcher.exe', version: '1.0.0', sha256: '0'.repeat(64), compatibility: { pairingApiVersion: contracts.pairingApiVersion, launcherVersion: '1.0.0' } }, principal: () => ({}), gateway: {} }), /protected data root/);
  const junction = await harness(); const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'kaoyan-c5-outside-')); try {
    await fsp.rm(junction.base.journalRoot, { recursive: true, force: true }); await fsp.symlink(outside, junction.base.journalRoot, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => junction.service(), /unsafe|link|junction|canonical/);
  } finally { await junction.cleanup(); await fsp.rm(outside, { recursive: true, force: true }); }
});

for (const phase of ['install:before-version-publish', 'install:after-manifest-publish']) test(`launcher install fault ${phase} recovers without a published client or launcher`, async () => {
  const current = await harness(); let fired = false; try {
    await assert.rejects(current.service({ fault(point) { if (!fired && point === phase) { fired = true; throw new pairing.PairingSimulatedCrash(point); } } }).connect(request()), pairing.PairingSimulatedCrash);
    assert.equal((await current.service().health({ product: 'codex', clientId: request().clientId })).state, 'disconnected');
    assert.equal(current.keys.size, 0); assert.equal(current.clients.size, 0); assert.equal(fs.existsSync(path.join(current.base.localAppData, 'KaoyanMathMistakeBook', 'bin')), false);
  } finally { await current.cleanup(); }
});

test('disconnect resumes after restart and retries a definite config removal failure', async () => {
  const current = await harness(); try {
    const service = current.service(); await service.connect(request()); current.failConfigRemove = true;
    assert.equal((await service.disconnect({ product: 'codex', clientId: request().clientId })).state, 'recovery_required');
    assert.equal((await current.service().health({ product: 'codex', clientId: request().clientId })).state, 'disconnected');
    assert.equal(current.keys.size, 0); assert.equal(current.clients.get(request().clientId).revoked, true);
  } finally { await current.cleanup(); }
});

test('disconnect crash after durable revocation resumes key cleanup and publication', async () => {
  const current = await harness(); let fired = false; try {
    const service = current.service(); await service.connect(request());
    await assert.rejects(current.service({ fault(point) { if (!fired && point === 'state:disconnect:gateway_revoked') { fired = true; throw new pairing.PairingSimulatedCrash(point); } } }).disconnect({ product: 'codex', clientId: request().clientId }), pairing.PairingSimulatedCrash);
    assert.equal(current.clients.get(request().clientId).revoked, true); assert.equal(current.keys.size, 1);
    assert.equal((await current.service().health({ product: 'codex', clientId: request().clientId })).state, 'disconnected'); assert.equal(current.keys.size, 0);
  } finally { await current.cleanup(); }
});

test('disconnect keeps a records-removed transaction until launcher uninstall succeeds', async () => {
  const current = await harness(); let fired = false; try {
    await current.service().connect(request());
    const crashing = current.service({ fault(point) { if (!fired && point === 'uninstall:before-remove') { fired = true; throw new pairing.PairingSimulatedCrash(point); } } });
    await assert.rejects(crashing.disconnect({ product: 'codex', clientId: request().clientId }), pairing.PairingSimulatedCrash);
    const statePath = path.join(current.base.localAppData, 'KaoyanMathMistakeBook', 'mcp-pairings-v1.json');
    assert.equal(JSON.parse(await fsp.readFile(statePath, 'utf8')).transaction.phase, 'records_removed');
    assert.equal((await current.service().health({ product: 'codex', clientId: request().clientId })).state, 'disconnected');
    assert.equal(fs.existsSync(path.join(current.base.localAppData, 'KaoyanMathMistakeBook', 'bin')), false);
    assert.equal(JSON.parse(await fsp.readFile(statePath, 'utf8')).transaction, undefined);
  } finally { await current.cleanup(); }
});

test('connect recovery deletes a CNG key created before its phase publication', async () => {
  const current = await harness(); let crashed = false; try {
    const run = async (file, args, env) => {
      const result = await current.base.run(file, args, env);
      if (!crashed && args[0] === '--pairing-control' && args[1] === 'create') { crashed = true; throw new pairing.PairingSimulatedCrash('after-key-create'); }
      return result;
    };
    await assert.rejects(current.service({ run }).connect(request()), pairing.PairingSimulatedCrash); assert.equal(current.keys.size, 1);
    assert.equal((await current.service().health({ product: 'codex', clientId: request().clientId })).state, 'disconnected'); assert.equal(current.keys.size, 0);
  } finally { await current.cleanup(); }
});

test('rotation recovery deletes a replacement key created before its phase publication', async () => {
  const current = await harness(); try {
    await current.service().connect(request()); const oldKey = [...current.keys.keys()][0]; let crashed = false;
    const run = async (file, args, env) => {
      const result = await current.base.run(file, args, env);
      if (!crashed && args[0] === '--pairing-control' && args[1] === 'create') { crashed = true; throw new pairing.PairingSimulatedCrash('after-rotation-key-create'); }
      return result;
    };
    await assert.rejects(current.service({ run }).rotate({ product: 'codex', clientId: request().clientId }), pairing.PairingSimulatedCrash); assert.equal(current.keys.size, 2);
    assert.equal((await current.service().health({ product: 'codex', clientId: request().clientId })).state, 'healthy'); assert.equal(current.keys.size, 1); assert.equal(current.keys.has(oldKey), true);
  } finally { await current.cleanup(); }
});

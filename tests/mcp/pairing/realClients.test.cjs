'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '../../..');
const executable = path.join(projectRoot, 'dist', 'mcp-stdio', 'kaoyan-mcp.exe');
const pairing = require(path.join(projectRoot, 'dist/main/main/mcp/pairing/pairingService.js'));

function invocation(file, args, env) {
  if (process.platform !== 'win32') return { file, args };
  const npmRoot = path.join(env.APPDATA, 'npm');
  if (file === 'claude') return { file: path.join(npmRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), args };
  if (file === 'codex') {
    const searchPath = env.PATH ?? env.Path ?? Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
    const node = searchPath.split(path.delimiter).map((entry) => path.join(entry.replace(/^"|"$/g, ''), 'node.exe')).find(fs.existsSync);
    return { file: node, args: [path.join(npmRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), ...args] };
  }
  return { file, args };
}
function command(file, args, env) { const target = invocation(file, args, env); return spawnSync(target.file, target.args, { encoding: 'utf8', timeout: 30_000, env, windowsHide: true }); }
function present(file) { const result = command(file, ['--version'], process.env); return result.status === 0 ? result.stdout.trim() : null; }

function gatewayHarness() {
  const clients = new Map(); const outcomes = new Map();
  return {
    clients,
    gateway: { async execute(envelope) {
      if (outcomes.has(envelope.requestId)) return outcomes.get(envelope.requestId);
      let value;
      if (envelope.operation === 'agent.clients.register_key') {
        if (clients.has(envelope.payload.clientId)) return { kind: 'rejected', error: { code: 'IDEMPOTENCY_CONFLICT' } };
        clients.set(envelope.payload.clientId, { ...envelope.payload, keyGeneration: 1, registryGeneration: 1, revoked: false });
        value = { apiVersion: 1, kind: 'client-key-binding', clientId: envelope.payload.clientId, publicKeyFormat: envelope.payload.publicKeyFormat, publicKeyFingerprint: envelope.payload.publicKeyFingerprint, signatureAlgorithm: envelope.payload.signatureAlgorithm, keyGeneration: 1, registryGeneration: 1, status: 'registered' };
      } else if (envelope.operation === 'agent.clients.rotate_key') {
        const current = clients.get(envelope.payload.clientId); if (!current || current.revoked || current.registryGeneration !== envelope.payload.expectedRegistryGeneration) return { kind: 'rejected', error: { code: 'IDEMPOTENCY_CONFLICT' } };
        Object.assign(current, envelope.payload, { keyGeneration: current.keyGeneration + 1, registryGeneration: current.registryGeneration + 1 });
        value = { apiVersion: 1, kind: 'client-key-binding', clientId: envelope.payload.clientId, publicKeyFormat: envelope.payload.publicKeyFormat, publicKeyFingerprint: envelope.payload.publicKeyFingerprint, signatureAlgorithm: envelope.payload.signatureAlgorithm, keyGeneration: current.keyGeneration, registryGeneration: current.registryGeneration, status: 'rotated' };
      } else if (envelope.operation === 'agent.clients.update_access') value = { clientId: envelope.payload.clientId };
      else if (envelope.operation === 'agent.clients.revoke') { const current = clients.get(envelope.payload.clientId); if (current) current.revoked = true; value = { clientId: envelope.payload.clientId, revoked: true }; }
      else throw new Error(`Unexpected Gateway operation ${envelope.operation}`);
      const outcome = { kind: 'completed', result: { value } }; outcomes.set(envelope.requestId, outcome); return outcome;
    } }
  };
}

function cliArgs(product, verb, name, launcher, clientId, keyName) {
  const launcherArgs = ['--client-id', clientId, '--key-name', keyName, '--discovery-root', '<discovery>', '--journal-root', '<journal>'];
  if (verb === 'get') return product === 'codex' ? ['mcp', 'get', '--json', name] : ['mcp', 'get', name];
  if (verb === 'remove') return product === 'codex' ? ['mcp', 'remove', name] : ['mcp', 'remove', '--scope', 'user', name];
  return product === 'codex' ? ['mcp', 'add', name, '--', launcher, ...launcherArgs] : ['mcp', 'add', '--scope', 'user', name, '--', launcher, ...launcherArgs];
}

for (const product of ['codex', 'claude_code']) test(`real ${product} disposable profile lifecycle`, { skip: process.platform !== 'win32' || !fs.existsSync(executable) || !present(product === 'codex' ? 'codex' : 'claude') }, async (t) => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kaoyan-c5-real-')); const previous = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  const profile = path.join(temp, product); const local = path.join(temp, 'local'); const userData = path.join(temp, 'user-data'); await Promise.all([fsp.mkdir(profile), fsp.mkdir(local), fsp.mkdir(userData)]);
  if (product === 'codex') process.env.CODEX_HOME = profile; else process.env.CLAUDE_CONFIG_DIR = profile;
  const env = { ...process.env }; const cli = product === 'codex' ? 'codex' : 'claude'; const unrelated = `kaoyan-c5-unrelated-${product}`; const clientId = `${product}-real-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`; const owned = `kaoyan-mcp-${clientId}`;
  const artifactBytes = await fsp.readFile(executable); const artifact = { root: path.dirname(executable), path: executable, version: '1.0.0', sha256: crypto.createHash('sha256').update(artifactBytes).digest('hex'), compatibility: { pairingApiVersion: 'kaoyan-pairing-v1@1', launcherVersion: '1.0.0' } };
  const gateway = gatewayHarness(); const base = { localAppData: local, discoveryRoot: userData, journalRoot: path.join(userData, 'journal'), launcherArtifact: artifact, gateway: gateway.gateway, principal: () => ({}) };
  const target = { product, clientId }; const request = { ...target, requestedScopes: ['system.read'], trust: 'observer', disclosureAccepted: true, authorityConfirmed: false };
  try {
    const addUnrelated = command(cli, product === 'codex' ? ['mcp', 'add', unrelated, '--', process.execPath, '--version'] : ['mcp', 'add', '--scope', 'user', unrelated, '--', process.execPath, '--version'], env);
    assert.equal(addUnrelated.status, 0, `${addUnrelated.stdout}\n${addUnrelated.stderr}`);
    const service = new pairing.PairingService(base); assert.equal((await service.connect(request)).state, 'healthy');
    assert.equal(command(cli, cliArgs(product, 'get', unrelated), env).status, 0);
    assert.equal((await service.rotate(target)).state, 'healthy');
    assert.equal(command(cli, cliArgs(product, 'remove', owned), env).status, 0);
    assert.equal((await service.health(target)).state, 'repairing'); assert.equal((await service.repair(target)).state, 'healthy');
    assert.equal(command(cli, cliArgs(product, 'remove', owned), env).status, 0);
    const external = command(cli, product === 'codex' ? ['mcp', 'add', owned, '--', process.execPath, '--version'] : ['mcp', 'add', '--scope', 'user', owned, '--', process.execPath, '--version'], env);
    assert.equal(external.status, 0, `${external.stdout}\n${external.stderr}`);
    assert.equal((await service.health(target)).state, 'conflict'); assert.equal((await service.repair(target)).state, 'conflict');
    assert.equal((await service.disconnect(target)).state, 'disconnected'); assert.equal(gateway.clients.get(clientId).revoked, true);
    assert.equal(command(cli, cliArgs(product, 'get', owned), env).status, 0, 'external conflict entry must survive disconnect');
    assert.equal(command(cli, cliArgs(product, 'get', unrelated), env).status, 0, 'unrelated entry must survive disconnect');
    assert.equal(command(cli, cliArgs(product, 'remove', owned), env).status, 0); assert.equal(command(cli, cliArgs(product, 'remove', unrelated), env).status, 0);

    const recoveryClient = `${product}-recovery-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`; let crashed = false;
    const recoveryRequest = { ...request, clientId: recoveryClient }; const recoveryTarget = { product, clientId: recoveryClient };
    await assert.rejects(new pairing.PairingService({ ...base, fault(phase) { if (!crashed && phase === 'state:connect:registering') { crashed = true; throw new pairing.PairingSimulatedCrash(phase); } } }).connect(recoveryRequest), pairing.PairingSimulatedCrash);
    const recovered = new pairing.PairingService(base); assert.equal((await recovered.health(recoveryTarget)).state, 'healthy'); assert.equal((await recovered.disconnect(recoveryTarget)).state, 'disconnected');
    t.diagnostic(`${cli}=${present(cli)} profile=${profile} lifecycle=pass conflict=preserved repair=pass crash-recovery=pass`);
  } finally {
    process.env.CODEX_HOME = previous.CODEX_HOME; process.env.CLAUDE_CONFIG_DIR = previous.CLAUDE_CONFIG_DIR;
    if (previous.CODEX_HOME === undefined) delete process.env.CODEX_HOME; if (previous.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    await fsp.rm(temp, { recursive: true, force: true }); assert.equal(fs.existsSync(temp), false);
  }
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '../../..');
const pairing = require(path.join(projectRoot, 'dist/main/main/mcp/pairing/pairingService.js'));

function root(label) { return fs.mkdtempSync(path.join(os.tmpdir(), `kaoyan-c7-artifact-${label}-`)); }
function artifactRoot(kind) { return kind === 'development' ? path.join(projectRoot, 'dist') : path.join(projectRoot, 'release', 'win-unpacked', 'resources'); }
function mockClient(runState) {
  return async (file, args) => {
    if (path.isAbsolute(file)) {
      const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true });
      return { stdout: result.stdout || '', stderr: result.stderr || '', exitCode: result.status ?? 1 };
    }
    const operation = args[1];
    const name = operation === 'get' && args[2] === '--json' ? args[3] : args[2] === '--scope' ? args[4] : args[2];
    if (operation === 'get') {
      const entry = runState.config.get(name);
      return entry ? { stdout: JSON.stringify(entry), stderr: '', exitCode: 0 } : { stdout: '', stderr: 'No MCP server named', exitCode: 1 };
    }
    if (operation === 'add') {
      const marker = args.indexOf('--');
      runState.config.set(name, { name, enabled: true, transport: { type: 'stdio', command: args[marker + 1], args: args.slice(marker + 2) } });
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (operation === 'remove') { runState.config.delete(name); return { stdout: '', stderr: '', exitCode: 0 }; }
    throw new Error(`Unexpected mock client command ${file} ${args.join(' ')}`);
  };
}

for (const kind of ['development', 'win-unpacked']) {
  test(`C7 ${kind} launcher artifact installs to stable LocalAppData and survives service restart`, {
    skip: process.platform !== 'win32' || !fs.existsSync(path.join(artifactRoot(kind), 'mcp-stdio', 'launcher-manifest.json')),
    timeout: 60_000
  }, async () => {
    const temp = root(kind);
    const localAppData = path.join(temp, 'local-app-data');
    const discoveryRoot = path.join(temp, 'user-data');
    const journalRoot = path.join(temp, 'journal');
    await Promise.all([fsp.mkdir(localAppData), fsp.mkdir(discoveryRoot), fsp.mkdir(journalRoot)]);
    const artifact = pairing.loadPackagedLauncherArtifact(artifactRoot(kind));
    assert.equal(artifact.path.toLowerCase().includes('app.asar'), false);
    const runState = { config: new Map() };
    const clientId = `c7-${kind}-artifact`;
    const gateway = {
      async execute(envelope) {
        if (envelope.operation !== 'agent.clients.register_key') return { kind: 'completed', result: { value: { clientId } } };
        return { kind: 'completed', result: { value: { apiVersion: 1, kind: 'client-key-binding', clientId: envelope.payload.clientId, publicKeyFormat: envelope.payload.publicKeyFormat, publicKeyFingerprint: envelope.payload.publicKeyFingerprint, signatureAlgorithm: envelope.payload.signatureAlgorithm, keyGeneration: 1, registryGeneration: 1, status: 'registered' } } };
      }
    };
    const base = { gateway, principal: () => ({}), launcherArtifact: artifact, localAppData, discoveryRoot, journalRoot, run: mockClient(runState) };
    const target = { product: 'codex', clientId };
    const request = { ...target, requestedScopes: ['system.read'], trust: 'observer', disclosureAccepted: true, authorityConfirmed: false };
    try {
      const first = new pairing.PairingService(base);
      const connected = await first.connect(request);
      assert.equal(connected.state, 'healthy', JSON.stringify(connected));
      assert.match(connected.launcherPath, /KaoyanMathMistakeBook[\\/]bin[\\/]1\.0\.0[\\/]kaoyan-mcp\.exe$/i);
      assert.equal(fs.existsSync(connected.launcherPath), true);
      const manifestPath = path.join(localAppData, 'KaoyanMathMistakeBook', 'bin', 'current.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assert.equal(manifest.launcher.path, connected.launcherPath);
      assert.equal(manifest.launcher.sha256, artifact.sha256);
      const restarted = new pairing.PairingService(base);
      const health = await restarted.health(target);
      assert.equal(health.state, 'healthy');
      assert.equal(health.launcherPath, connected.launcherPath);
      await restarted.disconnect(target);
      assert.equal(fs.existsSync(manifestPath), false);
    } finally {
      await fsp.rm(temp, { recursive: true, force: true });
    }
  });
}

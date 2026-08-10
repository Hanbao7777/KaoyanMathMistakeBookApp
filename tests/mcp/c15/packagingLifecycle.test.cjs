'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '../../..');
const pairing = require(path.join(projectRoot, 'dist/main/main/mcp/pairing/pairingService.js'));

async function resourceCopy(root, name) {
  const resources = path.join(root, name); const target = path.join(resources, 'mcp-stdio');
  await fsp.mkdir(target, { recursive: true });
  for (const file of ['kaoyan-mcp.exe', 'launcher-manifest.json']) await fsp.copyFile(path.join(projectRoot, 'dist', 'mcp-stdio', file), path.join(target, file));
  return resources;
}

async function holdExclusive(file, readyFile, milliseconds) {
  const quoted = (value) => value.replace(/'/g, "''");
  const script = `$stream = [IO.File]::Open('${quoted(file)}', [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None); try { [IO.File]::WriteAllText('${quoted(readyFile)}', 'ready'); Start-Sleep -Milliseconds ${milliseconds} } finally { $stream.Dispose() }`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], { stdio: 'ignore', windowsHide: true });
  const released = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`exclusive lock process exited ${code}`)));
  });
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(readyFile)) {
    if (Date.now() >= deadline) { child.kill(); throw new Error('exclusive lock process did not become ready'); }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return released;
}

function clientRunner(config) {
  return async (file, args) => {
    if (path.isAbsolute(file)) { const child = spawnSync(file, args, { encoding: 'utf8', windowsHide: true }); return { stdout: child.stdout || '', stderr: child.stderr || '', exitCode: child.status ?? 1 }; }
    const operation = args[1]; const name = operation === 'get' ? args.at(-1) : args[2];
    if (operation === 'get') { const value = config.get(name); return value ? { stdout: JSON.stringify(value), stderr: '', exitCode: 0 } : { stdout: '', stderr: 'No MCP server named', exitCode: 1 }; }
    if (operation === 'add') { const marker = args.indexOf('--'); config.set(name, { name, enabled: true, transport: { type: 'stdio', command: args[marker + 1], args: args.slice(marker + 2) } }); return { stdout: '', stderr: '', exitCode: 0 }; }
    if (operation === 'remove') { config.delete(name); return { stdout: '', stderr: '', exitCode: 0 }; }
    throw new Error(`Unexpected client command: ${file} ${args.join(' ')}`);
  };
}

test('C15 moved App repairs from new resources while retaining one stable launcher path', { skip: process.platform !== 'win32', timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-c15-moved-app-'));
  const localAppData = path.join(root, 'local-app-data'); const discoveryRoot = path.join(root, 'user-data'); const journalRoot = path.join(root, 'journal');
  await Promise.all([fsp.mkdir(localAppData), fsp.mkdir(discoveryRoot), fsp.mkdir(journalRoot)]);
  const firstResources = await resourceCopy(root, 'portable-original-resources'); const movedResources = await resourceCopy(root, 'portable-moved-resources');
  const config = new Map(); const clientId = 'c15-moved-codex';
  const gateway = { async execute(envelope) { return { kind: 'completed', result: { value: envelope.operation === 'agent.clients.register_key' ? { apiVersion: 1, kind: 'client-key-binding', clientId, publicKeyFormat: envelope.payload.publicKeyFormat, publicKeyFingerprint: envelope.payload.publicKeyFingerprint, signatureAlgorithm: envelope.payload.signatureAlgorithm, keyGeneration: 1, registryGeneration: 1, status: 'registered' } : { clientId } } }; } };
  const base = { gateway, principal: () => ({}), localAppData, discoveryRoot, journalRoot, run: clientRunner(config) };
  const target = { product: 'codex', clientId }; const request = { ...target, requestedScopes: ['system.read'], trust: 'observer', disclosureAccepted: true, authorityConfirmed: false };
  let lockReleased;
  try {
    const first = new pairing.PairingService({ ...base, launcherArtifact: pairing.loadPackagedLauncherArtifact(firstResources) });
    const connected = await first.connect(request); assert.equal(connected.state, 'healthy', JSON.stringify(connected));
    const stablePath = connected.launcherPath; assert.equal(fs.existsSync(stablePath), true);
    await fsp.rm(firstResources, { recursive: true, force: true }); await fsp.rm(stablePath, { force: true });
    const moved = new pairing.PairingService({
      ...base,
      launcherArtifact: pairing.loadPackagedLauncherArtifact(movedResources),
      async fault(phase) {
        if (phase !== 'install:before-version-publish') return;
        const directory = path.dirname(stablePath); const temporary = (await fsp.readdir(directory)).find((entry) => /^\.kaoyan-mcp\..+\.tmp$/.test(entry));
        assert.ok(temporary, 'temporary launcher should exist before publish');
        lockReleased = await holdExclusive(path.join(directory, temporary), path.join(root, 'launcher-lock-ready'), 750);
      }
    });
    assert.equal((await moved.health(target)).state, 'repairing');
    const repaired = await moved.repair(target); assert.equal(repaired.state, 'healthy', JSON.stringify(repaired)); assert.equal(repaired.launcherPath, stablePath); assert.equal(fs.existsSync(stablePath), true);
    await moved.disconnect(target); assert.equal(fs.existsSync(path.join(localAppData, 'KaoyanMathMistakeBook', 'bin')), false);
  } finally { try { await lockReleased; } finally { await fsp.rm(root, { recursive: true, force: true }); } }
});

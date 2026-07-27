const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..', '..');
const pairing = require(path.join(root, 'dist', 'main', 'main', 'mcp', 'pairing', 'pairingService.js'));

test('launcher build emits the exact packaged manifest and Electron includes only production artifacts', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'kaoyan-c5-manifest-'));
  try {
    const launcher = Buffer.from('standalone-launcher-fixture');
    writeFileSync(path.join(directory, 'kaoyan-mcp.exe'), launcher);
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-mcp-launcher-manifest.cjs'), directory], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(path.join(directory, 'launcher-manifest.json'), 'utf8')), {
      manifestVersion: 1,
      launcherVersion: '1.0.0',
      file: 'kaoyan-mcp.exe',
      sha256: createHash('sha256').update(launcher).digest('hex'),
      compatibility: { pairingApiVersion: 'kaoyan-pairing-v1@1', launcherVersion: '1.0.0' },
      release: { appVersion: '0.1.0', sdkVersion: '1.29.0', mcpProtocolVersion: '2025-11-25' }
    });

    const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.match(packageJson.scripts['build:launcher'], /build-mcp-launcher-manifest\.cjs/);
    assert.match(packageJson.scripts['pack:win'], /npm run build:launcher/);
    assert.equal(packageJson.build.files.includes('!dist/mcp-stdio/**/*'), true);
    assert.equal(packageJson.build.files.includes('!dist/launcher-build/**/*'), true);
    const packaged = packageJson.build.extraResources.filter((entry) => entry.to.startsWith('mcp-stdio/'));
    assert.deepEqual(packaged, [
      { from: 'dist/mcp-stdio/kaoyan-mcp.exe', to: 'mcp-stdio/kaoyan-mcp.exe' },
      { from: 'dist/mcp-stdio/launcher-manifest.json', to: 'mcp-stdio/launcher-manifest.json' }
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('C15 package verifier is deterministic and fails closed on stale release metadata', () => {
  const script = path.join(root, 'scripts', 'verify-phase-c-package.cjs');
  assert.equal(require('node:fs').existsSync(script), true);
  const source = readFileSync(script, 'utf8');
  assert.match(source, /outside ASAR|app\.asar\.unpacked/);
  assert.match(source, /listPackage|inside ASAR/);
  assert.match(source, /launcher hash mismatch/);
  assert.match(source, /asarUnpack/);
});

test('C15 launcher loader keeps same-major legacy manifests readable', () => {
  const resources = mkdtempSync(path.join(tmpdir(), 'kaoyan-c15-legacy-manifest-'));
  const directory = path.join(resources, 'mcp-stdio');
  try {
    mkdirSync(directory);
    const launcher = Buffer.from('legacy-standalone-launcher');
    writeFileSync(path.join(directory, 'kaoyan-mcp.exe'), launcher);
    writeFileSync(path.join(directory, 'launcher-manifest.json'), JSON.stringify({
      manifestVersion: 1,
      launcherVersion: '1.0.0',
      file: 'kaoyan-mcp.exe',
      sha256: createHash('sha256').update(launcher).digest('hex'),
      compatibility: { pairingApiVersion: 'kaoyan-pairing-v1@1', launcherVersion: '1.0.0' }
    }));
    const artifact = pairing.loadPackagedLauncherArtifact(resources);
    assert.equal(artifact.release, undefined);
    assert.equal(artifact.path, path.join(directory, 'kaoyan-mcp.exe'));
  } finally {
    rmSync(resources, { recursive: true, force: true });
  }
});

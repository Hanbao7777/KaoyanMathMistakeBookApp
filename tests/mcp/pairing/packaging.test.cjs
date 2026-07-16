const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..', '..');

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
      compatibility: { pairingApiVersion: 'kaoyan-pairing-v1@1', launcherVersion: '1.0.0' }
    });

    const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.match(packageJson.scripts['build:launcher'], /build-mcp-launcher-manifest\.cjs/);
    assert.match(packageJson.scripts['pack:win'], /npm run build:launcher/);
    const packaged = packageJson.build.extraResources.filter((entry) => entry.to.startsWith('mcp-stdio/'));
    assert.deepEqual(packaged, [
      { from: 'dist/mcp-stdio/kaoyan-mcp.exe', to: 'mcp-stdio/kaoyan-mcp.exe' },
      { from: 'dist/mcp-stdio/launcher-manifest.json', to: 'mcp-stdio/launcher-manifest.json' }
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

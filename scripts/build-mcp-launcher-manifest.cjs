const { createHash } = require('node:crypto');
const { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const launcherVersion = '1.0.0';
const pairingApiVersion = 'kaoyan-pairing-v1@1';
const outputDirectory = path.resolve(process.argv[2] ?? path.join('dist', 'mcp-stdio'));
const launcherPath = path.join(outputDirectory, 'kaoyan-mcp.exe');
const manifestPath = path.join(outputDirectory, 'launcher-manifest.json');
const temporaryPath = `${manifestPath}.${process.pid}.tmp`;

const launcher = readFileSync(launcherPath);
if (launcher.length < 1) throw new Error('Launcher executable is empty');

const manifest = Object.freeze({
  manifestVersion: 1,
  launcherVersion,
  file: 'kaoyan-mcp.exe',
  sha256: createHash('sha256').update(launcher).digest('hex'),
  compatibility: Object.freeze({ pairingApiVersion, launcherVersion })
});

mkdirSync(outputDirectory, { recursive: true });
try {
  writeFileSync(temporaryPath, `${JSON.stringify(manifest)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  renameSync(temporaryPath, manifestPath);
} finally {
  rmSync(temporaryPath, { force: true });
}

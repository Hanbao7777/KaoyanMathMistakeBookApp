'use strict';

const { createHash } = require('node:crypto');
const { existsSync, lstatSync, readFileSync, statSync } = require('node:fs');
const path = require('node:path');
const { listPackage } = require('@electron/asar');

function fail(message) { throw new Error(`C15 package verification failed: ${message}`); }
function file(filePath, label) {
  if (!existsSync(filePath) || !lstatSync(filePath).isFile()) fail(`${label} is missing`);
  const size = statSync(filePath).size; if (size < 1) fail(`${label} is empty`);
  return filePath;
}
function sha256(filePath) { return createHash('sha256').update(readFileSync(filePath)).digest('hex'); }

const root = path.resolve(process.argv[2] ?? path.join(__dirname, '..'));
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const resources = path.join(root, 'release', 'win-unpacked', 'resources');
const asarPath = file(path.join(resources, 'app.asar'), 'application ASAR');
const launcher = file(path.join(resources, 'mcp-stdio', 'kaoyan-mcp.exe'), 'win-unpacked launcher');
const manifestPath = file(path.join(resources, 'mcp-stdio', 'launcher-manifest.json'), 'win-unpacked launcher manifest');
const portable = file(path.join(root, 'release', `考研高数错题本 ${packageJson.version}.exe`), 'portable executable');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.manifestVersion !== 1 || manifest.file !== 'kaoyan-mcp.exe') fail('manifest identity is incompatible');
if (manifest.launcherVersion !== '1.0.0' || manifest.compatibility?.pairingApiVersion !== 'kaoyan-pairing-v1@1' || manifest.compatibility?.launcherVersion !== '1.0.0') fail('launcher compatibility is incompatible');
if (manifest.release?.appVersion !== packageJson.version || manifest.release?.sdkVersion !== packageJson.dependencies?.['@modelcontextprotocol/sdk'] || manifest.release?.mcpProtocolVersion !== '2025-11-25') fail('release metadata does not match package metadata');
if (manifest.sha256 !== sha256(launcher)) fail('launcher hash mismatch');
const asarEntries = listPackage(asarPath).map((entry) => entry.replaceAll('\\', '/').replace(/^\/+/, ''));
if (asarEntries.some((entry) => entry.startsWith('dist/mcp-stdio/') || entry.startsWith('dist/launcher-build/'))) fail('launcher content unexpectedly exists inside ASAR');
if (existsSync(path.join(resources, 'app.asar.unpacked', 'mcp-stdio', 'kaoyan-mcp.exe'))) fail('launcher unexpectedly exists in ASAR unpacked content');
const unpacked = packageJson.build?.asarUnpack ?? [];
if (JSON.stringify(unpacked) !== JSON.stringify(['node_modules/sql.js/dist/sql-wasm.wasm'])) fail('asarUnpack changed unexpectedly');
console.log(JSON.stringify({ ok: true, kind: 'kaoyan-phase-c-package-v1', appVersion: packageJson.version, portableBytes: statSync(portable).size, launcherBytes: statSync(launcher).size, launcherSha256: manifest.sha256, resources: 'outside-asar' }));

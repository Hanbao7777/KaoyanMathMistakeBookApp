'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { launchElectron } = require('./launchElectron.cjs');

const projectRoot = path.resolve(__dirname, '../..');
const builtMain = path.join(projectRoot, 'dist', 'main', 'main', 'main.js');
const realDataRoot = 'D:\\KaoyanMathMistakeBook';
const roots = new Set();

function createRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `kaoyan-c7-electron-${label}-`));
  roots.add(root);
  return root;
}
function prepare(root) {
  const userDataDir = path.join(root, 'user-data');
  const dataRoot = path.join(root, 'data-root');
  const resultFile = path.join(root, 'result.json');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(resultFile, '', 'utf8');
  return { root, userDataDir, dataRoot, resultFile };
}
function writeWrapper(paths, name, source) {
  const wrapper = path.join(paths.root, `${name}.cjs`);
  fs.writeFileSync(wrapper, source, 'utf8');
  return wrapper;
}
function waitForFile(file, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (fs.existsSync(file) && fs.statSync(file).size > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${file}`);
  })();
}
function isolated(paths) {
  for (const target of [paths.root, paths.userDataDir, paths.dataRoot, paths.resultFile]) {
    const normalized = path.resolve(target).toLowerCase();
    assert.equal(normalized.includes(realDataRoot.toLowerCase()), false);
    assert.equal(path.relative(paths.root, target).startsWith('..'), false);
  }
}
function launch(paths, appPath) {
  return launchElectron({
    projectRoot, root: paths.root, appPath, userDataDir: paths.userDataDir, resultFile: paths.resultFile,
    fixtureFile: undefined, dataRoot: paths.dataRoot, configureHarness: false, timeoutMs: 30_000,
    env: { ...process.env, KAOYAN_USE_RENDERER_BUILD: '1', KAOYAN_C7_RESULT_FILE: paths.resultFile }
  });
}

test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

test('C7 real Electron enables the loopback host after pairing, emergency-stops it, and recovers', async (context) => {
  const paths = prepare(createRoot('lifecycle'));
  isolated(paths);
  const wrapper = writeWrapper(paths, 'lifecycle-wrapper', `
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { McpLoopbackHost } = require(${JSON.stringify(path.join(projectRoot, 'dist', 'main', 'main', 'mcp', 'server.js'))});
const resultFile = process.env.KAOYAN_C7_RESULT_FILE;
const discovery = () => path.join(app.getPath('userData'), 'agent-mcp', 'mcp-loopback.discovery.json');
const wait = async (predicate) => { const deadline = Date.now() + 15000; while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error('C7 Electron lifecycle timeout'); };
const report = (value) => { fs.writeFileSync(resultFile, JSON.stringify(value), 'utf8'); setTimeout(() => app.quit(), 50); };
app.whenReady().then(async () => {
  let enabled = false;
  const authenticator = { async admitInitialize({ protocolVersion }) { return { sessionId: '00000000-0000-4000-8000-000000000701', protocolVersion, expiresAt: new Date(Date.now() + 60000).toISOString() }; }, async validateSession() { return Object.freeze({ clientId: 'c7-electron' }); }, async invalidateAll() {} };
  const host = new McpLoopbackHost({ discoveryRoot: path.join(app.getPath('userData'), 'agent-mcp'), externalControlEnabled: () => enabled, authenticatedReady: () => true, authenticator, discoveryOwnershipCheck: () => true });
  const assertions = ['ordinary startup began with no external listener'];
  if ((await host.start()).state !== 'disabled') throw new Error('disabled mode did not fence the host');
  enabled = true;
  await host.start();
  await wait(() => fs.existsSync(discovery()));
  assertions.push('real Electron loopback host enabled after pairing authority');
  enabled = false;
  await host.disable();
  await wait(() => !fs.existsSync(discovery()));
  assertions.push('emergency stop removed discovery and listener immediately');
  enabled = true;
  await host.start();
  await wait(() => fs.existsSync(discovery()));
  assertions.push('external control recovered in the same Electron process');
  await host.stop();
  await wait(() => !fs.existsSync(discovery()));
  report({ ok: true, assertions });
}).catch((error) => report({ ok: false, assertions: [], error: error instanceof Error ? error.message : String(error) }));
`);
  const app = launch(paths, wrapper);
  context.after(() => app.terminate());
  const result = await app.waitForResult();
  assert.equal(result.ok, true, `${JSON.stringify(result)} output=${JSON.stringify(app.getOutput())}`);
  assert.ok(result.assertions.includes('emergency stop removed discovery and listener immediately'));
  assert.equal((await app.exit).exitCode, 0);
});

test('C7 real Electron recovery-fence startup publishes no MCP discovery', async (context) => {
  const paths = prepare(createRoot('recovery-fence'));
  isolated(paths);
  const first = launch(paths, projectRoot);
  context.after(() => first.terminate());
  const databasePath = path.join(paths.dataRoot, 'data', 'mistakes.db');
  await waitForFile(databasePath);
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(fs.existsSync(path.join(paths.userDataDir, 'agent-mcp', 'mcp-loopback.discovery.json')), false);
  await first.terminate();
  fs.writeFileSync(databasePath, Buffer.from('not-a-sqlite-database'), { flag: 'w' });
  const failureWrapper = writeWrapper(paths, 'recovery-failure-wrapper', `
const { dialog } = require('electron');
dialog.showErrorBox = () => {};
require(${JSON.stringify(builtMain)});
`);
  const second = launch(paths, failureWrapper);
  context.after(() => second.terminate());
  await assert.rejects(second.waitForResult(), /before writing its harness result|exited before writing|timed out/i);
  assert.equal(fs.existsSync(path.join(paths.userDataDir, 'agent-mcp', 'mcp-loopback.discovery.json')), false);
});

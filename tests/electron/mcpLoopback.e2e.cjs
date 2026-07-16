const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { launchElectron } = require('./launchElectron.cjs');

const projectRoot = path.resolve(__dirname, '../..');
const roots = new Set();
function prepare() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-c2-electron-'));
  roots.add(root);
  const fixtureFile = path.join(root, 'fixture.json');
  const resultFile = path.join(root, 'result.json');
  const userDataDir = path.join(root, 'user-data');
  const dataRoot = path.join(root, 'data-root');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(fixtureFile, '{"version":1}', 'utf8');
  fs.writeFileSync(resultFile, '', 'utf8');
  return { root, fixtureFile, resultFile, userDataDir, dataRoot };
}
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

test('real Electron remains functional with external control disabled and publishes no loopback discovery', async () => {
  const paths = prepare();
  const launch = launchElectron({
    projectRoot,
    root: paths.root,
    appPath: projectRoot,
    userDataDir: paths.userDataDir,
    resultFile: paths.resultFile,
    fixtureFile: paths.fixtureFile,
    dataRoot: paths.dataRoot,
    timeoutMs: 30_000,
    env: { ...process.env, KAOYAN_USE_RENDERER_BUILD: '1' }
  });
  const result = await launch.waitForResult();
  assert.equal(result.ok, true);
  await launch.exit;
  assert.equal(fs.existsSync(path.join(paths.userDataDir, 'agent-mcp', 'mcp-loopback.discovery.json')), false);
});

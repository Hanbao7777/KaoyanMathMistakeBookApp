const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const environment = require('../main/helpers/controlPlaneTestEnv.cjs');
const { assertOwnedPath, launchElectron } = require('./launchElectron.cjs');

const projectRoot = path.resolve(__dirname, '../..');
const testRoot = environment.testRoot;
const userDataDir = environment.userDataRoot;
const resultFile = path.join(environment.resultRoot, 'harness.json');
const fixturePath = path.join(testRoot, 'electron-harness.cjs');

function assertSafePath(target) {
  const normalizedTarget = path.resolve(target).toLowerCase();
  const normalizedRealRoot = environment.realDataRoot.toLowerCase();
  assert.equal(normalizedTarget.includes(normalizedRealRoot), false);
  assert.equal(normalizedRealRoot.includes(normalizedTarget), false);
  assert.equal(assertOwnedPath(target, testRoot, 'test path'), path.resolve(target));
}

function writeHarnessFixture() {
  const builtMain = path.join(projectRoot, 'dist', 'main', 'main', 'main.js');
  const builtRenderer = path.join(projectRoot, 'dist', 'renderer', 'index.html');
  fs.writeFileSync(fixturePath, `
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const resultFile = process.env.KAOYAN_E2E_RESULT_FILE;
if (process.env.KAOYAN_E2E_HARNESS !== '1') throw new Error('B0 harness flag is required');
if (process.env.ELECTRON_RUN_AS_NODE) throw new Error('ELECTRON_RUN_AS_NODE must be removed');
if (!fs.existsSync(${JSON.stringify(builtMain)}) || !fs.existsSync(${JSON.stringify(builtRenderer)})) {
  throw new Error('Built Electron outputs are required for the B0 smoke fixture');
}
app.whenReady().then(() => {
  fs.mkdirSync(path.dirname(resultFile), { recursive: true });
  fs.writeFileSync(resultFile, JSON.stringify({ kind: 'harness-ready', userData: app.getPath('userData') }), 'utf8');
  setInterval(() => {}, 1_000);
});
`);
}

function writeFixture(name, source) {
  const target = path.join(testRoot, `electron-${name}.cjs`);
  fs.writeFileSync(target, source);
  return target;
}

function createLaunchOptions(name, appPath, timeoutMs = 20_000) {
  return {
    projectRoot,
    root: testRoot,
    appPath,
    userDataDir: path.join(environment.userDataRoot, name),
    resultFile: path.join(environment.resultRoot, `${name}.json`),
    timeoutMs,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  };
}

test.after(() => environment.cleanupControlPlaneRoot());

test('rejects Electron paths outside the owned temporary root', () => {
  assert.throws(() => assertOwnedPath(environment.realDataRoot, testRoot, 'result file'), /escapes/);
  assert.throws(() => assertOwnedPath(path.join(testRoot, '..', 'outside'), testRoot, 'userData'), /escapes/);
});

test('rejects arbitrary and real-data roots before Electron can spawn', () => {
  const sharedOptions = {
    projectRoot,
    appPath: fixturePath,
    userDataDir,
    resultFile,
    electronBinary: ''
  };

  assert.throws(
    () => launchElectron({ ...sharedOptions, root: path.join(projectRoot, 'unsafe-electron-root') }),
    /unique kaoyan-\* child/
  );
  assert.throws(
    () => launchElectron({ ...sharedOptions, root: environment.realDataRoot }),
    /never access the real data root/
  );
});

test('launches installed Electron with isolated userData and a structured harness result', { skip: process.platform !== 'win32' }, async (context) => {
  environment.prepareAgentTestEnvironment();
  writeHarnessFixture();
  for (const target of [testRoot, userDataDir, resultFile, fixturePath]) assertSafePath(target);

  const launch = launchElectron(createLaunchOptions('smoke', fixturePath));
  context.after(() => launch.terminate());

  const result = await launch.waitForResult();
  assert.equal(result.kind, 'harness-ready');
  assert.equal(path.resolve(result.userData), path.resolve(launch.userDataDir));
  assert.equal(fs.existsSync(launch.resultFile), true);
  assert.equal(launch.getOutput().stderr.includes('ELECTRON_RUN_AS_NODE must be removed'), false);

  const firstTermination = await launch.terminate();
  const secondTermination = await launch.terminate();
  assert.deepEqual(secondTermination, firstTermination);
});

test('reports early Electron exit state and captured stderr', { skip: process.platform !== 'win32' }, async () => {
  environment.prepareAgentTestEnvironment();
  const exitFixture = writeFixture('exit', `
const { app } = require('electron');
app.whenReady().then(() => {
  console.error('B0_EARLY_EXIT_STDERR');
  app.exit(17);
});
`);
  const launch = launchElectron(createLaunchOptions('early-exit', exitFixture, 5_000));

  await assert.rejects(launch.waitForResult(), (error) => {
    assert.match(error.message, /Electron exited before writing its harness result/);
    assert.match(error.message, /exit code: 17/);
    assert.match(error.message, /B0_EARLY_EXIT_STDERR/);
    return true;
  });
});

test('times out explicitly and terminates the Electron process', { skip: process.platform !== 'win32' }, async () => {
  environment.prepareAgentTestEnvironment();
  const timeoutFixture = writeFixture('timeout', `
const { app } = require('electron');
app.whenReady().then(() => {
  console.error('B0_TIMEOUT_STDERR');
  setInterval(() => {}, 1_000);
});
`);
  const launch = launchElectron(createLaunchOptions('timeout', timeoutFixture, 750));

  await assert.rejects(launch.waitForResult(), /Electron harness timed out after 750ms/);
  const exit = await launch.exit;
  assert.equal(launch.child.exitCode !== null || launch.child.signalCode !== null, true);
  assert.notEqual(exit.exitCode === null && exit.signal === null, true);
});

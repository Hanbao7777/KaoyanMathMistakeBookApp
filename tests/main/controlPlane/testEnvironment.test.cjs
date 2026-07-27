const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const environment = require('../helpers/controlPlaneTestEnv.cjs');

test.after(() => {
  environment.cleanupControlPlaneRoot();
});

test('creates unique isolated roots under the OS temporary directory', () => {
  const paths = environment.getControlPlanePaths();

  assert.equal(paths.testRoot.startsWith(os.tmpdir()), true);
  assert.equal(path.basename(paths.testRoot).startsWith('kaoyan-control-plane-'), true);
  assert.notEqual(paths.dataRoot, paths.userDataRoot);
  assert.notEqual(paths.dataRoot, paths.recoveryRoot);
  assert.notEqual(paths.userDataRoot, paths.recoveryRoot);
  assert.equal(environment.assertOwnedPath(paths.dataRoot), paths.dataRoot);
  assert.equal(environment.assertOwnedPath(paths.userDataRoot), paths.userDataRoot);
  assert.equal(environment.assertOwnedPath(paths.recoveryRoot), paths.recoveryRoot);
});

test('never overlaps the default real data root', () => {
  const paths = environment.getControlPlanePaths();
  const realRoot = environment.realDataRoot.toLowerCase();

  for (const root of [paths.testRoot, paths.dataRoot, paths.userDataRoot, paths.recoveryRoot]) {
    const normalized = root.toLowerCase();
    assert.notEqual(normalized, realRoot);
    assert.equal(normalized.includes(realRoot), false);
    assert.equal(realRoot.includes(normalized), false);
  }
});

test('reset initializes only control-plane paths', async () => {
  await environment.resetControlPlaneEnvironment();
  const paths = environment.getControlPlanePaths();

  assert.equal(fs.existsSync(paths.dataRoot), true);
  assert.equal(fs.existsSync(path.join(paths.dataRoot, 'data', 'mistakes.db')), true);
  assert.equal(fs.existsSync(path.join(paths.userDataRoot, 'data-root.json')), true);
  assert.equal(fs.existsSync(paths.recoveryRoot), true);
  assert.deepEqual(new Set(fs.readdirSync(paths.testRoot)), new Set(['data-root', 'user-data']));
});

test('rejects path escapes and unsafe cleanup targets', () => {
  const paths = environment.getControlPlanePaths();

  assert.throws(() => environment.assertOwnedPath(environment.realDataRoot), /real data root/);
  assert.throws(() => environment.assertOwnedPath(path.join(paths.testRoot, '..', 'outside')), /escapes/);
  assert.throws(() => environment.cleanupControlPlaneRoot(environment.realDataRoot), /real data root/);
  assert.throws(() => environment.cleanupControlPlaneRoot(paths.dataRoot), /only its temporary root/);
});

test('cleanup removes only the isolated root and is idempotent', () => {
  const paths = environment.getControlPlanePaths();

  environment.cleanupControlPlaneRoot();
  assert.equal(fs.existsSync(paths.testRoot), false);
  environment.cleanupControlPlaneRoot();
  assert.equal(fs.existsSync(paths.testRoot), false);
});

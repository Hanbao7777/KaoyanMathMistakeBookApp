const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const environment = require('../helpers/controlPlaneTestEnv.cjs');

test.after(() => environment.cleanupControlPlaneRoot());

test('provides unique Phase B roots confined to an OS temporary directory', () => {
  const paths = environment.prepareAgentTestEnvironment();
  const isolatedPaths = [
    paths.testRoot,
    paths.dataRoot,
    paths.userDataRoot,
    paths.recoveryRoot,
    paths.agentDatabaseRoot,
    paths.agentDatabasePath,
    paths.ledgerRoot,
    paths.resultRoot
  ];

  assert.equal(paths.testRoot.startsWith(os.tmpdir()), true);
  assert.equal(new Set(isolatedPaths.map((target) => target.toLowerCase())).size, isolatedPaths.length);
  for (const target of isolatedPaths) {
    assert.equal(environment.assertOwnedPath(target), path.resolve(target));
    assert.equal(target.toLowerCase().includes(environment.realDataRoot.toLowerCase()), false);
    assert.equal(environment.realDataRoot.toLowerCase().includes(target.toLowerCase()), false);
  }
  assert.equal(fs.existsSync(paths.agentDatabaseRoot), true);
  assert.equal(fs.existsSync(paths.ledgerRoot), true);
  assert.equal(fs.existsSync(paths.resultRoot), true);
});

test('rejects paths that escape the Phase B root or overlap real data', () => {
  const paths = environment.getControlPlanePaths();

  assert.throws(() => environment.assertOwnedPath(path.join(paths.testRoot, '..', 'unsafe')), /escapes/);
  assert.throws(() => environment.assertOwnedPath(environment.realDataRoot), /real data root/);
  assert.throws(() => environment.cleanupControlPlaneRoot(paths.ledgerRoot), /only its temporary root/);
});

test('supplies deterministic clock and UUID seams', () => {
  const clock = environment.createDeterministicClock('2026-07-15T12:00:00.000Z');
  const randomUUID = environment.createDeterministicUuid();

  assert.equal(clock.now(), '2026-07-15T12:00:00.000Z');
  assert.equal(clock.advance(250), '2026-07-15T12:00:00.250Z');
  assert.equal(randomUUID(), '00000000-0000-4000-8000-000000000001');
  assert.equal(randomUUID(), '00000000-0000-4000-8000-000000000002');
  assert.throws(() => environment.createDeterministicClock('not-a-date'), /valid ISO timestamp/);
  assert.throws(() => clock.advance(Number.NaN), /finite/);
});

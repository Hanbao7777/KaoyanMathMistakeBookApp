const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  assertOwnedPath,
  cleanupControlPlaneRoot,
  databaseService,
  getControlPlanePaths,
  resetControlPlaneEnvironment
} = require('../helpers/controlPlaneTestEnv.cjs');

test.after(() => cleanupControlPlaneRoot());
test.beforeEach(resetControlPlaneEnvironment);

async function seedQuestion() {
  const coordinator = await databaseService.getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: 'root-switch-seed',
    concurrency: 'none',
    execute(database) {
      database.run(`INSERT INTO questions (
        title, content, wrong_thinking, wrong_solution, correct_solution, answer, subject, category,
        question_type, error_reason, source, difficulty, mastery_level, note, created_at, updated_at
      ) VALUES ('root question', '', '', '', '', '', '高等数学', '其他', '其他', '其他', '', '中等', '一般', '', ?, ?)`,
      [new Date().toISOString(), new Date().toISOString()]);
      return { changed: true, value: true };
    }
  });
}

test('migrated root is hash-verified before atomic config publication and receives a fresh epoch', async () => {
  await seedQuestion();
  const oldVersion = (await databaseService.getDatabaseCoordinator()).currentVersion();
  const target = assertOwnedPath(path.join(getControlPlanePaths().testRoot, 'migrated-root'));
  const stages = [];

  const paths = await databaseService.switchDataRoot(target, true, {
    maintenance: { createEpoch: () => 'root-epoch' },
    root: { hook: (stage) => stages.push(stage) }
  });

  assert.equal(paths.root, target);
  assert.deepEqual((await databaseService.getDatabaseCoordinator()).currentVersion(), { dataEpoch: 'root-epoch', dataRevision: 0 });
  assert.notEqual(oldVersion.dataEpoch, 'root-epoch');
  assert.equal((await databaseService.listQuestions()).length, 1);
  assert.deepEqual(stages, [
    'before_space_check', 'after_space_check', 'after_copy', 'after_verify',
    'before_config_publish', 'after_config_publish'
  ]);
  const manifestRoot = path.join(getControlPlanePaths().userDataRoot, 'agent-recovery', 'operation-journal');
  const rootManifest = fs.readdirSync(manifestRoot)
    .filter((name) => name.endsWith('.operation.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(manifestRoot, name), 'utf8')))
    .find((manifest) => manifest.commandType === 'database.switch_root');
  assert.ok(rootManifest);
  assert.equal(rootManifest.state, 'completed');
  assert.deepEqual(rootManifest.versionAfter, { dataEpoch: 'root-epoch', dataRevision: 0 });
});

test('root switch rejects every pre-existing nonempty target before creating managed directories', async () => {
  const original = databaseService.getCurrentPaths();
  const targetWithFile = assertOwnedPath(path.join(getControlPlanePaths().testRoot, 'nonempty-file-root'));
  fs.mkdirSync(targetWithFile, { recursive: true });
  fs.writeFileSync(path.join(targetWithFile, 'unrelated.txt'), 'occupied');
  await assert.rejects(databaseService.switchDataRoot(targetWithFile, false), /must be empty/);
  assert.deepEqual(fs.readdirSync(targetWithFile), ['unrelated.txt']);
  assert.equal(databaseService.getCurrentPaths().root, original.root);

  const targetWithDirectory = assertOwnedPath(path.join(getControlPlanePaths().testRoot, 'nonempty-directory-root'));
  fs.mkdirSync(path.join(targetWithDirectory, 'unrelated-directory'), { recursive: true });
  await assert.rejects(databaseService.switchDataRoot(targetWithDirectory, false), /must be empty/);
  assert.deepEqual(fs.readdirSync(targetWithDirectory), ['unrelated-directory']);
  assert.equal(fs.existsSync(path.join(targetWithDirectory, 'data')), false);
  assert.equal(databaseService.getCurrentPaths().root, original.root);

  const emptyTarget = assertOwnedPath(path.join(getControlPlanePaths().testRoot, 'existing-empty-root'));
  fs.mkdirSync(emptyTarget, { recursive: true });
  await databaseService.switchDataRoot(emptyTarget, false, {
    maintenance: { createEpoch: () => 'existing-empty-epoch' }
  });
  assert.equal(databaseService.getCurrentPaths().root, emptyTarget);
  assert.deepEqual((await databaseService.getDatabaseCoordinator()).currentVersion(), {
    dataEpoch: 'existing-empty-epoch', dataRevision: 0
  });
});

test('failed maintenance acquisition does not stop the current JobExecutor', async () => {
  const coordinator = await databaseService.getDatabaseCoordinator();
  const plane = await databaseService.getAgentControlPlane();
  const lease = await coordinator.beginMaintenance();
  try {
    const target = assertOwnedPath(path.join(getControlPlanePaths().testRoot, 'already-maintained-root'));
    await assert.rejects(
      databaseService.switchDataRoot(target, false),
      (error) => error.code === 'MAINTENANCE_FENCE'
    );
    assert.equal(plane.jobExecutor.isStopped(), false);
    assert.equal(plane.jobExecutor.isIdle(), true);
  } finally {
    coordinator.finishMaintenance(lease, 'writable');
  }
});

test('insufficient space and copy/config phase failures leave the prior root authoritative', async () => {
  await seedQuestion();
  const original = databaseService.getCurrentPaths();
  const version = (await databaseService.getDatabaseCoordinator()).currentVersion();

  const noSpaceRoot = assertOwnedPath(path.join(getControlPlanePaths().testRoot, 'no-space-root'));
  await assert.rejects(
    databaseService.switchDataRoot(noSpaceRoot, true, { root: { availableBytes: () => 0 } }),
    /Insufficient space/
  );
  assert.equal(databaseService.getCurrentPaths().root, original.root);
  assert.deepEqual((await databaseService.getDatabaseCoordinator()).currentVersion(), version);

  const failedRoot = assertOwnedPath(path.join(getControlPlanePaths().testRoot, 'failed-root'));
  await assert.rejects(
    databaseService.switchDataRoot(failedRoot, true, {
      root: { hook(stage) { if (stage === 'after_config_publish') throw new Error('injected-config-failure'); } }
    }),
    /injected-config-failure/
  );
  assert.equal(databaseService.getCurrentPaths().root, original.root);
  assert.deepEqual((await databaseService.getDatabaseCoordinator()).currentVersion(), version);
  assert.equal((await databaseService.listQuestions()).length, 1);

  const corruptRoot = assertOwnedPath(path.join(getControlPlanePaths().testRoot, 'corrupt-copy-root'));
  await assert.rejects(
    databaseService.switchDataRoot(corruptRoot, true, {
      root: {
        hook(stage) {
          if (stage === 'after_copy') fs.appendFileSync(path.join(corruptRoot, 'data', 'mistakes.db'), 'corrupt');
        }
      }
    }),
    /verification failed/
  );
  assert.equal(databaseService.getCurrentPaths().root, original.root);

  const publishFailureRoot = assertOwnedPath(path.join(getControlPlanePaths().testRoot, 'publish-failure-root'));
  await assert.rejects(
    databaseService.switchDataRoot(publishFailureRoot, true, {
      maintenance: {
        atomicHook(context) {
          if (context.stage === 'afterTempFlush') throw new Error('injected-root-publication-failure');
        }
      }
    }),
    /New-root database could not be verified/
  );
  assert.equal(databaseService.getCurrentPaths().root, original.root);
});

test('new empty root becomes authoritative only after a verified revision-zero database exists', async () => {
  await seedQuestion();
  const target = assertOwnedPath(path.join(getControlPlanePaths().testRoot, 'fresh-root'));
  await databaseService.switchDataRoot(target, false, {
    maintenance: { createEpoch: () => 'fresh-root-epoch' }
  });
  assert.equal(databaseService.getCurrentPaths().root, target);
  assert.deepEqual((await databaseService.getDatabaseCoordinator()).currentVersion(), { dataEpoch: 'fresh-root-epoch', dataRevision: 0 });
  assert.equal((await databaseService.listQuestions()).length, 0);
  assert.equal(fs.existsSync(path.join(target, 'data', 'mistakes.db')), true);
});

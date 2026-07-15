const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  cleanupControlPlaneRoot,
  databaseService,
  getControlPlanePaths,
  requireMain,
  resetControlPlaneEnvironment
} = require('../helpers/controlPlaneTestEnv.cjs');

const backupService = requireMain('services/backupService.js');
const pathService = requireMain('services/pathService.js');

test.after(() => cleanupControlPlaneRoot());
test.beforeEach(resetControlPlaneEnvironment);

async function insertQuestion(title, imagePath = null) {
  const coordinator = await databaseService.getDatabaseCoordinator();
  return coordinator.executeWrite({
    requestId: `seed-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    concurrency: 'none',
    execute(database) {
      database.run(`INSERT INTO questions (
        title, content, wrong_thinking, wrong_solution, correct_solution, answer, subject, category,
        question_type, error_reason, source, difficulty, mastery_level, note, created_at, updated_at
      ) VALUES (?, '', '', '', '', '', '高等数学', '其他', '其他', '其他', '', '中等', '一般', '', ?, ?)`,
      [title, new Date().toISOString(), new Date().toISOString()]);
      if (imagePath) {
        const id = database.exec('SELECT last_insert_rowid()')[0].values[0][0];
        database.run("INSERT INTO question_images (question_id, image_type, file_path, created_at) VALUES (?, 'question', ?, ?)", [id, imagePath, new Date().toISOString()]);
      }
      return { changed: true, value: true };
    }
  });
}

test('restore validates first, publishes a new epoch at revision zero, and invalidates old versions', async () => {
  await insertQuestion('before backup');
  const backup = await backupService.createDatabaseBackupMaintained('manual');
  await insertQuestion('after backup');
  const oldVersion = (await databaseService.getDatabaseCoordinator()).currentVersion();

  const restored = await backupService.restoreDatabaseBackup(path.basename(backup.filePath), {
    createEpoch: () => 'restored-epoch'
  });

  assert.equal(restored.restored, true);
  assert.equal(fs.existsSync(restored.beforeRestoreBackup), true);
  const coordinator = await databaseService.getDatabaseCoordinator();
  assert.deepEqual(coordinator.currentVersion(), { dataEpoch: 'restored-epoch', dataRevision: 0 });
  assert.equal((await databaseService.listQuestions()).length, 1);
  await assert.rejects(
    coordinator.executeWrite({
      requestId: 'stale-after-restore',
      concurrency: 'strict',
      expectedVersion: oldVersion,
      execute: () => ({ changed: false, value: null })
    }),
    (error) => error && error.code === 'DATA_EPOCH_MISMATCH'
  );
});

test('corrupt restore and pre-publication failures leave the original candidate authoritative', async () => {
  await insertQuestion('authoritative');
  const before = (await databaseService.getDatabaseCoordinator()).currentVersion();
  const paths = pathService.getPaths();
  const corruptName = 'mistakes_backup_corrupt.db';
  fs.writeFileSync(path.join(paths.backups, corruptName), 'not a database');
  await assert.rejects(backupService.restoreDatabaseBackup(corruptName), /corrupt|incompatible|ambiguous/i);
  assert.deepEqual((await databaseService.getDatabaseCoordinator()).currentVersion(), before);

  const valid = await backupService.createDatabaseBackupMaintained('manual');
  await assert.rejects(
    backupService.restoreDatabaseBackup(path.basename(valid.filePath), {
      atomicHook(context) {
        if (context.stage === 'afterTempFlush') throw new Error('injected-before-publication');
      }
    }),
    /not published/
  );
  assert.deepEqual((await databaseService.getDatabaseCoordinator()).currentVersion(), before);
  assert.equal((await databaseService.listQuestions())[0].title, 'authoritative');
});

test('clear-all quarantines managed images and retains a verified consistency package', async () => {
  const paths = pathService.getPaths();
  const imagePath = path.join(paths.images, 'clear-me.png');
  fs.writeFileSync(imagePath, Buffer.from('image-bytes'));
  await insertQuestion('with image', imagePath);
  const before = (await databaseService.getDatabaseCoordinator()).currentVersion();

  await databaseService.clearAllData(true, { createEpoch: () => 'clear-epoch' });

  assert.equal(fs.existsSync(imagePath), false);
  assert.deepEqual((await databaseService.getDatabaseCoordinator()).currentVersion(), { dataEpoch: 'clear-epoch', dataRevision: 0 });
  assert.notEqual(before.dataEpoch, 'clear-epoch');
  assert.equal((await databaseService.listQuestions()).length, 0);
  const recoveryRoot = path.join(getControlPlanePaths().userDataRoot, 'agent-recovery');
  const packageNames = fs.readdirSync(path.join(recoveryRoot, 'consistency-packages'));
  assert.ok(packageNames.some((name) => name.endsWith('.before.db')));
  assert.ok(packageNames.some((name) => name.endsWith('.managed-files.json')));
  const quarantineNames = fs.readdirSync(path.join(paths.temp, 'a11-quarantine'));
  assert.equal(quarantineNames.length, 1);
});

test('restart reconciliation completes a replacement journal interrupted after database publication', async () => {
  await insertQuestion('restart source');
  const backup = await backupService.createDatabaseBackupMaintained('manual');
  let injected = false;
  await backupService.restoreDatabaseBackup(path.basename(backup.filePath), {
    createEpoch: () => 'restart-epoch',
    journal: {
      hook({ boundary, phase }) {
        if (!injected && boundary === 'after' && phase === 'db_committed_publish') {
          injected = true;
          throw new Error('simulated crash boundary');
        }
      }
    }
  });
  assert.equal(injected, true);
  assert.deepEqual((await databaseService.getDatabaseCoordinator()).currentVersion(), { dataEpoch: 'restart-epoch', dataRevision: 0 });
  const manifestRoot = path.join(getControlPlanePaths().userDataRoot, 'agent-recovery', 'operation-journal');
  const manifests = fs.readdirSync(manifestRoot).filter((name) => name.endsWith('.operation.json'));
  const states = manifests.map((name) => JSON.parse(fs.readFileSync(path.join(manifestRoot, name), 'utf8')).state);
  assert.ok(states.every((state) => state === 'completed'));
});

test('global JSON import replaces identity through the same recovery kernel', async () => {
  await insertQuestion('exported question');
  const exported = await databaseService.exportData();
  await insertQuestion('later question');
  const before = (await databaseService.getDatabaseCoordinator()).currentVersion();

  const result = await databaseService.importData(exported);

  assert.equal(result.imported, true);
  assert.equal(fs.existsSync(result.backup), true);
  const after = (await databaseService.getDatabaseCoordinator()).currentVersion();
  assert.notEqual(after.dataEpoch, before.dataEpoch);
  assert.equal(after.dataRevision, 0);
  assert.deepEqual((await databaseService.listQuestions()).map((question) => question.title), ['exported question']);
});

test('global JSON import rejects unsafe or missing managed image references before epoch publication', async () => {
  await insertQuestion('authoritative import state');
  const exported = await databaseService.exportData();
  const payload = JSON.parse(fs.readFileSync(exported, 'utf8'));
  const version = (await databaseService.getDatabaseCoordinator()).currentVersion();
  const paths = pathService.getPaths();
  const outsidePath = path.join(getControlPlanePaths().testRoot, 'outside-image.png');
  fs.writeFileSync(outsidePath, 'outside');

  payload.question_images = [{
    id: 1,
    question_id: payload.questions[0].id,
    image_type: 'question',
    file_path: outsidePath,
    created_at: new Date().toISOString()
  }];
  const unsafeImport = path.join(paths.exports, 'unsafe-image-import.json');
  fs.writeFileSync(unsafeImport, JSON.stringify(payload));
  await assert.rejects(databaseService.importData(unsafeImport), /IMPORT_MANAGED_FILE_MISSING/);
  assert.deepEqual((await databaseService.getDatabaseCoordinator()).currentVersion(), version);
  assert.deepEqual((await databaseService.listQuestions()).map((question) => question.title), ['authoritative import state']);

  payload.question_images[0].file_path = path.join(paths.images, 'missing-image.png');
  const missingImport = path.join(paths.exports, 'missing-image-import.json');
  fs.writeFileSync(missingImport, JSON.stringify(payload));
  await assert.rejects(databaseService.importData(missingImport), /IMPORT_MANAGED_FILE_MISSING/);
  assert.deepEqual((await databaseService.getDatabaseCoordinator()).currentVersion(), version);
  assert.deepEqual((await databaseService.listQuestions()).map((question) => question.title), ['authoritative import state']);
});

test('maintenance replacement drains an admitted write and rejects new racing writes', async () => {
  const coordinator = await databaseService.getDatabaseCoordinator();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const enteredGate = new Promise((resolve) => { entered = resolve; });
  const write = coordinator.executeWrite({
    requestId: 'write-before-maintenance',
    concurrency: 'none',
    async execute(database) {
      entered();
      await gate;
      database.run(`INSERT INTO questions (
        title, content, wrong_thinking, wrong_solution, correct_solution, answer, subject, category,
        question_type, error_reason, source, difficulty, mastery_level, note, created_at, updated_at
      ) VALUES ('drained write', '', '', '', '', '', '高等数学', '其他', '其他', '其他', '', '中等', '一般', '', ?, ?)`,
      [new Date().toISOString(), new Date().toISOString()]);
      return { changed: true, value: true };
    }
  });
  await enteredGate;
  const clear = databaseService.clearAllData(false, { createEpoch: () => 'maintenance-epoch' });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    coordinator.executeWrite({
      requestId: 'write-during-maintenance', concurrency: 'none', execute: () => ({ changed: false, value: null })
    }),
    /maintenance/i
  );
  release();
  await write;
  await clear;
  assert.deepEqual((await databaseService.getDatabaseCoordinator()).currentVersion(), { dataEpoch: 'maintenance-epoch', dataRevision: 0 });
  assert.equal((await databaseService.listQuestions()).length, 0);
});

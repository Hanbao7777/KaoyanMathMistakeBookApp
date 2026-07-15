const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const initSqlJs = require('sql.js');
const {
  cleanupTestRoot,
  databaseService,
  requireMain,
  resetTestDatabase
} = require('./helpers/mainTestEnv.cjs');

const backupService = requireMain('services/backupService.js');
const ticktickService = requireMain('services/ticktickService.js');

test.after(cleanupTestRoot);

test.beforeEach(resetTestDatabase);

async function openBackupDatabase(filePath) {
  const SQL = await initSqlJs({
    locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm')
  });
  return new SQL.Database(fs.readFileSync(filePath));
}

function oneValue(db, sql, params = []) {
  const result = db.exec(sql, params);
  if (!result.length || !result[0].values.length) return null;
  return result[0].values[0][0];
}

test('createDatabaseBackup writes readable backup database file', async () => {
  const list = await ticktickService.createTickTickList({ name: '备份清单' });
  await ticktickService.createTickTickTask({ list_id: list.id, title: '备份前任务' });

  const backup = await backupService.createDatabaseBackupMaintained('manual');

  assert.equal(fs.existsSync(backup.filePath), true);
  assert.ok(fs.statSync(backup.filePath).size > 0);

  const backupDb = await openBackupDatabase(backup.filePath);
  try {
    assert.equal(oneValue(backupDb, 'SELECT COUNT(*) FROM ticktick_tasks'), 1);
    assert.equal(oneValue(backupDb, 'SELECT title FROM ticktick_tasks LIMIT 1'), '备份前任务');
  } finally {
    backupDb.close();
  }
});

test('restoreDatabaseBackup restores readable database data', async () => {
  const list = await ticktickService.createTickTickList({ name: '恢复清单' });
  await ticktickService.createTickTickTask({ list_id: list.id, title: '恢复前任务' });
  const backup = await backupService.createDatabaseBackupMaintained('manual');

  await ticktickService.createTickTickTask({ list_id: list.id, title: '备份后任务' });
  assert.equal((await ticktickService.listTickTickTasks({ includeCompleted: true })).length, 2);

  const restored = await backupService.restoreDatabaseBackup(path.basename(backup.filePath));

  assert.equal(restored.restored, true);
  assert.equal(fs.existsSync(restored.beforeRestoreBackup), true);

  const tasks = await ticktickService.listTickTickTasks({ includeCompleted: true });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, '恢复前任务');
});

test('deleteDatabaseBackup journals quarantine and advances one database revision', async () => {
  const backup = await backupService.createDatabaseBackupMaintained('manual');
  const before = (await databaseService.getDatabaseCoordinator()).currentVersion();

  assert.equal(await backupService.deleteDatabaseBackup(path.basename(backup.filePath)), true);

  const after = (await databaseService.getDatabaseCoordinator()).currentVersion();
  assert.deepEqual(after, { dataEpoch: before.dataEpoch, dataRevision: before.dataRevision + 1 });
  assert.equal(fs.existsSync(backup.filePath), false);
  const paths = requireMain('services/pathService.js').getPaths();
  const quarantine = fs.readdirSync(path.join(paths.backups, '.quarantine'));
  assert.equal(quarantine.length, 1);
  const manifests = fs.readdirSync(path.join(paths.data, 'operation-journal'));
  const state = JSON.parse(fs.readFileSync(path.join(paths.data, 'operation-journal', manifests[0]), 'utf8')).state;
  assert.equal(state, 'completed');
});

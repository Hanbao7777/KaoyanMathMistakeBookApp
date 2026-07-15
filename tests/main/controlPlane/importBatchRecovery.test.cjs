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

const importBatchService = requireMain('services/importBatchService.js');
const pathService = requireMain('services/pathService.js');

test.after(() => cleanupControlPlaneRoot());
test.beforeEach(resetControlPlaneEnvironment);

async function seedBatch(suffix) {
  const batchId = `wrong_questions-recovery-${suffix}`;
  const question = await databaseService.createQuestion({
    title: '导入批次恢复测试',
    content: '题目内容',
    wrong_thinking: '错误思路',
    wrong_solution: '',
    correct_solution: '正确解析',
    answer: '1',
    subject: '高等数学',
    category: '函数、极限、连续',
    question_type: '解答题',
    error_reason: '概念不清',
    source: '恢复测试',
    difficulty: '中等',
    mastery_level: '一般',
    note: '',
    tags: [],
    questionImageSources: [],
    solutionImageSources: [],
    import_batch_id: batchId
  });
  const assetPath = path.join(pathService.getPaths().root, 'assets', 'question_bank', batchId, 'images', 'asset.txt');
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  fs.writeFileSync(assetPath, `asset-${suffix}`, 'utf8');
  const coordinator = await databaseService.getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: `seed-import-batch-${suffix}`,
    concurrency: 'none',
    execute(database) {
      const timestamp = new Date().toISOString();
      database.run(`INSERT INTO import_batches (
        id, type, name, source_file_name, source, imported_at, item_count, asset_count, status, metadata_json, deleted_at
      ) VALUES (?, 'wrong_questions', '恢复测试批次', 'recovery.zip', '', ?, 1, 1, 'active', '', NULL)`, [batchId, timestamp]);
      database.run(
        "INSERT INTO import_batch_items (batch_id, target_table, target_id, action, created_at) VALUES (?, 'questions', ?, 'created', ?)",
        [batchId, String(question.id), timestamp]
      );
      database.run(
        "INSERT INTO import_assets (batch_id, asset_type, file_path, created_at, deleted_at) VALUES (?, 'question_image', ?, ?, NULL)",
        [batchId, assetPath, timestamp]
      );
      return { changed: true, value: null };
    }
  });
  return { batchId, questionId: question.id, assetPath };
}

function operationManifests() {
  const root = path.join(getControlPlanePaths().dataRoot, 'data', 'operation-journal');
  return fs.existsSync(root)
    ? fs.readdirSync(root).filter((name) => name.endsWith('.operation.json')).map((name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')))
    : [];
}

async function batchStatus(batchId) {
  return (await importBatchService.getImportBatchDetail(batchId)).batch.status;
}

test('database failure compensates quarantined assets and rolls back question plus batch deletion', async () => {
  const seeded = await seedBatch('db-failure');
  const coordinator = await databaseService.getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: 'install-import-delete-failure-trigger',
    concurrency: 'none',
    execute(database) {
      database.run(`CREATE TRIGGER fail_import_batch_delete BEFORE UPDATE OF status ON import_batches
        WHEN NEW.status = 'deleted' BEGIN SELECT RAISE(ABORT, 'forced import delete failure'); END`);
      return { changed: true, value: null };
    }
  });
  const versionBefore = coordinator.currentVersion();

  await assert.rejects(importBatchService.deleteImportBatch(seeded.batchId), /forced import delete failure/);

  assert.deepEqual(coordinator.currentVersion(), versionBefore);
  assert.ok(await databaseService.getQuestion(seeded.questionId));
  assert.equal(await batchStatus(seeded.batchId), 'active');
  assert.equal(fs.existsSync(seeded.assetPath), true);
  const manifest = operationManifests().at(-1);
  assert.equal(manifest.state, 'compensated');
  assert.equal(manifest.lastError.phase, 'database_command');
  assert.equal(fs.existsSync(manifest.files[0].quarantinePath), false);
  assert.equal(fs.existsSync(manifest.files[0].targetPath), true);
  const backups = fs.readdirSync(pathService.getPaths().backups).filter((name) => name.startsWith('mistakes_before_delete_import_'));
  assert.equal(backups.length, 1);
});

test('file finalization failure fences writes and remains needs_recovery after restart', async () => {
  const seeded = await seedBatch('finalization-failure');
  const originalRename = fs.promises.rename;
  fs.promises.rename = async (source, target) => {
    if (String(source).endsWith('.tmp') && String(source).includes('operation-journal')) {
      const value = JSON.parse(fs.readFileSync(source, 'utf8'));
      if (value.state === 'db_committed') throw new Error('forced import asset finalization failure');
    }
    return originalRename.call(fs.promises, source, target);
  };
  try {
    await assert.rejects(
      importBatchService.deleteImportBatch(seeded.batchId),
      (error) => error?.code === 'RECOVERY_FENCE'
    );
  } finally {
    fs.promises.rename = originalRename;
  }

  const coordinator = await databaseService.getDatabaseCoordinator();
  assert.equal(coordinator.state, 'needs_recovery');
  assert.equal(await databaseService.getQuestion(seeded.questionId), null);
  assert.equal(await batchStatus(seeded.batchId), 'deleted');
  const manifest = operationManifests().at(-1);
  assert.equal(manifest.state, 'needs_recovery');
  assert.equal(manifest.lastError.phase, 'file_finalization');
  assert.equal(fs.existsSync(manifest.files[0].targetPath), false);
  assert.equal(fs.existsSync(manifest.files[0].quarantinePath), true);

  databaseService.resetDatabaseConnection();
  const restart = await databaseService.initializeDatabase();
  assert.equal(restart.state, 'needs_recovery');
  assert.equal((await databaseService.getDatabaseCoordinator()).state, 'needs_recovery');
  assert.equal(operationManifests().at(-1).state, 'needs_recovery');
});

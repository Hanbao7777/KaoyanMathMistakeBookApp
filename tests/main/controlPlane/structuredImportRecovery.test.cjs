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

const electron = require('electron');
const structuredImportService = requireMain('services/structuredImportService.js');
const importBatchService = requireMain('services/importBatchService.js');

test.after(() => cleanupControlPlaneRoot());
test.beforeEach(async () => {
  await resetControlPlaneEnvironment();
  electron.dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
});

function validRow(imagePath) {
  return {
    title: '恢复测试题',
    content: 'content',
    wrong_thinking: 'wrong',
    correct_solution: 'correct',
    answer: '1',
    subject: '高等数学',
    category: '函数、极限、连续',
    question_type: '解答题',
    error_reason: '概念不清',
    difficulty: '中等',
    mastery_level: '一般',
    source: 'test',
    tags: '恢复',
    knowledge_points: '',
    image_path: imagePath
  };
}

async function prepareJson(row) {
  const sourceRoot = getControlPlanePaths().testRoot;
  const jsonPath = path.join(sourceRoot, `structured-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify([row]));
  electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [jsonPath] });
  return structuredImportService.prepareJsonImport();
}

async function reopenExistingDatabase() {
  databaseService.resetDatabaseConnection();
  await databaseService.initializeDatabase();
}

async function onlyBatchDetail() {
  const batches = await importBatchService.listImportBatches();
  assert.equal(batches.length, 1);
  return importBatchService.getImportBatchDetail(batches[0].id);
}

test('image staging failure compensates the row and finalization survives restart', async () => {
  const source = path.join(getControlPlanePaths().testRoot, 'stage-failure.png');
  fs.writeFileSync(source, Buffer.from('image-source'));
  const preview = await prepareJson(validRow(source));
  const coordinator = await databaseService.getDatabaseCoordinator();
  const versionBefore = coordinator.currentVersion();
  const originalOpen = fs.promises.open;
  fs.promises.open = async (filePath, ...args) => {
    if (String(filePath).endsWith('.stage')) throw new Error('injected stage failure');
    return originalOpen.call(fs.promises, filePath, ...args);
  };

  let result;
  try {
    result = await structuredImportService.confirmStructuredImport(preview.sessionId);
  } finally {
    fs.promises.open = originalOpen;
  }
  assert.equal(result.successCount, 0);
  assert.equal(result.failCount, 1);
  assert.equal((await databaseService.listQuestions({})).length, 0);
  assert.equal(coordinator.currentVersion().dataRevision, versionBefore.dataRevision + 3);
  const journalRoot = path.join(getControlPlanePaths().dataRoot, 'data', 'operation-journal');
  const manifestPath = path.join(journalRoot, fs.readdirSync(journalRoot).find((name) => name.endsWith('.operation.json')));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.state, 'compensated');
  assert.equal(fs.existsSync(manifest.files[0].stagingPath), false);
  assert.equal(fs.existsSync(manifest.files[0].targetPath), false);

  await reopenExistingDatabase();
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).state, 'compensated');
  const detail = await onlyBatchDetail();
  const metadata = JSON.parse(detail.batch.metadata_json);
  assert.equal(detail.batch.status, 'failed');
  assert.equal(detail.batch.item_count, 0);
  assert.equal(detail.batch.asset_count, 0);
  assert.equal(metadata.phase, 'completed');
  assert.equal(metadata.rows[0].status, 'failed');
  assert.equal(metadata.rows[0].imageStatus, 'failed');
  assert.equal(metadata.rows[0].reason, 'An internal error occurred.');
});

test('journaled image commit and explainable finalization survive restart', async () => {
  const source = path.join(getControlPlanePaths().testRoot, 'committed.png');
  fs.writeFileSync(source, Buffer.from('image-source'));
  const preview = await prepareJson(validRow(source));

  const result = await structuredImportService.confirmStructuredImport(preview.sessionId);
  assert.equal(result.successCount, 1);
  assert.equal(result.imageCopiedCount, 1);
  const journalRoot = path.join(getControlPlanePaths().dataRoot, 'data', 'operation-journal');
  const manifests = fs.readdirSync(journalRoot)
    .filter((name) => name.endsWith('.operation.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(journalRoot, name), 'utf8')));
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0].state, 'completed');
  assert.equal(fs.existsSync(manifests[0].files[0].targetPath), true);

  await reopenExistingDatabase();
  const detail = await onlyBatchDetail();
  const metadata = JSON.parse(detail.batch.metadata_json);
  assert.equal(detail.batch.item_count, 1);
  assert.equal(detail.batch.asset_count, 1);
  assert.equal(metadata.phase, 'completed');
  assert.equal(metadata.cleanup, 'completed');
  assert.equal(metadata.rows[0].status, 'succeeded');
  assert.equal(metadata.rows[0].imageStatus, 'committed');
  assert.equal(fs.existsSync(detail.assets[0].file_path), true);
});

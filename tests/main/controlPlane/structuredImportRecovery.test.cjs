const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');
const AdmZip = require('adm-zip');
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

async function prepareZip(entries) {
  const sourceRoot = getControlPlanePaths().testRoot;
  const zipPath = path.join(sourceRoot, `structured-${Date.now()}-${Math.random()}.zip`);
  const sheet = XLSX.utils.json_to_sheet([validRow('images/nested.png')]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'import');
  const zip = new AdmZip();
  zip.addFile('import.xlsx', XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  for (const [name, bytes] of Object.entries(entries)) zip.addFile(name, Buffer.from(bytes));
  zip.writeZip(zipPath);
  electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [zipPath] });
  return { preview: await structuredImportService.prepareZipImport(), zipPath };
}

function manifests() {
  const journalRoot = path.join(getControlPlanePaths().dataRoot, 'data', 'operation-journal');
  return fs.existsSync(journalRoot)
    ? fs.readdirSync(journalRoot)
      .filter((name) => name.endsWith('.operation.json'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(journalRoot, name), 'utf8')))
    : [];
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

  try {
    await assert.rejects(structuredImportService.confirmStructuredImport(preview.sessionId), /injected stage failure/);
  } finally {
    fs.promises.open = originalOpen;
  }
  assert.equal((await databaseService.listQuestions({})).length, 0);
  assert.equal(coordinator.currentVersion().dataRevision, versionBefore.dataRevision + 1);
  const journalRoot = path.join(getControlPlanePaths().dataRoot, 'data', 'operation-journal');
  const manifestPath = path.join(journalRoot, fs.readdirSync(journalRoot).find((name) => name.endsWith('.operation.json')));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.state, 'compensated');
  assert.equal(fs.existsSync(manifest.files[0].stagingPath), false);
  assert.equal(fs.existsSync(manifest.files[0].targetPath), false);

  await reopenExistingDatabase();
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).state, 'compensated');
  assert.equal((await importBatchService.listImportBatches()).length, 0);
  const failedDatabase = await databaseService.getDatabase();
  assert.equal(databaseService.oneSql(failedDatabase, 'SELECT COUNT(*) AS count FROM import_drafts WHERE state = ?', ['collecting']).count, 1);
  assert.equal(databaseService.oneSql(failedDatabase, 'SELECT COUNT(*) AS count FROM import_managed_assets').count, 0);
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
  const applyManifest = manifests.find((manifest) => manifest.commandType === 'imports.apply_draft');
  assert.ok(applyManifest);
  assert.equal(applyManifest.state, 'completed');
  assert.equal(fs.existsSync(applyManifest.files[0].targetPath), true);

  await reopenExistingDatabase();
  const detail = await onlyBatchDetail();
  const metadata = JSON.parse(detail.batch.metadata_json);
  assert.equal(detail.batch.status, 'active');
  assert.equal(detail.batch.item_count, 1);
  assert.equal(detail.batch.asset_count, 1);
  assert.equal(metadata.schemaVersion, 1);
  assert.match(metadata.draftId, /^draft-/);
  assert.match(metadata.previewHash, /^sha256-v1:/);
  assert.equal(metadata.provenance.source, 'structured_file');
  assert.equal(metadata.provenance.networkDisclosure, 'none');
  assert.equal(fs.existsSync(detail.assets[0].file_path), true);
});

test('zip cleanup journals every nested extraction file without touching the caller zip', async () => {
  const { preview, zipPath } = await prepareZip({
    'images/nested.png': 'nested-image',
    'notes/deeper/readme.txt': 'temporary-note'
  });
  const extractionRoot = path.join(getControlPlanePaths().dataRoot, 'temp', preview.sessionId);

  const result = await structuredImportService.confirmStructuredImport(preview.sessionId);
  assert.equal(result.successCount, 1);
  assert.equal(fs.existsSync(zipPath), true);
  assert.equal(fs.existsSync(extractionRoot), false);

  const cleanup = manifests().find((manifest) => manifest.commandType === 'structuredImport.cleanupTemporaryExtraction');
  assert.ok(cleanup);
  assert.equal(cleanup.state, 'completed');
  assert.deepEqual(
    cleanup.files.map((file) => path.relative(extractionRoot, file.targetPath)).sort(),
    [path.join('images', 'nested.png'), 'import.xlsx', path.join('notes', 'deeper', 'readme.txt')]
  );
  assert.ok(cleanup.files.every((file) => /^[a-f0-9]{64}$/.test(file.content.sha256)));
  assert.ok(cleanup.files.every((file) => file.status === 'committed'));
  assert.ok(cleanup.files.every((file) => fs.existsSync(file.quarantinePath)));
  assert.ok(cleanup.files.every((file) => file.targetPath.startsWith(extractionRoot + path.sep)));
  assert.ok(cleanup.files.every((file) => file.targetPath !== zipPath && file.quarantinePath !== zipPath));
});

test('startup completes an interrupted committed zip cleanup from the data-root journal', async () => {
  const { preview } = await prepareZip({ 'images/nested.png': 'restart-image' });
  const originalRename = fs.promises.rename;
  fs.promises.rename = async (source, target) => {
    if (String(source).endsWith('.tmp') && String(source).includes('operation-journal')) {
      const value = JSON.parse(fs.readFileSync(source, 'utf8'));
      if (value.commandType === 'structuredImport.cleanupTemporaryExtraction' && ['db_committed', 'needs_recovery'].includes(value.state)) {
        throw new Error('simulated process interruption');
      }
    }
    return originalRename.call(fs.promises, source, target);
  };
  try {
    await assert.rejects(
      structuredImportService.cleanupStructuredImport(preview.sessionId),
      /simulated process interruption/
    );
  } finally {
    fs.promises.rename = originalRename;
  }

  const interrupted = manifests().find((manifest) => manifest.commandType === 'structuredImport.cleanupTemporaryExtraction');
  assert.equal(interrupted.state, 'files_staged');
  assert.ok(interrupted.files.every((file) => fs.existsSync(file.quarantinePath)));
  assert.ok(interrupted.files.every((file) => !fs.existsSync(file.targetPath)));

  databaseService.resetDatabaseConnection();
  const restart = await databaseService.initializeDatabase();
  assert.equal(restart.state, 'writable');
  const recovered = manifests().find((manifest) => manifest.operationId === interrupted.operationId);
  assert.equal(recovered.state, 'completed');
  assert.ok(recovered.files.every((file) => file.status === 'committed'));
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');
const AdmZip = require('adm-zip');
const {
  cleanupTestRoot,
  databaseService,
  requireMain,
  resetTestDatabase
} = require('./helpers/mainTestEnv.cjs');

const electron = require('electron');
const structuredImportService = requireMain('services/structuredImportService.js');
const importBatchService = requireMain('services/importBatchService.js');

test.after(cleanupTestRoot);

test.beforeEach(async () => {
  await resetTestDatabase();
  electron.dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
});

function setDialogFile(filePath) {
  electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
}

const VALID_ROW = {
  title: '极限题',
  content: 'lim x->0 sin(x)/x',
  wrong_thinking: '直接代入',
  correct_solution: '等价无穷小替换',
  answer: '1',
  subject: '高等数学',
  category: '函数、极限、连续',
  question_type: '解答题',
  error_reason: '概念不清',
  difficulty: '中等',
  mastery_level: '一般',
  source: '测试',
  tags: '极限',
  knowledge_points: '',
  image_path: ''
};

function writeExcel(filePath, rows) {
  const sheet = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'import');
  XLSX.writeFile(wb, filePath);
}

function writeZip(zipPath, entries) {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    if (Buffer.isBuffer(content) || typeof content === 'string') {
      zip.addFile(name, Buffer.from(content));
    }
  }
  zip.writeZip(zipPath);
}

test('prepareZipImport rejects zip without import.xlsx', async () => {
  const tempDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'imp-zip-'));
  const zipPath = path.join(tempDir, 'bad.zip');
  writeZip(zipPath, { 'readme.txt': 'no excel here' });
  setDialogFile(zipPath);

  await assert.rejects(
    () => structuredImportService.prepareZipImport(),
    /未找到 import\.xlsx/
  );
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('prepareExcelImport reports invalid row for nonexistent image', async () => {
  const tempDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'imp-xlsx-'));
  const excelPath = path.join(tempDir, 'import.xlsx');
  writeExcel(excelPath, [
    { ...VALID_ROW, title: '正常题' },
    { ...VALID_ROW, title: '图片缺失题', image_path: 'images/missing.png' }
  ]);
  setDialogFile(excelPath);

  const preview = await structuredImportService.prepareExcelImport();
  assert.ok(preview);
  assert.equal(preview.totalRows, 2);
  assert.equal(preview.validRows, 1);
  assert.equal(preview.invalidRows, 1);
  assert.equal(preview.rows[1].isValid, false);
  assert.match(preview.rows[1].errors[0], /图片文件不存在/);

  const versionBeforeCleanup = (await databaseService.getDatabaseCoordinator()).currentVersion();
  await structuredImportService.cleanupStructuredImport(preview.sessionId);
  assert.deepEqual((await databaseService.getDatabaseCoordinator()).currentVersion(), versionBeforeCleanup);
  assert.equal(fs.existsSync(excelPath), true);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('prepareJsonImport handles malformed JSON gracefully', async () => {
  const tempDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'imp-json-'));
  const jsonPath = path.join(tempDir, 'bad.json');
  fs.writeFileSync(jsonPath, '{ not valid json');
  setDialogFile(jsonPath);

  await assert.rejects(
    () => structuredImportService.prepareJsonImport(),
    /JSON/
  );
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('prepareJsonImport happy path creates valid preview and confirms import', async () => {
  const tempDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'imp-json-'));
  const jsonPath = path.join(tempDir, 'valid.json');
  fs.writeFileSync(jsonPath, JSON.stringify([
    { ...VALID_ROW, title: '题一' },
    { ...VALID_ROW, title: '题二', tags: '极限,连续' }
  ]));
  setDialogFile(jsonPath);

  const preview = await structuredImportService.prepareJsonImport();
  assert.ok(preview);
  assert.equal(preview.kind, 'json');
  assert.equal(preview.totalRows, 2);
  assert.equal(preview.validRows, 2);
  assert.equal(preview.invalidRows, 0);

  const result = await structuredImportService.confirmStructuredImport(preview.sessionId);
  assert.equal(result.successCount, 2);
  assert.equal(result.failCount, 0);

  const questions = await databaseService.listQuestions({});
  assert.equal(questions.length, 2);
  const titles = questions.map((q) => q.title).sort();
  assert.deepEqual(titles, ['题一', '题二']);

  const batches = await importBatchService.listImportBatches();
  const detail = await importBatchService.getImportBatchDetail(batches[0].id);
  const metadata = JSON.parse(detail.batch.metadata_json);
  assert.equal(detail.batch.item_count, 2);
  assert.equal(metadata.schemaVersion, 1);
  assert.match(metadata.draftId, /^draft-/);
  assert.match(metadata.previewHash, /^sha256-v1:/);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('confirmStructuredImport records invalid and successful rows independently', async () => {
  const tempDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'imp-mixed-'));
  const jsonPath = path.join(tempDir, 'mixed.json');
  fs.writeFileSync(jsonPath, JSON.stringify([
    { ...VALID_ROW, title: '有效题' },
    { ...VALID_ROW, title: '无效图片题', image_path: 'missing.png' }
  ]));
  setDialogFile(jsonPath);

  const preview = await structuredImportService.prepareJsonImport();
  const result = await structuredImportService.confirmStructuredImport(preview.sessionId);
  assert.equal(result.successCount, 1);
  assert.equal(result.failCount, 1);

  const batches = await importBatchService.listImportBatches();
  const detail = await importBatchService.getImportBatchDetail(batches[0].id);
  const metadata = JSON.parse(detail.batch.metadata_json);
  assert.equal(detail.batch.status, 'active');
  assert.equal(detail.batch.item_count, 1);
  assert.equal(metadata.schemaVersion, 1);
  assert.equal(result.failures[0].title, '无效图片题');
  assert.match(result.failures[0].reason, /图片文件不存在/);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('prepareZipImport happy path extracts and previews valid zip', async () => {
  const tempDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'imp-zip-'));
  const zipPath = path.join(tempDir, 'valid.zip');

  const excelBuffer = (() => {
    const sheet = XLSX.utils.json_to_sheet([{ ...VALID_ROW, title: 'ZIP 题目' }]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, 'import');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  })();

  writeZip(zipPath, { 'import.xlsx': excelBuffer });
  setDialogFile(zipPath);

  const preview = await structuredImportService.prepareZipImport();
  assert.ok(preview);
  assert.equal(preview.kind, 'zip');
  assert.equal(preview.totalRows, 1);
  assert.equal(preview.validRows, 1);

  const result = await structuredImportService.confirmStructuredImport(preview.sessionId);
  assert.equal(result.successCount, 1);
  assert.equal(result.failCount, 0);

  const questions = await databaseService.listQuestions({});
  assert.equal(questions.length, 1);
  assert.equal(questions[0].title, 'ZIP 题目');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('confirmStructuredImport records cleanup failure and leaves cleanup retryable', async () => {
  const tempDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'imp-cleanup-'));
  const zipPath = path.join(tempDir, 'cleanup.zip');
  const sheet = XLSX.utils.json_to_sheet([{ ...VALID_ROW, title: '清理状态题' }]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'import');
  writeZip(zipPath, { 'import.xlsx': XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) });
  setDialogFile(zipPath);

  const preview = await structuredImportService.prepareZipImport();
  const originalRename = fs.promises.rename;
  let blocked = true;
  fs.promises.rename = async (source, target) => {
    if (blocked && String(source).includes(`${path.sep}import-`) && String(target).includes('.structured-import-quarantine')) {
      blocked = false;
      throw new Error('cleanup blocked');
    }
    return originalRename.call(fs.promises, source, target);
  };
  let result;
  try {
    result = await structuredImportService.confirmStructuredImport(preview.sessionId);
  } finally {
    fs.promises.rename = originalRename;
  }

  assert.equal(result.successCount, 1);
  assert.match(result.warnings[0].message, /cleanup blocked/);
  const journalRoot = path.join(requireMain('services/pathService.js').getPaths().data, 'operation-journal');
  const failedCleanup = fs.readdirSync(journalRoot)
    .filter((name) => name.endsWith('.operation.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(journalRoot, name), 'utf8')))
    .find((manifest) => manifest.commandType === 'structuredImport.cleanupTemporaryExtraction');
  assert.equal(failedCleanup.state, 'compensated');
  assert.equal(await structuredImportService.cleanupStructuredImport(preview.sessionId), true);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

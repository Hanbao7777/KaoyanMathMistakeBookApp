const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  cleanupTestRoot,
  databaseService,
  requireMain,
  resetTestDatabase
} = require('./helpers/mainTestEnv.cjs');

const importBatchService = requireMain('services/importBatchService.js');
const pathService = requireMain('services/pathService.js');

test.after(cleanupTestRoot);

test.beforeEach(resetTestDatabase);

async function createQuestion(overrides = {}) {
  return databaseService.createQuestion({
    title: '导入批次错题',
    content: '题目内容',
    wrong_thinking: '错误思路',
    wrong_solution: '',
    correct_solution: '正确解析',
    answer: '答案',
    subject: '高等数学',
    category: '函数、极限、连续',
    question_type: '解答题',
    error_reason: '概念不清',
    source: '导入测试',
    difficulty: '中等',
    mastery_level: '一般',
    note: '',
    tags: [],
    questionImageSources: [],
    solutionImageSources: [],
    ...overrides
  });
}

async function createWrongQuestionsBatchWithQuestion() {
  const batchId = 'wrong_questions-test-batch';
  const batch = await importBatchService.createImportBatch({
    id: batchId,
    type: 'wrong_questions',
    name: '测试错题导入批次',
    sourceFileName: 'wrong_questions_import.zip'
  });
  const question = await createQuestion({ import_batch_id: batchId });
  const db = await databaseService.getDatabase();
  importBatchService.recordImportBatchItem(db, batchId, 'questions', question.id);
  importBatchService.finalizeImportBatch(db, batchId, 'active');
  databaseService.persistDatabase();
  return { batchId: batch, question };
}

async function createAssetForBatch(batchId) {
  const paths = pathService.getPaths();
  const assetPath = path.join(paths.root, 'assets', 'question_bank', batchId, 'images', 'sample.txt');
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  fs.writeFileSync(assetPath, 'asset', 'utf8');
  const db = await databaseService.getDatabase();
  importBatchService.recordImportAsset(db, batchId, 'question_image', assetPath);
  importBatchService.finalizeImportBatch(db, batchId, 'active');
  databaseService.persistDatabase();
  return assetPath;
}

test('deleteImportBatch creates before_delete_import backup and deletes wrong_questions rows', async () => {
  const { batchId, question } = await createWrongQuestionsBatchWithQuestion();

  const result = await importBatchService.deleteImportBatch(batchId, { deleteAssets: false });

  assert.ok(result.backupPath.endsWith('.db'));
  assert.match(path.basename(result.backupPath), /^mistakes_before_delete_import_/);
  assert.equal(fs.existsSync(result.backupPath), true);
  assert.ok(fs.statSync(result.backupPath).size > 0);
  assert.equal(result.deletedQuestions, 1);

  const deletedQuestion = await databaseService.getQuestion(question.id);
  assert.equal(deletedQuestion, null);

  const detail = await importBatchService.getImportBatchDetail(batchId);
  assert.ok(detail);
  assert.equal(detail.batch.status, 'deleted');
  assert.ok(detail.batch.deleted_at);
});

test('deleteImportBatch moves recorded assets to import trash when asset deletion is enabled', async () => {
  const { batchId } = await createWrongQuestionsBatchWithQuestion();
  const assetPath = await createAssetForBatch(batchId);
  const paths = pathService.getPaths();
  const expectedTrashPath = path.join(paths.root, 'trash', 'imports', batchId, 'images', 'sample.txt');

  const result = await importBatchService.deleteImportBatch(batchId);

  assert.equal(result.movedAssets, 1);
  assert.deepEqual(result.failedAssets, []);
  assert.equal(fs.existsSync(assetPath), false);
  assert.equal(fs.existsSync(expectedTrashPath), true);

  const detail = await importBatchService.getImportBatchDetail(batchId);
  assert.ok(detail.assets[0].deleted_at);
});

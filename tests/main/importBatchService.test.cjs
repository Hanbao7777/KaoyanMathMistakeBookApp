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

function operationManifests() {
  const root = path.join(pathService.getPaths().data, 'operation-journal');
  return fs.existsSync(root)
    ? fs.readdirSync(root).filter((name) => name.endsWith('.operation.json')).map((name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')))
    : [];
}

async function seedLegacyExternalGroup(suffix, count = 2) {
  const source = `legacy-source-${suffix}`;
  const examType = `legacy-exam-${suffix}`;
  const year = 2025;
  const coordinator = await databaseService.getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: `seed-legacy-group-${suffix}`,
    concurrency: 'none',
    execute(database) {
      const now = new Date().toISOString();
      for (let index = 0; index < count; index += 1) {
        const id = 50_000 + index + suffix.length * 100;
        database.run(`INSERT INTO external_questions (
          id, title, content, options, answer, solution, subject, category,
          question_format, question_type, difficulty, knowledge_points, source,
          year, exam_type, question_number, section, tags, raw_file_path,
          paper_pdf_path, solution_pdf_path, import_batch_id, asset_base_path,
          added_to_mistakes, created_question_id, created_at, updated_at
        ) VALUES (?, ?, '', '', '', '', '高等数学', '其他', '解答题', '其他', '中等', '', ?, ?, ?, ?, '', '', '', '', '', '', '', 0, NULL, ?, ?)`,
        [id, `legacy-${suffix}-${index}`, source, year, examType, index + 1, now, now]);
        database.run(
          "INSERT INTO external_question_attempts (external_question_id, result, attempted_at, note, added_to_mistakes, created_question_id) VALUES (?, 'wrong', ?, '', 0, NULL)",
          [id, now]
        );
      }
      return { changed: true, value: null };
    }
  });
  return { source, examType, year, groupKey: `${source}|${examType}|${year}` };
}

async function countRows(sql, params = []) {
  const database = await databaseService.getReadOnlyDatabase();
  return database.select(sql, params)[0].count;
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
  const coordinator = await databaseService.getDatabaseCoordinator();
  const versionBefore = coordinator.currentVersion();

  const result = await importBatchService.deleteImportBatch(batchId);

  assert.equal(result.movedAssets, 1);
  assert.deepEqual(result.failedAssets, []);
  assert.equal(fs.existsSync(assetPath), false);
  assert.equal(fs.existsSync(expectedTrashPath), true);

  const detail = await importBatchService.getImportBatchDetail(batchId);
  assert.ok(detail.assets[0].deleted_at);
  assert.equal(coordinator.currentVersion().dataRevision, versionBefore.dataRevision + 1);
  const manifest = operationManifests().at(-1);
  assert.equal(manifest.state, 'completed');
  assert.equal(manifest.commandType, 'importBatches.delete');
  assert.equal(manifest.versionBefore.dataRevision, versionBefore.dataRevision);
  assert.equal(manifest.versionAfter.dataRevision, versionBefore.dataRevision + 1);
});

test('deleteImportBatch owns no raw question transaction or persistence path', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/main/services/importBatchService.ts'), 'utf8');
  const start = source.indexOf('export async function deleteImportBatch');
  const end = source.indexOf('\nexport async function listLegacyExternalQuestionGroups', start);
  const body = source.slice(start, end);
  assert.notEqual(start, -1);
  assert.match(body, /coordinator\.executeWrite\(/);
  assert.match(body, /new QuestionRepository\(database, scope\)/);
  assert.doesNotMatch(body, /\b(?:persistDatabase|runSql|getDatabase)\b/);
  assert.doesNotMatch(body, /database\.run\(['"](?:BEGIN|COMMIT|ROLLBACK)/);
  assert.doesNotMatch(body, /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:questions|question_images|tags|question_tags|review_logs|question_knowledge_points)\b/i);
});

test('deleteLegacyExternalQuestionGroup uses one durable coordinator revision and preserves its result shape', async () => {
  const seeded = await seedLegacyExternalGroup('success');
  const coordinator = await databaseService.getDatabaseCoordinator();
  const before = coordinator.currentVersion();
  const groups = await importBatchService.listLegacyExternalQuestionGroups();
  assert.ok(groups.some((group) => group.groupKey === seeded.groupKey));

  const result = await importBatchService.deleteLegacyExternalQuestionGroup(seeded.groupKey);

  assert.equal(result.deletedQuestions, 2);
  assert.equal(result.deletedAttempts, 2);
  assert.equal(result.movedAssets, 0);
  assert.deepEqual(result.failedAssets, []);
  assert.equal(fs.existsSync(result.backupPath), true);
  assert.deepEqual(coordinator.currentVersion(), {
    dataEpoch: before.dataEpoch,
    dataRevision: before.dataRevision + 1
  });
  assert.equal(await countRows('SELECT COUNT(*) AS count FROM external_questions WHERE source = ?', [seeded.source]), 0);
});

test('deleteLegacyExternalQuestionGroup no-op keeps revision while retaining the verified backup shape', async () => {
  const coordinator = await databaseService.getDatabaseCoordinator();
  const before = coordinator.currentVersion();
  const result = await importBatchService.deleteLegacyExternalQuestionGroup('missing-source|missing-exam|2025');
  assert.equal(result.deletedQuestions, 0);
  assert.equal(result.deletedAttempts, 0);
  assert.equal(fs.existsSync(result.backupPath), true);
  assert.deepEqual(coordinator.currentVersion(), before);
});

test('deleteLegacyExternalQuestionGroup rolls back database and revision on mutation failure', async () => {
  const seeded = await seedLegacyExternalGroup('rollback', 1);
  const coordinator = await databaseService.getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: 'install-legacy-delete-trigger',
    concurrency: 'none',
    execute(database) {
      database.run(`CREATE TRIGGER fail_legacy_external_delete BEFORE DELETE ON external_questions
        BEGIN SELECT RAISE(ABORT, 'forced legacy deletion failure'); END`);
      return { changed: true, value: null };
    }
  });
  const before = coordinator.currentVersion();
  await assert.rejects(importBatchService.deleteLegacyExternalQuestionGroup(seeded.groupKey), /forced legacy deletion failure/);
  assert.deepEqual(coordinator.currentVersion(), before);
  assert.equal(await countRows('SELECT COUNT(*) AS count FROM external_questions WHERE source = ?', [seeded.source]), 1);
  assert.equal(fs.readdirSync(pathService.getPaths().backups).filter((name) => name.startsWith('mistakes_before_delete_import_')).length, 1);
});

test('deleteLegacyExternalQuestionGroup restores live state when durable publication fails', async () => {
  const seeded = await seedLegacyExternalGroup('publication', 1);
  const coordinator = await databaseService.getDatabaseCoordinator();
  const before = coordinator.currentVersion();
  const databasePath = pathService.getPaths().database;
  const originalRename = fs.promises.rename;
  let injected = false;
  fs.promises.rename = async (source, target) => {
    if (!injected && source === databasePath && path.basename(String(target)) === '.mistakes.db.previous') {
      injected = true;
      throw new Error('forced legacy publication failure');
    }
    return originalRename.call(fs.promises, source, target);
  };
  try {
    await assert.rejects(importBatchService.deleteLegacyExternalQuestionGroup(seeded.groupKey), /forced legacy publication failure/);
  } finally {
    fs.promises.rename = originalRename;
  }
  assert.equal(injected, true);
  assert.deepEqual(coordinator.currentVersion(), before);
  assert.equal(await countRows('SELECT COUNT(*) AS count FROM external_questions WHERE source = ?', [seeded.source]), 1);
});

test('deleteLegacyExternalQuestionGroup drains an admitted write before snapshot and deletion', async () => {
  const seeded = await seedLegacyExternalGroup('concurrency', 1);
  const coordinator = await databaseService.getDatabaseCoordinator();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const enteredGate = new Promise((resolve) => { entered = resolve; });
  const precedingWrite = coordinator.executeWrite({
    requestId: 'legacy-delete-preceding-write',
    concurrency: 'none',
    async execute(database) {
      entered();
      await gate;
      database.run("UPDATE external_questions SET title = 'updated-before-snapshot' WHERE source = ?", [seeded.source]);
      return { changed: true, value: null };
    }
  });
  await enteredGate;
  const deletion = importBatchService.deleteLegacyExternalQuestionGroup(seeded.groupKey);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.state, 'maintenance');
  release();
  await precedingWrite;
  const result = await deletion;
  assert.equal(result.deletedQuestions, 1);
  const backupDb = await require('sql.js')({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
  const snapshot = new backupDb.Database(fs.readFileSync(result.backupPath));
  try {
    assert.equal(snapshot.exec('SELECT title FROM external_questions WHERE source = ?', [seeded.source])[0].values[0][0], 'updated-before-snapshot');
  } finally {
    snapshot.close();
  }
});

test('legacy external-group paths have no mutable read or persistence bypass', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/main/services/importBatchService.ts'), 'utf8');
  const listStart = source.indexOf('export async function listLegacyExternalQuestionGroups');
  const deleteStart = source.indexOf('export async function deleteLegacyExternalQuestionGroup', listStart);
  const deleteEnd = source.indexOf('\nexport async function openTrashFolder', deleteStart);
  const listBody = source.slice(listStart, deleteStart);
  const deleteBody = source.slice(deleteStart, deleteEnd);
  assert.match(listBody, /getReadOnlyDatabase\(/);
  assert.doesNotMatch(listBody, /getDatabase\(/);
  assert.match(deleteBody, /executeWriteWithVerifiedSnapshot\(/);
  assert.doesNotMatch(deleteBody, /\b(?:getDatabase|persistDatabase)\s*\(/);
  assert.doesNotMatch(deleteBody, /database\.run\(['"](?:BEGIN|COMMIT|ROLLBACK)/);
});

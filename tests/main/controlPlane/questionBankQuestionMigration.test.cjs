const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  cleanupControlPlaneRoot,
  databaseService,
  getControlPlanePaths,
  projectRoot,
  requireMain,
  resetControlPlaneEnvironment
} = require('../helpers/controlPlaneTestEnv.cjs');

const questionBankService = requireMain('services/questionBankService.js');

test.after(() => cleanupControlPlaneRoot());
test.beforeEach(resetControlPlaneEnvironment);

async function seedExternalQuestion(overrides = {}) {
  const coordinator = await databaseService.getDatabaseCoordinator();
  const id = overrides.id ?? 4101;
  await coordinator.executeWrite({
    requestId: `seed-external-${id}`,
    concurrency: 'none',
    execute(database) {
      const now = new Date().toISOString();
      database.run(`INSERT INTO external_questions (
        id, title, content, answer, solution, subject, category, question_format, question_type,
        difficulty, knowledge_points, source, year, exam_type, question_number, tags, import_batch_id,
        asset_base_path, added_to_mistakes, created_question_id, created_at, updated_at
      ) VALUES (?, ?, ?, '1', ?, '高等数学', '函数、极限、连续', '解答题', '解答题',
        '中等', '', '迁移测试题库', 2026, '数学一', 1, '迁移', 'migration-batch', '', 0, NULL, ?, ?)`, [
        id,
        overrides.title ?? '题库跨域原子性测试',
        overrides.content ?? '题目内容',
        overrides.solution ?? '解析内容',
        now,
        now
      ]);
      database.run(`INSERT INTO external_question_attempts (
        external_question_id, result, attempted_at, note, added_to_mistakes, created_question_id
      ) VALUES (?, 'wrong', ?, '测试', 0, NULL)`, [id, now]);
      return { changed: true, value: null };
    }
  });
  return id;
}

function readCount(database, table) {
  return Number(database.exec(`SELECT COUNT(*) FROM ${table}`)[0].values[0][0]);
}

function operationManifests() {
  const root = path.join(getControlPlanePaths().dataRoot, 'data', 'operation-journal');
  return fs.existsSync(root)
    ? fs.readdirSync(root).filter((name) => name.endsWith('.operation.json')).map((name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')))
    : [];
}

test('question-bank service contains every DB writer inside coordinator scope', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'src/main/services/questionBankService.ts'), 'utf8');
  assert.doesNotMatch(source, /\b(createQuestion|linkQuestionKnowledgePoints|runSql|persistDatabase)\b/);
  assert.doesNotMatch(source, /database\.run\(['"](?:BEGIN|COMMIT|ROLLBACK)/);
  assert.doesNotMatch(source, /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:questions|question_images|tags|question_tags|review_logs|question_knowledge_points)\b/i);
  assert.match(source, /new QuestionRepository\(database, scope\)/);
  for (const functionName of [
    'importQuestionBankZipFromPath',
    'recordExternalQuestionAttempt',
    'addExternalQuestionToMistakes',
    'deleteExternalQuestionBatch'
  ]) {
    const start = source.indexOf(`export async function ${functionName}`);
    const end = source.indexOf('\nexport async function ', start + 1);
    const body = source.slice(start, end < 0 ? source.length : end);
    assert.notEqual(start, -1, `${functionName} must remain exported`);
    assert.match(body, /coordinator\.executeWrite\(/, `${functionName} must use coordinator execution`);
  }
});

test('DB failure compensates staged images and rolls back all cross-domain state', async () => {
  const sourceImage = path.join(getControlPlanePaths().testRoot, 'db-failure.png');
  fs.writeFileSync(sourceImage, Buffer.from('db-failure-image'));
  const externalQuestionId = await seedExternalQuestion({ content: `题目\n![图](${sourceImage})` });
  const coordinator = await databaseService.getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: 'install-question-bank-failure-trigger',
    concurrency: 'none',
    execute(database) {
      database.run(`CREATE TRIGGER fail_question_bank_flags BEFORE UPDATE OF added_to_mistakes ON external_questions
        BEGIN SELECT RAISE(ABORT, 'forced flag failure'); END`);
      return { changed: true, value: null };
    }
  });
  const versionBefore = coordinator.currentVersion();

  await assert.rejects(
    questionBankService.addExternalQuestionToMistakes(externalQuestionId),
    /forced flag failure/
  );

  assert.deepEqual(coordinator.currentVersion(), versionBefore);
  const database = await databaseService.getDatabase();
  assert.equal(readCount(database, 'questions'), 0);
  assert.equal(readCount(database, 'question_images'), 0);
  assert.equal(readCount(database, 'question_knowledge_points'), 0);
  assert.deepEqual(database.exec('SELECT added_to_mistakes, created_question_id FROM external_questions WHERE id = ?', [externalQuestionId])[0].values[0], [0, null]);
  assert.deepEqual(database.exec('SELECT added_to_mistakes, created_question_id FROM external_question_attempts WHERE external_question_id = ?', [externalQuestionId])[0].values[0], [0, null]);
  const manifest = operationManifests().at(-1);
  assert.equal(manifest.state, 'compensated');
  assert.equal(fs.existsSync(manifest.files[0].targetPath), false);
  assert.equal(fs.existsSync(manifest.files[0].stagingPath), false);
});

test('image finalization failure reports no success, fences writes, and survives restart as recovery evidence', async () => {
  const sourceImage = path.join(getControlPlanePaths().testRoot, 'finalization-failure.png');
  fs.writeFileSync(sourceImage, Buffer.from('finalization-failure-image'));
  const externalQuestionId = await seedExternalQuestion({ id: 4102, content: `题目\n![图](${sourceImage})` });
  const originalRename = fs.promises.rename;
  fs.promises.rename = async (source, target) => {
    if (String(source).includes('.question-bank-operations') && String(source).endsWith('.stage')) {
      throw new Error('forced image finalization failure');
    }
    return originalRename(source, target);
  };
  try {
    await assert.rejects(
      questionBankService.addExternalQuestionToMistakes(externalQuestionId),
      (error) => error?.code === 'RECOVERY_FENCE'
    );
  } finally {
    fs.promises.rename = originalRename;
  }

  const coordinator = await databaseService.getDatabaseCoordinator();
  assert.equal(coordinator.state, 'needs_recovery');
  const manifest = operationManifests().at(-1);
  assert.equal(manifest.state, 'needs_recovery');
  assert.equal(manifest.lastError.phase, 'file_finalization');
  assert.equal(fs.existsSync(manifest.files[0].targetPath), false);
  assert.equal(fs.existsSync(manifest.files[0].stagingPath), true);
  await assert.rejects(
    questionBankService.recordExternalQuestionAttempt({ externalQuestionId, result: 'wrong' }),
    (error) => error?.code === 'RECOVERY_FENCE'
  );

  databaseService.resetDatabaseConnection();
  const restart = await databaseService.initializeDatabase();
  assert.equal(restart.state, 'needs_recovery');
  assert.equal((await databaseService.getDatabaseCoordinator()).state, 'needs_recovery');
  const persisted = operationManifests().at(-1);
  assert.equal(persisted.state, 'needs_recovery');
  assert.equal(fs.existsSync(persisted.files[0].stagingPath), true);
});

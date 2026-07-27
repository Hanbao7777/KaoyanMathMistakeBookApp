const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  cleanupTestRoot,
  databaseService,
  requireMain,
  resetTestDatabase,
  testRoot
} = require('./helpers/mainTestEnv.cjs');

const questionBankService = requireMain('services/questionBankService.js');
const pathService = requireMain('services/pathService.js');

test.after(cleanupTestRoot);

test.beforeEach(resetTestDatabase);

async function createExternalQuestion(overrides = {}) {
  const db = await databaseService.getDatabase();
  const now = new Date().toISOString();
  const externalId = overrides.id ?? 1001;
  databaseService.runSql(
    db,
    `INSERT INTO external_questions (
      id, title, content, options, answer, solution, subject, category,
      question_format, question_type, difficulty, knowledge_points, source,
      year, exam_type, question_number, section, tags, raw_file_path,
      paper_pdf_path, solution_pdf_path, import_batch_id, asset_base_path,
      added_to_mistakes, created_question_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
    [
      externalId,
      overrides.title || '2026 数学一第 1 题',
      overrides.content || '题库题目内容',
      overrides.options || '',
      overrides.answer || 'A',
      overrides.solution || '题库解析',
      overrides.subject || '高等数学',
      overrides.category || '函数、极限、连续',
      overrides.question_format || '选择题',
      overrides.question_type || '选择题',
      overrides.difficulty || '中等',
      overrides.knowledge_points || '',
      overrides.source || '测试题库',
      overrides.year ?? 2026,
      overrides.exam_type || '数学一',
      overrides.question_number ?? 1,
      overrides.section || '',
      overrides.tags || '题库,测试',
      overrides.raw_file_path || '',
      overrides.paper_pdf_path || '',
      overrides.solution_pdf_path || '',
      overrides.import_batch_id || 'batch-test',
      overrides.asset_base_path || '',
      now,
      now
    ]
  );
  databaseService.persistDatabase();
  return externalId;
}

test('recordExternalQuestionAttempt writes external_question_attempts row', async () => {
  const externalQuestionId = await createExternalQuestion();
  assert.ok(externalQuestionId > 0);
  assert.ok(await questionBankService.getExternalQuestion(externalQuestionId));
  const coordinator = await databaseService.getDatabaseCoordinator();
  const versionBefore = coordinator.currentVersion();

  const attempt = await questionBankService.recordExternalQuestionAttempt({
    externalQuestionId,
    result: 'wrong',
    note: '计算错误'
  });

  assert.equal(attempt.external_question_id, externalQuestionId);
  assert.equal(attempt.result, 'wrong');
  assert.equal(attempt.note, '计算错误');
  assert.equal(attempt.added_to_mistakes, 0);
  assert.equal(attempt.created_question_id, null);
  assert.equal(coordinator.currentVersion().dataRevision, versionBefore.dataRevision + 1);

  const db = await databaseService.getDatabase();
  const rows = db.exec('SELECT result, note FROM external_question_attempts WHERE external_question_id = ?', [externalQuestionId]);
  assert.equal(rows[0].values.length, 1);
  assert.deepEqual(rows[0].values[0], ['wrong', '计算错误']);
});

test('deleteExternalQuestionBatch publishes its database deletion once', async () => {
  const externalQuestionId = await createExternalQuestion({ id: 1002, import_batch_id: 'batch-delete' });
  await questionBankService.recordExternalQuestionAttempt({ externalQuestionId, result: 'wrong' });
  const coordinator = await databaseService.getDatabaseCoordinator();
  const versionBefore = coordinator.currentVersion();

  const result = await questionBankService.deleteExternalQuestionBatch('batch-delete');

  assert.deepEqual(result, { deletedQuestions: 1, deletedAttempts: 1, movedAssetPath: '' });
  assert.equal(coordinator.currentVersion().dataRevision, versionBefore.dataRevision + 1);
  assert.equal(await questionBankService.getExternalQuestion(externalQuestionId), null);
});

test('addExternalQuestionToMistakes creates mistake question and updates external links', async () => {
  const imagePath = path.join(testRoot, 'question-bank-source.png');
  fs.writeFileSync(imagePath, Buffer.from('question-bank-image'));
  const externalQuestionId = await createExternalQuestion({
    title: '题库加入错题测试',
    content: `题库原题内容\n![原题](${imagePath})`,
    solution: '题库解析内容',
    answer: '42',
    tags: '题库,错题',
    knowledge_points: '极限定义'
  });
  const coordinator = await databaseService.getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: 'question-bank-test-knowledge',
    concurrency: 'none',
    execute(database) {
      const now = new Date().toISOString();
      database.run("INSERT INTO knowledge_points (node_id, title, level, sort_order, created_at, updated_at) VALUES ('limit-definition', '极限定义', 1, 1, ?, ?)", [now, now]);
      return { changed: true, value: null };
    }
  });
  const attempt = await questionBankService.recordExternalQuestionAttempt({
    externalQuestionId,
    result: 'wrong',
    note: '不会做'
  });
  const versionBefore = coordinator.currentVersion();

  const result = await questionBankService.addExternalQuestionToMistakes(externalQuestionId);

  assert.equal(coordinator.currentVersion().dataRevision, versionBefore.dataRevision + 1);
  assert.equal(result.question.title, '题库加入错题测试');
  assert.equal(result.question.content, '题库原题内容');
  assert.equal(result.question.correct_solution, '题库解析内容');
  assert.equal(result.question.answer, '42');
  assert.equal(result.question.mastery_level, '较弱');
  assert.equal(result.attempt.id, attempt.id);
  assert.equal(result.question.question_images.length, 1);
  assert.equal(fs.existsSync(path.join(pathService.getPaths().root, result.question.question_images[0].file_path)), true);

  const external = await questionBankService.getExternalQuestion(externalQuestionId);
  assert.equal(external.added_to_mistakes, 1);
  assert.equal(external.created_question_id, result.question.id);

  const attempts = (await databaseService.getDatabase()).exec(
    'SELECT added_to_mistakes, created_question_id FROM external_question_attempts WHERE external_question_id = ?',
    [externalQuestionId]
  );
  assert.equal(attempts[0].values.length, 1);
  assert.deepEqual(attempts[0].values[0], [1, result.question.id]);
  const links = (await databaseService.getDatabase()).exec(
    'SELECT knowledge_node_id FROM question_knowledge_points WHERE question_id = ?',
    [result.question.id]
  );
  assert.deepEqual(links[0].values, [['limit-definition']]);
});

test('addExternalQuestionToMistakes rejects duplicate add', async () => {
  const externalQuestionId = await createExternalQuestion();
  await questionBankService.recordExternalQuestionAttempt({
    externalQuestionId,
    result: 'no_idea'
  });
  await questionBankService.addExternalQuestionToMistakes(externalQuestionId);
  const coordinator = await databaseService.getDatabaseCoordinator();
  const versionBefore = coordinator.currentVersion();

  await assert.rejects(
    () => questionBankService.addExternalQuestionToMistakes(externalQuestionId),
    /已经加入错题本/
  );
  assert.deepEqual(coordinator.currentVersion(), versionBefore);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  cleanupControlPlaneRoot,
  databaseService,
  projectRoot,
  requireMain,
  resetControlPlaneEnvironment
} = require('../helpers/controlPlaneTestEnv.cjs');

const knowledgeMapService = requireMain('services/knowledgeMapService.js');

test.after(() => cleanupControlPlaneRoot());
test.beforeEach(resetControlPlaneEnvironment);

async function seedMatchingQuestion() {
  const coordinator = await databaseService.getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: 'seed-knowledge-rematch',
    concurrency: 'none',
    execute(database) {
      const now = new Date().toISOString();
      database.run(`INSERT INTO questions (
        id, title, content, answer, wrong_solution, correct_solution, subject, category, question_type, difficulty,
        source, error_reason, wrong_thinking, mastery_level, review_count, correct_count,
        wrong_count, no_idea_count, created_at, updated_at
      ) VALUES (5101, '极限计算', '求极限', '', '', '', '高等数学', '函数、极限、连续', '解答题',
        '中等', '', '', '', '一般', 0, 0, 0, 0, ?, ?)`, [now, now]);
      database.run(`INSERT INTO knowledge_points (
        node_id, title, subject, category, level, sort_order, summary, core_formulas,
        common_question_types, common_error_reasons, tags, created_at, updated_at
      ) VALUES ('limit-node', '极限计算', '高等数学', '函数、极限、连续', 1, 1, '', '[]',
        '[]', '[]', '[]', ?, ?)`, [now, now]);
      return { changed: true, value: null };
    }
  });
}

function linkCount(database) {
  return Number(database.exec('SELECT COUNT(*) FROM question_knowledge_points')[0].values[0][0]);
}

test('knowledge-map writers use coordinator scope and question commands', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'src/main/services/knowledgeMapService.ts'), 'utf8');
  assert.doesNotMatch(source, /\b(?:persistDatabase|runSql|linkQuestionKnowledgePoints)\b/);
  assert.doesNotMatch(source, /database\.run\(['"](?:BEGIN|COMMIT|ROLLBACK)/);
  assert.doesNotMatch(source, /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:questions|question_images|tags|question_tags|review_logs|question_knowledge_points)\b/i);
  assert.match(source, /type: 'questions\.rematch_knowledge'/);
  assert.match(source, /assertDatabaseMutationScope\(scope, database\)/);
  for (const functionName of ['importKnowledgeMapZip', 'seedImportKnowledgeMap', 'bindTextbookPdf']) {
    const start = source.indexOf(`export async function ${functionName}`);
    const end = source.indexOf('\nexport async function ', start + 1);
    const body = source.slice(start, end < 0 ? source.length : end);
    assert.notEqual(start, -1, `${functionName} must remain exported`);
    assert.match(body, /(?:persistKnowledgeImport|coordinator\.executeWrite)\(/, `${functionName} must enter coordinator execution`);
  }
});

test('rematch preserves legacy counters and a repeated no-op does not revise data', async () => {
  await seedMatchingQuestion();
  const coordinator = await databaseService.getDatabaseCoordinator();
  const versionBefore = coordinator.currentVersion();

  const first = await knowledgeMapService.rematchKnowledgePoints();
  const versionAfterFirst = coordinator.currentVersion();
  const second = await knowledgeMapService.rematchKnowledgePoints();

  assert.deepEqual(first, {
    scannedQuestions: 1,
    insertedCount: 1,
    skippedExistingCount: 0,
    unmatchedQuestions: 0
  });
  assert.deepEqual(second, {
    scannedQuestions: 1,
    insertedCount: 0,
    skippedExistingCount: 1,
    unmatchedQuestions: 0
  });
  assert.equal(versionAfterFirst.dataRevision, versionBefore.dataRevision + 1);
  assert.deepEqual(coordinator.currentVersion(), versionAfterFirst);
  assert.equal(linkCount(await databaseService.getDatabase()), 1);
});

test('rematch failure rolls back link writes and leaves the version unchanged', async () => {
  await seedMatchingQuestion();
  const coordinator = await databaseService.getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: 'install-rematch-failure-trigger',
    concurrency: 'none',
    execute(database) {
      database.run(`CREATE TRIGGER fail_knowledge_rematch BEFORE INSERT ON question_knowledge_points
        BEGIN SELECT RAISE(ABORT, 'forced rematch failure'); END`);
      return { changed: true, value: null };
    }
  });
  const versionBefore = coordinator.currentVersion();

  await assert.rejects(
    knowledgeMapService.rematchKnowledgePoints(),
    (error) => error?.code === 'INTERNAL_ERROR'
  );

  assert.deepEqual(coordinator.currentVersion(), versionBefore);
  assert.equal(linkCount(await databaseService.getDatabase()), 0);
});

test('concurrent rematches serialize and publish the link only once', async () => {
  await seedMatchingQuestion();
  const coordinator = await databaseService.getDatabaseCoordinator();
  const versionBefore = coordinator.currentVersion();

  const results = await Promise.all([
    knowledgeMapService.rematchKnowledgePoints(),
    knowledgeMapService.rematchKnowledgePoints()
  ]);

  assert.deepEqual(results.map((result) => result.insertedCount).sort(), [0, 1]);
  assert.deepEqual(results.map((result) => result.skippedExistingCount).sort(), [0, 1]);
  assert.equal(coordinator.currentVersion().dataRevision, versionBefore.dataRevision + 1);
  assert.equal(linkCount(await databaseService.getDatabase()), 1);
});

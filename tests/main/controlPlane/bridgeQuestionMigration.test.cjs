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

const bridgeService = requireMain('services/bridgeService.js');
const ticktickService = requireMain('services/ticktickService.js');

test.after(() => cleanupControlPlaneRoot());
test.beforeEach(resetControlPlaneEnvironment);

function questionInput() {
  return {
    title: '桥接命令迁移', content: 'content', wrong_thinking: 'wrong', wrong_solution: '', correct_solution: 'correct', answer: '1',
    subject: '高等数学', category: '函数、极限、连续', question_type: '解答题', error_reason: '概念不清', source: 'test',
    difficulty: '中等', mastery_level: '一般', note: '', tags: [], questionImageSources: [], solutionImageSources: []
  };
}

async function bridgedTask() {
  const question = await databaseService.createQuestion(questionInput());
  const list = await ticktickService.createTickTickList({ name: '控制面桥接' });
  const task = await ticktickService.createTickTickTask({ list_id: list.id, title: '控制面同步', priority: 'none' });
  await ticktickService.createTickTickBridge({
    ticktick_task_id: task.id,
    linked_type: 'question',
    linked_id: String(question.id),
    sync_review: 1,
    sync_mastery: 0
  });
  return { question, task };
}

test('bridge service has no direct question writer or raw persistence bypass', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'src/main/services/bridgeService.ts'), 'utf8');
  assert.doesNotMatch(source, /\bsubmitReviewResult\b|\bpersistDatabase\b|\bgetDatabase\s*\(/);
  assert.doesNotMatch(source, /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:questions|question_images|tags|question_tags|review_logs|question_knowledge_points)\b/i);
  assert.match(source, /type: 'questions\.submit_review'/);
  assert.match(source, /type: 'questions\.undo_review'/);
  assert.doesNotMatch(source, /console\.error/);
});

test('bridge submit and undo each publish one question command revision', async () => {
  const { question, task } = await bridgedTask();
  const coordinator = await databaseService.getDatabaseCoordinator();
  const beforeSubmit = coordinator.currentVersion();

  await bridgeService.syncTaskCompletedToReview(task.id, task.title, 20);
  const afterSubmit = coordinator.currentVersion();
  assert.equal(afterSubmit.dataRevision, beforeSubmit.dataRevision + 1);
  assert.equal((await databaseService.listReviewLogs(question.id)).length, 1);

  await bridgeService.undoSyncTaskCompleted(task.id, task.title);
  const afterUndo = coordinator.currentVersion();
  assert.equal(afterUndo.dataRevision, afterSubmit.dataRevision + 1);
  assert.equal((await databaseService.listReviewLogs(question.id)).length, 0);
  assert.equal((await databaseService.getQuestion(question.id)).review_count, 0);
});

test('bridge undo is a no-op when no matching review exists', async () => {
  const { question, task } = await bridgedTask();
  const coordinator = await databaseService.getDatabaseCoordinator();
  const version = coordinator.currentVersion();

  await bridgeService.undoSyncTaskCompleted(task.id, task.title);

  assert.deepEqual(coordinator.currentVersion(), version);
  assert.equal((await databaseService.listReviewLogs(question.id)).length, 0);
});

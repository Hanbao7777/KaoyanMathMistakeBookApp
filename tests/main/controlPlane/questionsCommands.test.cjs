const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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

const { createInternalExecutionContext } = requireMain('application/executionContext.js');
const { registerQuestions } = requireMain('application/questions/registerQuestions.js');
const { QuestionRepository } = requireMain('application/questions/questionRepository.js');

test.after(() => cleanupControlPlaneRoot());
test.beforeEach(resetControlPlaneEnvironment);

function input(overrides = {}) {
  return {
    title: '命令边界测试', content: 'content', wrong_thinking: 'wrong', wrong_solution: '', correct_solution: 'correct', answer: '1',
    subject: '高等数学', category: '函数、极限、连续', question_type: '解答题', error_reason: '概念不清',
    source: 'test', difficulty: '中等', mastery_level: '一般', note: '', tags: ['命令'],
    questionImageSources: [], solutionImageSources: [],
    ...overrides
  };
}

function context(expectedVersion, overrides = {}) {
  return createInternalExecutionContext({
    concurrency: 'strict', expectedVersion, requestId: crypto.randomUUID(), traceId: crypto.randomUUID(), ...overrides
  });
}

async function isolatedApplication(options = {}) {
  const coordinator = await databaseService.getDatabaseCoordinator();
  const readOnlyDatabase = await databaseService.getReadOnlyDatabase();
  return registerQuestions({ coordinator, readOnlyDatabase, ...options });
}

function databasePath() {
  return path.join(getControlPlanePaths().dataRoot, 'data', 'mistakes.db');
}

function manifestPath(requestId) {
  return path.join(getControlPlanePaths().dataRoot, 'data', 'operation-journal', `${requestId}.operation.json`);
}

function readManifest(requestId) {
  return JSON.parse(fs.readFileSync(manifestPath(requestId), 'utf8'));
}

function writeSource(name) {
  const source = path.join(getControlPlanePaths().testRoot, name);
  fs.writeFileSync(source, Buffer.from(`managed-test-${name}`));
  return source;
}

async function applicationAndVersion() {
  const application = await databaseService.getQuestionsApplication();
  const query = application.query({ type: 'questions.list', payload: { filters: {}, limit: 20 } },
    createInternalExecutionContext({ concurrency: 'none' }));
  return { application, version: query.dataVersion };
}

test('question commands are versioned, immutable-evented, and reject stale writes', async () => {
  const { application, version } = await applicationAndVersion();
  const observed = [];
  application.eventBus.subscribe((event) => observed.push(event));

  const created = await application.execute({ type: 'questions.create', payload: { input: input() } }, context(version));
  assert.equal(created.changed, true);
  assert.equal(created.dataVersion.dataRevision, version.dataRevision + 1);
  assert.equal(created.events.length, 1);
  assert.equal(created.events[0].type, 'questions.question_created');
  assert.deepEqual(created.events[0].versionBefore, version);
  assert.deepEqual(created.events[0].versionAfter, created.dataVersion);
  assert.equal(Object.isFrozen(created.events[0].payload), true);
  assert.equal(observed.length, 1);

  const unchanged = await application.execute({
    type: 'questions.update', payload: { questionId: created.value.id, input: input() }
  }, context(created.dataVersion));
  assert.equal(unchanged.changed, false);
  assert.deepEqual(unchanged.dataVersion, created.dataVersion);
  assert.equal(unchanged.events.length, 0);

  await assert.rejects(
    application.execute({ type: 'questions.mark_mastery', payload: { questionId: created.value.id, mastery: '已掌握' } }, context(version)),
    (error) => error && error.code === 'DATA_REVISION_CONFLICT'
  );
  assert.equal(observed.length, 1);
});

test('question repository rejects mutation construction without a coordinator scope', async () => {
  const database = await databaseService.getDatabase();
  assert.throws(
    () => new QuestionRepository(database, Object.freeze({}), () => new Date().toISOString()),
    /scope|capability|mutation/i
  );
});

test('undo review restores aggregates from retained history and emits an immutable event', async () => {
  const { application, version } = await applicationAndVersion();
  const created = await application.execute({ type: 'questions.create', payload: { input: input() } }, context(version));
  const first = await application.execute({
    type: 'questions.submit_review', payload: { questionId: created.value.id, result: 'correct', note: 'first' }
  }, context(created.dataVersion));
  const second = await application.execute({
    type: 'questions.submit_review', payload: { questionId: created.value.id, result: 'wrong', note: 'second' }
  }, context(first.dataVersion));
  const observed = [];
  application.eventBus.subscribe((event) => observed.push(event));

  await assert.rejects(
    application.execute({
      type: 'questions.undo_review', payload: { questionId: created.value.id, reviewLogId: first.value.log.id }
    }, context(second.dataVersion)),
    (error) => error?.code === 'VALIDATION_ERROR'
  );
  assert.deepEqual((await databaseService.getDatabaseCoordinator()).currentVersion(), second.dataVersion);

  const undone = await application.execute({
    type: 'questions.undo_review', payload: { questionId: created.value.id, reviewLogId: second.value.log.id }
  }, context(second.dataVersion));
  assert.equal(undone.changed, true);
  assert.equal(undone.value.reviewLog.id, second.value.log.id);
  assert.equal(undone.value.question.review_count, 1);
  assert.equal(undone.value.question.correct_count, 1);
  assert.equal(undone.value.question.wrong_count, 0);
  assert.equal(undone.value.question.no_idea_count, 0);
  assert.equal(undone.value.question.consecutive_correct, 1);
  assert.equal(undone.value.question.mastery_level, first.value.log.mastery_after);
  assert.equal(undone.value.question.last_reviewed_at, first.value.log.reviewed_at);
  assert.equal(undone.value.question.next_review_at, first.value.log.next_review_at);
  assert.equal(undone.events[0].type, 'questions.review_undone');
  assert.deepEqual(undone.events[0].payload, { questionId: created.value.id, reviewLogId: second.value.log.id });
  assert.equal(Object.isFrozen(undone.events[0].payload), true);
  assert.equal(observed.length, 1);

  const empty = await application.execute({
    type: 'questions.undo_review', payload: { questionId: created.value.id, reviewLogId: first.value.log.id }
  }, context(undone.dataVersion));
  assert.equal(empty.value.question.review_count, 0);
  assert.equal(empty.value.question.correct_count, 0);
  assert.equal(empty.value.question.wrong_count, 0);
  assert.equal(empty.value.question.consecutive_correct, 0);
  assert.equal(empty.value.question.mastery_level, first.value.log.mastery_before);
  assert.equal(empty.value.question.last_reviewed_at, null);
  assert.equal(empty.value.question.next_review_at, null);
});

test('undo review rejects wrong-question ownership and stale versions without mutation', async () => {
  const { application, version } = await applicationAndVersion();
  const firstQuestion = await application.execute({ type: 'questions.create', payload: { input: input() } }, context(version));
  const secondQuestion = await application.execute({ type: 'questions.create', payload: { input: input({ title: 'second' }) } }, context(firstQuestion.dataVersion));
  const reviewed = await application.execute({
    type: 'questions.submit_review', payload: { questionId: firstQuestion.value.id, result: 'correct' }
  }, context(secondQuestion.dataVersion));

  await assert.rejects(
    application.execute({
      type: 'questions.undo_review', payload: { questionId: secondQuestion.value.id, reviewLogId: reviewed.value.log.id }
    }, context(reviewed.dataVersion)),
    (error) => error?.code === 'VALIDATION_ERROR'
  );
  await assert.rejects(
    application.execute({
      type: 'questions.undo_review', payload: { questionId: firstQuestion.value.id, reviewLogId: reviewed.value.log.id }
    }, context(secondQuestion.dataVersion)),
    (error) => error?.code === 'DATA_REVISION_CONFLICT'
  );
  assert.deepEqual((await databaseService.getDatabaseCoordinator()).currentVersion(), reviewed.dataVersion);
  assert.equal((await databaseService.listReviewLogs(firstQuestion.value.id)).length, 1);
});

test('image create and quarantine deletion complete through the operation journal', async () => {
  const { application, version } = await applicationAndVersion();
  const paths = getControlPlanePaths();
  const source = path.join(paths.testRoot, 'source.png');
  fs.writeFileSync(source, Buffer.from('not-a-real-png-but-a-managed-test-file'));
  let imageExistedAtEvent = false;
  application.eventBus.subscribe((event) => {
    if (event.type !== 'questions.question_created') return;
    const question = application.query(
      { type: 'questions.get', payload: { questionId: event.payload.questionId } },
      createInternalExecutionContext({ concurrency: 'none' })
    ).value;
    imageExistedAtEvent = Boolean(question?.question_images[0]) && fs.existsSync(
      path.join(paths.dataRoot, question.question_images[0].file_path.replaceAll('/', path.sep))
    );
  });

  const created = await application.execute({
    type: 'questions.create', payload: { input: input({ questionImageSources: [source] }) }
  }, context(version));
  const image = created.value.question_images[0];
  const target = path.join(paths.dataRoot, image.file_path.replaceAll('/', path.sep));
  assert.equal(fs.existsSync(target), true);
  assert.equal(imageExistedAtEvent, true);

  const deleted = await application.execute({
    type: 'questions.remove_image', payload: { imageId: image.id, deleteFile: true }
  }, context(created.dataVersion));
  assert.equal(deleted.changed, true);
  assert.equal(fs.existsSync(target), false);
  const journalRoot = path.join(paths.dataRoot, 'data', 'operation-journal');
  assert.equal(fs.readdirSync(journalRoot).some((name) => name.endsWith('.json')), true);
});

for (const dependency of ['uuid', 'clock']) {
  test(`event ${dependency} preparation failure rolls back database and compensates staged images`, async () => {
    const beforeDisk = fs.readFileSync(databasePath());
    const coordinator = await databaseService.getDatabaseCoordinator();
    const version = coordinator.currentVersion();
    const requestId = crypto.randomUUID();
    const source = writeSource(`event-${dependency}.png`);
    const eventBusOptions = dependency === 'uuid'
      ? { randomUUID: () => { throw new Error('event uuid failed'); } }
      : { now: () => { throw new Error('event clock failed'); } };
    const application = await isolatedApplication({ eventBusOptions });

    await assert.rejects(
      application.execute(
        { type: 'questions.create', payload: { input: input({ questionImageSources: [source] }) } },
        context(version, { requestId })
      ),
      (error) => error?.code === 'INTERNAL_ERROR'
    );

    assert.deepEqual(coordinator.currentVersion(), version);
    assert.deepEqual(fs.readFileSync(databasePath()), beforeDisk);
    const manifest = readManifest(requestId);
    assert.equal(manifest.state, 'compensated');
    assert.equal(fs.existsSync(manifest.files[0].targetPath), false);
    assert.equal(fs.existsSync(manifest.files[0].stagingPath), false);
  });
}

test('event dependencies finish before durable publication and public delivery waits for files', async () => {
  const coordinator = await databaseService.getDatabaseCoordinator();
  const version = coordinator.currentVersion();
  const requestId = crypto.randomUUID();
  const source = writeSource('event-order.png');
  let finalizationStarted = false;
  let uuidCalls = 0;
  let clockCalls = 0;
  let observedTargetExists = false;
  const application = await isolatedApplication({
    eventBusOptions: {
      randomUUID() {
        assert.equal(finalizationStarted, false);
        uuidCalls += 1;
        return crypto.randomUUID();
      },
      now() {
        assert.equal(finalizationStarted, false);
        clockCalls += 1;
        return new Date().toISOString();
      }
    },
    commandDependencies: {
      journalHook({ boundary, phase }) {
        if (boundary === 'before' && phase === 'db_committed_publish') finalizationStarted = true;
      }
    }
  });
  application.eventBus.subscribe((event) => {
    if (event.type !== 'questions.question_created') return;
    const manifest = readManifest(requestId);
    observedTargetExists = manifest.state === 'completed' && fs.existsSync(manifest.files[0].targetPath);
  });

  const result = await application.execute(
    { type: 'questions.create', payload: { input: input({ questionImageSources: [source] }) } },
    context(version, { requestId })
  );

  assert.equal(result.events.length, 1);
  assert.equal(uuidCalls, 1);
  assert.equal(clockCalls, 1);
  assert.equal(observedTargetExists, true);
});

test('file-stage failure compensates without a database revision or final file', async () => {
  const coordinator = await databaseService.getDatabaseCoordinator();
  const version = coordinator.currentVersion();
  const requestId = crypto.randomUUID();
  const source = writeSource('stage-failure.png');
  const application = await isolatedApplication({
    commandDependencies: {
      journalHook({ boundary, phase }) {
        if (boundary === 'before' && phase === 'file_stage') throw new Error('stage failed');
      }
    }
  });

  await assert.rejects(
    application.execute(
      { type: 'questions.create', payload: { input: input({ questionImageSources: [source] }) } },
      context(version, { requestId })
    ),
    (error) => error?.code === 'INTERNAL_ERROR'
  );

  assert.deepEqual(coordinator.currentVersion(), version);
  const manifest = readManifest(requestId);
  assert.equal(manifest.state, 'compensated');
  assert.equal(fs.existsSync(manifest.files[0].targetPath), false);
});

for (const phase of ['db_committed_publish', 'file_commit']) {
  test(`${phase} failure persists recovery evidence, fences access, and publishes no event`, async () => {
    const coordinator = await databaseService.getDatabaseCoordinator();
    const readOnly = await databaseService.getReadOnlyDatabase();
    const version = coordinator.currentVersion();
    const requestId = crypto.randomUUID();
    const source = writeSource(`${phase}.png`);
    const observed = [];
    const application = await isolatedApplication({
      commandDependencies: {
        journalHook({ boundary, phase: currentPhase }) {
          if (boundary === 'before' && currentPhase === phase) throw new Error(`${phase} failed`);
        }
      }
    });
    application.eventBus.subscribe((event) => observed.push(event));

    await assert.rejects(
      application.execute(
        { type: 'questions.create', payload: { input: input({ questionImageSources: [source] }) } },
        context(version, { requestId })
      ),
      (error) => error?.code === 'RECOVERY_FENCE'
    );

    const manifest = readManifest(requestId);
    assert.equal(manifest.state, 'needs_recovery');
    assert.equal(coordinator.state, 'needs_recovery');
    assert.equal(observed.length, 0);
    assert.equal(fs.existsSync(manifest.files[0].targetPath), false);
    assert.equal(readOnly.select('SELECT COUNT(*) AS count FROM questions')[0].count, 1);
    await assert.rejects(
      application.execute({ type: 'questions.create', payload: { input: input() } }, context(coordinator.currentVersion())),
      (error) => error?.code === 'RECOVERY_FENCE'
    );
  });
}

test('legacy knowledge-link wrapper preserves unmatched and ambiguous warnings', async () => {
  const question = await databaseService.createQuestion(input());
  const coordinator = await databaseService.getDatabaseCoordinator();
  await coordinator.executeWrite({
    requestId: crypto.randomUUID(),
    concurrency: 'none',
    execute(database) {
      const timestamp = new Date().toISOString();
      database.run("INSERT INTO knowledge_points (node_id, title, level, sort_order, created_at, updated_at) VALUES ('a', '重复知识点', 1, 1, ?, ?)", [timestamp, timestamp]);
      database.run("INSERT INTO knowledge_points (node_id, title, level, sort_order, created_at, updated_at) VALUES ('b', '重复知识点', 2, 2, ?, ?)", [timestamp, timestamp]);
      return { changed: true, value: null };
    }
  });

  const warnings = await databaseService.linkQuestionKnowledgePoints(question.id, ['不存在', '重复知识点']);
  assert.deepEqual(warnings, [
    '未匹配到知识点：不存在',
    '知识点标题重复，已使用第一个匹配项：重复知识点'
  ]);
});

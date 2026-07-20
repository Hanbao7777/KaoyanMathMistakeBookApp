const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const { databaseService, cleanupControlPlaneRoot, resetControlPlaneEnvironment } = environment;
const agent = require(`${environment.projectRoot}/dist/main/shared/agent/index.js`);
const studyModule = environment.requireMain('application/study/index.js');

test.after(() => cleanupControlPlaneRoot());
test.beforeEach(resetControlPlaneEnvironment);

const timestamp = '2026-07-18T09:00:00.000Z';
const uuid = () => crypto.randomUUID();

async function seedStudyData() {
  const coordinator = await databaseService.getDatabaseCoordinator();
  await coordinator.executeWrite({ requestId: `c10-seed-${uuid().replaceAll('-', '')}`, concurrency: 'none', execute(database) {
    database.run(`INSERT INTO study_settings (id, exam_date, daily_target_minutes, supervision_mode, auto_rollover_enabled, last_rollover_date, created_at, updated_at)
      VALUES (1, '2027-01-01', 240, 'strict', 1, NULL, ?, ?)`, [timestamp, timestamp]);
    database.run(`INSERT INTO study_subjects (id, name, sort_order, is_active, created_at, updated_at) VALUES
      ('math', '数学', 1, 1, ?, ?), ('english', '英语', 2, 1, ?, ?)`, [timestamp, timestamp, timestamp, timestamp]);
    database.run(`INSERT INTO study_materials (id, subject_id, name, material_type, progress_unit, total_amount, current_amount, status, note, created_at, updated_at)
      VALUES ('material-math', 'math', '章节', 'chapter', '章', 100, 10, '进行中', '', ?, ?)`, [timestamp, timestamp]);
    database.run(`INSERT INTO study_tasks (id, task_date, subject_id, material_id, title, task_type, estimated_minutes, actual_minutes, priority, status, defer_count, note, created_at, updated_at)
      VALUES ('task-math', '2026-07-18', 'math', 'material-math', '完成极限练习', '其他', 60, 0, '中', '未开始', 0, 'stored note', ?, ?)`, [timestamp, timestamp]);
    return { changed: true, value: null };
  }});
  return coordinator;
}

function context(version, requestId = uuid()) {
  return { trust: 'trusted', source: 'renderer', requestId, traceId: uuid(), actor: { actorId: 'c10-user', actorType: 'user' }, client: { clientId: 'renderer' }, timestamp, concurrency: 'strict', expectedVersion: version };
}

function commandEnvelope(operation, payload, expectedVersion, requestId = uuid()) {
  return { apiVersion: 1, kind: 'agent-command', operation, payload, requestId, expectedVersion, catalog: agent.operationCatalogIdentity };
}

test('C10 queries use deterministic Monday boundaries and bounded task results', async () => {
  const coordinator = await seedStudyData();
  const application = await databaseService.getStudyApplication();
  await coordinator.executeWrite({ requestId: `c10-boundary-${uuid().replaceAll('-', '')}`, concurrency: 'none', execute(database) {
    database.run(`INSERT INTO study_tasks (id, task_date, subject_id, title, estimated_minutes, actual_minutes, priority, status, defer_count, note, created_at, updated_at)
      VALUES ('task-sun', '2026-07-19', 'math', 'Sunday', 30, 0, '中', '已完成', 0, '', ?, ?)`, [timestamp, timestamp]);
    database.run(`INSERT INTO study_sessions (id, session_date, subject_id, task_id, start_time, duration_minutes, note, created_at, updated_at)
      VALUES ('session-sun', '2026-07-19', 'math', 'task-sun', ?, 30, '', ?, ?)`, [timestamp, timestamp, timestamp]);
    for (let index = 0; index < 55; index += 1) {
      database.run(`INSERT INTO study_tasks (id, task_date, subject_id, title, estimated_minutes, actual_minutes, priority, status, defer_count, note, created_at, updated_at)
        VALUES (?, '2026-07-18', 'math', ?, 10, 0, '中', '未开始', 0, '', ?, ?)`, [`task-bounded-${index}`, `Bounded ${index}`, timestamp, timestamp]);
    }
    return { changed: true, value: null };
  }});
  const queryContext = context(coordinator.currentVersion());
  const today = application.query({ type: 'study.get_today', payload: { date: '2026-07-18' } }, queryContext).value;
  assert.equal(today.totalTasks, 56);
  assert.equal(today.completedTasks, 0);
  assert.equal(today.unfinishedTasks.length, 50);
  const monday = application.query({ type: 'study.get_week_summary', payload: { date: '2026-07-13' } }, queryContext).value;
  assert.deepEqual({ weekStart: monday.weekStart, weekEnd: monday.weekEnd }, { weekStart: '2026-07-13', weekEnd: '2026-07-13' });
  assert.equal(monday.daily.length, 1);
  assert.equal(monday.totalMinutes, 0);
  const sunday = application.query({ type: 'study.get_week_summary', payload: { date: '2026-07-19' } }, queryContext).value;
  assert.equal(sunday.totalMinutes, 30);
  assert.equal(sunday.completedTasks, 1);
  assert.deepEqual(sunday.daily.map((entry) => entry.date), ['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17', '2026-07-18', '2026-07-19']);
  assert.throws(() => application.query({ type: 'study.get_today', payload: { date: '2026-02-30' } }, queryContext), /invalid|validation/i);
});

test('C10 writes are atomic, reconcile only matching references, and keep no-ops revision-neutral', async () => {
  const coordinator = await seedStudyData();
  const application = await databaseService.getStudyApplication();
  const before = coordinator.currentVersion();
  await assert.rejects(application.execute({ type: 'study.record_manual_progress', payload: { date: '2026-07-18', subjectId: 'math', minutes: 20, taskId: 'task-math', materialId: 'missing', materialCurrentAmount: 20 } }, context(before)));
  const database = await databaseService.getDatabase();
  assert.equal(database.exec('SELECT COUNT(*) FROM study_sessions')[0].values[0][0], 0);
  assert.equal(coordinator.currentVersion().dataRevision, before.dataRevision);

  const adjusted = await application.execute({ type: 'study.apply_plan_adjustment', payload: { taskId: 'task-math', estimatedMinutes: 60, note: 'stored note', status: '未开始' } }, context(before));
  assert.equal(adjusted.changed, false);
  assert.equal(coordinator.currentVersion().dataRevision, before.dataRevision);
  await assert.rejects(application.execute({ type: 'study.record_manual_progress', payload: { date: '2026-07-18', subjectId: 'english', minutes: 20, taskId: 'task-math' } }, context(before)));

  await coordinator.executeWrite({ requestId: `c10-null-note-${uuid().replaceAll('-', '')}`, concurrency: 'none', execute(database) {
    database.run('UPDATE study_tasks SET note=NULL WHERE id=?', ['task-math']);
    return { changed: true, value: null };
  }});
  const nullNoteVersion = coordinator.currentVersion();
  const nullNoteNoop = await application.execute({ type: 'study.apply_plan_adjustment', payload: { taskId: 'task-math' } }, context(nullNoteVersion));
  assert.equal(nullNoteNoop.changed, false);
  assert.equal(coordinator.currentVersion().dataRevision, nullNoteVersion.dataRevision);

  const draft = { type: 'study.create_plan_draft', payload: { date: '2026-07-18', tasks: [
    { subjectId: 'math', title: 'A', estimatedMinutes: 20 },
    { subjectId: 'english', title: 'B', estimatedMinutes: 30 }
  ] } };
  const resolved = application.resolveState({ apiVersion: 1, kind: 'agent-command', operation: draft.type, payload: draft.payload, requestId: uuid(), expectedVersion: coordinator.currentVersion(), catalog: agent.operationCatalogIdentity }, agent.resolveOperationDescriptor(draft.type));
  assert.equal(resolved.affectedEntityCount, 2);
  assert.equal(resolved.affectedEntities.length, 2);
  assert.notEqual(resolved.affectedEntities[0].entityId, resolved.affectedEntities[1].entityId);
});

test('C10 Gateway provides replay, stale conflict, audit, affected binding, and restart evidence', async () => {
  const coordinator = await seedStudyData();
  const plane = await databaseService.getAgentControlPlane();
  const version = coordinator.currentVersion();
  const requestId = uuid();
  const envelope = commandEnvelope('study.record_manual_progress', { date: '2026-07-18', subjectId: 'math', minutes: 25, taskId: 'task-math', materialId: 'material-math', materialCurrentAmount: 35 }, version, requestId);
  const first = await plane.gateway.execute(envelope, plane.renderer.principal());
  assert.equal(first.kind, 'completed');
  assert.equal(first.result.changed, true);
  const replay = await plane.gateway.execute(envelope, plane.renderer.principal());
  assert.equal(replay.kind, 'replayed');
  assert.equal((await databaseService.getDatabase()).exec('SELECT COUNT(*) FROM study_sessions')[0].values[0][0], 1);
  const receipt = (await databaseService.getDatabase()).exec('SELECT status, affected_set_hash FROM agent_idempotency WHERE request_id = ?', [requestId])[0].values[0];
  assert.equal(receipt[0], 'completed');
  assert.equal(receipt[1], agent.hashCanonicalJson([
    { entityType: 'study_material', entityId: 'material-math' },
    { entityType: 'study_session_create', entityId: agent.hashCanonicalJson(envelope.payload) },
    { entityType: 'study_task', entityId: 'task-math' }
  ]));
  const stale = await plane.gateway.execute(commandEnvelope('study.apply_plan_adjustment', { taskId: 'task-math', note: 'stale' }, version), plane.renderer.principal());
  assert.equal(stale.kind, 'rejected');
  assert.equal(stale.error.code, 'DATA_REVISION_CONFLICT');
  const auditCount = (await databaseService.getDatabase()).exec("SELECT COUNT(*) FROM agent_audit_events WHERE operation = 'study.record_manual_progress'")[0].values[0][0];
  assert.equal(auditCount >= 2, true);

  databaseService.resetDatabaseConnection();
  await databaseService.initializeDatabase({ agent: { appInstanceId: 'c10-restarted', cursorSecret: 'c10'.repeat(16) } });
  const restarted = await databaseService.getDatabase();
  assert.deepEqual(restarted.exec('SELECT status FROM agent_idempotency WHERE request_id = ?', [requestId])[0].values[0], ['completed']);
  assert.equal(restarted.exec('SELECT current_amount FROM study_materials WHERE id = ?', ['material-math'])[0].values[0][0], 35);
});

test('C10 reset rebuilds the study application against the reopened database', async () => {
  await seedStudyData();
  const beforeReset = await databaseService.getStudyApplication();
  databaseService.resetDatabaseConnection();
  const afterReset = await databaseService.getStudyApplication();
  assert.notEqual(afterReset, beforeReset);
});

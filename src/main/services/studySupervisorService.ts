import { randomUUID } from 'node:crypto';
import type { Database, SqlValue } from 'sql.js';
import type { ReadOnlyDatabaseFacade } from '../application/queryBus';
import type { DatabaseMutationResult } from '../persistence';
import {
  allSql,
  getDatabaseCoordinator,
  getQuestionsApplication,
  getReadOnlyDatabase,
  oneSql,
  runSql
} from './databaseService';
import type {
  DailyReview,
  DailyReviewInput,
  StudyMaterial,
  StudyMaterialFilters,
  StudyMaterialInput,
  StudyQuality,
  StudyRiskLevel,
  StudySession,
  StudySessionFilters,
  StudySessionInput,
  StudySettings,
  StudySubject,
  StudySubjectId,
  StudySubjectStat,
  StudySupervisorDashboard,
  StudyTask,
  StudyTaskFilters,
  StudyTaskInput
} from '../../shared/types';

const INCOMPLETE_TASK_STATUSES = ['未开始', '进行中', '部分完成'];
const DEFAULT_SUBJECTS = [
  { id: 'math', name: '数学', sort_order: 1 },
  { id: 'major', name: '专业课', sort_order: 2 },
  { id: 'politics', name: '政治', sort_order: 3 },
  { id: 'english', name: '英语', sort_order: 4 }
];

type StudyReadDatabase = Database | ReadOnlyDatabaseFacade;

function readAll<T>(database: StudyReadDatabase, sql: string, params: readonly SqlValue[] = []): T[] {
  if ('kind' in database) return [...database.select(sql, params)] as T[];
  return allSql<T>(database, sql, [...params]);
}

function readOne<T>(database: StudyReadDatabase, sql: string, params: readonly SqlValue[] = []): T | null {
  if ('kind' in database) return (database.select(sql, params)[0] as T | undefined) ?? null;
  return oneSql<T>(database, sql, [...params]);
}

function runMutation(database: Database, sql: string, params: readonly SqlValue[] = []): boolean {
  runSql(database, sql, [...params]);
  return database.getRowsModified() > 0;
}

async function executeLegacyMutation<T>(
  operation: string,
  execute: (database: Database) => DatabaseMutationResult<T> | Promise<DatabaseMutationResult<T>>
): Promise<T> {
  const coordinator = await getDatabaseCoordinator();
  const application = await getQuestionsApplication();
  const requestId = randomUUID();
  const preparedEvents = application.eventBus.prepareEvents(
    [{ type: 'legacy.operation_completed', payload: { operation } }],
    { requestId, traceId: randomUUID(), source: 'internal' }
  );
  const result = await coordinator.executeWrite({
    requestId,
    concurrency: 'none',
    execute
  });
  if (result.changed) {
    await application.eventBus.publish(application.eventBus.finalizeEvents(preparedEvents, {
      versionBefore: result.versionBefore,
      versionAfter: result.versionAfter
    }));
  }
  return result.value;
}

function nowIso() {
  return new Date().toISOString();
}

function localDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function id(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function parseDate(value?: string | null) {
  if (!value) return null;
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysBetween(from: string, to: string) {
  const fromDate = parseDate(from);
  const toDate = parseDate(to);
  if (!fromDate || !toDate) return 0;
  return Math.floor((toDate.getTime() - fromDate.getTime()) / 86400000);
}

function riskRank(level: StudyRiskLevel) {
  return { normal: 0, warning: 1, danger: 2, critical: 3 }[level];
}

function delayLevel(deferCount: number): StudyRiskLevel {
  if (deferCount >= 5) return 'critical';
  if (deferCount >= 3) return 'danger';
  if (deferCount >= 2) return 'warning';
  return 'normal';
}

function materialRisk(material: StudyMaterial, today = localDate()): StudyMaterial {
  const total = Math.max(0, Number(material.total_amount || 0));
  const current = Math.max(0, Number(material.current_amount || 0));
  const completionRate = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  const remainingAmount = Math.max(0, total - current);
  const unit = material.custom_unit_name || material.progress_unit;

  let expectedAmount: number | null = null;
  let lagAmount = 0;
  let riskLevel: StudyRiskLevel = 'normal';
  let suggestedDailyAmount: number | null = null;
  let suggestedPaceText: string | null = null;
  let catchUpText: string | null = null;

  const start = parseDate(material.start_date);
  const target = parseDate(material.target_date);
  if (start && target && total > 0) {
    const totalDays = Math.max(1, daysBetween(material.start_date!, material.target_date!));
    const elapsedDays = Math.max(0, Math.min(totalDays, daysBetween(material.start_date!, today)));
    // Don't flag materials that haven't been started yet (within 3 days grace)
    if (current === 0 && elapsedDays <= 3) {
      riskLevel = 'normal';
      lagAmount = 0;
      suggestedPaceText = '尚未开始，建议尽快启动';
    } else {
      expectedAmount = Math.min(total, Math.round((total * elapsedDays) / totalDays));
      lagAmount = Math.max(0, Math.round((expectedAmount - current) * 10) / 10);

      // Round lagAmount for discrete units (not pages)
      if (unit !== '页' && lagAmount > 0) {
        lagAmount = Math.ceil(lagAmount);
      }

      const lagRatio = lagAmount / total;
      if (lagRatio >= 0.3) riskLevel = 'critical';
      else if (lagRatio >= 0.2) riskLevel = 'danger';
      else if (lagRatio >= 0.1) riskLevel = 'warning';
      else if (lagAmount > 0) riskLevel = 'normal';

      const daysLeft = Math.max(1, daysBetween(today, material.target_date!));
      const dailyNeed = remainingAmount / daysLeft;
      if (dailyNeed >= 1) {
        suggestedDailyAmount = Math.ceil(dailyNeed);
        suggestedPaceText = `建议每日 ${suggestedDailyAmount} ${unit}`;
      } else if (dailyNeed > 0) {
        const weeklyNeed = Math.max(1, Math.round(dailyNeed * 7));
        suggestedPaceText = `每周约 ${weeklyNeed} ${unit}`;
      } else {
        suggestedPaceText = '已完成目标进度';
      }

      if (lagAmount > 0) {
        const catchUpPerDay = Math.ceil(lagAmount / Math.min(7, daysLeft));
        const catchUpDays = Math.ceil(lagAmount / Math.max(1, catchUpPerDay));
        if (catchUpDays <= 7) {
          catchUpText = `每天多学 ${catchUpPerDay} ${unit}，${catchUpDays} 天后赶上`;
        } else {
          catchUpText = `每天多学 ${catchUpPerDay} ${unit}，需 ${catchUpDays} 天赶上目标`;
        }
      }
    }
  }

  return {
    ...material,
    completionRate,
    remainingAmount,
    expectedAmount,
    lagAmount,
    suggestedDailyAmount,
    suggestedPaceText,
    catchUpText,
    riskLevel,
    note: material.note || '',
    custom_unit_name: material.custom_unit_name || null,
    unit
  } as StudyMaterial;
}

function hydrateTask(row: StudyTask): StudyTask {
  return { ...row, delayLevel: delayLevel(Number(row.defer_count || 0)), note: row.note || '' };
}

function ensureColumn(database: Database, table: string, name: string, sql: string) {
  const columns = allSql<{ name: string }>(database, `PRAGMA table_info(${table})`).map((column) => column.name);
  if (columns.includes(name)) return false;
  database.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${sql}`);
  return true;
}

export async function initializeStudySupervisor() {
  return executeLegacyMutation('study-initialize', (database) => {
    let changed = ensureColumn(database, 'study_settings', 'auto_rollover_enabled', 'INTEGER DEFAULT 1');
    changed = ensureColumn(database, 'study_settings', 'last_rollover_date', 'TEXT') || changed;
    changed = ensureColumn(database, 'study_materials', 'is_deleted', 'INTEGER DEFAULT 0') || changed;

    const timestamp = nowIso();
    changed = runMutation(
      database,
      `INSERT OR IGNORE INTO study_settings (
        id, exam_date, daily_target_minutes, supervision_mode, auto_rollover_enabled, last_rollover_date, created_at, updated_at
      ) VALUES (1, NULL, 240, 'strict', 1, NULL, ?, ?)`,
      [timestamp, timestamp]
    ) || changed;

    for (const subject of DEFAULT_SUBJECTS) {
      changed = runMutation(
        database,
        `INSERT OR IGNORE INTO study_subjects (id, name, sort_order, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
        [subject.id, subject.name, subject.sort_order, timestamp, timestamp]
      ) || changed;
    }
    return { changed, value: undefined };
  });
}

function getSettingsRow(database: StudyReadDatabase) {
  return readOne<StudySettings>(database, 'SELECT * FROM study_settings WHERE id = 1');
}

export async function getStudySettings() {
  return getSettingsRow(await getReadOnlyDatabase());
}

export async function updateStudySettings(input: Partial<StudySettings>) {
  return executeLegacyMutation('study-settings-update', (database) => {
    const changed = runMutation(
      database,
      `UPDATE study_settings SET
        exam_date = ?, daily_target_minutes = ?, supervision_mode = ?,
        auto_rollover_enabled = ?, updated_at = ?
       WHERE id = 1`,
      [
        input.exam_date || null,
        Number(input.daily_target_minutes || 240),
        input.supervision_mode || 'strict',
        input.auto_rollover_enabled === 0 ? 0 : 1,
        nowIso()
      ]
    );
    return { changed, value: getSettingsRow(database) };
  });
}

export async function listStudySubjects() {
  const database = await getReadOnlyDatabase();
  return readAll<StudySubject>(
    database,
    'SELECT * FROM study_subjects WHERE is_active = 1 ORDER BY sort_order ASC, name ASC'
  );
}

function materialSelectSql(whereSql = '') {
  return `SELECT m.*, s.name AS subject_name
    FROM study_materials m
    INNER JOIN study_subjects s ON s.id = m.subject_id
    WHERE COALESCE(m.is_deleted, 0) = 0 ${whereSql}
    ORDER BY CASE m.priority WHEN '高' THEN 0 WHEN '中' THEN 1 ELSE 2 END, m.updated_at DESC`;
}

export async function listStudyMaterials(filters: StudyMaterialFilters = {}) {
  const database = await getReadOnlyDatabase();
  return listStudyMaterialsFrom(database, filters);
}

function listStudyMaterialsFrom(database: StudyReadDatabase, filters: StudyMaterialFilters = {}) {
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (filters.subjectId && filters.subjectId !== 'all') {
    where.push('m.subject_id = ?');
    params.push(filters.subjectId);
  }
  if (filters.status && filters.status !== 'all') {
    where.push('m.status = ?');
    params.push(filters.status);
  }
  if (filters.search?.trim()) {
    where.push('(m.name LIKE ? OR m.note LIKE ?)');
    params.push(`%${filters.search.trim()}%`, `%${filters.search.trim()}%`);
  }

  const rows = readAll<StudyMaterial>(database, materialSelectSql(where.length ? `AND ${where.join(' AND ')}` : ''), params)
    .map((row) => materialRisk(row));

  if (!filters.risk || filters.risk === 'all') return rows;
  if (filters.risk === 'risky') return rows.filter((row) => (row.lagAmount || 0) > 0);
  return rows.filter((row) => row.riskLevel === filters.risk);
}

export async function createStudyMaterial(input: StudyMaterialInput) {
  return executeLegacyMutation('study-material-create', (database) => {
    const timestamp = nowIso();
    const materialId = id('material');
    const changed = runMutation(
      database,
      `INSERT INTO study_materials (
        id, subject_id, name, material_type, progress_unit, custom_unit_name,
        total_amount, current_amount, start_date, target_date, priority, status,
        note, is_deleted, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        materialId,
        input.subject_id,
        input.name.trim(),
        input.material_type || '其他',
        input.progress_unit || '自定义',
        input.custom_unit_name || null,
        Number(input.total_amount || 0),
        Number(input.current_amount || 0),
        input.start_date || null,
        input.target_date || null,
        input.priority || '中',
        input.status || '进行中',
        input.note || '',
        timestamp,
        timestamp
      ]
    );
    const value = listStudyMaterialsFrom(database).find((item) => item.id === materialId)!;
    return { changed, value };
  });
}

export async function updateStudyMaterial(materialId: string, input: StudyMaterialInput) {
  return executeLegacyMutation('study-material-update', (database) => {
    const changed = runMutation(
      database,
      `UPDATE study_materials SET
        subject_id = ?, name = ?, material_type = ?, progress_unit = ?, custom_unit_name = ?,
        total_amount = ?, current_amount = ?, start_date = ?, target_date = ?,
        priority = ?, status = ?, note = ?, updated_at = ?
       WHERE id = ?`,
      [
        input.subject_id,
        input.name.trim(),
        input.material_type || '其他',
        input.progress_unit || '自定义',
        input.custom_unit_name || null,
        Number(input.total_amount || 0),
        Number(input.current_amount || 0),
        input.start_date || null,
        input.target_date || null,
        input.priority || '中',
        input.status || '进行中',
        input.note || '',
        nowIso(),
        materialId
      ]
    );
    return { changed, value: listStudyMaterialsFrom(database).find((item) => item.id === materialId) ?? null };
  });
}

export async function deleteStudyMaterial(materialId: string) {
  return executeLegacyMutation('study-material-delete', (database) => ({
    changed: runMutation(database, 'UPDATE study_materials SET is_deleted = 1, updated_at = ? WHERE id = ? AND COALESCE(is_deleted, 0) = 0', [nowIso(), materialId]),
    value: true
  }));
}

export async function updateStudyMaterialProgress(materialId: string, currentAmount: number) {
  return executeLegacyMutation('study-material-progress', (database) => {
    const changed = runMutation(database, 'UPDATE study_materials SET current_amount = ?, updated_at = ? WHERE id = ?', [
      Number(currentAmount || 0),
      nowIso(),
      materialId
    ]);
    return { changed, value: listStudyMaterialsFrom(database).find((item) => item.id === materialId) ?? null };
  });
}

function taskSelectSql(whereSql = '') {
  return `SELECT t.*, s.name AS subject_name, m.name AS material_name
    FROM study_tasks t
    INNER JOIN study_subjects s ON s.id = t.subject_id
    LEFT JOIN study_materials m ON m.id = t.material_id
    ${whereSql}
    ORDER BY t.task_date ASC,
      CASE t.priority WHEN '高' THEN 0 WHEN '中' THEN 1 ELSE 2 END,
      t.created_at ASC`;
}

export async function listStudyTasks(filters: StudyTaskFilters = {}) {
  const database = await getReadOnlyDatabase();
  return listStudyTasksFrom(database, filters);
}

function listStudyTasksFrom(database: StudyReadDatabase, filters: StudyTaskFilters = {}) {
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (filters.date) {
    where.push(filters.includeBeforeDate ? 't.task_date <= ?' : 't.task_date = ?');
    params.push(filters.date);
  }
  if (filters.subjectId && filters.subjectId !== 'all') {
    where.push('t.subject_id = ?');
    params.push(filters.subjectId);
  }
  if (filters.status && filters.status !== 'all') {
    where.push('t.status = ?');
    params.push(filters.status);
  }
  return readAll<StudyTask>(database, taskSelectSql(where.length ? `WHERE ${where.join(' AND ')}` : ''), params)
    .map(hydrateTask);
}

function assertTaskInput(input: StudyTaskInput) {
  if (input.status === '已跳过' && !input.skipped_reason?.trim()) {
    throw new Error('强度监督模式下，跳过任务必须填写原因。');
  }
}

export async function createStudyTask(input: StudyTaskInput) {
  assertTaskInput(input);
  return executeLegacyMutation('study-task-create', (database) => {
    const timestamp = nowIso();
    const taskId = id('task');
    const changed = runMutation(
      database,
      `INSERT INTO study_tasks (
        id, task_date, subject_id, material_id, title, task_type, estimated_minutes,
        actual_minutes, priority, status, completion_quality, defer_count, original_date,
        skipped_reason, note, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?)`,
      [
        taskId,
        input.task_date || localDate(),
        input.subject_id,
        input.material_id || null,
        input.title.trim(),
        input.task_type || '其他',
        Number(input.estimated_minutes || 0),
        Number(input.actual_minutes || 0),
        input.priority || '中',
        input.status || '未开始',
        input.completion_quality || null,
        input.skipped_reason || null,
        input.note || '',
        timestamp,
        timestamp,
        input.status === '已完成' ? timestamp : null
      ]
    );
    return { changed, value: listStudyTasksFrom(database).find((item) => item.id === taskId)! };
  });
}

export async function updateStudyTask(taskId: string, input: StudyTaskInput) {
  assertTaskInput(input);
  return executeLegacyMutation('study-task-update', (database) => {
    const completedAt = input.status === '已完成' ? nowIso() : null;
    const changed = runMutation(
      database,
      `UPDATE study_tasks SET
        task_date = ?, subject_id = ?, material_id = ?, title = ?, task_type = ?,
        estimated_minutes = ?, actual_minutes = ?, priority = ?, status = ?,
        completion_quality = ?, skipped_reason = ?, note = ?, updated_at = ?,
        completed_at = ?
       WHERE id = ?`,
      [
        input.task_date || localDate(),
        input.subject_id,
        input.material_id || null,
        input.title.trim(),
        input.task_type || '其他',
        Number(input.estimated_minutes || 0),
        Number(input.actual_minutes || 0),
        input.priority || '中',
        input.status || '未开始',
        input.completion_quality || null,
        input.skipped_reason || null,
        input.note || '',
        nowIso(),
        completedAt,
        taskId
      ]
    );
    return { changed, value: listStudyTasksFrom(database).find((item) => item.id === taskId) ?? null };
  });
}

export async function deleteStudyTask(taskId: string) {
  return executeLegacyMutation('study-task-delete', (database) => ({
    changed: runMutation(database, 'DELETE FROM study_tasks WHERE id = ?', [taskId]),
    value: true
  }));
}

export async function completeStudyTask(taskId: string, input: { actual_minutes?: number; completion_quality?: StudyQuality; note?: string } = {}) {
  return executeLegacyMutation('study-task-complete', (database) => {
    const current = readOne<StudyTask>(database, 'SELECT * FROM study_tasks WHERE id = ?', [taskId]);
    if (!current) return { changed: false, value: null };
    const timestamp = nowIso();
    const changed = runMutation(
      database,
      `UPDATE study_tasks SET status = '已完成', actual_minutes = ?, completion_quality = ?,
        note = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
      [
        Number(input.actual_minutes ?? current.actual_minutes ?? 0),
        input.completion_quality || current.completion_quality || null,
        input.note ?? current.note ?? '',
        timestamp,
        timestamp,
        taskId
      ]
    );
    return { changed, value: listStudyTasksFrom(database).find((item) => item.id === taskId) ?? null };
  });
}

export async function skipStudyTask(taskId: string, reason: string) {
  if (!reason.trim()) throw new Error('强度监督模式下，跳过任务必须填写原因。');
  return executeLegacyMutation('study-task-skip', (database) => {
    const timestamp = nowIso();
    const changed = runMutation(
      database,
      `UPDATE study_tasks SET status = '已跳过', skipped_reason = ?, completed_at = ?, updated_at = ?
       WHERE id = ?`,
      [reason.trim(), timestamp, timestamp, taskId]
    );
    return { changed, value: listStudyTasksFrom(database).find((item) => item.id === taskId) ?? null };
  });
}

export async function rolloverStudyTasks(force = false) {
  return executeLegacyMutation('study-task-rollover', (database) => {
    const settings = getSettingsRow(database);
    if (!settings) return { changed: false, value: { rolled: 0, skipped: true } };
    const today = localDate();
    if (!force && settings.auto_rollover_enabled !== 0 && settings.last_rollover_date === today) {
      return { changed: false, value: { rolled: 0, skipped: true } };
    }
    if (settings.auto_rollover_enabled === 0 && !force) {
      return { changed: false, value: { rolled: 0, skipped: true } };
    }

    const timestamp = nowIso();
    const placeholders = INCOMPLETE_TASK_STATUSES.map(() => '?').join(', ');
    const tasks = readAll<StudyTask>(
      database,
      `SELECT * FROM study_tasks WHERE task_date < ? AND status IN (${placeholders})`,
      [today, ...INCOMPLETE_TASK_STATUSES]
    );
    let changed = false;
    for (const task of tasks) {
      changed = runMutation(
        database,
        `UPDATE study_tasks SET task_date = ?, defer_count = COALESCE(defer_count, 0) + 1,
          original_date = COALESCE(original_date, ?), updated_at = ? WHERE id = ?`,
        [today, task.task_date, timestamp, task.id]
      ) || changed;
    }
    changed = runMutation(database, 'UPDATE study_settings SET last_rollover_date = ?, updated_at = ? WHERE id = 1', [today, timestamp]) || changed;
    return { changed, value: { rolled: tasks.length, skipped: false } };
  });
}

export async function listTodayStudyTasks() {
  return listStudyTasks({ date: localDate() });
}

function sessionSelectSql(whereSql = '') {
  return `SELECT ss.*, subj.name AS subject_name, t.title AS task_title, m.name AS material_name
    FROM study_sessions ss
    INNER JOIN study_subjects subj ON subj.id = ss.subject_id
    LEFT JOIN study_tasks t ON t.id = ss.task_id
    LEFT JOIN study_materials m ON m.id = ss.material_id
    ${whereSql}
    ORDER BY ss.start_time DESC`;
}

export async function listStudySessions(filters: StudySessionFilters = {}) {
  const database = await getReadOnlyDatabase();
  return listStudySessionsFrom(database, filters);
}

function listStudySessionsFrom(database: StudyReadDatabase, filters: StudySessionFilters = {}) {
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (filters.date) {
    where.push('ss.session_date = ?');
    params.push(filters.date);
  }
  if (filters.subjectId && filters.subjectId !== 'all') {
    where.push('ss.subject_id = ?');
    params.push(filters.subjectId);
  }
  if (filters.from) {
    where.push('ss.session_date >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    where.push('ss.session_date <= ?');
    params.push(filters.to);
  }
  return readAll<StudySession>(database, sessionSelectSql(where.length ? `WHERE ${where.join(' AND ')}` : ''), params)
    .map((row) => ({ ...row, note: row.note || '' }));
}

export async function createStudySession(input: StudySessionInput) {
  return executeLegacyMutation('study-session-create', (database) => {
    const timestamp = nowIso();
    const sessionId = id('session');
    let changed = runMutation(
      database,
      `INSERT INTO study_sessions (
        id, session_date, subject_id, task_id, material_id, start_time, end_time,
        duration_minutes, quality, note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sessionId,
        input.session_date || localDate(),
        input.subject_id,
        input.task_id || null,
        input.material_id || null,
        input.start_time,
        input.end_time || null,
        Number(input.duration_minutes || 0),
        input.quality || null,
        input.note || '',
        timestamp,
        timestamp
      ]
    );

    if (input.task_id) {
      changed = runMutation(
        database,
        'UPDATE study_tasks SET actual_minutes = COALESCE(actual_minutes, 0) + ?, updated_at = ? WHERE id = ?',
        [Number(input.duration_minutes || 0), timestamp, input.task_id]
      ) || changed;
    }
    return { changed, value: listStudySessionsFrom(database).find((item) => item.id === sessionId)! };
  });
}

export async function deleteStudySession(sessionId: string) {
  return executeLegacyMutation('study-session-delete', (database) => ({
    changed: runMutation(database, 'DELETE FROM study_sessions WHERE id = ?', [sessionId]),
    value: true
  }));
}

function dailyTaskStats(database: Database, date: string) {
  const total = oneSql<{ count: number }>(database, 'SELECT COUNT(*) AS count FROM study_tasks WHERE task_date = ?', [date])?.count ?? 0;
  const completed = oneSql<{ count: number }>(
    database,
    "SELECT COUNT(*) AS count FROM study_tasks WHERE task_date = ? AND status IN ('已完成', '已跳过')",
    [date]
  )?.count ?? 0;
  const minutes = oneSql<{ total: number }>(
    database,
    'SELECT COALESCE(SUM(duration_minutes), 0) AS total FROM study_sessions WHERE session_date = ?',
    [date]
  )?.total ?? 0;
  return { total, completed, minutes, rate: total ? Math.round((completed / total) * 100) : 0 };
}

export async function getDailyReview(date = localDate()) {
  return readOne<DailyReview>(await getReadOnlyDatabase(), 'SELECT * FROM daily_reviews WHERE review_date = ?', [date]);
}

export async function saveDailyReview(input: DailyReviewInput) {
  return executeLegacyMutation('study-review-save', (database) => {
    const date = input.review_date || localDate();
    const stats = dailyTaskStats(database, date);
    const existing = readOne<DailyReview>(database, 'SELECT * FROM daily_reviews WHERE review_date = ?', [date]);
    const timestamp = nowIso();
    const changed = existing
      ? runMutation(
        database,
        `UPDATE daily_reviews SET completion_rate = ?, total_study_minutes = ?,
          completed_task_count = ?, total_task_count = ?, mood = ?, today_summary = ?,
          main_problem = ?, tomorrow_priority = ?, updated_at = ? WHERE review_date = ?`,
        [
          stats.rate,
          stats.minutes,
          stats.completed,
          stats.total,
          input.mood || null,
          input.today_summary || '',
          input.main_problem || '',
          input.tomorrow_priority || '',
          timestamp,
          date
        ]
      )
      : runMutation(
        database,
        `INSERT INTO daily_reviews (
          id, review_date, completion_rate, total_study_minutes, completed_task_count,
          total_task_count, mood, today_summary, main_problem, tomorrow_priority, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id('review'),
          date,
          stats.rate,
          stats.minutes,
          stats.completed,
          stats.total,
          input.mood || null,
          input.today_summary || '',
          input.main_problem || '',
          input.tomorrow_priority || '',
          timestamp,
          timestamp
        ]
      );
    return { changed, value: readOne<DailyReview>(database, 'SELECT * FROM daily_reviews WHERE review_date = ?', [date]) };
  });
}

function consecutiveNoStudyDays(sessions: StudySession[], subjectId: StudySubjectId, today: string) {
  let days = 0;
  for (let offset = 0; offset < 30; offset += 1) {
    const date = new Date(`${today}T00:00:00`);
    date.setDate(date.getDate() - offset);
    const dateText = localDate(date);
    const studied = sessions.some((session) => session.subject_id === subjectId && session.session_date === dateText);
    if (studied) break;
    days += 1;
  }
  return days;
}

export async function getStudySupervisorDashboard(date = localDate()): Promise<StudySupervisorDashboard> {
  const database = await getReadOnlyDatabase();
  const settings = getSettingsRow(database);
  if (!settings) throw new Error('Study supervisor is not initialized');
  const subjects = readAll<StudySubject>(database, 'SELECT * FROM study_subjects WHERE is_active = 1 ORDER BY sort_order ASC, name ASC');
  const materials = listStudyMaterialsFrom(database);
  const tasks = listStudyTasksFrom(database, { date });
  const weekStart = new Date(`${date}T00:00:00`);
  const day = weekStart.getDay() || 7;
  weekStart.setDate(weekStart.getDate() - day + 1);
  const weekStartText = localDate(weekStart);
  const sessions = listStudySessionsFrom(database, { from: weekStartText, to: date });
  const todaySessions = sessions.filter((session) => session.session_date === date);

  const todayStudyMinutes = todaySessions.reduce((sum, session) => sum + Number(session.duration_minutes || 0), 0);
  const todayTaskTotal = tasks.length;
  const todayTaskCompleted = tasks.filter((task) => task.status === '已完成' || task.status === '已跳过').length;
  const todayCompletionRate = todayTaskTotal ? Math.round((todayTaskCompleted / todayTaskTotal) * 100) : 0;
  const delayedTasks = tasks.filter((task) => task.defer_count > 0 && !['已完成', '已跳过'].includes(task.status));
  const criticalDelayedTasks = delayedTasks.filter((task) => delayLevel(task.defer_count) === 'critical' || delayLevel(task.defer_count) === 'danger');
  const riskyMaterials = materials.filter((material) => (material.lagAmount || 0) > 0);

  const subjectStats: StudySubjectStat[] = subjects.map((subject) => {
    const subjectTasks = tasks.filter((task) => task.subject_id === subject.id);
    const subjectMaterials = materials.filter((material) => material.subject_id === subject.id);
    const noStudyDays = consecutiveNoStudyDays(sessions, subject.id, date);
    const delayedMaterialCount = subjectMaterials.filter((material) => (material.lagAmount || 0) > 0).length;
    const weekStudyMinutes = sessions
      .filter((session) => session.subject_id === subject.id)
      .reduce((sum, session) => sum + Number(session.duration_minutes || 0), 0);
    const unfinishedTaskCount = subjectTasks.filter((task) => INCOMPLETE_TASK_STATUSES.includes(task.status)).length;
    let status: StudyRiskLevel = 'normal';
    if (noStudyDays >= 7 || delayedMaterialCount >= 2 || subjectTasks.some((task) => task.defer_count >= 5)) status = 'critical';
    else if (noStudyDays >= 5 || delayedMaterialCount >= 1 || subjectTasks.some((task) => task.defer_count >= 3)) status = 'danger';
    else if (noStudyDays >= 3 || subjectTasks.some((task) => task.defer_count >= 2)) status = 'warning';
    return {
      subjectId: subject.id,
      subjectName: subject.name,
      weekStudyMinutes,
      todayTaskTotal: subjectTasks.length,
      todayTaskCompleted: subjectTasks.filter((task) => task.status === '已完成' || task.status === '已跳过').length,
      unfinishedTaskCount,
      consecutiveNoStudyDays: noStudyDays,
      materialCount: subjectMaterials.length,
      delayedMaterialCount,
      status
    };
  });

  const maxSubjectRisk = subjectStats.reduce<StudyRiskLevel>((level, item) => (riskRank(item.status) > riskRank(level) ? item.status : level), 'normal');
  let supervisionStatus: StudyRiskLevel = maxSubjectRisk;
  if (criticalDelayedTasks.length || riskyMaterials.some((material) => material.riskLevel === 'danger')) supervisionStatus = 'danger';
  if (delayedTasks.some((task) => task.defer_count >= 5)) supervisionStatus = 'critical';
  if (todayTaskTotal > 0 && todayCompletionRate < 50 && new Date().getHours() >= 20) supervisionStatus = 'danger';

  const dueReviewCount = readOne<{ count: number }>(
    database,
    `SELECT COUNT(*) AS count FROM questions
     WHERE (next_review_at IS NOT NULL AND next_review_at != '' AND substr(next_review_at, 1, 10) <= ?)
        OR ((next_review_at IS NULL OR next_review_at = '') AND COALESCE(review_count, 0) = 0)`,
    [date]
  )?.count ?? 0;

  const suggestions: string[] = [];
  const dangerTask = criticalDelayedTasks[0];
  if (dangerTask) suggestions.push(`先处理拖延 ${dangerTask.defer_count} 天的任务：${dangerTask.title}`);
  const risky = riskyMaterials[0];
  if (risky) {
    const unit = risky.custom_unit_name || risky.progress_unit;
    suggestions.push(`${risky.name} 已落后 ${risky.lagAmount}${unit}，${risky.catchUpText || risky.suggestedPaceText || '请尽快安排补进度'}`);
  }
  const noStudy = subjectStats.find((item) => item.consecutiveNoStudyDays >= 3);
  if (noStudy) suggestions.push(`${noStudy.subjectName} 已连续 ${noStudy.consecutiveNoStudyDays} 天未学习，今天至少安排 30 分钟`);
  if (dueReviewCount > 0) suggestions.push(`数学今日有 ${dueReviewCount} 道错题待复习，请前往复习页处理`);
  if (!suggestions.length) suggestions.push('今天没有明显风险，按计划推进并在晚上完成复盘。');

  return {
    today: date,
    examDate: settings.exam_date,
    daysUntilExam: settings.exam_date ? Math.max(0, daysBetween(date, settings.exam_date)) : null,
    dailyTargetMinutes: Number(settings.daily_target_minutes || 240),
    todayStudyMinutes,
    todayTaskTotal,
    todayTaskCompleted,
    todayCompletionRate,
    todayUnfinishedTaskCount: tasks.filter((task) => INCOMPLETE_TASK_STATUSES.includes(task.status)).length,
    supervisionStatus,
    dueReviewCount,
    subjectStats,
    delayedTasks,
    criticalDelayedTasks,
    riskyMaterials,
    noStudySubjects: subjectStats.filter((item) => item.consecutiveNoStudyDays >= 3),
    suggestions
  };
}

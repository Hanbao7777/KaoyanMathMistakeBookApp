import type { Database, SqlValue } from 'sql.js';
import { assertDatabaseMutationScope, type DatabaseMutationScope } from '../../persistence/databaseCoordinator';
import type { StudyTask, StudySession } from '../../../shared/types';
import type { StudyCommand, StudyCommandValues } from './contracts';
import { isCanonicalStudyDate } from '../../../shared/agent/v1/schemas';

function one<T>(database: Database, sql: string, values: readonly SqlValue[] = []): T | null {
  const statement = database.prepare(sql);
  try {
    statement.bind([...values]);
    return statement.step() ? statement.getAsObject() as T : null;
  } finally {
    statement.free();
  }
}

function changed(database: Database, sql: string, values: readonly SqlValue[] = []): boolean {
  database.run(sql, [...values]);
  return database.getRowsModified() > 0;
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be blank`);
  return normalized;
}

function requireDate(value: string): string {
  if (!isCanonicalStudyDate(value)) throw new Error('Invalid study date');
  return value;
}

function requireSubject(database: Database, subjectId: string): void {
  if (!one(database, 'SELECT id FROM study_subjects WHERE id = ? AND is_active = 1', [subjectId])) throw new Error('Study subject not found');
}

function requireTask(database: Database, taskId: string): StudyTask { const task = one<StudyTask>(database, 'SELECT * FROM study_tasks WHERE id = ?', [taskId]); if (!task) throw new Error('Study task not found'); return task; }
function requireMaterial(database: Database, materialId: string): { id: string; subject_id: string; total_amount: number; is_deleted: number } {
  const material = one<{ id: string; subject_id: string; total_amount: number; is_deleted: number }>(database, 'SELECT id, subject_id, total_amount, COALESCE(is_deleted, 0) AS is_deleted FROM study_materials WHERE id = ?', [materialId]);
  if (!material || material.is_deleted !== 0) throw new Error('Study material not found');
  return material;
}

export function executeStudyCommand<C extends StudyCommand>(command: C, database: Database, scope: DatabaseMutationScope, now: () => string, nextId: (prefix: string) => string): { changed: boolean; value: StudyCommandValues[C['type']]; eventType: string; eventPayload: Record<string, unknown> } {
  assertDatabaseMutationScope(scope, database);
  const timestamp = now();
  switch (command.type) {
    case 'study.create_plan_draft': {
      const date = requireDate(command.payload.date);
      for (const task of command.payload.tasks) {
        requireSubject(database, task.subjectId);
        requiredText(task.title, 'Study task title');
      }
      const ids: string[] = [];
      for (const task of command.payload.tasks) {
        const id = nextId('study-task');
        changed(database, `INSERT INTO study_tasks (id,task_date,subject_id,material_id,title,task_type,estimated_minutes,actual_minutes,priority,status,completion_quality,defer_count,original_date,skipped_reason,note,created_at,updated_at,completed_at) VALUES (?,?,?,?,?,'其他',?,0,?,'未开始',NULL,0,NULL,NULL,?,?,?,NULL)`, [id, date, task.subjectId, null, requiredText(task.title, 'Study task title'), task.estimatedMinutes, task.priority ?? '中', task.note ?? '', timestamp, timestamp]);
        ids.push(id);
      }
      return { changed: ids.length > 0, value: { date, createdTaskIds: Object.freeze(ids) } as StudyCommandValues[C['type']], eventType: 'study.plan_draft_created', eventPayload: { date, taskCount: ids.length } };
    }
    case 'study.apply_plan_adjustment': {
      const current = requireTask(database, command.payload.taskId);
      const nextStatus = command.payload.status ?? current.status;
      const next = { estimated: command.payload.estimatedMinutes ?? current.estimated_minutes, priority: command.payload.priority ?? current.priority, note: command.payload.note ?? current.note, status: nextStatus, skipped: nextStatus === '已跳过' ? (command.payload.skippedReason ?? current.skipped_reason ?? null) : null };
      if (next.status === '已跳过' && !String(next.skipped).trim()) throw new Error('Skipped study task requires a reason');
      const completedAt = next.status === '已完成' || next.status === '已跳过' ? (current.completed_at ?? timestamp) : null;
      const didChange = changed(database, `UPDATE study_tasks SET estimated_minutes=?, priority=?, note=?, status=?, skipped_reason=?, completed_at=?, updated_at=? WHERE id=? AND (estimated_minutes IS NOT ? OR priority IS NOT ? OR note IS NOT ? OR status IS NOT ? OR skipped_reason IS NOT ? OR completed_at IS NOT ?)`, [
        next.estimated, next.priority, next.note, next.status, next.skipped, completedAt, timestamp,
        command.payload.taskId, next.estimated, next.priority, next.note, next.status, next.skipped, completedAt
      ]);
      return { changed: didChange, value: one<StudyTask>(database, 'SELECT * FROM study_tasks WHERE id = ?', [command.payload.taskId]) as StudyCommandValues[C['type']], eventType: 'study.plan_adjusted', eventPayload: { taskId: command.payload.taskId } };
    }
    case 'study.record_manual_progress': {
      const date = requireDate(command.payload.date);
      requireSubject(database, command.payload.subjectId);
      const task = command.payload.taskId ? requireTask(database, command.payload.taskId) : null;
      if (task && task.subject_id !== command.payload.subjectId) throw new Error('Study task subject mismatch');
      if (command.payload.materialCurrentAmount !== undefined && !command.payload.materialId) throw new Error('Material amount requires a material');
      const material = command.payload.materialId ? requireMaterial(database, command.payload.materialId) : null;
      if (material && material.subject_id !== command.payload.subjectId) throw new Error('Study material subject mismatch');
      if (task?.material_id && material && task.material_id !== material.id) throw new Error('Study task material mismatch');
      if (material && command.payload.materialCurrentAmount !== undefined && command.payload.materialCurrentAmount > Number(material.total_amount)) throw new Error('Material progress exceeds total amount');
      const id = nextId('study-session');
      changed(database, `INSERT INTO study_sessions (id,session_date,subject_id,task_id,material_id,start_time,end_time,duration_minutes,quality,note,created_at,updated_at) VALUES (?,?,?,?,?,?,NULL,?,NULL,?,?,?)`, [
        id, date, command.payload.subjectId, task?.id ?? null, material?.id ?? null, `${date}T00:00:00.000Z`,
        command.payload.minutes, command.payload.note ?? '', timestamp, timestamp
      ]);
      if (task) changed(database, 'UPDATE study_tasks SET actual_minutes=COALESCE(actual_minutes,0)+?, updated_at=? WHERE id=?', [command.payload.minutes, timestamp, task.id]);
      if (material && command.payload.materialCurrentAmount !== undefined) changed(database, 'UPDATE study_materials SET current_amount=?, updated_at=? WHERE id=? AND current_amount IS NOT ?', [command.payload.materialCurrentAmount, timestamp, material.id, command.payload.materialCurrentAmount]);
      return { changed: true, value: one<StudySession>(database, 'SELECT * FROM study_sessions WHERE id = ?', [id]) as StudyCommandValues[C['type']], eventType: 'study.manual_progress_recorded', eventPayload: { studySessionId: id, date, ...(task ? { taskId: task.id } : {}), ...(material ? { materialId: material.id } : {}) } };
    }
  }
}

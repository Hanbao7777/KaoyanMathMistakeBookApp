import { randomUUID } from 'node:crypto';
import type { Database, SqlValue } from 'sql.js';
import type { DatabaseMutationScope } from '../../persistence/databaseCoordinator';
import { assertDatabaseMutationScope } from '../../persistence/databaseCoordinator';
import { createQuestionCommandHandlers } from '../questions/commands';
import type { TrustedExecutionContext } from '../../../shared/agent/v1/contracts';
import type { TickTickBridge, TickTickFocusSession, TickTickHabit, TickTickHabitPatch, TickTickList, TickTickListPatch, TickTickTask } from '../../../shared/types';
import type { TickTickCommand, TickTickCommandValues, TickTickTaskPatch } from './contracts';

const TASK_SELECT = 'SELECT t.*, l.name AS list_name, l.color AS list_color FROM ticktick_tasks t LEFT JOIN ticktick_lists l ON t.list_id = l.id';

export interface TickTickCommandDependencies {
  readonly now?: () => string;
  readonly randomUUID?: () => string;
}

export interface TickTickCommandResult<T> {
  readonly changed: boolean;
  readonly value: T;
  readonly eventType: string;
  readonly eventPayload: Readonly<Record<string, unknown>>;
}

function now(dependencies: TickTickCommandDependencies): string {
  return new Date((dependencies.now ?? (() => new Date().toISOString()))()).toISOString();
}

function dateOnly(timestamp: string): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function id(prefix: string, dependencies: TickTickCommandDependencies): string {
  return `${prefix}_${(dependencies.randomUUID ?? randomUUID)()}`;
}

function all<T>(database: Database, sql: string, parameters: readonly SqlValue[] = []): T[] {
  const statement = database['prepare'](sql);
  const rows: T[] = [];
  try {
    statement.bind([...parameters]);
    while (statement.step()) rows.push(statement.getAsObject() as T);
  } finally {
    statement.free();
  }
  return rows;
}

function one<T>(database: Database, sql: string, parameters: readonly SqlValue[] = []): T | null {
  return all<T>(database, sql, parameters)[0] ?? null;
}

function run(database: Database, sql: string, parameters: readonly SqlValue[] = []): boolean {
  const statement = database['prepare'](sql);
  try {
    statement.bind([...parameters]);
    statement.step();
  } finally {
    statement.free();
  }
  return database.getRowsModified() > 0;
}

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function task(database: Database, taskId: string): TickTickTask | null {
  const value = one<TickTickTask>(database, `${TASK_SELECT} WHERE t.id = ?`, [taskId]);
  if (!value) return null;
  const stats = one<{ total: number; completed: number }>(database,
    'SELECT COUNT(*) AS total, COALESCE(SUM(is_completed), 0) AS completed FROM ticktick_tasks WHERE parent_id = ?', [taskId]);
  return {
    ...value,
    tags_list: parseTags(value.tags),
    subtask_count: Number(stats?.total ?? 0),
    subtask_completed: Number(stats?.completed ?? 0)
  };
}

function assertList(database: Database, listId: string): void {
  if (!one<{ id: string }>(database, 'SELECT id FROM ticktick_lists WHERE id = ?', [listId])) {
    throw new Error('清单不存在，请刷新后重试');
  }
}

function createTask(database: Database, input: Extract<TickTickCommand, { type: 'tasks.create' }>['payload']['input'], dependencies: TickTickCommandDependencies): TickTickTask {
  const listId = input.list_id?.trim();
  if (!listId) throw new Error('请先创建或选择一个清单');
  const title = input.title.trim();
  if (!title) throw new Error('任务标题不能为空');
  assertList(database, listId);
  const taskId = id('task', dependencies);
  const timestamp = now(dependencies);
  const maxOrder = Number(one<{ value: number }>(database, 'SELECT MAX(sort_order) AS value FROM ticktick_tasks WHERE list_id = ?', [listId])?.value ?? -1);
  run(database, `INSERT INTO ticktick_tasks (
    id, list_id, title, note, due_date, due_time, priority, is_completed, completed_at, parent_id,
    sort_order, tags, recurrence_rule, estimated_minutes, actual_minutes, pomodoro_sessions, source, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`, [
    taskId, listId, title, input.note || '', input.due_date ?? null, input.due_time ?? null,
    input.priority || 'none', input.parent_id ?? null, maxOrder + 1, JSON.stringify(input.tags || []),
    input.recurrence_rule ?? null, input.estimated_minutes ?? 0, input.source || 'manual', timestamp, timestamp
  ]);
  for (const tag of input.tags || []) {
    run(database, 'INSERT OR IGNORE INTO ticktick_tags (id, name, color) VALUES (?, ?, ?)', [`tag_${tag}`, tag, '#999999']);
  }
  return task(database, taskId)!;
}

function updateTask(database: Database, taskId: string, partial: TickTickTaskPatch, dependencies: TickTickCommandDependencies): { changed: boolean; value: TickTickTask | null } {
  const current = task(database, taskId);
  if (!current) return { changed: false, value: null };
  const sets: string[] = [];
  const values: SqlValue[] = [];
  if (partial.list_id !== undefined) {
    const listId = partial.list_id.trim();
    if (!listId) throw new Error('请先创建或选择一个清单');
    assertList(database, listId);
    if (current.list_id !== listId) { sets.push('list_id = ?'); values.push(listId); }
  }
  if (partial.title !== undefined) {
    const title = partial.title.trim();
    if (!title) throw new Error('任务标题不能为空');
    if (current.title !== title) { sets.push('title = ?'); values.push(title); }
  }
  const fields: ReadonlyArray<[keyof TickTickTaskPatch, string]> = [
    ['note', 'note'], ['due_date', 'due_date'], ['due_time', 'due_time'], ['priority', 'priority'],
    ['parent_id', 'parent_id'], ['recurrence_rule', 'recurrence_rule'], ['estimated_minutes', 'estimated_minutes'],
    ['actual_minutes', 'actual_minutes'], ['pomodoro_sessions', 'pomodoro_sessions'], ['source', 'source'], ['sort_order', 'sort_order']
  ];
  for (const [key, column] of fields) {
    if (partial[key] !== undefined && current[column as keyof TickTickTask] !== partial[key]) {
      sets.push(`${column} = ?`); values.push(partial[key] as SqlValue);
    }
  }
  if (partial.tags !== undefined && JSON.stringify(parseTags(current.tags)) !== JSON.stringify(partial.tags)) {
    sets.push('tags = ?'); values.push(JSON.stringify(partial.tags));
  }
  if (partial.is_completed !== undefined) {
    if (current.is_completed !== partial.is_completed) {
      sets.push('is_completed = ?'); values.push(partial.is_completed);
      if (partial.is_completed === 1) { sets.push('completed_at = ?'); values.push(now(dependencies)); }
      else sets.push('completed_at = NULL');
    }
  }
  if (!sets.length) return { changed: false, value: current };
  sets.push('updated_at = ?'); values.push(now(dependencies), taskId);
  const changed = run(database, `UPDATE ticktick_tasks SET ${sets.join(', ')} WHERE id = ?`, values);
  return { changed, value: task(database, taskId) };
}

function reviewNote(title: string): string {
  return `TickTick 任务完成: ${title}`;
}

async function completeWithBridge(
  database: Database,
  scope: DatabaseMutationScope,
  context: TrustedExecutionContext,
  taskId: string,
  completed: boolean,
  dependencies: TickTickCommandDependencies
): Promise<{ changed: boolean; value: TickTickTask | null }> {
  const updated = updateTask(database, taskId, { is_completed: completed ? 1 : 0 }, dependencies);
  if (!updated.value) return updated;
  let changed = updated.changed;
  const timestamp = now(dependencies);
  const questionHandlers = createQuestionCommandHandlers({ now: () => timestamp });
  const bridges = all<{ linked_type: string; linked_id: string }>(database,
    'SELECT linked_type, linked_id FROM ticktick_bridge WHERE ticktick_task_id = ? AND sync_review = 1 ORDER BY id ASC', [taskId]);
  for (const bridge of bridges) {
    if (bridge.linked_type === 'question') {
      const questionId = Number.parseInt(bridge.linked_id, 10);
      if (!Number.isSafeInteger(questionId) || questionId <= 0) continue;
      const matches = all<{ id: number }>(database,
        'SELECT id FROM review_logs WHERE question_id = ? AND review_date = ? AND note = ? ORDER BY id DESC',
        [questionId, dateOnly(timestamp), reviewNote(updated.value.title)]);
      if (completed) {
        if (!matches.length) {
          await questionHandlers.submitReview({ type: 'questions.submit_review', payload: { questionId, result: 'correct', note: reviewNote(updated.value.title) } }, context, database, scope);
          changed = true;
        }
      } else if (matches.length) {
        if (matches.length !== 1) throw new Error('Review undo is ambiguous for the bridged task');
        await questionHandlers.undoReview({ type: 'questions.undo_review', payload: { questionId, reviewLogId: matches[0].id } }, context, database, scope);
        changed = true;
      }
    } else if (completed && bridge.linked_type === 'study_task') {
      const studyTask = one<{ status: string }>(database, 'SELECT status FROM study_tasks WHERE id = ?', [bridge.linked_id]);
      if (studyTask && studyTask.status !== '已完成') {
        changed = run(database, `UPDATE study_tasks SET status = '已完成', actual_minutes = actual_minutes + ?, completed_at = ?, updated_at = ? WHERE id = ?`,
          [updated.value.actual_minutes || updated.value.estimated_minutes || 0, timestamp, timestamp, bridge.linked_id]) || changed;
      }
    }
  }
  return { changed, value: task(database, taskId) };
}

function deleteTask(database: Database, taskId: string): boolean {
  const taskIds = [taskId];
  for (let index = 0; index < taskIds.length; index += 1) {
    for (const child of all<{ id: string }>(database, 'SELECT id FROM ticktick_tasks WHERE parent_id = ? ORDER BY id ASC', [taskIds[index]])) {
      if (!taskIds.includes(child.id)) taskIds.push(child.id);
    }
  }
  let changed = false;
  for (const id of taskIds) changed = run(database, 'DELETE FROM ticktick_bridge WHERE ticktick_task_id = ?', [id]) || changed;
  for (const id of [...taskIds].reverse()) changed = run(database, 'DELETE FROM ticktick_tasks WHERE id = ?', [id]) || changed;
  return changed;
}

function list(database: Database, listId: string): TickTickList | null {
  return one<TickTickList>(database, `SELECT l.*, (SELECT COUNT(*) FROM ticktick_tasks t WHERE t.list_id = l.id) AS task_count FROM ticktick_lists l WHERE l.id = ?`, [listId]);
}

function createList(database: Database, input: Extract<TickTickCommand, { type: 'ticktick.lists.create' }>['payload']['input'], dependencies: TickTickCommandDependencies): TickTickList {
  const name = input.name.trim();
  if (!name) throw new Error('List name is required');
  const listId = id('list', dependencies); const timestamp = now(dependencies);
  const sortOrder = Number(one<{ value: number }>(database, 'SELECT MAX(sort_order) AS value FROM ticktick_lists')?.value ?? -1) + 1;
  run(database, 'INSERT INTO ticktick_lists (id, name, color, icon, sort_order, is_folder, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [listId, name, input.color || '#4a90d9', input.icon || 'list', sortOrder, input.is_folder ?? 0, input.parent_id ?? null, timestamp, timestamp]);
  return list(database, listId)!;
}

function updateList(database: Database, listId: string, input: TickTickListPatch, dependencies: TickTickCommandDependencies): { changed: boolean; value: TickTickList | null } {
  const current = list(database, listId); if (!current) return { changed: false, value: null };
  const next = { name: input.name === undefined ? current.name : input.name.trim(), color: input.color ?? current.color, icon: input.icon ?? current.icon, isFolder: input.is_folder ?? current.is_folder, parentId: input.parent_id === undefined ? current.parent_id : input.parent_id };
  if (!next.name) throw new Error('List name is required');
  if (current.name === next.name && current.color === next.color && current.icon === next.icon && current.is_folder === next.isFolder && current.parent_id === next.parentId) return { changed: false, value: current };
  run(database, 'UPDATE ticktick_lists SET name = ?, color = ?, icon = ?, is_folder = ?, parent_id = ?, updated_at = ? WHERE id = ?', [next.name, next.color, next.icon, next.isFolder, next.parentId, now(dependencies), listId]);
  return { changed: true, value: list(database, listId) };
}

function habit(database: Database, habitId: string): TickTickHabit | null { return one<TickTickHabit>(database, 'SELECT * FROM ticktick_habits WHERE id = ?', [habitId]); }
function createHabit(database: Database, input: Extract<TickTickCommand, { type: 'ticktick.habits.create' }>['payload']['input'], dependencies: TickTickCommandDependencies): TickTickHabit {
  const name = input.name.trim(); if (!name) throw new Error('Habit name is required');
  const habitId = id('habit', dependencies); const timestamp = now(dependencies); const sortOrder = Number(one<{ value: number }>(database, 'SELECT MAX(sort_order) AS value FROM ticktick_habits')?.value ?? -1) + 1;
  run(database, 'INSERT INTO ticktick_habits (id, name, icon, color, goal_description, frequency, target_count, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [habitId, name, input.icon || 'check', input.color || '#4a90d9', input.goal_description || '', input.frequency || 'daily', input.target_count || 1, sortOrder, timestamp, timestamp]);
  return habit(database, habitId)!;
}
function updateHabit(database: Database, habitId: string, input: TickTickHabitPatch, dependencies: TickTickCommandDependencies): { changed: boolean; value: TickTickHabit | null } {
  const current = habit(database, habitId); if (!current) return { changed: false, value: null };
  const next = { name: input.name === undefined ? current.name : input.name.trim(), icon: input.icon ?? current.icon, color: input.color ?? current.color, goal: input.goal_description ?? current.goal_description, frequency: input.frequency ?? current.frequency, target: input.target_count ?? current.target_count };
  if (!next.name) throw new Error('Habit name is required');
  if (current.name === next.name && current.icon === next.icon && current.color === next.color && current.goal_description === next.goal && current.frequency === next.frequency && current.target_count === next.target) return { changed: false, value: current };
  run(database, 'UPDATE ticktick_habits SET name = ?, icon = ?, color = ?, goal_description = ?, frequency = ?, target_count = ?, updated_at = ? WHERE id = ?', [next.name, next.icon, next.color, next.goal, next.frequency, next.target, now(dependencies), habitId]);
  return { changed: true, value: habit(database, habitId) };
}
function updateBridge(database: Database, input: Extract<TickTickCommand, { type: 'ticktick.bridges.update' }>['payload']['input'], dependencies: TickTickCommandDependencies): { changed: boolean; value: TickTickBridge } {
  if (!task(database, input.ticktick_task_id)) throw new Error('TickTick task does not exist');
  const existing = one<TickTickBridge>(database, 'SELECT * FROM ticktick_bridge WHERE ticktick_task_id = ? AND linked_type = ? AND linked_id = ?', [input.ticktick_task_id, input.linked_type, input.linked_id]);
  const syncReview = input.sync_review ?? existing?.sync_review ?? 1; const syncMastery = input.sync_mastery ?? existing?.sync_mastery ?? 0;
  if (existing && existing.sync_review === syncReview && existing.sync_mastery === syncMastery) return { changed: false, value: existing };
  if (existing) run(database, 'UPDATE ticktick_bridge SET sync_review = ?, sync_mastery = ? WHERE id = ?', [syncReview, syncMastery, existing.id]);
  else run(database, 'INSERT INTO ticktick_bridge (ticktick_task_id, linked_type, linked_id, sync_review, sync_mastery, created_at) VALUES (?, ?, ?, ?, ?, ?)', [input.ticktick_task_id, input.linked_type, input.linked_id, syncReview, syncMastery, now(dependencies)]);
  return { changed: true, value: one<TickTickBridge>(database, 'SELECT * FROM ticktick_bridge WHERE ticktick_task_id = ? AND linked_type = ? AND linked_id = ?', [input.ticktick_task_id, input.linked_type, input.linked_id])! };
}

export async function executeTickTickCommand<C extends TickTickCommand>(
  command: C,
  database: Database,
  scope: DatabaseMutationScope,
  context: TrustedExecutionContext,
  dependencies: TickTickCommandDependencies = {}
): Promise<TickTickCommandResult<TickTickCommandValues[C['type']]>> {
  assertDatabaseMutationScope(scope, database);
  switch (command.type) {
    case 'tasks.create': {
      const value = createTask(database, command.payload.input, dependencies);
      return { changed: true, value, eventType: 'tasks.task_created', eventPayload: { taskId: value.id } } as unknown as TickTickCommandResult<TickTickCommandValues[C['type']]>;
    }
    case 'tasks.update': {
      const result = updateTask(database, command.payload.taskId, command.payload.input, dependencies);
      return { ...result, eventType: 'tasks.task_updated', eventPayload: { taskId: command.payload.taskId } } as unknown as TickTickCommandResult<TickTickCommandValues[C['type']]>;
    }
    case 'tasks.complete':
    case 'tasks.uncomplete': {
      const completed = command.type === 'tasks.complete';
      const result = await completeWithBridge(database, scope, context, command.payload.taskId, completed, dependencies);
      return { ...result, eventType: completed ? 'tasks.task_completed' : 'tasks.task_uncompleted', eventPayload: { taskId: command.payload.taskId } } as unknown as TickTickCommandResult<TickTickCommandValues[C['type']]>;
    }
    case 'tasks.delete': {
      const changed = deleteTask(database, command.payload.taskId);
      return { changed, value: true, eventType: 'tasks.task_deleted', eventPayload: { taskId: command.payload.taskId } } as unknown as TickTickCommandResult<TickTickCommandValues[C['type']]>;
    }
    case 'focus.sessions.create': {
      const sessionId = id('focus', dependencies);
      const timestamp = now(dependencies);
      const input = command.payload.input;
      run(database, `INSERT INTO ticktick_focus_sessions (
        id, task_id, start_time, end_time, duration_minutes, session_type, completed, white_noise, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [sessionId, input.task_id ?? null, input.start_time, input.end_time ?? null,
        input.duration_minutes, input.session_type || 'focus', input.completed ?? 1, input.white_noise ?? null, timestamp]);
      const value = one<TickTickFocusSession>(database, `SELECT fs.*, t.title AS task_title FROM ticktick_focus_sessions fs
        LEFT JOIN ticktick_tasks t ON t.id = fs.task_id WHERE fs.id = ?`, [sessionId])!;
      return { changed: true, value, eventType: 'focus.session_created', eventPayload: { sessionId } } as unknown as TickTickCommandResult<TickTickCommandValues[C['type']]>;
    }
    case 'ticktick.lists.create': { const value = createList(database, command.payload.input, dependencies); return { changed: true, value, eventType: 'ticktick.list_created', eventPayload: { listId: value.id } } as unknown as TickTickCommandResult<TickTickCommandValues[C['type']]>; }
    case 'ticktick.lists.update': { const result = updateList(database, command.payload.listId, command.payload.input, dependencies); return { ...result, eventType: 'ticktick.list_updated', eventPayload: { listId: command.payload.listId } } as unknown as TickTickCommandResult<TickTickCommandValues[C['type']]>; }
    case 'ticktick.habits.create': { const value = createHabit(database, command.payload.input, dependencies); return { changed: true, value, eventType: 'ticktick.habit_created', eventPayload: { habitId: value.id } } as unknown as TickTickCommandResult<TickTickCommandValues[C['type']]>; }
    case 'ticktick.habits.update': { const result = updateHabit(database, command.payload.habitId, command.payload.input, dependencies); return { ...result, eventType: 'ticktick.habit_updated', eventPayload: { habitId: command.payload.habitId } } as unknown as TickTickCommandResult<TickTickCommandValues[C['type']]>; }
    case 'ticktick.bridges.update': { const result = updateBridge(database, command.payload.input, dependencies); return { ...result, eventType: 'ticktick.bridge_updated', eventPayload: { bridgeId: result.value.id } } as unknown as TickTickCommandResult<TickTickCommandValues[C['type']]>; }
  }
}

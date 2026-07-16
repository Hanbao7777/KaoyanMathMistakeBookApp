import type { SqlValue } from 'sql.js';
import type { ReadOnlyDatabaseFacade } from '../queryBus';
import type { TickTickFocusSession, TickTickTask, TickTickTaskFilters } from '../../../shared/types';
import type { TickTickQuery, TickTickQueryValues } from './contracts';

const TASK_SELECT = 'SELECT t.*, l.name AS list_name, l.color AS list_color FROM ticktick_tasks t LEFT JOIN ticktick_lists l ON t.list_id = l.id';

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function hydrateTask(database: ReadOnlyDatabaseFacade, task: TickTickTask): TickTickTask {
  const stats = database.select<{ total: number; completed: number }>(
    'SELECT COUNT(*) AS total, COALESCE(SUM(is_completed), 0) AS completed FROM ticktick_tasks WHERE parent_id = ?',
    [task.id]
  )[0];
  return {
    ...task,
    tags_list: parseTags(task.tags),
    subtask_count: Number(stats?.total ?? 0),
    subtask_completed: Number(stats?.completed ?? 0)
  };
}

export function getTask(database: ReadOnlyDatabaseFacade, taskId: string): TickTickTask | null {
  const task = database.select<Readonly<Record<string, unknown>>>(`${TASK_SELECT} WHERE t.id = ?`, [taskId])[0] as unknown as TickTickTask | undefined;
  return task ? hydrateTask(database, { ...task }) : null;
}

export function listTasks(database: ReadOnlyDatabaseFacade, filters: TickTickTaskFilters = {}): TickTickTask[] {
  const where = ['t.parent_id IS NULL'];
  const parameters: SqlValue[] = [];
  if (filters.listId) { where.push('t.list_id = ?'); parameters.push(filters.listId); }
  if (filters.dueDate) { where.push('t.due_date = ?'); parameters.push(filters.dueDate); }
  if (filters.dueDateBefore) { where.push('t.due_date <= ?'); parameters.push(filters.dueDateBefore); }
  if (!filters.includeCompleted) where.push('t.is_completed = 0');
  if (filters.search) { where.push('(t.title LIKE ? OR t.note LIKE ?)'); parameters.push(`%${filters.search}%`, `%${filters.search}%`); }
  if (filters.priority) { where.push('t.priority = ?'); parameters.push(filters.priority); }
  if (filters.tag) { where.push("t.tags LIKE '%\"' || ? || '\"%'"); parameters.push(filters.tag); }
  if (filters.includeNoDate) where.push('t.due_date IS NULL');
  return database.select<Readonly<Record<string, unknown>>>(
    `${TASK_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.due_time ASC, t.sort_order ASC, t.created_at ASC`,
    parameters
  ).map((task) => hydrateTask(database, { ...task } as unknown as TickTickTask));
}

export function listFocusSessions(
  database: ReadOnlyDatabaseFacade,
  filters: { readonly date?: string; readonly taskId?: string } = {}
): TickTickFocusSession[] {
  const where: string[] = [];
  const parameters: SqlValue[] = [];
  if (filters.date) { where.push('date(fs.start_time) = ?'); parameters.push(filters.date); }
  if (filters.taskId) { where.push('fs.task_id = ?'); parameters.push(filters.taskId); }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return database.select<Readonly<Record<string, unknown>>>(`SELECT fs.*, t.title AS task_title
    FROM ticktick_focus_sessions fs LEFT JOIN ticktick_tasks t ON t.id = fs.task_id
    ${whereClause} ORDER BY fs.start_time DESC`, parameters).map((session) => ({ ...session } as unknown as TickTickFocusSession));
}

export function executeTickTickQuery<Q extends TickTickQuery>(
  query: Q,
  database: ReadOnlyDatabaseFacade
): TickTickQueryValues[Q['type']] {
  switch (query.type) {
    case 'tasks.list': return listTasks(database, query.payload.filters) as TickTickQueryValues[Q['type']];
    case 'tasks.get': return getTask(database, query.payload.taskId) as TickTickQueryValues[Q['type']];
    case 'focus.sessions.list': return listFocusSessions(database, query.payload.filters) as TickTickQueryValues[Q['type']];
  }
}

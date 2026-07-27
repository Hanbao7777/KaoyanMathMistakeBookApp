import type { SqlValue } from 'sql.js';
import type { ReadOnlyDatabaseFacade } from '../queryBus';
import type { TickTickBridge, TickTickCalendarDay, TickTickFocusSession, TickTickHabit, TickTickList, TickTickTask, TickTickTaskFilters } from '../../../shared/types';
import type { TickTickQuery, TickTickQueryValues } from './contracts';

const TASK_SELECT = 'SELECT t.*, l.name AS list_name, l.color AS list_color FROM ticktick_tasks t LEFT JOIN ticktick_lists l ON t.list_id = l.id';

export interface TickTickQueryDependencies {
  readonly today?: () => string;
}

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

export function listLists(database: ReadOnlyDatabaseFacade): TickTickList[] {
  return database.select<Readonly<Record<string, unknown>>>('SELECT l.*, (SELECT COUNT(*) FROM ticktick_tasks t WHERE t.list_id = l.id) AS task_count FROM ticktick_lists l ORDER BY l.sort_order ASC, l.created_at ASC')
    .map((list) => ({ ...list } as unknown as TickTickList));
}

function dateOnly(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dateFromIso(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid TickTick query clock');
  return date;
}

export function listHabits(database: ReadOnlyDatabaseFacade, dependencies: TickTickQueryDependencies = {}): TickTickHabit[] {
  const habits = database.select<Readonly<Record<string, unknown>>>('SELECT * FROM ticktick_habits ORDER BY sort_order ASC')
    .map((habit) => ({ ...habit } as unknown as TickTickHabit));
  if (!habits.length) return [];
  const today = dependencies.today ? dateFromIso(dependencies.today()) : new Date();
  const todayKey = dateOnly(today);
  const since = new Date(today.getTime());
  since.setDate(since.getDate() - 364);
  const logs = database.select<Readonly<Record<string, unknown>>>(
    `SELECT habit_id, log_date FROM ticktick_habit_logs WHERE habit_id IN (${habits.map(() => '?').join(',')}) AND log_date >= ? ORDER BY log_date DESC`,
    [...habits.map(({ id }) => id), dateOnly(since)]
  );
  const logMap = new Map<string, Set<string>>();
  for (const log of logs) {
    const habitId = String(log.habit_id);
    let dates = logMap.get(habitId);
    if (!dates) { dates = new Set<string>(); logMap.set(habitId, dates); }
    dates.add(String(log.log_date));
  }
  return habits.map((habit) => {
    const dates = logMap.get(habit.id) ?? new Set<string>();
    let streak = 0;
    for (let offset = 0; offset < 365; offset += 1) {
      const day = new Date(today.getTime()); day.setDate(day.getDate() - offset);
      if (dates.has(dateOnly(day))) streak += 1;
      else if (offset !== 0) break;
    }
    return { ...habit, today_completed: dates.has(todayKey) ? 1 : 0, streak };
  });
}

export function getBridges(database: ReadOnlyDatabaseFacade, taskId: string): TickTickBridge[] {
  return database.select<Readonly<Record<string, unknown>>>('SELECT * FROM ticktick_bridge WHERE ticktick_task_id = ? ORDER BY linked_type, linked_id', [taskId])
    .map((bridge) => ({ ...bridge } as unknown as TickTickBridge));
}

export function listCalendarEvents(database: ReadOnlyDatabaseFacade, year: number, month: number): TickTickCalendarDay[] {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const end = `${year}-${String(month).padStart(2, '0')}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`;
  const tasks = database.select<Readonly<Record<string, unknown>>>(`${TASK_SELECT} WHERE t.parent_id IS NULL AND t.due_date >= ? AND t.due_date <= ? ORDER BY t.due_date, t.sort_order`, [start, end]).map((value) => hydrateTask(database, { ...value } as unknown as TickTickTask));
  const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const reviewRows = database.select<Readonly<Record<string, unknown>>>('SELECT next_review_at FROM questions WHERE next_review_at >= ? AND next_review_at < ?', [start, nextMonth]);
  const focusRows = database.select<Readonly<Record<string, unknown>>>("SELECT date(start_time) AS date, COUNT(*) AS count FROM ticktick_focus_sessions WHERE session_type = 'focus' AND completed = 1 AND date(start_time) >= ? AND date(start_time) < ? GROUP BY date(start_time)", [start, nextMonth]);
  const planRows = database.select<Readonly<Record<string, unknown>>>('SELECT plan_date FROM ticktick_ai_plans WHERE plan_date >= ? AND plan_date < ?', [start, nextMonth]);
  const taskByDate = new Map<string, TickTickTask[]>(); for (const item of tasks) if (item.due_date) taskByDate.set(item.due_date, [...(taskByDate.get(item.due_date) ?? []), item]);
  const reviews = new Map<string, number>();
  for (const row of reviewRows) {
    const reviewAt = typeof row.next_review_at === 'string' ? row.next_review_at : null;
    if (reviewAt) { const date = reviewAt.slice(0, 10); reviews.set(date, (reviews.get(date) ?? 0) + 1); }
  }
  const focus = new Map(focusRows.map((row) => [String(row.date), Number(row.count)])); const plans = new Set(planRows.map((row) => String(row.plan_date)));
  return Array.from({ length: new Date(year, month, 0).getDate() }, (_, index) => {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`; const entries = taskByDate.get(date) ?? [];
    return { date, task_count: entries.length, completed_count: entries.filter(({ is_completed }) => is_completed === 1).length, review_due_count: reviews.get(date) ?? 0, pomodoro_count: focus.get(date) ?? 0, has_ai_plan: plans.has(date), tasks: entries };
  });
}

export function executeTickTickQuery<Q extends TickTickQuery>(
  query: Q,
  database: ReadOnlyDatabaseFacade,
  dependencies: TickTickQueryDependencies = {}
): TickTickQueryValues[Q['type']] {
  switch (query.type) {
    case 'tasks.list': return listTasks(database, query.payload.filters) as TickTickQueryValues[Q['type']];
    case 'tasks.get': return getTask(database, query.payload.taskId) as TickTickQueryValues[Q['type']];
    case 'focus.sessions.list': return listFocusSessions(database, query.payload.filters) as TickTickQueryValues[Q['type']];
    case 'ticktick.lists.list': return listLists(database) as TickTickQueryValues[Q['type']];
    case 'ticktick.habits.list': return listHabits(database, dependencies) as TickTickQueryValues[Q['type']];
    case 'ticktick.calendar.list_events': return listCalendarEvents(database, query.payload.year, query.payload.month) as TickTickQueryValues[Q['type']];
    case 'ticktick.bridges.get': return getBridges(database, query.payload.taskId) as TickTickQueryValues[Q['type']];
  }
}

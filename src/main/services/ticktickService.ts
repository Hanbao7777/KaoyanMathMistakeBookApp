import { randomUUID } from 'node:crypto';
import type { Database, SqlValue } from 'sql.js';
import type { ReadOnlyDatabaseFacade } from '../application/queryBus';
import { createInternalExecutionContext } from '../application/executionContext';
import type { TickTickCommand, TickTickQuery } from '../application/ticktick';
import type { DatabaseMutationResult } from '../persistence';
import {
  allSql,
  getDatabaseCoordinator,
  getQuestionsApplication,
  getTickTickApplication,
  getReadOnlyDatabase,
  oneSql,
  runSql
} from './databaseService';
import type {
  TickTickBridge,
  TickTickBridgeInput,
  TickTickBridgeLinkedType,
  TickTickCalendarDay,
  TickTickFocusSession,
  TickTickFocusSessionInput,
  TickTickHabit,
  TickTickHabitInput,
  TickTickHabitLog,
  TickTickList,
  TickTickListInput,
  TickTickSettings,
  TickTickTag,
  TickTickTask,
  TickTickTaskFilters,
  TickTickTaskInput,
} from '../../shared/types';

// ── Helpers ──

function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function localDate(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

type TickTickReadDatabase = Database | ReadOnlyDatabaseFacade;

function readAll<T>(database: TickTickReadDatabase, sql: string, params: readonly SqlValue[] = []): T[] {
  if ('kind' in database) return [...database.select(sql, params)] as T[];
  return allSql<T>(database, sql, [...params]);
}

function readOne<T>(database: TickTickReadDatabase, sql: string, params: readonly SqlValue[] = []): T | null {
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
  const result = await coordinator.executeWrite({ requestId, concurrency: 'none', execute });
  if (result.changed) {
    await application.eventBus.publish(application.eventBus.finalizeEvents(preparedEvents, {
      versionBefore: result.versionBefore,
      versionAfter: result.versionAfter
    }));
  }
  return result.value;
}

async function executeTickTickCommand<C extends TickTickCommand>(command: C) {
  const application = await getTickTickApplication();
  return (await application.execute(command, createInternalExecutionContext({ concurrency: 'none' }))).value;
}

async function executeTickTickQuery<Q extends TickTickQuery>(query: Q) {
  const application = await getTickTickApplication();
  return application.query(query, createInternalExecutionContext({ concurrency: 'none' })).value;
}

// ── ID Generator ──

// ── Lists CRUD ──

export async function listTickTickLists(): Promise<TickTickList[]> {
  return executeTickTickQuery({ type: 'ticktick.lists.list', payload: {} });
}

export async function getTickTickList(listId: string): Promise<TickTickList | null> {
  return getTickTickListFrom(await getReadOnlyDatabase(), listId);
}

function getTickTickListFrom(database: TickTickReadDatabase, listId: string): TickTickList | null {
  return readOne<TickTickList & { task_count: number }>(
    database,
    `SELECT l.*, (SELECT COUNT(*) FROM ticktick_tasks t WHERE t.list_id = l.id) AS task_count
     FROM ticktick_lists l WHERE l.id = ?`,
    [listId]
  );
}

export async function createTickTickList(input: TickTickListInput): Promise<TickTickList> {
  return executeTickTickCommand({ type: 'ticktick.lists.create', payload: { input } });
}

export async function updateTickTickList(listId: string, input: TickTickListInput): Promise<TickTickList | null> {
  return executeTickTickCommand({ type: 'ticktick.lists.update', payload: { listId, input } });
}

export async function deleteTickTickList(listId: string): Promise<boolean> {
  return executeLegacyMutation('ticktick-list-delete', (database) => {
    let changed = runMutation(database, 'DELETE FROM ticktick_bridge WHERE ticktick_task_id IN (SELECT id FROM ticktick_tasks WHERE list_id = ?)', [listId]);
    changed = runMutation(database, 'DELETE FROM ticktick_lists WHERE id = ?', [listId]) || changed;
    return { changed, value: true };
  });
}

export async function reorderTickTickLists(ids: string[]): Promise<void> {
  return executeLegacyMutation('ticktick-list-reorder', (database) => {
    let changed = false;
    const timestamp = nowIso();
    for (let index = 0; index < ids.length; index += 1) {
      changed = runMutation(
        database,
        'UPDATE ticktick_lists SET sort_order = ?, updated_at = ? WHERE id = ? AND sort_order != ?',
        [index, timestamp, ids[index], index]
      ) || changed;
    }
    return { changed, value: undefined };
  });
}

// ── Tasks CRUD ──

const TASK_SELECT = `SELECT t.*, l.name as list_name, l.color as list_color FROM ticktick_tasks t LEFT JOIN ticktick_lists l ON t.list_id = l.id`;

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.error('parseTags: invalid JSON', raw);
    return [];
  }
}

function hydrateTask(database: TickTickReadDatabase, task: TickTickTask): TickTickTask {
  const hydrated = { ...task, tags_list: parseTags(task.tags) };

  // Sub-task counts
  const subStats = readOne<{ total: number; completed: number }>(
    database,
    'SELECT COUNT(*) AS total, COALESCE(SUM(is_completed), 0) AS completed FROM ticktick_tasks WHERE parent_id = ?',
    [hydrated.id]
  );
  hydrated.subtask_count = subStats?.total ?? 0;
  hydrated.subtask_completed = subStats?.completed ?? 0;
  return hydrated;
}

export async function listTickTickTasks(filters: TickTickTaskFilters = {}): Promise<TickTickTask[]> {
  return executeTickTickQuery({ type: 'tasks.list', payload: { filters } });
}

function listTickTickTasksFrom(database: TickTickReadDatabase, filters: TickTickTaskFilters = {}): TickTickTask[] {
  const where: string[] = ['t.parent_id IS NULL'];
  const params: unknown[] = [];

  if (filters.listId) {
    where.push('t.list_id = ?');
    params.push(filters.listId);
  }

  if (filters.dueDate) {
    where.push('t.due_date = ?');
    params.push(filters.dueDate);
  }

  if (filters.dueDateBefore) {
    where.push('t.due_date <= ?');
    params.push(filters.dueDateBefore);
  }

  if (!filters.includeCompleted) {
    where.push('t.is_completed = 0');
  }

  if (filters.search) {
    where.push('(t.title LIKE ? OR t.note LIKE ?)');
    const term = `%${filters.search}%`;
    params.push(term, term);
  }

  if (filters.priority) {
    where.push('t.priority = ?');
    params.push(filters.priority);
  }

  if (filters.tag) {
    // tags is stored as JSON array string; match approximately
    where.push("t.tags LIKE '%\"' || ? || '\"%'");
    params.push(filters.tag);
  }

  if (filters.includeNoDate) {
    where.push('t.due_date IS NULL');
  }

  const sql = `${TASK_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.due_time ASC, t.sort_order ASC, t.created_at ASC`;

  const rows = readAll<TickTickTask>(database, sql, params as SqlValue[]);

  // Batch-hydrate subtask counts to avoid N+1 queries
  const taskIds = rows.map((t) => t.id);
  const subStatsMap = new Map<string, { total: number; completed: number }>();
  if (taskIds.length > 0) {
    const placeholders = taskIds.map(() => '?').join(',');
    const subRows = readAll<{ parent_id: string; total: number; completed: number }>(
      database,
      `SELECT parent_id, COUNT(*) AS total, COALESCE(SUM(is_completed), 0) AS completed
       FROM ticktick_tasks WHERE parent_id IN (${placeholders}) GROUP BY parent_id`,
      taskIds
    );
    for (const r of subRows) {
      subStatsMap.set(r.parent_id, { total: r.total, completed: r.completed });
    }
  }

  const result: TickTickTask[] = [];
  for (const task of rows) {
    const hydrated = { ...task, tags_list: parseTags(task.tags) };
    const stats = subStatsMap.get(task.id);
    hydrated.subtask_count = stats?.total ?? 0;
    hydrated.subtask_completed = stats?.completed ?? 0;
    result.push(hydrated);
  }
  return result;
}

export async function getTickTickTask(taskId: string): Promise<TickTickTask | null> {
  return executeTickTickQuery({ type: 'tasks.get', payload: { taskId } });
}

function getTickTickTaskFrom(database: TickTickReadDatabase, taskId: string): TickTickTask | null {
  const task = readOne<TickTickTask>(database, `${TASK_SELECT} WHERE t.id = ?`, [taskId]);
  return task ? hydrateTask(database, task) : null;
}

export async function createTickTickTask(input: TickTickTaskInput): Promise<TickTickTask> {
  return executeTickTickCommand({ type: 'tasks.create', payload: { input } });
}

export async function updateTickTickTask(taskId: string, partial: Partial<TickTickTaskInput & { is_completed?: number; actual_minutes?: number; pomodoro_sessions?: number; sort_order?: number }>): Promise<TickTickTask | null> {
  return executeTickTickCommand({ type: 'tasks.update', payload: { taskId, input: partial } });
}

export async function deleteTickTickTask(taskId: string): Promise<boolean> {
  return executeTickTickCommand({ type: 'tasks.delete', payload: { taskId } });
}

export async function completeTickTickTask(taskId: string): Promise<TickTickTask | null> {
  return updateTickTickTask(taskId, { is_completed: 1 });
}

export async function uncompleteTickTickTask(taskId: string): Promise<TickTickTask | null> {
  return updateTickTickTask(taskId, { is_completed: 0 });
}

export async function getTodayTickTickTasks(): Promise<{
  overdue: TickTickTask[];
  today: TickTickTask[];
  upcoming: TickTickTask[];
}> {
  const today = localDate();
  const database = await getReadOnlyDatabase();

  // Overdue: due_date before today, not completed, no parent
  const overdue = readAll<TickTickTask>(database,
    `${TASK_SELECT} WHERE t.parent_id IS NULL AND t.is_completed = 0 AND t.due_date IS NOT NULL AND t.due_date < ? ORDER BY t.due_date ASC, t.sort_order ASC`,
    [today]
  ).map((task) => hydrateTask(database, task));

  // Today: due_date = today or no due_date
  const todayTasks = readAll<TickTickTask>(database,
    `${TASK_SELECT} WHERE t.parent_id IS NULL AND t.is_completed = 0 AND (t.due_date = ? OR t.due_date IS NULL) ORDER BY t.due_time ASC, t.sort_order ASC`,
    [today]
  ).map((task) => hydrateTask(database, task));

  // Upcoming: due_date after today
  const upcoming = readAll<TickTickTask>(database,
    `${TASK_SELECT} WHERE t.parent_id IS NULL AND t.is_completed = 0 AND t.due_date > ? ORDER BY t.due_date ASC, t.sort_order ASC`,
    [today]
  ).map((task) => hydrateTask(database, task));

  return { overdue, today: todayTasks, upcoming };
}

// ── Tags ──

export async function listTickTickTags(): Promise<TickTickTag[]> {
  const database = await getReadOnlyDatabase();
  return readAll<TickTickTag & { task_count: number }>(
    database,
    `SELECT tg.*,
       (SELECT COUNT(*) FROM ticktick_tasks t
        WHERE t.tags LIKE '%"' || tg.name || '"%'
          AND t.parent_id IS NULL
          AND t.is_completed = 0) AS task_count
     FROM ticktick_tags tg
     ORDER BY task_count DESC, tg.name ASC`
  );
}

export async function initializeTickTickService(): Promise<void> {
  return executeLegacyMutation('ticktick-initialize', (database) => {
    const tableExists = readOne<{ count: number }>(
      database,
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'"
    )?.count === 1;
    if (!tableExists) database.run('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    let changed = !tableExists;
    changed = runMutation(
      database,
      'INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)',
      ['ticktick_settings', JSON.stringify(DEFAULT_TICKTICK_SETTINGS)]
    ) || changed;
    changed = runMutation(
      database,
      `DELETE FROM ticktick_tags
       WHERE NOT EXISTS (
         SELECT 1 FROM ticktick_tasks t
         WHERE t.tags LIKE '%"' || ticktick_tags.name || '"%'
           AND t.is_completed = 0 AND t.parent_id IS NULL
       )`
    ) || changed;
    return { changed, value: undefined };
  });
}

// ── Focus Sessions ──

export async function listTickTickFocusSessions(filters?: {
  date?: string;
  taskId?: string;
}): Promise<TickTickFocusSession[]> {
  return executeTickTickQuery({ type: 'focus.sessions.list', payload: { filters: filters ?? {} } });
}

export async function createTickTickFocusSession(input: TickTickFocusSessionInput): Promise<TickTickFocusSession> {
  return executeTickTickCommand({ type: 'focus.sessions.create', payload: { input } });
}

// ── Bridge ──

export async function getTickTickTaskBridges(taskId: string): Promise<TickTickBridge[]> {
  return executeTickTickQuery({ type: 'ticktick.bridges.get', payload: { taskId } });
}

export async function createTickTickBridge(input: TickTickBridgeInput): Promise<TickTickBridge> {
  return executeTickTickCommand({ type: 'ticktick.bridges.update', payload: { input } });
}

export async function deleteTickTickBridge(bridgeId: number): Promise<boolean> {
  return executeLegacyMutation('ticktick-bridge-delete', (database) => ({
    changed: runMutation(database, 'DELETE FROM ticktick_bridge WHERE id = ?', [bridgeId]),
    value: true
  }));
}

export async function getBridgesForLinked(
  linkedType: TickTickBridgeLinkedType,
  linkedId: string
): Promise<TickTickBridge[]> {
  return readAll<TickTickBridge>(
    await getReadOnlyDatabase(),
    'SELECT * FROM ticktick_bridge WHERE linked_type = ? AND linked_id = ?',
    [linkedType, linkedId]
  );
}

// ── Calendar ──

export async function getTickTickCalendarMonth(year: number, month: number): Promise<TickTickCalendarDay[]> {
  return executeTickTickQuery({ type: 'ticktick.calendar.list_events', payload: { year, month } });
}

// ── Settings ──

const DEFAULT_TICKTICK_SETTINGS: TickTickSettings = {
  pomodoro: {
    focusMinutes: 25,
    shortBreakMinutes: 5,
    longBreakMinutes: 15,
    sessionsBeforeLongBreak: 4,
  },
  autoCreateReviewTasks: true,
  whiteNoise: 'none',
  defaultListId: null,
};

export async function getTickTickSettings(): Promise<TickTickSettings> {
  const database = await getReadOnlyDatabase();
  const tableExists = readOne<{ count: number }>(
    database,
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'"
  )?.count === 1;
  if (!tableExists) return { ...DEFAULT_TICKTICK_SETTINGS };
  const row = readOne<{ value: string }>(
    database,
    "SELECT value FROM app_settings WHERE key = 'ticktick_settings'"
  );
  if (!row) {
    return { ...DEFAULT_TICKTICK_SETTINGS };
  }

  try {
    const parsed = JSON.parse(row.value);
    return {
      pomodoro: { ...DEFAULT_TICKTICK_SETTINGS.pomodoro, ...(parsed.pomodoro || {}) },
      autoCreateReviewTasks: parsed.autoCreateReviewTasks ?? DEFAULT_TICKTICK_SETTINGS.autoCreateReviewTasks,
      whiteNoise: parsed.whiteNoise ?? DEFAULT_TICKTICK_SETTINGS.whiteNoise,
      defaultListId: parsed.defaultListId ?? DEFAULT_TICKTICK_SETTINGS.defaultListId,
    };
  } catch {
    return { ...DEFAULT_TICKTICK_SETTINGS };
  }
}

export async function saveTickTickSettings(settings: TickTickSettings): Promise<TickTickSettings> {
  if (settings.pomodoro && settings.pomodoro.focusMinutes < 1) {
    throw new Error('focusMinutes must be >= 1');
  }

  const merged: TickTickSettings = {
    pomodoro: { ...DEFAULT_TICKTICK_SETTINGS.pomodoro, ...(settings.pomodoro || {}) },
    autoCreateReviewTasks: settings.autoCreateReviewTasks ?? DEFAULT_TICKTICK_SETTINGS.autoCreateReviewTasks,
    whiteNoise: settings.whiteNoise ?? DEFAULT_TICKTICK_SETTINGS.whiteNoise,
    defaultListId: settings.defaultListId ?? DEFAULT_TICKTICK_SETTINGS.defaultListId,
  };

  return executeLegacyMutation('ticktick-settings-save', (database) => ({
    changed: runMutation(
      database,
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE value != excluded.value`,
      ['ticktick_settings', JSON.stringify(merged)]
    ),
    value: merged
  }));
}

// ── Habits ──

const togglingHabits = new Set<string>();

export async function listTickTickHabits(): Promise<TickTickHabit[]> {
  return executeTickTickQuery({ type: 'ticktick.habits.list', payload: {} });
}

export async function createTickTickHabit(input: TickTickHabitInput): Promise<TickTickHabit> {
  return executeTickTickCommand({ type: 'ticktick.habits.create', payload: { input } });
}

export async function updateTickTickHabit(id: string, input: TickTickHabitInput): Promise<TickTickHabit | null> {
  return executeTickTickCommand({ type: 'ticktick.habits.update', payload: { habitId: id, input } });
}

export async function deleteTickTickHabit(id: string): Promise<boolean> {
  return executeLegacyMutation('ticktick-habit-delete', (database) => ({
    changed: runMutation(database, 'DELETE FROM ticktick_habits WHERE id = ?', [id]),
    value: true
  }));
}

export async function toggleTickTickHabit(habitId: string, date: string): Promise<TickTickHabitLog | null> {
  if (togglingHabits.has(habitId)) return null; // Skip concurrent toggle
  togglingHabits.add(habitId);
  try {
    return await executeLegacyMutation('ticktick-habit-toggle', (database) => {
      const existing = readOne<{ id: string; completed: number }>(database,
        'SELECT id, completed FROM ticktick_habit_logs WHERE habit_id = ? AND log_date = ?', [habitId, date]);
      if (existing?.completed) {
        return { changed: runMutation(database, 'DELETE FROM ticktick_habit_logs WHERE id = ?', [existing.id]), value: null };
      }
      if (existing) {
        return { changed: false, value: { id: existing.id, habit_id: habitId, log_date: date, completed: 0, note: '', created_at: '' } };
      }
      const logId = id('hlog');
      const changed = runMutation(database,
        'INSERT OR IGNORE INTO ticktick_habit_logs (id, habit_id, log_date, completed, note, created_at) VALUES (?, ?, ?, 1, ?, ?)',
        [logId, habitId, date, '', nowIso()]
      );
      return { changed, value: readOne<TickTickHabitLog>(database, 'SELECT * FROM ticktick_habit_logs WHERE id = ?', [logId]) };
    });
  } finally {
    togglingHabits.delete(habitId);
  }
}

export async function getTickTickHabitLogs(habitId: string, fromDate?: string, toDate?: string): Promise<TickTickHabitLog[]> {
  const database = await getReadOnlyDatabase();
  if (fromDate && toDate) {
    return readAll<TickTickHabitLog>(database,
      'SELECT * FROM ticktick_habit_logs WHERE habit_id = ? AND log_date >= ? AND log_date <= ? ORDER BY log_date DESC',
      [habitId, fromDate, toDate]
    );
  }
  return readAll<TickTickHabitLog>(database,
    'SELECT * FROM ticktick_habit_logs WHERE habit_id = ? ORDER BY log_date DESC LIMIT 60',
    [habitId]
  );
}

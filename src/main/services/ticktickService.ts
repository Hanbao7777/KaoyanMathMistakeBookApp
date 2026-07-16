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
  const database = await getReadOnlyDatabase();
  return readAll<TickTickList & { task_count: number }>(
    database,
    `SELECT l.*, (SELECT COUNT(*) FROM ticktick_tasks t WHERE t.list_id = l.id) AS task_count
     FROM ticktick_lists l
     ORDER BY l.sort_order ASC, l.created_at ASC`
  );
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
  const name = input.name.trim();
  if (!name) throw new Error('清单名称不能为空');

  return executeLegacyMutation('ticktick-list-create', (database) => {
    const listId = id('list');
    const timestamp = nowIso();
    const maxOrder = readOne<{ m: number }>(database, 'SELECT MAX(sort_order) AS m FROM ticktick_lists');
    const sortOrder = (maxOrder?.m ?? -1) + 1;
    const changed = runMutation(
      database,
      `INSERT INTO ticktick_lists (id, name, color, icon, sort_order, is_folder, parent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [listId, name, input.color || '#4a90d9', input.icon || 'list', sortOrder, input.is_folder ?? 0,
        input.parent_id ?? null, timestamp, timestamp]
    );
    return { changed, value: getTickTickListFrom(database, listId)! };
  });
}

export async function updateTickTickList(listId: string, input: TickTickListInput): Promise<TickTickList | null> {
  return executeLegacyMutation('ticktick-list-update', (database) => {
    const current = getTickTickListFrom(database, listId);
    if (!current) return { changed: false, value: null };
    const changed = runMutation(
      database,
    `UPDATE ticktick_lists SET
       name = COALESCE(?, name),
       color = COALESCE(?, color),
       icon = COALESCE(?, icon),
       is_folder = COALESCE(?, is_folder),
       parent_id = COALESCE(?, parent_id),
       updated_at = ?
     WHERE id = ?`,
    [
      input.name?.trim() ?? null,
      input.color ?? null,
      input.icon ?? null,
      input.is_folder ?? null,
      input.parent_id !== undefined ? input.parent_id : null,
      nowIso(),
      listId
    ]
    );
    return { changed, value: getTickTickListFrom(database, listId) };
  });
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
  return readAll<TickTickBridge>(
    await getReadOnlyDatabase(),
    'SELECT * FROM ticktick_bridge WHERE ticktick_task_id = ? ORDER BY linked_type, linked_id',
    [taskId]
  );
}

export async function createTickTickBridge(input: TickTickBridgeInput): Promise<TickTickBridge> {
  return executeLegacyMutation('ticktick-bridge-create', (database) => {
    const timestamp = nowIso();
    const changed = runMutation(
      database,
    `INSERT OR IGNORE INTO ticktick_bridge (ticktick_task_id, linked_type, linked_id, sync_review, sync_mastery, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.ticktick_task_id,
      input.linked_type,
      input.linked_id,
      input.sync_review ?? 1,
      input.sync_mastery ?? 0,
      timestamp
    ]
    );
    const value = readOne<TickTickBridge>(
      database,
      'SELECT * FROM ticktick_bridge WHERE ticktick_task_id = ? AND linked_type = ? AND linked_id = ?',
      [input.ticktick_task_id, input.linked_type, input.linked_id]
    )!;
    return { changed, value };
  });
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
  if (month < 1 || month > 12) throw new Error('月份必须在 1-12 之间');

  const database = await getReadOnlyDatabase();

  // Month range
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate(); // month is 0-indexed
  const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  // 1) Tasks in this month (parent tasks only)
  const tasks = readAll<TickTickTask>(database,
    `${TASK_SELECT} WHERE t.parent_id IS NULL AND t.due_date >= ? AND t.due_date <= ? ORDER BY t.due_date, t.sort_order`,
    [startDate, endDate]
  ).map((task) => hydrateTask(database, task));

  // 2) Review due dates from questions table
  const reviews = readAll<{ next_review_at: string | null }>(database,
    `SELECT next_review_at FROM questions WHERE next_review_at >= ? AND next_review_at <= ?`,
    [startDate, endDate]
  );
  const reviewMap = new Map<string, number>();
  for (const review of reviews) {
      if (review.next_review_at) {
        const d = review.next_review_at.slice(0, 10);
        reviewMap.set(d, (reviewMap.get(d) || 0) + 1);
      }
  }

  // 3) Focus sessions (pomodoro count is per day)
  const sessions = readAll<{ d: string; cnt: number }>(database,
    `SELECT date(start_time) AS d, COUNT(*) AS cnt
     FROM ticktick_focus_sessions
     WHERE session_type = 'focus' AND completed = 1 AND date(start_time) >= ? AND date(start_time) <= ?
     GROUP BY d`,
    [startDate, endDate]
  );
  const pomodoroMap = new Map<string, number>();
  for (const session of sessions) pomodoroMap.set(String(session.d), Number(session.cnt));

  // 4) AI plans
  const plans = readAll<{ plan_date: string }>(database,
    `SELECT plan_date FROM ticktick_ai_plans WHERE plan_date >= ? AND plan_date <= ?`,
    [startDate, endDate]
  );
  const planSet = new Set<string>();
  for (const plan of plans) planSet.add(String(plan.plan_date));

  // Build day-by-day map
  const dayMap = new Map<string, TickTickCalendarDay>();

  // Group tasks by date
  const tasksByDate = new Map<string, TickTickTask[]>();
  for (const t of tasks) {
    if (t.due_date) {
      const list = tasksByDate.get(t.due_date) || [];
      list.push(t);
      tasksByDate.set(t.due_date, list);
    }
  }

  // Create a calendar day entry for each day of the month
  for (let day = 1; day <= lastDay; day++) {
    const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dayTasks = tasksByDate.get(dateKey) || [];
    const completedCount = dayTasks.filter((t) => t.is_completed === 1).length;

    dayMap.set(dateKey, {
      date: dateKey,
      task_count: dayTasks.length,
      completed_count: completedCount,
      review_due_count: reviewMap.get(dateKey) || 0,
      pomodoro_count: pomodoroMap.get(dateKey) || 0,
      has_ai_plan: planSet.has(dateKey),
      tasks: dayTasks,
    });
  }

  // Return sorted by date
  return Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));
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
  const database = await getReadOnlyDatabase();
  const today = localDate();
  const habits = readAll<TickTickHabit>(database, 'SELECT * FROM ticktick_habits ORDER BY sort_order ASC')
    .map((habit) => ({ ...habit }));
  if (habits.length === 0) return [];

  // Batch load all logs for the last 365 days
  const since = localDate(new Date(Date.now() - 365 * 86400000));
  const allLogs = readAll<{ habit_id: string; log_date: string }>(database,
    'SELECT habit_id, log_date FROM ticktick_habit_logs WHERE habit_id IN (' + habits.map(() => '?').join(',') + ') AND log_date >= ? ORDER BY log_date DESC',
    [...habits.map(h => h.id), since]
  );

  // Group logs by habit_id
  const logMap = new Map<string, Set<string>>();
  for (const log of allLogs) {
    if (!logMap.has(log.habit_id)) logMap.set(log.habit_id, new Set());
    logMap.get(log.habit_id)!.add(log.log_date);
  }

  for (const h of habits) {
    const logs = logMap.get(h.id) || new Set();
    h.today_completed = logs.has(today) ? 1 : 0;

    // Streak calculation
    let streak = 0;
    for (let i = 0; i < 365; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const ds = localDate(d);
      if (logs.has(ds)) {
        streak++;
      } else if (i === 0) {
        continue; // Today not yet completed
      } else {
        break;
      }
    }
    h.streak = streak;
  }
  return habits;
}

export async function createTickTickHabit(input: TickTickHabitInput): Promise<TickTickHabit> {
  return executeLegacyMutation('ticktick-habit-create', (database) => {
    const habitId = id('habit');
    const timestamp = nowIso();
    const maxOrder = readOne<{ m: number }>(database, 'SELECT MAX(sort_order) AS m FROM ticktick_habits');
    const sortOrder = (maxOrder?.m ?? -1) + 1;
    const changed = runMutation(database,
      'INSERT INTO ticktick_habits (id, name, icon, color, goal_description, frequency, target_count, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [habitId, input.name.trim(), input.icon || 'check', input.color || '#4a90d9', input.goal_description || '', input.frequency || 'daily', input.target_count || 1, sortOrder, timestamp, timestamp]
    );
    return { changed, value: readOne<TickTickHabit>(database, 'SELECT * FROM ticktick_habits WHERE id = ?', [habitId])! };
  });
}

export async function updateTickTickHabit(id: string, input: TickTickHabitInput): Promise<TickTickHabit | null> {
  return executeLegacyMutation('ticktick-habit-update', (database) => {
    const changed = runMutation(database,
      `UPDATE ticktick_habits SET name = COALESCE(?, name), icon = COALESCE(?, icon), color = COALESCE(?, color), goal_description = COALESCE(?, goal_description), frequency = COALESCE(?, frequency), target_count = COALESCE(?, target_count), updated_at = ? WHERE id = ?`,
      [input.name?.trim() || null, input.icon || null, input.color || null, input.goal_description || null, input.frequency || null, input.target_count || null, nowIso(), id]
    );
    return { changed, value: readOne<TickTickHabit>(database, 'SELECT * FROM ticktick_habits WHERE id = ?', [id]) };
  });
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

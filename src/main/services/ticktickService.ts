import {
  allSql,
  getDatabase,
  oneSql,
  persistDatabase,
  runSql
} from './databaseService';
import type {
  TickTickBridge,
  TickTickBridgeInput,
  TickTickBridgeLinkedType,
  TickTickCalendarDay,
  TickTickFocusSession,
  TickTickFocusSessionInput,
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

function ensureAppSettings(db: import('sql.js').Database) {
  db.run('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
}

// ── ID Generator ──

// ── Lists CRUD ──

export async function listTickTickLists(): Promise<TickTickList[]> {
  const db = await getDatabase();
  const rows = allSql<TickTickList & { task_count: number }>(
    db,
    `SELECT l.*, (SELECT COUNT(*) FROM ticktick_tasks t WHERE t.list_id = l.id) AS task_count
     FROM ticktick_lists l
     ORDER BY l.sort_order ASC, l.created_at ASC`
  );
  return rows;
}

export async function getTickTickList(listId: string): Promise<TickTickList | null> {
  const db = await getDatabase();
  const row = oneSql<TickTickList & { task_count: number }>(
    db,
    `SELECT l.*, (SELECT COUNT(*) FROM ticktick_tasks t WHERE t.list_id = l.id) AS task_count
     FROM ticktick_lists l WHERE l.id = ?`,
    [listId]
  );
  return row ?? null;
}

export async function createTickTickList(input: TickTickListInput): Promise<TickTickList> {
  const db = await getDatabase();
  const listId = id('list');
  const timestamp = nowIso();

  // Compute next sort_order
  const maxOrder = oneSql<{ m: number }>(
    db,
    'SELECT MAX(sort_order) AS m FROM ticktick_lists'
  );
  const sortOrder = (maxOrder?.m ?? -1) + 1;

  runSql(
    db,
    `INSERT INTO ticktick_lists (id, name, color, icon, sort_order, is_folder, parent_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      listId,
      input.name.trim(),
      input.color || '#4a90d9',
      input.icon || 'list',
      sortOrder,
      input.is_folder ?? 0,
      input.parent_id ?? null,
      timestamp,
      timestamp
    ]
  );
  persistDatabase();
  return (await getTickTickList(listId))!;
}

export async function updateTickTickList(listId: string, input: TickTickListInput): Promise<TickTickList | null> {
  const db = await getDatabase();
  const current = await getTickTickList(listId);
  if (!current) return null;

  runSql(
    db,
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
  persistDatabase();
  return getTickTickList(listId);
}

export async function deleteTickTickList(listId: string): Promise<boolean> {
  const db = await getDatabase();
  runSql(db, 'BEGIN');
  try {
    // FK CASCADE handles task deletion, but manual bridge cleanup as safety net for existing DBs
    runSql(db, 'DELETE FROM ticktick_bridge WHERE ticktick_task_id IN (SELECT id FROM ticktick_tasks WHERE list_id = ?)', [listId]);
    runSql(db, 'DELETE FROM ticktick_lists WHERE id = ?', [listId]);
    runSql(db, 'COMMIT');
    persistDatabase();
    return true;
  } catch (e) {
    runSql(db, 'ROLLBACK');
    throw e;
  }
}

export async function reorderTickTickLists(ids: string[]): Promise<boolean> {
  const db = await getDatabase();
  const stmt = db.prepare('UPDATE ticktick_lists SET sort_order = ?, updated_at = ? WHERE id = ?');
  const ts = nowIso();
  try {
    for (let i = 0; i < ids.length; i++) {
      stmt.bind([i, ts, ids[i]]);
      stmt.step();
      stmt.reset();
    }
  } finally {
    stmt.free();
  }
  persistDatabase();
  return true;
}

// ── Tasks CRUD ──

function mapTask(row: any[]): TickTickTask {
  return {
    id: row[0],
    list_id: row[1],
    title: row[2],
    note: row[3],
    due_date: row[4],
    due_time: row[5],
    priority: row[6] as TickTickTask['priority'],
    is_completed: row[7],
    completed_at: row[8],
    parent_id: row[9],
    sort_order: row[10],
    tags: row[11],
    recurrence_rule: row[12],
    estimated_minutes: row[13],
    actual_minutes: row[14],
    pomodoro_sessions: row[15],
    source: row[16] as TickTickTask['source'],
    created_at: row[17],
    updated_at: row[18],
    list_name: row[19] || undefined,
    list_color: row[20] || undefined,
  };
}

const TASK_SELECT = `SELECT t.*, l.name as list_name, l.color as list_color FROM ticktick_tasks t LEFT JOIN ticktick_lists l ON t.list_id = l.id`;

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function hydrateTask(db: import('sql.js').Database, task: TickTickTask): Promise<TickTickTask> {
  task.tags_list = parseTags(task.tags);

  // Sub-task counts
  const subStats = oneSql<{ total: number; completed: number }>(
    db,
    'SELECT COUNT(*) AS total, COALESCE(SUM(is_completed), 0) AS completed FROM ticktick_tasks WHERE parent_id = ?',
    [task.id]
  );
  task.subtask_count = subStats?.total ?? 0;
  task.subtask_completed = subStats?.completed ?? 0;

  return task;
}

export async function listTickTickTasks(filters: TickTickTaskFilters = {}): Promise<TickTickTask[]> {
  const db = await getDatabase();
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
    where.push("t.tags LIKE ?");
    params.push(`%"${filters.tag}"%`);
  }

  if (filters.includeNoDate) {
    where.push('t.due_date IS NULL');
  }

  const sql = `${TASK_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.due_time ASC, t.sort_order ASC, t.created_at ASC`;

  const rawRows = db.exec(sql, params as import('sql.js').SqlValue[]);
  const rows: TickTickTask[] = [];
  if (rawRows.length > 0) {
    const vals = rawRows[0].values;
    for (const row of vals) {
      rows.push(mapTask(row));
    }
  }

  // Hydrate each task
  const result: TickTickTask[] = [];
  for (const task of rows) {
    result.push(await hydrateTask(db, task));
  }
  return result;
}

export async function getTickTickTask(taskId: string): Promise<TickTickTask | null> {
  const db = await getDatabase();
  const rawRows = db.exec(`${TASK_SELECT} WHERE t.id = ?`, [taskId]);
  if (rawRows.length === 0 || rawRows[0].values.length === 0) return null;
  const task = mapTask(rawRows[0].values[0]);
  return hydrateTask(db, task);
}

export async function createTickTickTask(input: TickTickTaskInput): Promise<TickTickTask> {
  const db = await getDatabase();

  // Validate list_id: if empty or nonexistent, auto-create a default list
  let listId = input.list_id;
  if (!listId) {
    const firstList = oneSql<{ id: string }>(db, 'SELECT id FROM ticktick_lists ORDER BY sort_order ASC LIMIT 1');
    if (!firstList) {
      // Auto-create a default "收集箱" list
      const now = nowIso();
      listId = 'list_default';
      runSql(db,
        "INSERT OR IGNORE INTO ticktick_lists (id, name, color, icon, sort_order, created_at, updated_at) VALUES (?, '收集箱', '#4a90d9', 'inbox', 0, ?, ?)",
        [listId, now, now]
      );
    } else {
      listId = firstList.id;
    }
  } else {
    // Verify the list exists
    const listExists = oneSql<{ cnt: number }>(db, 'SELECT 1 AS cnt FROM ticktick_lists WHERE id = ?', [listId]);
    if (!listExists) throw new Error(`清单 ${listId} 不存在`);
  }

  const taskId = id('task');
  const timestamp = nowIso();

  // Next sort_order in the same list
  const maxOrder = oneSql<{ m: number }>(
    db,
    'SELECT MAX(sort_order) AS m FROM ticktick_tasks WHERE list_id = ?',
    [listId]
  );
  const sortOrder = (maxOrder?.m ?? -1) + 1;

  runSql(
    db,
    `INSERT INTO ticktick_tasks (
       id, list_id, title, note, due_date, due_time, priority,
       is_completed, completed_at, parent_id, sort_order, tags,
       recurrence_rule, estimated_minutes, actual_minutes,
       pomodoro_sessions, source, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
    [
      taskId,
      listId,
      input.title.trim(),
      input.note || '',
      input.due_date ?? null,
      input.due_time ?? null,
      input.priority || 'none',
      input.parent_id ?? null,
      sortOrder,
      JSON.stringify(input.tags || []),
      input.recurrence_rule ?? null,
      input.estimated_minutes ?? 0,
      input.source || 'manual',
      timestamp,
      timestamp
    ]
  );
  persistDatabase();
  return (await getTickTickTask(taskId))!;
}

export async function updateTickTickTask(taskId: string, partial: Partial<TickTickTaskInput & { is_completed?: number; actual_minutes?: number; pomodoro_sessions?: number }>): Promise<TickTickTask | null> {
  const db = await getDatabase();
  const current = await getTickTickTask(taskId);
  if (!current) return null;

  const sets: string[] = [];
  const values: unknown[] = [];

  if (partial.list_id !== undefined) {
    sets.push('list_id = ?');
    values.push(partial.list_id);
  }
  if (partial.title !== undefined) {
    sets.push('title = ?');
    values.push(partial.title.trim());
  }
  if (partial.note !== undefined) {
    sets.push('note = ?');
    values.push(partial.note);
  }
  if (partial.due_date !== undefined) {
    sets.push('due_date = ?');
    values.push(partial.due_date);
  }
  if (partial.due_time !== undefined) {
    sets.push('due_time = ?');
    values.push(partial.due_time);
  }
  if (partial.priority !== undefined) {
    sets.push('priority = ?');
    values.push(partial.priority);
  }
  if (partial.parent_id !== undefined) {
    sets.push('parent_id = ?');
    values.push(partial.parent_id);
  }
  if (partial.tags !== undefined) {
    sets.push('tags = ?');
    values.push(JSON.stringify(partial.tags));
  }
  if (partial.recurrence_rule !== undefined) {
    sets.push('recurrence_rule = ?');
    values.push(partial.recurrence_rule);
  }
  if (partial.estimated_minutes !== undefined) {
    sets.push('estimated_minutes = ?');
    values.push(partial.estimated_minutes);
  }
  if (partial.actual_minutes !== undefined) {
    sets.push('actual_minutes = ?');
    values.push(partial.actual_minutes);
  }
  if (partial.pomodoro_sessions !== undefined) {
    sets.push('pomodoro_sessions = ?');
    values.push(partial.pomodoro_sessions);
  }
  if (partial.source !== undefined) {
    sets.push('source = ?');
    values.push(partial.source);
  }

  // Handle is_completed specially
  if (partial.is_completed !== undefined) {
    sets.push('is_completed = ?');
    values.push(partial.is_completed);
    if (partial.is_completed === 1 && !current.completed_at) {
      sets.push('completed_at = ?');
      values.push(nowIso());
    } else if (partial.is_completed === 0) {
      sets.push('completed_at = NULL');
    }
  }

  if (sets.length === 0) return current;

  sets.push('updated_at = ?');
  values.push(nowIso());
  values.push(taskId);

  runSql(db, `UPDATE ticktick_tasks SET ${sets.join(', ')} WHERE id = ?`, values);
  persistDatabase();
  return getTickTickTask(taskId);
}

export async function deleteTickTickTask(taskId: string): Promise<boolean> {
  const db = await getDatabase();
  runSql(db, 'BEGIN');
  try {
    // Recursively collect all descendant IDs
    const allIds: string[] = [taskId];
    for (let i = 0; i < allIds.length; i++) {
      const children = allSql<{ id: string }>(db, 'SELECT id FROM ticktick_tasks WHERE parent_id = ?', [allIds[i]]);
      for (const child of children) allIds.push(child.id);
    }
    // FK CASCADE handles bridge cleanup, but we also clean manually for existing DBs
    for (const id of allIds) {
      runSql(db, 'DELETE FROM ticktick_bridge WHERE ticktick_task_id = ?', [id]);
    }
    // Delete all descendant tasks (order doesn't matter with FK CASCADE on subtasks)
    for (const id of allIds) {
      runSql(db, 'DELETE FROM ticktick_tasks WHERE id = ?', [id]);
    }
    runSql(db, 'COMMIT');
    persistDatabase();
    return true;
  } catch (e) {
    runSql(db, 'ROLLBACK');
    throw e;
  }
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
  const db = await getDatabase();

  // Overdue: due_date before today, not completed, no parent
  const overdueRaw = db.exec(
    `${TASK_SELECT} WHERE t.parent_id IS NULL AND t.is_completed = 0 AND t.due_date IS NOT NULL AND t.due_date < ? ORDER BY t.due_date ASC, t.sort_order ASC`,
    [today]
  );
  const overdue: TickTickTask[] = [];
  if (overdueRaw.length > 0) {
    for (const row of overdueRaw[0].values) {
      overdue.push(await hydrateTask(db, mapTask(row)));
    }
  }

  // Today: due_date = today or no due_date
  const todayRaw = db.exec(
    `${TASK_SELECT} WHERE t.parent_id IS NULL AND t.is_completed = 0 AND (t.due_date = ? OR t.due_date IS NULL) ORDER BY t.due_time ASC, t.sort_order ASC`,
    [today]
  );
  const todayTasks: TickTickTask[] = [];
  if (todayRaw.length > 0) {
    for (const row of todayRaw[0].values) {
      todayTasks.push(await hydrateTask(db, mapTask(row)));
    }
  }

  // Upcoming: due_date after today
  const upcomingRaw = db.exec(
    `${TASK_SELECT} WHERE t.parent_id IS NULL AND t.is_completed = 0 AND t.due_date > ? ORDER BY t.due_date ASC, t.sort_order ASC`,
    [today]
  );
  const upcoming: TickTickTask[] = [];
  if (upcomingRaw.length > 0) {
    for (const row of upcomingRaw[0].values) {
      upcoming.push(await hydrateTask(db, mapTask(row)));
    }
  }

  return { overdue, today: todayTasks, upcoming };
}

// ── Tags ──

export async function listTickTickTags(): Promise<TickTickTag[]> {
  const db = await getDatabase();
  const rows = allSql<TickTickTag & { task_count: number }>(
    db,
    `SELECT tg.*,
       (SELECT COUNT(*) FROM ticktick_tasks t
        WHERE t.tags LIKE '%"' || tg.name || '"%'
          AND t.parent_id IS NULL) AS task_count
     FROM ticktick_tags tg
     ORDER BY task_count DESC, tg.name ASC`
  );
  return rows;
}

// ── Focus Sessions ──

export async function listTickTickFocusSessions(filters?: {
  date?: string;
  taskId?: string;
}): Promise<TickTickFocusSession[]> {
  const db = await getDatabase();
  const where: string[] = [];
  const params: unknown[] = [];

  if (filters?.date) {
    where.push("date(fs.start_time) = ?");
    params.push(filters.date);
  }
  if (filters?.taskId) {
    where.push('fs.task_id = ?');
    params.push(filters.taskId);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = allSql<TickTickFocusSession & { task_title: string }>(
    db,
    `SELECT fs.*, t.title AS task_title
     FROM ticktick_focus_sessions fs
     LEFT JOIN ticktick_tasks t ON t.id = fs.task_id
     ${whereClause}
     ORDER BY fs.start_time DESC`,
    params
  );
  return rows;
}

export async function createTickTickFocusSession(input: TickTickFocusSessionInput): Promise<TickTickFocusSession> {
  const db = await getDatabase();
  const sessionId = id('focus');
  const timestamp = nowIso();

  runSql(
    db,
    `INSERT INTO ticktick_focus_sessions (
       id, task_id, start_time, end_time, duration_minutes,
       session_type, completed, white_noise, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sessionId,
      input.task_id ?? null,
      input.start_time,
      input.end_time ?? null,
      input.duration_minutes,
      input.session_type || 'focus',
      input.completed ?? 1,
      input.white_noise ?? null,
      timestamp
    ]
  );
  persistDatabase();

  const row = oneSql<TickTickFocusSession & { task_title: string }>(
    db,
    `SELECT fs.*, t.title AS task_title
     FROM ticktick_focus_sessions fs
     LEFT JOIN ticktick_tasks t ON t.id = fs.task_id
     WHERE fs.id = ?`,
    [sessionId]
  );
  return row!;
}

// ── Bridge ──

export async function getTickTickTaskBridges(taskId: string): Promise<TickTickBridge[]> {
  const db = await getDatabase();
  return allSql<TickTickBridge>(
    db,
    'SELECT * FROM ticktick_bridge WHERE ticktick_task_id = ? ORDER BY linked_type, linked_id',
    [taskId]
  );
}

export async function createTickTickBridge(input: TickTickBridgeInput): Promise<TickTickBridge> {
  const db = await getDatabase();
  const timestamp = nowIso();

  runSql(
    db,
    `INSERT INTO ticktick_bridge (ticktick_task_id, linked_type, linked_id, sync_review, sync_mastery, created_at)
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
  persistDatabase();

  const lastId = oneSql<{ id: number }>(db, 'SELECT last_insert_rowid() AS id');
  const row = oneSql<TickTickBridge>(db, 'SELECT * FROM ticktick_bridge WHERE id = ?', [lastId!.id]);
  return row!;
}

export async function deleteTickTickBridge(bridgeId: number): Promise<boolean> {
  const db = await getDatabase();
  runSql(db, 'DELETE FROM ticktick_bridge WHERE id = ?', [bridgeId]);
  persistDatabase();
  return true;
}

export async function getBridgesForLinked(
  linkedType: TickTickBridgeLinkedType,
  linkedId: string
): Promise<TickTickBridge[]> {
  const db = await getDatabase();
  return allSql<TickTickBridge>(
    db,
    'SELECT * FROM ticktick_bridge WHERE linked_type = ? AND linked_id = ?',
    [linkedType, linkedId]
  );
}

// ── Calendar ──

export async function getTickTickCalendarMonth(year: number, month: number): Promise<TickTickCalendarDay[]> {
  const db = await getDatabase();

  // Month range
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate(); // month is 0-indexed
  const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  // 1) Tasks in this month (parent tasks only)
  const tasksRaw = db.exec(
    `${TASK_SELECT} WHERE t.parent_id IS NULL AND t.due_date >= ? AND t.due_date <= ? ORDER BY t.due_date, t.sort_order`,
    [startDate, endDate]
  );
  const tasks: TickTickTask[] = [];
  if (tasksRaw.length > 0) {
    for (const row of tasksRaw[0].values) {
      tasks.push(await hydrateTask(db, mapTask(row)));
    }
  }

  // 2) Review due dates from questions table
  const reviewsRaw = db.exec(
    `SELECT next_review_at FROM questions WHERE next_review_at >= ? AND next_review_at <= ?`,
    [startDate, endDate]
  );
  const reviewMap = new Map<string, number>();
  if (reviewsRaw.length > 0) {
    for (const [raw] of reviewsRaw[0].values) {
      if (raw) {
        const d = String(raw).slice(0, 10);
        reviewMap.set(d, (reviewMap.get(d) || 0) + 1);
      }
    }
  }

  // 3) Focus sessions (pomodoro count is per day)
  const sessionsRaw = db.exec(
    `SELECT date(start_time) AS d, COUNT(*) AS cnt
     FROM ticktick_focus_sessions
     WHERE session_type = 'focus' AND completed = 1 AND date(start_time) >= ? AND date(start_time) <= ?
     GROUP BY d`,
    [startDate, endDate]
  );
  const pomodoroMap = new Map<string, number>();
  if (sessionsRaw.length > 0) {
    for (const [d, cnt] of sessionsRaw[0].values) {
      pomodoroMap.set(String(d), Number(cnt));
    }
  }

  // 4) AI plans
  const plansRaw = db.exec(
    `SELECT plan_date FROM ticktick_ai_plans WHERE plan_date >= ? AND plan_date <= ?`,
    [startDate, endDate]
  );
  const planSet = new Set<string>();
  if (plansRaw.length > 0) {
    for (const [d] of plansRaw[0].values) {
      planSet.add(String(d));
    }
  }

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
  const db = await getDatabase();
  ensureAppSettings(db);

  const rawRows = db.exec("SELECT value FROM app_settings WHERE key = 'ticktick_settings'");
  if (rawRows.length === 0 || rawRows[0].values.length === 0) {
    return { ...DEFAULT_TICKTICK_SETTINGS };
  }

  try {
    const parsed = JSON.parse(String(rawRows[0].values[0][0]));
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
  const db = await getDatabase();
  ensureAppSettings(db);

  const merged: TickTickSettings = {
    pomodoro: { ...DEFAULT_TICKTICK_SETTINGS.pomodoro, ...(settings.pomodoro || {}) },
    autoCreateReviewTasks: settings.autoCreateReviewTasks ?? DEFAULT_TICKTICK_SETTINGS.autoCreateReviewTasks,
    whiteNoise: settings.whiteNoise ?? DEFAULT_TICKTICK_SETTINGS.whiteNoise,
    defaultListId: settings.defaultListId ?? DEFAULT_TICKTICK_SETTINGS.defaultListId,
  };

  runSql(
    db,
    'INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)',
    ['ticktick_settings', JSON.stringify(merged)]
  );
  persistDatabase();
  return merged;
}

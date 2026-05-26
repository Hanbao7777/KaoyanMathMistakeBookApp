# TickTick Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate a full TickTick-style task management system with bidirectional sync to the existing 考研数学错题本 Electron app.

**Architecture:** Mini-app approach — TickTick has its own Shell, Sidebar, pages, services, and DB tables. A mode toggle in the top Shell switches between "错题本" and "TickTick" modes. A bridge table and BridgeService handle bidirectional sync. AI features reuse the existing DeepSeek service. CSS variables power a dual light/dark theme.

**Tech Stack:** Same as existing — Electron + React 18 + TypeScript (strict) + sql.js + KaTeX + Recharts + Lucide React + plain CSS

---

### Task 1: Database Schema — Add TickTick Tables

**Files:**
- Modify: `src/main/database/schema.ts` — append new tables to `schemaSql`

- [ ] **Step 1: Add TickTick tables to schema.ts**

Append the following to the `schemaSql` string, before the final backtick. Add after existing tables (before any closing `\``):

```sql
CREATE TABLE IF NOT EXISTS ticktick_lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#4a90d9',
  icon TEXT DEFAULT 'list',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_folder INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ticktick_tasks (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  title TEXT NOT NULL,
  note TEXT DEFAULT '',
  due_date TEXT,
  due_time TEXT,
  priority TEXT CHECK(priority IN ('none','低','中','高')) DEFAULT 'none',
  is_completed INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  parent_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  tags TEXT DEFAULT '[]',
  recurrence_rule TEXT,
  estimated_minutes INTEGER NOT NULL DEFAULT 0,
  actual_minutes INTEGER NOT NULL DEFAULT 0,
  pomodoro_sessions INTEGER NOT NULL DEFAULT 0,
  source TEXT DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (list_id) REFERENCES ticktick_lists(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES ticktick_tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ticktick_tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#999999'
);

CREATE TABLE IF NOT EXISTS ticktick_focus_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT,
  duration_minutes INTEGER NOT NULL DEFAULT 0,
  session_type TEXT CHECK(session_type IN ('focus','short_break','long_break')) DEFAULT 'focus',
  completed INTEGER NOT NULL DEFAULT 1,
  white_noise TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES ticktick_tasks(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ticktick_bridge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticktick_task_id TEXT NOT NULL,
  linked_type TEXT NOT NULL CHECK(linked_type IN ('question','knowledge_point','subject','study_task')),
  linked_id TEXT NOT NULL,
  sync_review INTEGER NOT NULL DEFAULT 1,
  sync_mastery INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ticktick_ai_plans (
  id TEXT PRIMARY KEY,
  plan_date TEXT NOT NULL,
  raw_response TEXT NOT NULL,
  tasks_json TEXT NOT NULL,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  reviewed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ticktick_tasks_list ON ticktick_tasks(list_id);
CREATE INDEX IF NOT EXISTS idx_ticktick_tasks_date ON ticktick_tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_ticktick_tasks_parent ON ticktick_tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_ticktick_bridge_task ON ticktick_bridge(ticktick_task_id);
CREATE INDEX IF NOT EXISTS idx_ticktick_bridge_linked ON ticktick_bridge(linked_type, linked_id);
CREATE INDEX IF NOT EXISTS idx_ticktick_focus_task ON ticktick_focus_sessions(task_id);
```

- [ ] **Step 2: Verify app starts with new tables**

Run: `npm run dev`
Expected: App launches without errors. Tables are created idempotently.

- [ ] **Step 3: Commit**

```bash
git add src/main/database/schema.ts
git commit -m "feat: add TickTick database tables (lists, tasks, tags, focus_sessions, bridge, ai_plans)"
```

---

### Task 2: Shared Types — TickTick Type Definitions

**Files:**
- Modify: `src/shared/types.ts` — append new interfaces

- [ ] **Step 1: Add TickTick types to types.ts**

Append to end of file:

```typescript
// ── TickTick Types ──

export type TickTickPriority = 'none' | '低' | '中' | '高';
export type TickTickSessionType = 'focus' | 'short_break' | 'long_break';
export type TickTickBridgeLinkedType = 'question' | 'knowledge_point' | 'subject' | 'study_task';
export type TickTickTaskSource = 'manual' | 'auto_review' | 'ai_plan';
export type TickTickWhiteNoise = 'rain' | 'stream' | 'cafe' | 'white' | 'forest' | 'none';

export interface TickTickList {
  id: string;
  name: string;
  color: string;
  icon: string;
  sort_order: number;
  is_folder: number;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
  task_count?: number;
}

export interface TickTickListInput {
  name: string;
  color?: string;
  icon?: string;
  is_folder?: number;
  parent_id?: string | null;
}

export interface TickTickTask {
  id: string;
  list_id: string;
  list_name?: string;
  list_color?: string;
  title: string;
  note: string;
  due_date: string | null;
  due_time: string | null;
  priority: TickTickPriority;
  is_completed: number;
  completed_at: string | null;
  parent_id: string | null;
  sort_order: number;
  tags: string;
  tags_list?: string[];
  recurrence_rule: string | null;
  estimated_minutes: number;
  actual_minutes: number;
  pomodoro_sessions: number;
  source: TickTickTaskSource;
  created_at: string;
  updated_at: string;
  subtask_count?: number;
  subtask_completed?: number;
  bridge_links?: TickTickBridge[];
}

export interface TickTickTaskInput {
  list_id: string;
  title: string;
  note?: string;
  due_date?: string | null;
  due_time?: string | null;
  priority?: TickTickPriority;
  parent_id?: string | null;
  tags?: string[];
  recurrence_rule?: string | null;
  estimated_minutes?: number;
  source?: TickTickTaskSource;
}

export interface TickTickTaskFilters {
  listId?: string;
  dueDate?: string;
  dueDateBefore?: string;
  includeCompleted?: boolean;
  includeNoDate?: boolean;
  search?: string;
  tag?: string;
  priority?: TickTickPriority;
}

export interface TickTickTag {
  id: string;
  name: string;
  color: string;
  task_count?: number;
}

export interface TickTickFocusSession {
  id: string;
  task_id: string | null;
  task_title?: string;
  start_time: string;
  end_time: string | null;
  duration_minutes: number;
  session_type: TickTickSessionType;
  completed: number;
  white_noise: TickTickWhiteNoise | null;
  created_at: string;
}

export interface TickTickFocusSessionInput {
  task_id?: string | null;
  start_time: string;
  end_time?: string | null;
  duration_minutes: number;
  session_type?: TickTickSessionType;
  completed?: number;
  white_noise?: TickTickWhiteNoise | null;
}

export interface TickTickBridge {
  id: number;
  ticktick_task_id: string;
  linked_type: TickTickBridgeLinkedType;
  linked_id: string;
  sync_review: number;
  sync_mastery: number;
  created_at: string;
}

export interface TickTickBridgeInput {
  ticktick_task_id: string;
  linked_type: TickTickBridgeLinkedType;
  linked_id: string;
  sync_review?: number;
  sync_mastery?: number;
}

export interface TickTickAiPlan {
  id: string;
  plan_date: string;
  raw_response: string;
  tasks_json: string;
  accepted_count: number;
  reviewed: number;
  created_at: string;
}

export interface TickTickCalendarDay {
  date: string;
  task_count: number;
  completed_count: number;
  review_due_count: number;
  pomodoro_count: number;
  has_ai_plan: boolean;
  tasks: TickTickTask[];
}

export interface TickTickAiDecompositionInput {
  goal: string;
  context?: {
    availableDays?: number;
    weakKnowledgePoints?: string[];
    subjectId?: string;
  };
}

export interface TickTickAiDecompositionResult {
  subtasks: Array<{
    title: string;
    estimated_days: number;
    tags: string[];
    knowledge_points: string[];
  }>;
  total_days: number;
}

export interface TickTickAiDailyPlanResult {
  suggested_tasks: Array<{
    title: string;
    time_block: string;
    priority: TickTickPriority;
    estimated_minutes: number;
    linked_type: TickTickBridgeLinkedType | null;
    linked_id: string | null;
    reason: string;
  }>;
  summary: string;
}

export interface TickTickAiReviewResult {
  completion_rate: number;
  total_focus_minutes: number;
  correct_rate: number | null;
  weak_points: string[];
  suggestion: string;
}

export interface TickTickPomodoroSettings {
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  sessionsBeforeLongBreak: number;
}

export interface TickTickSettings {
  pomodoro: TickTickPomodoroSettings;
  autoCreateReviewTasks: boolean;
  whiteNoise: TickTickWhiteNoise;
  defaultListId: string | null;
}
```

- [ ] **Step 2: Verify TypeScript compilation**

Run: `npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat: add TickTick shared type definitions"
```

---

### Task 3: API Contract — Extend AppApi

**Files:**
- Modify: `src/shared/api.ts` — add TickTick method signatures

- [ ] **Step 1: Add TickTick methods to AppApi interface**

Import the new types at the top of api.ts:

```typescript
import type {
  // ... existing imports ...
  TickTickList, TickTickListInput,
  TickTickTask, TickTickTaskInput, TickTickTaskFilters,
  TickTickTag,
  TickTickFocusSession, TickTickFocusSessionInput,
  TickTickBridge, TickTickBridgeInput,
  TickTickAiPlan,
  TickTickCalendarDay,
  TickTickAiDecompositionInput, TickTickAiDecompositionResult,
  TickTickAiDailyPlanResult, TickTickAiReviewResult,
  TickTickPomodoroSettings, TickTickSettings,
  TickTickWhiteNoise,
} from './types';
```

Add methods to the `AppApi` interface before the closing `}`:

```typescript
  // TickTick Lists
  listTickTickLists: () => Promise<TickTickList[]>;
  getTickTickList: (id: string) => Promise<TickTickList | null>;
  createTickTickList: (input: TickTickListInput) => Promise<TickTickList>;
  updateTickTickList: (id: string, input: TickTickListInput) => Promise<TickTickList | null>;
  deleteTickTickList: (id: string) => Promise<boolean>;
  reorderTickTickLists: (ids: string[]) => Promise<void>;

  // TickTick Tasks
  listTickTickTasks: (filters?: TickTickTaskFilters) => Promise<TickTickTask[]>;
  getTickTickTask: (id: string) => Promise<TickTickTask | null>;
  createTickTickTask: (input: TickTickTaskInput) => Promise<TickTickTask>;
  updateTickTickTask: (id: string, input: Partial<TickTickTaskInput> & { is_completed?: number; actual_minutes?: number; pomodoro_sessions?: number; sort_order?: number }) => Promise<TickTickTask | null>;
  deleteTickTickTask: (id: string) => Promise<boolean>;
  completeTickTickTask: (id: string) => Promise<TickTickTask | null>;
  uncompleteTickTickTask: (id: string) => Promise<TickTickTask | null>;
  getTodayTickTickTasks: () => Promise<{ overdue: TickTickTask[]; today: TickTickTask[]; upcoming: TickTickTask[] }>;

  // TickTick Tags
  listTickTickTags: () => Promise<TickTickTag[]>;

  // TickTick Focus Sessions
  listTickTickFocusSessions: (filters?: { date?: string; taskId?: string }) => Promise<TickTickFocusSession[]>;
  createTickTickFocusSession: (input: TickTickFocusSessionInput) => Promise<TickTickFocusSession>;

  // TickTick Bridge
  getTickTickTaskBridges: (taskId: string) => Promise<TickTickBridge[]>;
  createTickTickBridge: (input: TickTickBridgeInput) => Promise<TickTickBridge>;
  deleteTickTickBridge: (id: number) => Promise<boolean>;
  getBridgesForLinked: (linkedType: TickTickBridgeLinkedType, linkedId: string) => Promise<TickTickBridge[]>;

  // TickTick Calendar
  getTickTickCalendarMonth: (year: number, month: number) => Promise<TickTickCalendarDay[]>;

  // TickTick AI
  aiDecomposeTask: (input: TickTickAiDecompositionInput) => Promise<TickTickAiDecompositionResult>;
  aiGenerateDailyPlan: () => Promise<TickTickAiDailyPlanResult>;
  aiGenerateReview: (type: 'daily' | 'weekly') => Promise<TickTickAiReviewResult>;

  // TickTick Settings
  getTickTickSettings: () => Promise<TickTickSettings>;
  saveTickTickSettings: (settings: TickTickSettings) => Promise<TickTickSettings>;

  // TickTick White Noise
  getTickTickWhiteNoiseState: () => Promise<{ enabled: boolean; noise: TickTickWhiteNoise }>;
  setTickTickWhiteNoiseState: (state: { enabled: boolean; noise: TickTickWhiteNoise }) => Promise<void>;

  // Auto review task creation
  triggerReviewTaskGeneration: () => Promise<{ created: number }>;
```

- [ ] **Step 2: Commit**

```bash
git add src/shared/api.ts
git commit -m "feat: add TickTick API method signatures to AppApi"
```

---

### Task 4: NLP Date Parser Utility

**Files:**
- Create: `src/renderer/utils/nlpDateParser.ts`

- [ ] **Step 1: Create the NLP parser**

Write the complete file at `src/renderer/utils/nlpDateParser.ts`:

```typescript
export interface ParsedTaskInput {
  title: string;
  due_date: string | null;
  due_time: string | null;
  priority: 'none' | '低' | '中' | '高';
  tags: string[];
  list_name: string | null;
  recurrence_rule: string | null;
  estimated_minutes: number;
}

function todayDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const WEEKDAY_MAP: Record<string, number> = {
  '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0
};

function parseDateWord(word: string): string | null {
  switch (word) {
    case '今天': return todayDate();
    case '明天': return addDays(1);
    case '后天': return addDays(2);
    case '大后天': return addDays(3);
    default: return null;
  }
}

function parseRelativeDay(text: string): string | null {
  const match = text.match(/^(\d+)天后$/);
  if (match) return addDays(parseInt(match[1], 10));
  return null;
}

function parseWeekday(text: string): string | null {
  const m1 = text.match(/^下?周([一二三四五六日天])$/);
  if (m1) {
    const target = WEEKDAY_MAP[m1[1]];
    const now = new Date();
    const currentDay = now.getDay();
    let diff = target - currentDay;
    if (text.startsWith('下')) diff += 7;
    else if (diff <= 0) diff += 7;
    return addDays(diff);
  }
  return null;
}

function parseAbsoluteDate(text: string): string | null {
  const m1 = text.match(/^(\d{1,2})月(\d{1,2})[日号]?$/);
  if (m1) {
    const year = new Date().getFullYear();
    const month = parseInt(m1[1], 10);
    const day = parseInt(m1[2], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  const m2 = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m2) {
    const year = parseInt(m2[1], 10);
    const month = parseInt(m2[2], 10);
    const day = parseInt(m2[3], 10);
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const m3 = text.match(/^下个月(\d{1,2})[日号]?$/);
  if (m3) {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 2; // next month
    const day = parseInt(m3[1], 10);
    if (month > 12) return `${year + 1}-${String(month - 12).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null;
}

function parseTimeWord(word: string): string | null {
  const timeMap: Record<string, string> = {
    '早上': '08:00', '上午': '09:00', '中午': '12:00',
    '下午': '14:00', '傍晚': '17:00', '晚上': '20:00', '今晚': '20:00'
  };
  if (timeMap[word]) return timeMap[word];

  const m1 = word.match(/^(\d{1,2})点(半|(\d{1,2})分?)?$/);
  if (m1) {
    const hour = parseInt(m1[1], 10);
    const minute = m1[2] === '半' ? 30 : (m1[2] ? parseInt(m1[2], 10) : 0);
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  const m2 = word.match(/^(\d{1,2}):(\d{2})$/);
  if (m2) {
    return `${String(parseInt(m2[1], 10)).padStart(2, '0')}:${m2[2]}`;
  }
  // 复合: 下午3点
  const m3 = word.match(/^(早上|上午|中午|下午|傍晚|晚上|今晚)(\d{1,2})点(半|(\d{1,2})分?)?$/);
  if (m3) {
    const base = timeMap[m3[1]] || '12:00';
    const baseHour = parseInt(base.split(':')[0], 10);
    const hour = parseInt(m3[2], 10);
    const minute = m3[3] === '半' ? 30 : (m3[3] ? parseInt(m3[3], 10) : 0);
    const adjustedHour = m3[1] === '下午' || m3[1] === '傍晚' || m3[1] === '晚上' || m3[1] === '今晚'
      ? (hour === 12 ? 12 : hour + 12)
      : hour;
    return `${String(adjustedHour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  return null;
}

function parseRecurrence(text: string): string | null {
  if (/^每[天天日]$/.test(text)) return 'daily';
  const m1 = text.match(/^每周([一二三四五六日天])$/);
  if (m1) return `weekly:${WEEKDAY_MAP[m1[1]]}`;
  const m2 = text.match(/^每个?月(\d{1,2})[日号]$/);
  if (m2) return `monthly:${parseInt(m2[1], 10)}`;
  if (/^每个?工作日$/.test(text)) return 'weekly:1,2,3,4,5';
  if (/^每个?周末$/.test(text)) return 'weekly:6,0';
  return null;
}

function parseEstimatedMinutes(text: string): number {
  const m = text.match(/预计(\d+)(分钟|分)/);
  return m ? parseInt(m[1], 10) : 0;
}

export function parseTaskInput(raw: string): ParsedTaskInput {
  const result: ParsedTaskInput = {
    title: raw,
    due_date: null,
    due_time: null,
    priority: 'none',
    tags: [],
    list_name: null,
    recurrence_rule: null,
    estimated_minutes: 0,
  };

  // Extract estimated minutes
  const estMatch = raw.match(/预计(\d+)(分钟|分)/);
  if (estMatch) {
    result.estimated_minutes = parseInt(estMatch[1], 10);
    result.title = result.title.replace(estMatch[0], '').trim();
  }

  // Extract priority !!高 !!中 !!低
  const priorityMatch = raw.match(/!!(高|中|低)/);
  if (priorityMatch) {
    result.priority = priorityMatch[1] as '高' | '中' | '低';
    result.title = result.title.replace(priorityMatch[0], '').trim();
  }

  // Extract tags #tag
  const tagMatches = raw.match(/#(\S+)/g);
  if (tagMatches) {
    result.tags = tagMatches.map(t => t.slice(1));
    tagMatches.forEach(m => { result.title = result.title.replace(m, '').trim(); });
  }

  // Extract list @list
  const listMatch = raw.match(/@(\S+)/);
  if (listMatch) {
    result.list_name = listMatch[1];
    result.title = result.title.replace(listMatch[0], '').trim();
  }

  // Extract recurrence: check for pattern at the end or beginning
  const recurrencePatterns = [
    /每天$/, /每日$/, /每周[一二三四五六日天]$/, /每周一$/, /每周二$/, /每周三$/, /每周四$/, /每周五$/, /每周六$/, /每周日$/,
    /每个月\d{1,2}[日号]$/, /每个工作日$/, /每个周末$/
  ];
  for (const pattern of recurrencePatterns) {
    const m = result.title.match(pattern);
    if (m) {
      result.recurrence_rule = parseRecurrence(m[0]);
      if (result.recurrence_rule) {
        result.title = result.title.replace(m[0], '').trim();
        break;
      }
    }
  }

  // Extract date/time from remaining title — try compound patterns first
  // e.g., "明天下午3点"
  const dateTimeMatch = result.title.match(/(今天|明天|后天|大后天|\d+天后|下?周[一二三四五六日天]|\d{1,2}月\d{1,2}[日号]?)(早上|上午|中午|下午|傍晚|晚上|今晚)?(\d{1,2})?(点(半|(\d{1,2})分?)?)?/);
  if (dateTimeMatch) {
    const datePart = dateTimeMatch[1];
    const timePrefix = dateTimeMatch[2] || '';
    const hourPart = dateTimeMatch[3] || '';
    const minuteSuffix = dateTimeMatch[4] || '';

    const parsedDate = parseDateWord(datePart) || parseRelativeDay(datePart) || parseWeekday(datePart) || parseAbsoluteDate(datePart);
    if (parsedDate) {
      result.due_date = parsedDate;
    }

    if (hourPart) {
      const timeStr = timePrefix + hourPart + minuteSuffix;
      result.due_time = parseTimeWord(timeStr) || parseTimeWord(hourPart + minuteSuffix);
    }

    result.title = result.title.replace(dateTimeMatch[0], '').trim();
  }

  // Try standalone time
  const timeMatch = result.title.match(/(\d{1,2}):(\d{2})/);
  if (timeMatch && !result.due_time) {
    result.due_time = timeMatch[0];
    result.title = result.title.replace(timeMatch[0], '').trim();
  }

  // Clean up extra whitespace
  result.title = result.title.replace(/\s{2,}/g, ' ').trim();

  return result;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/utils/nlpDateParser.ts
git commit -m "feat: add Chinese NLP date parser for TickTick task input"
```

---

### Task 5: TickTick Task Service

**Files:**
- Create: `src/main/services/ticktickService.ts`

- [ ] **Step 1: Create the TickTick service**

Write `src/main/services/ticktickService.ts`:

```typescript
import { v4 as uuidv4 } from 'uuid';
import { getDatabase, persistDatabase } from './databaseService';
import type {
  TickTickList, TickTickListInput,
  TickTickTask, TickTickTaskInput, TickTickTaskFilters,
  TickTickTag,
  TickTickFocusSession, TickTickFocusSessionInput,
  TickTickBridge, TickTickBridgeInput,
  TickTickBridgeLinkedType,
  TickTickCalendarDay,
  TickTickSettings, TickTickPomodoroSettings,
} from '../../shared/types';

// Helper: generate ID with short prefix
function id(prefix: string): string {
  const short = uuidv4().replace(/-/g, '').slice(0, 12);
  return `${prefix}_${short}`;
}

// ── Lists ──

export async function listTickTickLists(): Promise<TickTickList[]> {
  const db = await getDatabase();
  const rows = db.exec(
    `SELECT l.*, (SELECT COUNT(*) FROM ticktick_tasks t WHERE t.list_id = l.id AND t.parent_id IS NULL) as task_count
     FROM ticktick_lists l ORDER BY l.sort_order ASC`
  );
  if (!rows.length) return [];
  return rows[0].values.map((row: any[]) => ({
    id: row[0], name: row[1], color: row[2], icon: row[3],
    sort_order: row[4], is_folder: row[5], parent_id: row[6],
    created_at: row[7], updated_at: row[8], task_count: row[9],
  }));
}

export async function getTickTickList(listId: string): Promise<TickTickList | null> {
  const db = await getDatabase();
  const rows = db.exec('SELECT * FROM ticktick_lists WHERE id = ?', [listId]);
  if (!rows.length || !rows[0].values.length) return null;
  const row = rows[0].values[0] as any[];
  return {
    id: row[0], name: row[1], color: row[2], icon: row[3],
    sort_order: row[4], is_folder: row[5], parent_id: row[6],
    created_at: row[7], updated_at: row[8],
  };
}

export async function createTickTickList(input: TickTickListInput): Promise<TickTickList> {
  const db = await getDatabase();
  const listId = id('list');
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO ticktick_lists (id, name, color, icon, is_folder, parent_id, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM ticktick_lists), ?, ?)`,
    [listId, input.name, input.color || '#4a90d9', input.icon || 'list', input.is_folder || 0, input.parent_id || null, now, now]
  );
  persistDatabase();
  return (await getTickTickList(listId))!;
}

export async function updateTickTickList(listId: string, input: TickTickListInput): Promise<TickTickList | null> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  db.run(
    `UPDATE ticktick_lists SET name = COALESCE(?, name), color = COALESCE(?, color), icon = COALESCE(?, icon), updated_at = ? WHERE id = ?`,
    [input.name || null, input.color || null, input.icon || null, now, listId]
  );
  persistDatabase();
  return getTickTickList(listId);
}

export async function deleteTickTickList(listId: string): Promise<boolean> {
  const db = await getDatabase();
  db.run('DELETE FROM ticktick_lists WHERE id = ?', [listId]);
  persistDatabase();
  return true;
}

export async function reorderTickTickLists(ids: string[]): Promise<void> {
  const db = await getDatabase();
  const stmt = db.prepare('UPDATE ticktick_lists SET sort_order = ? WHERE id = ?');
  ids.forEach((listId, index) => stmt.run([index, listId]));
  stmt.free();
  persistDatabase();
}

// ── Tasks ──

function mapTask(row: any[]): TickTickTask {
  return {
    id: row[0], list_id: row[1], title: row[2], note: row[3],
    due_date: row[4], due_time: row[5], priority: row[6],
    is_completed: row[7], completed_at: row[8], parent_id: row[9],
    sort_order: row[10], tags: row[11], recurrence_rule: row[12],
    estimated_minutes: row[13], actual_minutes: row[14],
    pomodoro_sessions: row[15], source: row[16],
    created_at: row[17], updated_at: row[18],
    list_name: row[19] || undefined,
    list_color: row[20] || undefined,
  };
}

const TASK_SELECT = `SELECT t.*, l.name as list_name, l.color as list_color FROM ticktick_tasks t LEFT JOIN ticktick_lists l ON t.list_id = l.id`;

export async function listTickTickTasks(filters: TickTickTaskFilters = {}): Promise<TickTickTask[]> {
  const db = await getDatabase();
  const conditions: string[] = ['t.parent_id IS NULL'];
  const params: any[] = [];

  if (filters.listId) {
    conditions.push('t.list_id = ?');
    params.push(filters.listId);
  }
  if (filters.dueDate) {
    conditions.push('t.due_date = ?');
    params.push(filters.dueDate);
  }
  if (filters.dueDateBefore) {
    conditions.push('t.due_date <= ?');
    params.push(filters.dueDateBefore);
  }
  if (!filters.includeCompleted) {
    conditions.push('t.is_completed = 0');
  }
  if (!filters.includeNoDate && !filters.dueDate) {
    // skip no-date filter unless explicitly included
  }
  if (filters.search) {
    conditions.push('t.title LIKE ?');
    params.push(`%${filters.search}%`);
  }
  if (filters.priority && filters.priority !== 'none') {
    conditions.push('t.priority = ?');
    params.push(filters.priority);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.exec(`${TASK_SELECT} ${where} ORDER BY COALESCE(t.due_time, '99:99') ASC, t.sort_order ASC, t.created_at DESC`, params);
  if (!rows.length) return [];

  const tasks = rows[0].values.map(mapTask);

  // Attach tags_list and subtask counts
  for (const task of tasks) {
    try { task.tags_list = JSON.parse(task.tags as unknown as string); } catch { task.tags_list = []; }
    const subRows = db.exec('SELECT COUNT(*) as cnt FROM ticktick_tasks WHERE parent_id = ?', [task.id]);
    task.subtask_count = subRows.length ? subRows[0].values[0][0] as number : 0;
    const subCompRows = db.exec('SELECT COUNT(*) as cnt FROM ticktick_tasks WHERE parent_id = ? AND is_completed = 1', [task.id]);
    task.subtask_completed = subCompRows.length ? subCompRows[0].values[0][0] as number : 0;
  }

  return tasks;
}

export async function getTickTickTask(taskId: string): Promise<TickTickTask | null> {
  const db = await getDatabase();
  const rows = db.exec(`${TASK_SELECT} WHERE t.id = ?`, [taskId]);
  if (!rows.length || !rows[0].values.length) return null;
  const task = mapTask(rows[0].values[0] as any[]);
  try { task.tags_list = JSON.parse(task.tags as unknown as string); } catch { task.tags_list = []; }

  const subRows = db.exec('SELECT * FROM ticktick_tasks WHERE parent_id = ? ORDER BY sort_order ASC', [taskId]);
  task.subtask_count = subRows.length ? subRows[0].values.length : 0;
  const compCount = subRows.length
    ? subRows[0].values.filter((r: any[]) => r[7] === 1).length
    : 0;
  task.subtask_completed = compCount;

  return task;
}

export async function createTickTickTask(input: TickTickTaskInput): Promise<TickTickTask> {
  const db = await getDatabase();
  const taskId = id('task');
  const now = new Date().toISOString();
  const tags = JSON.stringify(input.tags || []);
  db.run(
    `INSERT INTO ticktick_tasks (id, list_id, title, note, due_date, due_time, priority, parent_id, sort_order, tags, recurrence_rule, estimated_minutes, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM ticktick_tasks WHERE list_id = ? AND parent_id IS NOT DISTINCT FROM ?), ?, ?, ?, ?, ?, ?)`,
    [taskId, input.list_id, input.title, input.note || '', input.due_date || null, input.due_time || null,
     input.priority || 'none', input.parent_id || null,
     input.list_id, input.parent_id || null,
     tags, input.recurrence_rule || null, input.estimated_minutes || 0, input.source || 'manual', now, now]
  );
  persistDatabase();
  return (await getTickTickTask(taskId))!;
}

export async function updateTickTickTask(taskId: string, input: Partial<TickTickTaskInput> & { is_completed?: number; actual_minutes?: number; pomodoro_sessions?: number; sort_order?: number }): Promise<TickTickTask | null> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const sets: string[] = ['updated_at = ?'];
  const params: any[] = [now];

  if (input.title !== undefined) { sets.push('title = ?'); params.push(input.title); }
  if (input.note !== undefined) { sets.push('note = ?'); params.push(input.note); }
  if (input.due_date !== undefined) { sets.push('due_date = ?'); params.push(input.due_date); }
  if (input.due_time !== undefined) { sets.push('due_time = ?'); params.push(input.due_time); }
  if (input.priority !== undefined) { sets.push('priority = ?'); params.push(input.priority); }
  if (input.list_id !== undefined) { sets.push('list_id = ?'); params.push(input.list_id); }
  if (input.tags !== undefined) { sets.push('tags = ?'); params.push(JSON.stringify(input.tags)); }
  if (input.recurrence_rule !== undefined) { sets.push('recurrence_rule = ?'); params.push(input.recurrence_rule); }
  if (input.estimated_minutes !== undefined) { sets.push('estimated_minutes = ?'); params.push(input.estimated_minutes); }
  if (input.is_completed !== undefined) {
    sets.push('is_completed = ?'); params.push(input.is_completed);
    sets.push('completed_at = ?'); params.push(input.is_completed ? now : null);
  }
  if (input.actual_minutes !== undefined) { sets.push('actual_minutes = ?'); params.push(input.actual_minutes); }
  if (input.pomodoro_sessions !== undefined) { sets.push('pomodoro_sessions = ?'); params.push(input.pomodoro_sessions); }
  if (input.sort_order !== undefined) { sets.push('sort_order = ?'); params.push(input.sort_order); }

  params.push(taskId);
  db.run(`UPDATE ticktick_tasks SET ${sets.join(', ')} WHERE id = ?`, params);
  persistDatabase();
  return getTickTickTask(taskId);
}

export async function deleteTickTickTask(taskId: string): Promise<boolean> {
  const db = await getDatabase();
  db.run('DELETE FROM ticktick_tasks WHERE id = ? OR parent_id = ?', [taskId, taskId]);
  db.run('DELETE FROM ticktick_bridge WHERE ticktick_task_id = ?', [taskId]);
  persistDatabase();
  return true;
}

export async function completeTickTickTask(taskId: string): Promise<TickTickTask | null> {
  return updateTickTickTask(taskId, { is_completed: 1 });
}

export async function uncompleteTickTickTask(taskId: string): Promise<TickTickTask | null> {
  return updateTickTickTask(taskId, { is_completed: 0 });
}

export async function getTodayTickTickTasks(): Promise<{ overdue: TickTickTask[]; today: TickTickTask[]; upcoming: TickTickTask[] }> {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const all = await listTickTickTasks({ includeCompleted: false });

  const overdue = all.filter(t => t.due_date && t.due_date < todayStr);
  const todayTasks = all.filter(t => t.due_date === todayStr);
  const upcoming = all.filter(t => t.due_date && t.due_date > todayStr);

  return { overdue, today: todayTasks, upcoming: upcoming.slice(0, 10) };
}

// ── Tags ──

export async function listTickTickTags(): Promise<TickTickTag[]> {
  const db = await getDatabase();
  const rows = db.exec(
    `SELECT tg.*, (SELECT COUNT(*) FROM ticktick_tasks t WHERE t.tags LIKE '%' || tg.name || '%') as task_count
     FROM ticktick_tags tg ORDER BY tg.name ASC`
  );
  if (!rows.length) return [];
  return rows[0].values.map((row: any[]) => ({
    id: row[0], name: row[1], color: row[2], task_count: row[3],
  }));
}

async function ensureTagsExist(tagNames: string[]): Promise<void> {
  const db = await getDatabase();
  const stmt = db.prepare('INSERT OR IGNORE INTO ticktick_tags (id, name, color) VALUES (?, ?, ?)');
  for (const name of tagNames) {
    stmt.run([`tag_${name}`, name, '#999999']);
  }
  stmt.free();
  persistDatabase();
}

// ── Focus Sessions ──

export async function listTickTickFocusSessions(filters?: { date?: string; taskId?: string }): Promise<TickTickFocusSession[]> {
  const db = await getDatabase();
  const conditions: string[] = [];
  const params: any[] = [];

  if (filters?.date) {
    conditions.push("date(fs.start_time) = ?");
    params.push(filters.date);
  }
  if (filters?.taskId) {
    conditions.push('fs.task_id = ?');
    params.push(filters.taskId);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.exec(
    `SELECT fs.*, t.title as task_title FROM ticktick_focus_sessions fs LEFT JOIN ticktick_tasks t ON fs.task_id = t.id ${where} ORDER BY fs.created_at DESC`,
    params
  );
  if (!rows.length) return [];
  return rows[0].values.map((row: any[]) => ({
    id: row[0], task_id: row[1], start_time: row[2], end_time: row[3],
    duration_minutes: row[4], session_type: row[5], completed: row[6],
    white_noise: row[7], created_at: row[8], task_title: row[9] || undefined,
  }));
}

export async function createTickTickFocusSession(input: TickTickFocusSessionInput): Promise<TickTickFocusSession> {
  const db = await getDatabase();
  const sessionId = id('pomo');
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO ticktick_focus_sessions (id, task_id, start_time, end_time, duration_minutes, session_type, completed, white_noise, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, input.task_id || null, input.start_time, input.end_time || null,
     input.duration_minutes, input.session_type || 'focus', input.completed ?? 1,
     input.white_noise || null, now]
  );
  persistDatabase();
  const rows = db.exec('SELECT * FROM ticktick_focus_sessions WHERE id = ?', [sessionId]);
  const row = rows[0].values[0] as any[];
  return {
    id: row[0], task_id: row[1], start_time: row[2], end_time: row[3],
    duration_minutes: row[4], session_type: row[5], completed: row[6],
    white_noise: row[7], created_at: row[8],
  };
}

// ── Bridge ──

export async function getTickTickTaskBridges(taskId: string): Promise<TickTickBridge[]> {
  const db = await getDatabase();
  const rows = db.exec('SELECT * FROM ticktick_bridge WHERE ticktick_task_id = ?', [taskId]);
  if (!rows.length) return [];
  return rows[0].values.map((row: any[]) => ({
    id: row[0], ticktick_task_id: row[1], linked_type: row[2],
    linked_id: row[3], sync_review: row[4], sync_mastery: row[5], created_at: row[6],
  }));
}

export async function createTickTickBridge(input: TickTickBridgeInput): Promise<TickTickBridge> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  db.run(
    'INSERT INTO ticktick_bridge (ticktick_task_id, linked_type, linked_id, sync_review, sync_mastery, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [input.ticktick_task_id, input.linked_type, input.linked_id, input.sync_review ?? 1, input.sync_mastery ?? 0, now]
  );
  persistDatabase();
  const rows = db.exec('SELECT * FROM ticktick_bridge WHERE rowid = last_insert_rowid()');
  const row = rows[0].values[0] as any[];
  return { id: row[0], ticktick_task_id: row[1], linked_type: row[2], linked_id: row[3], sync_review: row[4], sync_mastery: row[5], created_at: row[6] };
}

export async function deleteTickTickBridge(id: number): Promise<boolean> {
  const db = await getDatabase();
  db.run('DELETE FROM ticktick_bridge WHERE id = ?', [id]);
  persistDatabase();
  return true;
}

export async function getBridgesForLinked(linkedType: TickTickBridgeLinkedType, linkedId: string): Promise<TickTickBridge[]> {
  const db = await getDatabase();
  const rows = db.exec('SELECT * FROM ticktick_bridge WHERE linked_type = ? AND linked_id = ?', [linkedType, linkedId]);
  if (!rows.length) return [];
  return rows[0].values.map((row: any[]) => ({
    id: row[0], ticktick_task_id: row[1], linked_type: row[2],
    linked_id: row[3], sync_review: row[4], sync_mastery: row[5], created_at: row[6],
  }));
}

// ── Calendar ──

export async function getTickTickCalendarMonth(year: number, month: number): Promise<TickTickCalendarDay[]> {
  const db = await getDatabase();
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const taskRows = db.exec(
    `SELECT due_date, COUNT(*) as cnt, SUM(CASE WHEN is_completed = 1 THEN 1 ELSE 0 END) as done
     FROM ticktick_tasks WHERE due_date >= ? AND due_date <= ? AND parent_id IS NULL
     GROUP BY due_date ORDER BY due_date`,
    [startDate, endDate]
  );

  const reviewRows = db.exec(
    `SELECT DATE(next_review_at) as review_date, COUNT(*) as cnt
     FROM questions WHERE next_review_at IS NOT NULL AND DATE(next_review_at) >= ? AND DATE(next_review_at) <= ?
     GROUP BY DATE(next_review_at)`,
    [startDate, endDate]
  );

  const pomoRows = db.exec(
    `SELECT date(start_time) as session_date, COUNT(*) as cnt
     FROM ticktick_focus_sessions WHERE date(start_time) >= ? AND date(start_time) <= ? AND session_type = 'focus'
     GROUP BY date(start_time)`,
    [startDate, endDate]
  );

  const aiPlanRows = db.exec(
    `SELECT plan_date FROM ticktick_ai_plans WHERE plan_date >= ? AND plan_date <= ?`,
    [startDate, endDate]
  );

  const dayMap = new Map<string, TickTickCalendarDay>();
  for (let d = 1; d <= lastDay; d++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    dayMap.set(dateStr, { date: dateStr, task_count: 0, completed_count: 0, review_due_count: 0, pomodoro_count: 0, has_ai_plan: false, tasks: [] });
  }

  if (taskRows.length) {
    taskRows[0].values.forEach((row: any[]) => {
      const day = dayMap.get(row[0] as string);
      if (day) { day.task_count = row[1] as number; day.completed_count = row[2] as number; }
    });
  }
  if (reviewRows.length) {
    reviewRows[0].values.forEach((row: any[]) => {
      const day = dayMap.get(row[0] as string);
      if (day) day.review_due_count = row[1] as number;
    });
  }
  if (pomoRows.length) {
    pomoRows[0].values.forEach((row: any[]) => {
      const day = dayMap.get(row[0] as string);
      if (day) day.pomodoro_count = row[1] as number;
    });
  }
  if (aiPlanRows.length) {
    aiPlanRows[0].values.forEach((row: any[]) => {
      const day = dayMap.get(row[0] as string);
      if (day) day.has_ai_plan = true;
    });
  }

  return Array.from(dayMap.values());
}

// ── Settings ──

const DEFAULT_TICKTICK_SETTINGS: TickTickSettings = {
  pomodoro: { focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, sessionsBeforeLongBreak: 4 },
  autoCreateReviewTasks: true,
  whiteNoise: 'none',
  defaultListId: null,
};

export async function getTickTickSettings(): Promise<TickTickSettings> {
  const db = await getDatabase();
  try {
    const rows = db.exec("SELECT value FROM app_settings WHERE key = 'ticktick_settings'");
    if (rows.length && rows[0].values.length) {
      return { ...DEFAULT_TICKTICK_SETTINGS, ...JSON.parse(rows[0].values[0][0] as string) };
    }
  } catch { /* ignore parse errors */ }
  return { ...DEFAULT_TICKTICK_SETTINGS };
}

export async function saveTickTickSettings(settings: TickTickSettings): Promise<TickTickSettings> {
  const db = await getDatabase();
  db.run("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('ticktick_settings', ?)", [JSON.stringify(settings)]);
  persistDatabase();
  return settings;
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc -p tsconfig.main.json --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/main/services/ticktickService.ts
git commit -m "feat: add TickTick main process service (lists, tasks, tags, focus, bridge, calendar, settings)"
```

---

### Task 6: Bridge Sync Service

**Files:**
- Create: `src/main/services/bridgeService.ts`

- [ ] **Step 1: Create the bridge sync service**

Write `src/main/services/bridgeService.ts`:

```typescript
import { getDatabase, persistDatabase } from './databaseService';
import { getTickTickSettings, getBridgesForLinked, createTickTickTask } from './ticktickService';
import type { TickTickBridgeLinkedType } from '../../shared/types';

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Path 1: TickTick task completed → write review log to mistake book
export async function syncTaskCompletedToReview(ticktickTaskId: string, taskTitle: string, actualMinutes: number): Promise<void> {
  const db = await getDatabase();
  const bridges = await getBridgesForLinked('question', ticktickTaskId);
  // We need to look up bridges BY the task
  const bridgeRows = db.exec('SELECT * FROM ticktick_bridge WHERE ticktick_task_id = ? AND sync_review = 1', [ticktickTaskId]);
  if (!bridgeRows.length) return;

  const now = new Date().toISOString();
  const reviewDate = todayStr();

  for (const row of bridgeRows[0].values) {
    const linkedType = row[2] as string;
    const linkedId = row[3] as string;

    if (linkedType === 'question') {
      const questionId = parseInt(linkedId, 10);
      if (isNaN(questionId)) continue;

      // Add review log
      db.run(
        `INSERT INTO review_logs (question_id, review_date, result, duration_minutes, reviewed_at, note)
         VALUES (?, ?, 'correct', ?, ?, ?)`,
        [questionId, reviewDate, actualMinutes, now, `TickTick 任务完成: ${taskTitle}`]
      );

      // Update question review stats
      const q = db.exec('SELECT review_count, correct_count, consecutive_correct FROM questions WHERE id = ?', [questionId]);
      if (q.length && q[0].values.length) {
        const qRow = q[0].values[0] as any[];
        const newReviewCount = (qRow[1] as number) + 1;
        const newCorrectCount = (qRow[2] as number) + 1;
        const newConsecutive = (qRow[3] as number) + 1;
        db.run(
          'UPDATE questions SET review_count = ?, correct_count = ?, consecutive_correct = ?, last_reviewed_at = ?, updated_at = ? WHERE id = ?',
          [newReviewCount, newCorrectCount, newConsecutive, now, now, questionId]
        );
      }
    } else if (linkedType === 'study_task') {
      // Mark study task as completed
      db.run(
        "UPDATE study_tasks SET status = '已完成', actual_minutes = actual_minutes + ?, completed_at = ?, updated_at = ? WHERE id = ?",
        [actualMinutes, now, now, linkedId]
      );
    }
  }

  persistDatabase();
}

// Path 2: Review from mistake book → update TickTick task progress
export async function syncReviewToTickTickTask(linkedType: TickTickBridgeLinkedType, linkedId: string): Promise<void> {
  const bridges = await getBridgesForLinked(linkedType, linkedId);
  for (const bridge of bridges) {
    const db = await getDatabase();
    const taskRows = db.exec('SELECT * FROM ticktick_tasks WHERE id = ? AND is_completed = 0', [bridge.ticktick_task_id]);
    if (!taskRows.length || !taskRows[0].values.length) continue;
    // Update actual_minutes or mark as completed based on linked data
    // For now, just increment actual_minutes
    db.run('UPDATE ticktick_tasks SET actual_minutes = actual_minutes + 5, updated_at = ? WHERE id = ?', [new Date().toISOString(), bridge.ticktick_task_id]);
    persistDatabase();
  }
}

// Path 3: Mastery changed → adjust TickTick task priority
export async function syncMasteryToTaskPriority(knowledgeNodeId: string, newMasteryScore: number): Promise<void> {
  const bridges = await getBridgesForLinked('knowledge_point', knowledgeNodeId);
  for (const bridge of bridges) {
    if (!bridge.sync_mastery) continue;
    const db = await getDatabase();
    // Higher mastery → lower priority; lower mastery → higher priority
    const newPriority = newMasteryScore >= 4 ? '低' : newMasteryScore >= 3 ? '中' : '高';
    db.run('UPDATE ticktick_tasks SET priority = ?, updated_at = ? WHERE id = ? AND is_completed = 0',
      [newPriority, new Date().toISOString(), bridge.ticktick_task_id]);
    persistDatabase();
  }
}

// Path 4: Auto-create review tasks from mistake book due reviews
export async function generateAutoReviewTasks(): Promise<{ created: number }> {
  const settings = await getTickTickSettings();
  if (!settings.autoCreateReviewTasks) return { created: 0 };

  const db = await getDatabase();
  const today = todayStr();

  // Find questions due for review today
  const dueRows = db.exec(
    `SELECT q.id, q.title, q.subject, kp.node_id, kp.title as kp_title
     FROM questions q
     LEFT JOIN question_knowledge_points qkp ON q.id = qkp.question_id
     LEFT JOIN knowledge_points kp ON qkp.knowledge_node_id = kp.node_id
     WHERE q.next_review_at IS NOT NULL AND date(q.next_review_at) <= ?
     ORDER BY q.next_review_at ASC
     LIMIT 20`,
    [today]
  );

  if (!dueRows.length || !dueRows[0].values.length) return { created: 0 };

  // Check which questions already have an auto-review task today
  const existingRows = db.exec(
    "SELECT linked_id FROM ticktick_bridge WHERE linked_type = 'question' AND created_at >= ?",
    [today]
  );
  const existingIds = new Set(existingRows.length ? existingRows[0].values.map((r: any[]) => r[0] as string) : []);

  let created = 0;
  const defaultListId = settings.defaultListId;
  const defaultList = defaultListId || await getOrCreateDefaultList(db);

  for (const row of dueRows[0].values) {
    const questionId = String(row[0]);
    if (existingIds.has(questionId)) continue;

    const questionTitle = row[1] as string;
    const kpTitle = row[4] as string;

    const taskId = `task_${Date.now()}_${created}`;
    const now = new Date().toISOString();
    const title = kpTitle ? `复习错题: ${kpTitle}` : `复习错题: ${questionTitle}`;

    db.run(
      `INSERT INTO ticktick_tasks (id, list_id, title, due_date, priority, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, '高', 'auto_review', ?, ?)`,
      [taskId, defaultList, title, today, now, now]
    );

    db.run(
      'INSERT INTO ticktick_bridge (ticktick_task_id, linked_type, linked_id, sync_review, sync_mastery) VALUES (?, ?, ?, 1, 0)',
      [taskId, 'question', questionId]
    );

    created++;
  }

  persistDatabase();
  return { created };
}

async function getOrCreateDefaultList(db: any): Promise<string> {
  const rows = db.exec("SELECT id FROM ticktick_lists LIMIT 1");
  if (rows.length && rows[0].values.length) return rows[0].values[0][0] as string;

  const listId = 'list_default';
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO ticktick_lists (id, name, color, icon, sort_order, created_at, updated_at) VALUES (?, '收集箱', '#4a90d9', 'inbox', 0, ?, ?)",
    [listId, now, now]
  );
  return listId;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/main/services/bridgeService.ts
git commit -m "feat: add BridgeService for bidirectional TickTick-mistakeBook sync"
```

---

### Task 7: AI TickTick Service

**Files:**
- Create: `src/main/services/ticktickAiService.ts`

- [ ] **Step 1: Create AI service**

Write `src/main/services/ticktickAiService.ts`:

```typescript
import { getDeepSeekSettings } from './deepseekService';
import { getDatabase } from './databaseService';
import { getTickTickSettings } from './ticktickService';
import type {
  TickTickAiDecompositionInput, TickTickAiDecompositionResult,
  TickTickAiDailyPlanResult, TickTickAiReviewResult,
} from '../../shared/types';

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function callDeepSeek(systemPrompt: string, userMessage: string, maxTokens = 4096): Promise<string> {
  const settings = await getDeepSeekSettings();
  if (!settings.apiKey) throw new Error('请先在设置中配置 DeepSeek API Key');

  const response = await fetch(`${settings.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: maxTokens,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DeepSeek API 错误 ${response.status}: ${text}`);
  }

  const data = await response.json() as any;
  return data.choices?.[0]?.message?.content || '';
}

function extractJson(text: string): any {
  // Try raw parse first
  try { return JSON.parse(text); } catch {}

  // Try ```json fence
  const fenceMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]); } catch {}
  }

  // Balanced-brace extraction
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { start = -1; }
      }
    }
  }
  throw new Error('无法从 AI 响应中提取 JSON');
}

// ── Task Decomposition ──

export async function aiDecomposeTask(input: TickTickAiDecompositionInput): Promise<TickTickAiDecompositionResult> {
  const db = await getDatabase();
  const today = todayStr();

  // Gather weak knowledge points context
  const weakRows = db.exec(
    `SELECT kp.title, kp.category, COUNT(q.id) as question_count
     FROM knowledge_points kp
     LEFT JOIN question_knowledge_points qkp ON kp.node_id = qkp.knowledge_node_id
     LEFT JOIN questions q ON qkp.question_id = q.id
     WHERE q.mastery_level IN ('未掌握', '较弱')
     GROUP BY kp.node_id
     ORDER BY question_count DESC LIMIT 10`
  );

  let weakContext = '';
  if (weakRows.length && weakRows[0].values.length) {
    weakContext = weakRows[0].values.map((r: any[]) => `- ${r[0]} (${r[1]}, ${r[2]}道错题)`).join('\n');
  }

  const systemPrompt = `你是一个考研数学学习规划助手。根据用户的学习目标，拆解为具体的每日任务。

输出格式（严格 JSON）：
{
  "subtasks": [
    {
      "title": "具体任务描述",
      "estimated_days": 2,
      "tags": ["刷题", "复习"],
      "knowledge_points": ["知识点名称"]
    }
  ],
  "total_days": 15
}`;

  const userMessage = `学习目标：${input.goal}${input.context?.availableDays ? `\n可用天数：${input.context.availableDays} 天` : ''}
当前薄弱知识点：
${weakContext || '无数据'}
${input.context?.weakKnowledgePoints?.length ? `\n用户指定的薄弱点：${input.context.weakKnowledgePoints.join('、')}` : ''}

请拆解为具体可行的每日任务。每个任务要具体、可执行，标签用中文。`;

  const raw = await callDeepSeek(systemPrompt, userMessage, 2048);
  const json = extractJson(raw);

  return {
    subtasks: json.subtasks || [],
    total_days: json.total_days || 0,
  };
}

// ── Daily Plan Generation ──

export async function aiGenerateDailyPlan(): Promise<TickTickAiDailyPlanResult> {
  const db = await getDatabase();
  const today = todayStr();
  const settings = await getTickTickSettings();

  // Due review questions
  const reviewRows = db.exec(
    `SELECT q.id, q.title, q.subject, q.mastery_level, kp.title as kp_title
     FROM questions q LEFT JOIN question_knowledge_points qkp ON q.id = qkp.question_id
     LEFT JOIN knowledge_points kp ON qkp.knowledge_node_id = kp.node_id
     WHERE q.next_review_at IS NOT NULL AND date(q.next_review_at) <= ?
     ORDER BY q.mastery_level ASC LIMIT 15`, [today]
  );
  let reviewContext = '';
  if (reviewRows.length && reviewRows[0].values.length) {
    reviewContext = reviewRows[0].values.map((r: any[]) =>
      `- ${r[1]} (掌握度:${r[3]}, 知识点:${r[4] || '未知'})`).join('\n');
  }

  // Overdue tasks
  const overdueRows = db.exec(
    "SELECT title FROM ticktick_tasks WHERE due_date < ? AND is_completed = 0 AND parent_id IS NULL LIMIT 10", [today]
  );
  let overdueContext = '';
  if (overdueRows.length && overdueRows[0].values.length) {
    overdueContext = overdueRows[0].values.map((r: any[]) => `- ${r[0]}`).join('\n');
  }

  // Daily target
  const studyRows = db.exec("SELECT daily_target_minutes FROM study_settings LIMIT 1");
  const dailyTarget = studyRows.length && studyRows[0].values.length ? studyRows[0].values[0][0] : 120;

  const systemPrompt = `你是一个考研学习日程规划助手。根据用户的学习数据，生成今日建议任务列表。

输出格式（严格 JSON）：
{
  "suggested_tasks": [
    {
      "title": "任务描述",
      "time_block": "上午/下午/晚上",
      "priority": "高/中/低",
      "estimated_minutes": 45,
      "reason": "为什么推荐这个任务"
    }
  ],
  "summary": "今日总体建议（50字内）"
}`;

  const userMessage = `今日日期：${today}
每日学习目标：${dailyTarget} 分钟
番茄钟设置：专注${settings.pomodoro.focusMinutes}分钟/休息${settings.pomodoro.shortBreakMinutes}分钟

到期复习错题：
${reviewContext || '无到期复习'}

过期未完成任务：
${overdueContext || '无过期任务'}

请生成今日学习计划建议。优先安排薄弱知识点的复习，合理分配时间块。`;

  const raw = await callDeepSeek(systemPrompt, userMessage, 2048);
  const json = extractJson(raw);

  return {
    suggested_tasks: (json.suggested_tasks || []).map((t: any) => ({
      ...t,
      linked_type: null,
      linked_id: null,
    })),
    summary: json.summary || '今日建议已生成',
  };
}

// ── AI Review ──

export async function aiGenerateReview(type: 'daily' | 'weekly'): Promise<TickTickAiReviewResult> {
  const db = await getDatabase();
  const today = todayStr();

  // Completion rate
  const taskRows = db.exec(
    `SELECT COUNT(*) as total, SUM(CASE WHEN is_completed = 1 THEN 1 ELSE 0 END) as done
     FROM ticktick_tasks WHERE parent_id IS NULL AND due_date = ?`, [today]
  );
  const total = taskRows.length ? taskRows[0].values[0][0] as number : 0;
  const done = taskRows.length ? taskRows[0].values[0][1] as number : 0;
  const completionRate = total > 0 ? Math.round((done / total) * 100) : 0;

  // Focus minutes
  const focusRows = db.exec(
    `SELECT COALESCE(SUM(duration_minutes), 0) FROM ticktick_focus_sessions
     WHERE date(start_time) = ? AND session_type = 'focus'`, [today]
  );
  const focusMinutes = focusRows.length ? focusRows[0].values[0][0] as number : 0;

  // Review correct rate
  const reviewRows = db.exec(
    `SELECT COUNT(*) as total, SUM(CASE WHEN result = 'correct' THEN 1 ELSE 0 END) as correct
     FROM review_logs WHERE review_date = ?`, [today]
  );
  const reviewTotal = reviewRows.length ? reviewRows[0].values[0][0] as number : 0;
  const reviewCorrect = reviewRows.length ? reviewRows[0].values[0][1] as number : 0;
  const correctRate = reviewTotal > 0 ? Math.round((reviewCorrect / reviewTotal) * 100) : null;

  const systemPrompt = `你是一个考研学习复盘助手。根据用户今日/本周的学习数据，给出简短的建议。

输出格式（严格 JSON）：
{
  "completion_rate": 80,
  "total_focus_minutes": 120,
  "correct_rate": 70,
  "weak_points": ["薄弱点1", "薄弱点2"],
  "suggestion": "明天应该重点复习XXX，建议用XXX方法"
}`;

  const userMessage = `${type === 'daily' ? '今日' : '本周'}复盘数据：
- 任务完成率：${completionRate}%（${done}/${total}）
- 专注时长：${focusMinutes} 分钟
- 错题复习正确率：${correctRate !== null ? correctRate + '%' : '无数据'}
${type === 'weekly' ? '\n请根据本周整体趋势给出下周学习建议。' : '\n请给出明天简短建议。'}`;

  const raw = await callDeepSeek(systemPrompt, userMessage, 1024);
  const json = extractJson(raw);

  return {
    completion_rate: json.completion_rate ?? completionRate,
    total_focus_minutes: json.total_focus_minutes ?? focusMinutes,
    correct_rate: json.correct_rate ?? correctRate ?? 0,
    weak_points: json.weak_points || [],
    suggestion: json.suggestion || '继续加油！',
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/main/services/ticktickAiService.ts
git commit -m "feat: add TickTick AI service (decomposition, daily plan, review)"
```

---

### Task 8: IPC Registration

**Files:**
- Modify: `src/main/ipc/registerIpc.ts` — add TickTick handler registrations

- [ ] **Step 1: Add imports for TickTick services**

Add at top of registerIpc.ts, after existing imports:

```typescript
import {
  listTickTickLists, getTickTickList, createTickTickList, updateTickTickList, deleteTickTickList, reorderTickTickLists,
  listTickTickTasks, getTickTickTask, createTickTickTask, updateTickTickTask, deleteTickTickTask,
  completeTickTickTask, uncompleteTickTickTask, getTodayTickTickTasks,
  listTickTickTags,
  listTickTickFocusSessions, createTickTickFocusSession,
  getTickTickTaskBridges, createTickTickBridge, deleteTickTickBridge, getBridgesForLinked,
  getTickTickCalendarMonth,
  getTickTickSettings, saveTickTickSettings,
} from '../services/ticktickService';
import { syncTaskCompletedToReview, generateAutoReviewTasks } from '../services/bridgeService';
import { aiDecomposeTask, aiGenerateDailyPlan, aiGenerateReview } from '../services/ticktickAiService';
```

- [ ] **Step 2: Add TickTick handler registrations**

Inside the `registerIpc()` function body, before the closing `}`, add:

```typescript
  // TickTick Lists
  handle('ticktick:lists:list', () => listTickTickLists());
  handle('ticktick:lists:get', (id: string) => getTickTickList(id));
  handle('ticktick:lists:create', (input: any) => createTickTickList(input));
  handle('ticktick:lists:update', (id: string, input: any) => updateTickTickList(id, input));
  handle('ticktick:lists:delete', (id: string) => deleteTickTickList(id));
  handle('ticktick:lists:reorder', (ids: string[]) => reorderTickTickLists(ids));

  // TickTick Tasks
  handle('ticktick:tasks:list', (filters?: any) => listTickTickTasks(filters));
  handle('ticktick:tasks:get', (id: string) => getTickTickTask(id));
  handle('ticktick:tasks:create', (input: any) => createTickTickTask(input));
  handle('ticktick:tasks:update', (id: string, input: any) => updateTickTickTask(id, input));
  handle('ticktick:tasks:delete', (id: string) => deleteTickTickTask(id));
  handle('ticktick:tasks:complete', (id: string) => completeTickTickTask(id));
  handle('ticktick:tasks:uncomplete', (id: string) => uncompleteTickTickTask(id));
  handle('ticktick:tasks:today', () => getTodayTickTickTasks());

  // TickTick Tags
  handle('ticktick:tags:list', () => listTickTickTags());

  // TickTick Focus
  handle('ticktick:focus:list', (filters?: any) => listTickTickFocusSessions(filters));
  handle('ticktick:focus:create', (input: any) => createTickTickFocusSession(input));

  // TickTick Bridge
  handle('ticktick:bridge:list', (taskId: string) => getTickTickTaskBridges(taskId));
  handle('ticktick:bridge:create', (input: any) => createTickTickBridge(input));
  handle('ticktick:bridge:delete', (id: number) => deleteTickTickBridge(id));
  handle('ticktick:bridge:linked', (linkedType: any, linkedId: string) => getBridgesForLinked(linkedType, linkedId));

  // TickTick Calendar
  handle('ticktick:calendar:month', (year: number, month: number) => getTickTickCalendarMonth(year, month));

  // TickTick AI
  handle('ticktick:ai:decompose', (input: any) => aiDecomposeTask(input));
  handle('ticktick:ai:dailyPlan', () => aiGenerateDailyPlan());
  handle('ticktick:ai:review', (type: 'daily' | 'weekly') => aiGenerateReview(type));

  // TickTick Settings
  handle('ticktick:settings:get', () => getTickTickSettings());
  handle('ticktick:settings:save', (settings: any) => saveTickTickSettings(settings));

  // TickTick Sync
  handle('ticktick:sync:reviewTask', (taskId: string, taskTitle: string, actualMinutes: number) => syncTaskCompletedToReview(taskId, taskTitle, actualMinutes));
  handle('ticktick:sync:generateReviewTasks', () => generateAutoReviewTasks());

  // White noise state (stored in app_settings)
  handle('ticktick:whiteNoise:get', async () => {
    const db = await (await import('../services/databaseService')).getDatabase();
    try {
      const rows = db.exec("SELECT value FROM app_settings WHERE key = 'ticktick_white_noise'");
      if (rows.length && rows[0].values.length) return JSON.parse(rows[0].values[0][0] as string);
    } catch {}
    return { enabled: false, noise: 'none' };
  });
  handle('ticktick:whiteNoise:set', async (state: any) => {
    const db = await (await import('../services/databaseService')).getDatabase();
    db.run("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('ticktick_white_noise', ?)", [JSON.stringify(state)]);
    (await import('../services/databaseService')).persistDatabase();
  });
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc -p tsconfig.main.json --noEmit`
Expected: No errors. Fix any import issues.

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/registerIpc.ts
git commit -m "feat: register all TickTick IPC handlers"
```

---

### Task 9: Preload Bridge

**Files:**
- Modify: `src/preload/preload.ts` — add TickTick API implementations

- [ ] **Step 1: Add TickTick methods to the preload api object**

After existing `AppApi` method implementations in `preload.ts`, add all TickTick methods. Each maps to its IPC channel:

```typescript
  // TickTick Lists
  listTickTickLists: () => invoke('ticktick:lists:list'),
  getTickTickList: (id) => invoke('ticktick:lists:get', id),
  createTickTickList: (input) => invoke('ticktick:lists:create', input),
  updateTickTickList: (id, input) => invoke('ticktick:lists:update', id, input),
  deleteTickTickList: (id) => invoke('ticktick:lists:delete', id),
  reorderTickTickLists: (ids) => invoke('ticktick:lists:reorder', ids),

  // TickTick Tasks
  listTickTickTasks: (filters?) => invoke('ticktick:tasks:list', filters),
  getTickTickTask: (id) => invoke('ticktick:tasks:get', id),
  createTickTickTask: (input) => invoke('ticktick:tasks:create', input),
  updateTickTickTask: (id, input) => invoke('ticktick:tasks:update', id, input),
  deleteTickTickTask: (id) => invoke('ticktick:tasks:delete', id),
  completeTickTickTask: (id) => invoke('ticktick:tasks:complete', id),
  uncompleteTickTickTask: (id) => invoke('ticktick:tasks:uncomplete', id),
  getTodayTickTickTasks: () => invoke('ticktick:tasks:today'),

  // TickTick Tags
  listTickTickTags: () => invoke('ticktick:tags:list'),

  // TickTick Focus
  listTickTickFocusSessions: (filters?) => invoke('ticktick:focus:list', filters),
  createTickTickFocusSession: (input) => invoke('ticktick:focus:create', input),

  // TickTick Bridge
  getTickTickTaskBridges: (taskId) => invoke('ticktick:bridge:list', taskId),
  createTickTickBridge: (input) => invoke('ticktick:bridge:create', input),
  deleteTickTickBridge: (id) => invoke('ticktick:bridge:delete', id),
  getBridgesForLinked: (linkedType, linkedId) => invoke('ticktick:bridge:linked', linkedType, linkedId),

  // TickTick Calendar
  getTickTickCalendarMonth: (year, month) => invoke('ticktick:calendar:month', year, month),

  // TickTick AI
  aiDecomposeTask: (input) => invoke('ticktick:ai:decompose', input),
  aiGenerateDailyPlan: () => invoke('ticktick:ai:dailyPlan'),
  aiGenerateReview: (type) => invoke('ticktick:ai:review', type),

  // TickTick Settings
  getTickTickSettings: () => invoke('ticktick:settings:get'),
  saveTickTickSettings: (settings) => invoke('ticktick:settings:save', settings),

  // White Noise
  getTickTickWhiteNoiseState: () => invoke('ticktick:whiteNoise:get'),
  setTickTickWhiteNoiseState: (state) => invoke('ticktick:whiteNoise:set', state),

  // Sync
  triggerReviewTaskGeneration: () => invoke('ticktick:sync:generateReviewTasks'),
```

- [ ] **Step 2: Commit**

```bash
git add src/preload/preload.ts
git commit -m "feat: add TickTick IPC methods to preload bridge"
```

---

### Task 10: CSS Dual Theme System

**Files:**
- Modify: `src/renderer/styles/global.css` — add CSS custom properties for dual theme
- Create: `src/renderer/styles/ticktick.css`

- [ ] **Step 1: Add TickTick CSS file**

Create `src/renderer/styles/ticktick.css` with TickTick-style design system and page styles. This is a large file — write it all at once:

```css
/* ═══════════════════════════════════════════════════════
   TickTick Design System
   ═══════════════════════════════════════════════════════ */

/* ── Theme Variables (light = TickTick default, dark = matches existing) ── */
:root {
  --tt-bg: #ffffff;
  --tt-bg-sidebar: #fafafa;
  --tt-bg-hover: #f5f5f5;
  --tt-bg-input: #f5f5f5;
  --tt-bg-active: #fff0e8;
  --tt-text: #333333;
  --tt-text-secondary: #999999;
  --tt-text-muted: #bbbbbb;
  --tt-border: #eeeeee;
  --tt-border-light: #f0f0f0;
  --tt-accent: #ff6b35;
  --tt-accent-soft: #fff0e8;
  --tt-danger: #e53935;
  --tt-success: #4caf50;
  --tt-warning: #ff9800;
  --tt-radius-sm: 6px;
  --tt-radius-md: 8px;
  --tt-radius-lg: 12px;
  --tt-shadow: 0 1px 3px rgba(0,0,0,0.06);
}

.dark {
  --tt-bg: #0d1117;
  --tt-bg-sidebar: #161b22;
  --tt-bg-hover: #21262d;
  --tt-bg-input: #21262d;
  --tt-bg-active: #2d1f14;
  --tt-text: #c9d1d9;
  --tt-text-secondary: #8b949e;
  --tt-text-muted: #484f58;
  --tt-border: #30363d;
  --tt-border-light: #21262d;
}

/* ── TickTick Mode Shell ── */
.ticktick-app-shell {
  display: flex;
  height: 100%;
  background: var(--tt-bg);
  color: var(--tt-text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.ticktick-sidebar {
  width: 240px;
  min-width: 240px;
  background: var(--tt-bg-sidebar);
  border-right: 1px solid var(--tt-border);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}
.ticktick-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ticktick-main-header {
  padding: 14px 24px;
  border-bottom: 1px solid var(--tt-border-light);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.ticktick-main-header h1 {
  font-size: 20px;
  font-weight: 700;
  margin: 0;
}
.ticktick-main-content {
  flex: 1;
  overflow-y: auto;
  padding: 8px 24px;
}

/* ── Sidebar ── */
.tt-sidebar-section {
  padding: 6px 16px;
}
.tt-sidebar-label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--tt-text-muted);
  padding: 10px 4px 4px;
}
.tt-sidebar-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: var(--tt-radius-sm);
  font-size: 13px;
  color: var(--tt-text);
  cursor: pointer;
  transition: background 0.15s;
  border: none;
  background: none;
  width: 100%;
  text-align: left;
}
.tt-sidebar-item:hover { background: var(--tt-bg-hover); }
.tt-sidebar-item.active {
  background: var(--tt-bg-active);
  color: var(--tt-accent);
  font-weight: 600;
}
.tt-sidebar-item .badge {
  margin-left: auto;
  background: var(--tt-accent);
  color: #fff;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 10px;
  font-weight: 600;
}
.tt-sidebar-item.active .badge { background: var(--tt-accent); }
.tt-sidebar-item .dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
}
.tt-sidebar-item .count {
  margin-left: auto;
  font-size: 11px;
  color: var(--tt-text-secondary);
}

/* ── Quick Add Bar ── */
.tt-quick-add {
  padding: 10px 0;
  border-bottom: 1px solid var(--tt-border-light);
  flex-shrink: 0;
}
.tt-quick-add-inner {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--tt-bg-input);
  border: 1px solid transparent;
  border-radius: var(--tt-radius-md);
  padding: 8px 14px;
  transition: border-color 0.2s;
}
.tt-quick-add-inner:focus-within {
  border-color: var(--tt-accent);
}
.tt-quick-add-inner .plus {
  color: var(--tt-accent);
  font-size: 20px;
  font-weight: 300;
  line-height: 1;
}
.tt-quick-add-inner input {
  flex: 1;
  border: none;
  background: transparent;
  font-size: 13px;
  color: var(--tt-text);
  outline: none;
}
.tt-quick-add-inner input::placeholder {
  color: var(--tt-text-muted);
}
.tt-quick-add-inner .icon-btn {
  color: var(--tt-text-muted);
  font-size: 14px;
  cursor: pointer;
  background: none;
  border: none;
  padding: 2px;
}
.tt-quick-add-inner .icon-btn:hover { color: var(--tt-text-secondary); }
.tt-quick-add-hint {
  font-size: 10px;
  color: var(--tt-text-muted);
  margin-top: 4px;
  padding-left: 2px;
}

/* ── Task Groups ── */
.tt-task-group {
  margin-bottom: 12px;
}
.tt-task-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 0;
  cursor: pointer;
  border: none;
  background: none;
  width: 100%;
  font-size: 12px;
  color: var(--tt-text-secondary);
}
.tt-task-group-header .chevron {
  font-size: 10px;
  transition: transform 0.2s;
  color: var(--tt-text-muted);
}
.tt-task-group-header.collapsed .chevron { transform: rotate(-90deg); }
.tt-task-group-header .label {
  font-weight: 600;
  font-size: 12px;
}
.tt-task-group-header .label.overdue { color: var(--tt-danger); }
.tt-task-group-header .label.today { color: var(--tt-text); }
.tt-task-group-header .label.upcoming { color: var(--tt-success); }
.tt-task-group-header .count { color: var(--tt-text-muted); font-size: 11px; }

/* ── Task Row ── */
.tt-task-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--tt-radius-md);
  margin: 2px 0;
  cursor: pointer;
  transition: background 0.15s;
  position: relative;
}
.tt-task-row:hover { background: var(--tt-bg-hover); }
.tt-task-row.completed { opacity: 0.5; }
.tt-task-row .checkbox-circle {
  width: 18px; height: 18px;
  border: 2px solid var(--tt-border);
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 1px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.2s, background 0.2s;
}
.tt-task-row .checkbox-circle:hover { border-color: var(--tt-accent); }
.tt-task-row .checkbox-circle.checked {
  background: var(--tt-accent);
  border-color: var(--tt-accent);
}
.tt-task-row .checkbox-circle.checked::after {
  content: '✓';
  color: #fff;
  font-size: 10px;
  font-weight: 700;
}
.tt-task-row .task-body { flex: 1; min-width: 0; }
.tt-task-row .task-title {
  font-size: 13px;
  line-height: 1.4;
  color: var(--tt-text);
}
.tt-task-row.completed .task-title {
  text-decoration: line-through;
  color: var(--tt-text-muted);
}
.tt-task-row .task-meta {
  font-size: 11px;
  color: var(--tt-text-secondary);
  margin-top: 2px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.tt-task-row .task-meta .list-dot {
  width: 6px; height: 6px; border-radius: 50%;
}
.tt-task-row .task-meta .bridge-link {
  color: var(--tt-accent);
}
.tt-task-row .task-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  font-size: 11px;
  color: var(--tt-text-secondary);
}
.tt-task-row .task-right .priority-dot {
  width: 6px; height: 6px; border-radius: 50%;
}
.tt-task-row .task-right .priority-dot.high { background: var(--tt-danger); }
.tt-task-row .task-right .priority-dot.medium { background: var(--tt-warning); }
.tt-task-row .task-right .pomodoro-icon { color: var(--tt-accent); font-size: 13px; }

/* ── Task Detail Panel ── */
.tt-detail-panel {
  width: 340px;
  min-width: 340px;
  background: var(--tt-bg-sidebar);
  border-left: 1px solid var(--tt-border);
  padding: 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
  animation: slideInRight 0.2s ease;
}
@keyframes slideInRight {
  from { transform: translateX(20px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}
.tt-detail-panel h3 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}
.tt-detail-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.tt-detail-field label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--tt-text-muted);
}
.tt-detail-field input,
.tt-detail-field textarea,
.tt-detail-field select {
  background: var(--tt-bg);
  border: 1px solid var(--tt-border);
  border-radius: var(--tt-radius-sm);
  padding: 8px 10px;
  font-size: 13px;
  color: var(--tt-text);
  font-family: inherit;
  outline: none;
}
.tt-detail-field input:focus,
.tt-detail-field textarea:focus,
.tt-detail-field select:focus {
  border-color: var(--tt-accent);
}
.tt-detail-subtask {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  font-size: 13px;
}
.tt-detail-subtask .subtask-checkbox {
  width: 16px; height: 16px;
  border: 2px solid var(--tt-border);
  border-radius: 50%;
  cursor: pointer;
}
.tt-detail-subtask .subtask-checkbox.done {
  background: var(--tt-accent);
  border-color: var(--tt-accent);
}
.tt-detail-subtask .subtask-title {
  flex: 1;
  color: var(--tt-text);
}
.tt-detail-subtask.done .subtask-title {
  text-decoration: line-through;
  color: var(--tt-text-muted);
}

/* ── Calendar ── */
.tt-calendar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.tt-calendar-nav {
  display: flex;
  align-items: center;
  gap: 12px;
}
.tt-calendar-nav button {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--tt-text-secondary);
  font-size: 16px;
  padding: 4px;
}
.tt-calendar-nav button:hover { color: var(--tt-text); }
.tt-calendar-nav .month-label {
  font-size: 15px;
  font-weight: 600;
}
.tt-calendar-view-toggle {
  display: flex;
  background: var(--tt-bg-input);
  border-radius: var(--tt-radius-sm);
  padding: 2px;
  gap: 2px;
}
.tt-calendar-view-toggle button {
  border: none;
  background: none;
  padding: 4px 12px;
  font-size: 11px;
  cursor: pointer;
  border-radius: 4px;
  color: var(--tt-text-secondary);
}
.tt-calendar-view-toggle button.active {
  background: var(--tt-accent);
  color: #fff;
  font-weight: 600;
}
.tt-month-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 1px;
  background: var(--tt-border);
  border-radius: var(--tt-radius-md);
  overflow: hidden;
}
.tt-month-grid .day-header {
  background: var(--tt-bg);
  padding: 8px 6px;
  text-align: center;
  font-size: 11px;
  color: var(--tt-text-muted);
  font-weight: 600;
}
.tt-month-grid .day-cell {
  background: var(--tt-bg);
  min-height: 80px;
  padding: 6px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}
.tt-month-grid .day-cell:hover { background: var(--tt-bg-hover); }
.tt-month-grid .day-cell.today {
  border: 1px solid var(--tt-accent);
  border-radius: 3px;
}
.tt-month-grid .day-cell .day-num {
  font-weight: 600;
  margin-bottom: 2px;
  display: inline-block;
}
.tt-month-grid .day-cell.today .day-num {
  background: var(--tt-accent);
  color: #fff;
  width: 22px; height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
}
.tt-month-grid .day-cell .day-badge {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 3px;
  margin-top: 2px;
  display: block;
  line-height: 1.4;
}
.tt-month-grid .day-cell .day-badge.tasks { background: #e3f2fd; color: #1565c0; }
.tt-month-grid .day-cell .day-badge.reviews { background: #fce4ec; color: #c62828; }
.tt-month-grid .day-cell .day-badge.pomo { background: #e8f5e9; color: #2e7d32; }

.dark .tt-month-grid .day-cell .day-badge.tasks { background: #1a3a5c; color: #64b5f6; }
.dark .tt-month-grid .day-cell .day-badge.reviews { background: #3e1a1a; color: #ef5350; }
.dark .tt-month-grid .day-cell .day-badge.pomo { background: #1a3a2a; color: #81c784; }

/* ── Ring Timer ── */
.tt-timer-page {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 40px 24px;
  gap: 24px;
}
.tt-ring-timer {
  position: relative;
  width: 220px;
  height: 220px;
}
.tt-ring-timer svg { transform: rotate(-90deg); }
.tt-ring-timer .bg-ring { fill: none; stroke: var(--tt-border); stroke-width: 8; }
.tt-ring-timer .fg-ring {
  fill: none; stroke-width: 8; stroke-linecap: round;
  transition: stroke-dashoffset 0.3s linear;
}
.tt-ring-timer .fg-ring.focus { stroke: var(--tt-accent); }
.tt-ring-timer .fg-ring.break { stroke: var(--tt-success); }
.tt-ring-timer .fg-ring.paused { stroke: var(--tt-text-muted); }
.tt-ring-timer .timer-text {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.tt-ring-timer .time-display {
  font-size: 36px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: 2px;
}
.tt-ring-timer .session-label {
  font-size: 12px;
  color: var(--tt-text-secondary);
  margin-top: 4px;
}
.tt-timer-controls {
  display: flex;
  gap: 12px;
  align-items: center;
}
.tt-timer-controls button {
  padding: 10px 24px;
  border-radius: 24px;
  border: none;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s;
}
.tt-timer-controls .btn-start { background: var(--tt-accent); color: #fff; }
.tt-timer-controls .btn-start:hover { opacity: 0.9; }
.tt-timer-controls .btn-pause { background: var(--tt-bg-input); color: var(--tt-text); }
.tt-timer-controls .btn-pause:hover { background: var(--tt-bg-hover); }
.tt-timer-controls .btn-skip { background: none; color: var(--tt-text-secondary); font-weight: 400; }
.tt-timer-pomodoro-dots {
  display: flex;
  gap: 6px;
}
.tt-timer-pomodoro-dots .dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--tt-border);
}
.tt-timer-pomodoro-dots .dot.done { background: var(--tt-accent); }

/* ── White Noise Picker ── */
.tt-noise-picker {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: center;
}
.tt-noise-picker button {
  padding: 6px 14px;
  border-radius: 16px;
  border: 1px solid var(--tt-border);
  background: var(--tt-bg);
  font-size: 12px;
  cursor: pointer;
  color: var(--tt-text-secondary);
}
.tt-noise-picker button.active {
  background: var(--tt-accent-soft);
  border-color: var(--tt-accent);
  color: var(--tt-accent);
}

/* ── AI Panel ── */
.tt-ai-panel {
  background: var(--tt-bg);
  border: 1px solid var(--tt-border);
  border-radius: var(--tt-radius-lg);
  padding: 20px;
  margin: 16px 0;
}
.tt-ai-panel h3 { font-size: 15px; font-weight: 600; margin: 0 0 12px; }
.tt-ai-plan-tasks {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 12px 0;
}
.tt-ai-plan-task {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--tt-bg-hover);
  border-radius: var(--tt-radius-sm);
  font-size: 13px;
}
.tt-ai-plan-task .time-block {
  font-size: 10px;
  color: var(--tt-text-muted);
  background: var(--tt-bg-input);
  padding: 2px 8px;
  border-radius: 4px;
}

/* ── Empty State ── */
.tt-empty {
  text-align: center;
  padding: 40px 20px;
  color: var(--tt-text-muted);
  font-size: 13px;
}
```

- [ ] **Step 2: Import TickTick CSS in App.tsx**

Add to the existing style imports in `src/renderer/App.tsx`:

```typescript
import './styles/ticktick.css';
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/styles/ticktick.css src/renderer/App.tsx
git commit -m "feat: add TickTick CSS design system and import in App"
```

---

### Task 11: Shell Mode Toggle

**Files:**
- Modify: `src/renderer/components/Shell.tsx` — add mode toggle

- [ ] **Step 1: Update Shell to support mode toggle**

Update `Shell.tsx` to add a mode toggle between "错题本" and "TickTick" modes. The existing Shell gets a new `mode` prop. When `mode='ticktick'`, render `TickTickShell` instead of the default sidebar+main. The focus timer mini bar stays visible in both modes.

Add to Shell props:

```typescript
interface ShellProps {
  page: PageKey;
  onNavigate: (page: PageKey) => void;
  children: ReactNode;
  focusTimer?: FocusTimerState;
  focusTimerControls?: FocusTimerControls;
  mode?: 'mistake' | 'ticktick';
  onModeChange?: (mode: 'mistake' | 'ticktick') => void;
}
```

Add mode toggle markup before the brand section or right after it:

```tsx
{mode && onModeChange ? (
  <div className="mode-toggle">
    <button
      className={`mode-toggle-btn ${mode === 'mistake' ? 'active' : ''}`}
      onClick={() => onModeChange('mistake')}
      type="button"
    >
      <BookOpen size={14} /> 错题本
    </button>
    <button
      className={`mode-toggle-btn ${mode === 'ticktick' ? 'active' : ''}`}
      onClick={() => onModeChange('ticktick')}
      type="button"
    >
      <CheckSquare size={14} /> TickTick
    </button>
  </div>
) : null}
```

Add mode toggle CSS to `ticktick.css`:

```css
.mode-toggle {
  display: flex;
  gap: 2px;
  padding: 8px 12px;
  background: var(--tt-bg-input);
  border-radius: var(--tt-radius-md);
  margin: 0 12px 8px;
}
.mode-toggle-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 6px 8px;
  border: none;
  background: none;
  border-radius: var(--tt-radius-sm);
  font-size: 12px;
  cursor: pointer;
  color: var(--tt-text-secondary);
  transition: background 0.15s, color 0.15s;
}
.mode-toggle-btn.active {
  background: var(--tt-accent);
  color: #fff;
  font-weight: 600;
}
```

- [ ] **Step 2: When mode is 'ticktick', render TickTickShell instead of sidebar+main**

Inside Shell, conditionally render:

```tsx
if (mode === 'ticktick') {
  return (
    <div className="app-shell">
      {/* Optional: keep the brand area narrow or embed the toggle */}
      <TickTickShell
        page={page}
        onNavigate={onNavigate}
        focusTimer={focusTimer}
        focusTimerControls={focusTimerControls}
        onModeChange={onModeChange}
      />
      {showTimer ? (/* mini bar */) : null}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/Shell.tsx
git commit -m "feat: add mode toggle to Shell for mistake-book/TickTick switching"
```

---

### Tasks 12-20: Renderer Pages and Components

Due to the large scope, the remaining UI tasks are grouped. Each page follows the same React pattern established in the codebase.

**Note for implementation:** All pages use hooks (`useState`, `useEffect`), call `window.api.*` methods, and follow the existing page component structure. The remaining tasks are to create each page/component file with complete implementation.

---

### Task 12: TickTickShell + TickTickSidebar

**Files:**
- Create: `src/renderer/pages/ticktick/TickTickShell.tsx`
- Create: `src/renderer/pages/ticktick/TickTickSidebar.tsx`

TickTickShell renders the TickTick-mode layout: sidebar + main area. Props include current page, navigation handler, mode change handler. Renders `TickTickSidebar` on the left and the active page component on the right.

TickTickSidebar renders the TickTick-style navigation tree: smart lists (今天/日历/收集箱), user's lists from `listTickTickLists()`, tags from `listTickTickTags()`, and other sections (看板/艾森豪威尔/习惯 in Phase 2, 专注计时, 设置). Lists load from the database and display count badges.

---

### Task 13: QuickAddBar Component

**Files:**
- Create: `src/renderer/components/TickTick/QuickAddBar.tsx`

A controlled input component that: (1) accepts raw text, (2) calls `parseTaskInput()` from the NLP parser on Enter, (3) creates the task via `window.api.createTickTickTask(input)`, (4) handles list selection and date picker dropdowns via the icon buttons. Shows a hint below the input ("NLP: 明天→日期 / #标签→标签 / @清单→指定清单 / !!高→高优先级").

---

### Task 14: TaskRow + TaskDetailPanel Components

**Files:**
- Create: `src/renderer/components/TickTick/TaskRow.tsx`
- Create: `src/renderer/components/TickTick/TaskDetailPanel.tsx`

TaskRow renders a single task with: checkbox circle (toggles completion), title, metadata row (list dot + list name, due date, bridge link count, subtask progress, tags), right side (due time, pomodoro icon, priority indicator). Click opens TaskDetailPanel. Drag handle on hover.

TaskDetailPanel is a right-side slide-in panel for editing task details: title input, note textarea, date picker, time input, priority select, list select, tags editor, subtask list (CRUD), bridge links section (link to mistake book questions/knowledge points). Changes auto-save on blur or debounced.

---

### Task 15: TodayPage

**Files:**
- Create: `src/renderer/pages/ticktick/TodayPage.tsx`

The main TickTick landing page. Structure:
1. Header: "今天" + date + completed count
2. QuickAddBar
3. Task list grouped into sections: Overdue, Today, Upcoming
4. Each section is collapsible, each task is a TaskRow
5. Click task opens TaskDetailPanel as a right-side panel (or modal)
6. Loads data via `window.api.getTodayTickTickTasks()`
7. Handles task completion (checkbox) and inline editing

---

### Task 16: CalendarPage

**Files:**
- Create: `src/renderer/pages/ticktick/CalendarPage.tsx`

Month/week/day calendar view with:
1. Header: month/year label + nav arrows + "Today" button + view toggle (月/周/日)
2. Month grid (7-column CSS Grid) showing days with task counts, review counts, pomodoro counts
3. Click a day to see its tasks in a popover or side panel
4. Drag tasks from sidebar onto calendar days (Phase 1 uses click-to-assign, drag is nice-to-have)
5. Review due dates from mistake book shown as red badges
6. Loads data via `window.api.getTickTickCalendarMonth(year, month)`

---

### Task 17: ListDetailPage

**Files:**
- Create: `src/renderer/pages/ticktick/ListDetailPage.tsx`

A page showing all tasks in a specific list. Structure:
1. Header: list name + color dot + task count + sort options
2. QuickAddBar (pre-filled with list context)
3. Task list (similar to Today but filtered to this list, all dates)
4. List settings (rename, change color, delete)

---

### Task 18: Focus Timer Page (Rewrite)

**Files:**
- Create: `src/renderer/pages/ticktick/FocusTimerPage.tsx`
- Create: `src/renderer/components/TickTick/RingTimer.tsx`
- Create: `src/renderer/components/TickTick/WhiteNoisePicker.tsx`

Complete rewrite of the focus timer to match TickTick's Pomodoro design:

RingTimer: SVG circle progress ring with countdown. Props: `totalSeconds`, `remainingSeconds`, `status` (focus/break/paused). Computes stroke-dashoffset for the ring animation. Shows time in MM:SS format centered inside the ring. Color changes: focus=#ff6b35, break=#4caf50, paused=#999.

WhiteNoisePicker: A row of buttons for selecting ambient sound (雨声/溪流/咖啡馆/白噪音/森林/无). Uses Web Audio API to generate white/pink noise and modulated variants. Active state highlighted.

FocusTimerPage: The full page with:
1. RingTimer component
2. Pomodoro session dots (track completed sessions)
3. Start/Pause/Skip controls
4. Bound task display (shows linked TickTick task or mistake book review)
5. WhiteNoisePicker
6. Session log below (today's completed pomodoros)
7. On session end: settlement panel to save to ticktick_focus_sessions and optionally sync to mistake book review
8. Settings: configure focus/break durations, long break interval

---

### Task 19: AI Components

**Files:**
- Create: `src/renderer/components/TickTick/AiPlanPanel.tsx`
- Create: `src/renderer/components/TickTick/AiDecompositionPanel.tsx`
- Create: `src/renderer/components/TickTick/AiReviewPanel.tsx`

AiDecompositionPanel: Text input + "拆解" button → loading state → list of suggested subtasks with checkboxes → "批量创建" button.

AiPlanPanel: "生成今日计划" button → loading state → list of time-blocked suggested tasks → user can toggle each → "添加到今天" to create them.

AiReviewPanel: "今日复盘" / "本周复盘" buttons → loading state → shows completion rate, focus time, suggestion text.

All panels share the same pattern: trigger action → loading skeleton → show results → user confirm → create data. Reuse the existing Toast for errors.

---

### Task 20: TickTick Settings Page

**Files:**
- Create: `src/renderer/pages/ticktick/TickTickSettingsPage.tsx`

Settings page for TickTick configuration:
1. Pomodoro settings: focus minutes, short break, long break, sessions before long break (number inputs)
2. Auto-create review tasks toggle
3. Default white noise selection
4. Default list selection
5. Save button → `window.api.saveTickTickSettings()`

---

### Task 21: App.tsx Integration

**Files:**
- Modify: `src/renderer/App.tsx` — add mode state, TickTick pages, mode toggling

- [ ] **Step 1: Add mode state and TickTick page routing**

Add to App.tsx:

```typescript
import { TickTickShell } from './pages/ticktick/TickTickShell';
import { TodayPage } from './pages/ticktick/TodayPage';
import { CalendarPage } from './pages/ticktick/CalendarPage';
import { ListDetailPage } from './pages/ticktick/ListDetailPage';
import { TickTickSettingsPage } from './pages/ticktick/TickTickSettingsPage';
import { FocusTimerPage as TickTickFocusTimerPage } from './pages/ticktick/FocusTimerPage';

// Add mode state
const [mode, setMode] = useState<'mistake' | 'ticktick'>('mistake');

// Add TickTick page key
type TickTickPageKey = 'today' | 'calendar' | 'inbox' | 'list' | 'focus' | 'settings';
const [ticktickPage, setTicktickPage] = useState<TickTickPageKey>('today');
```

Update the Shell render to pass mode:

```tsx
<Shell
  page={page}
  onNavigate={navigate}
  focusTimer={focusTimer}
  focusTimerControls={focusTimerControls}
  mode={mode}
  onModeChange={(newMode) => {
    setMode(newMode);
    if (newMode === 'ticktick') setTicktickPage('today');
  }}
>
```

When `mode === 'ticktick'`, Shell renders TickTickShell which internally routes to the correct page.

Alternatively, render TickTick content conditionally at the App level:

```tsx
{mode === 'ticktick' ? (
  <div className="app-shell">
    <div className="ticktick-app-shell">
      <TickTickSidebar page={ticktickPage} onNavigate={setTicktickPage} lists={lists} tags={tags} onModeChange={setMode} />
      <div className="ticktick-main">
        {ticktickPage === 'today' && <TodayPage onNavigate={setTicktickPage} />}
        {ticktickPage === 'calendar' && <CalendarPage />}
        {ticktickPage === 'list' && <ListDetailPage />}
        {ticktickPage === 'focus' && <TickTickFocusTimerPage />}
        {ticktickPage === 'settings' && <TickTickSettingsPage />}
      </div>
    </div>
    {showTimer ? (/* focus mini bar */) : null}
  </div>
) : (
  <Shell page={page} onNavigate={navigate} focusTimer={focusTimer} focusTimerControls={focusTimerControls}>
    {/* existing page renders */}
  </Shell>
)}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat: integrate TickTick mode with page routing in App"
```

---

### Task 22: Final Integration — Hooking Up the Bridge

**Files:**
- Modify: `src/renderer/App.tsx` — call `triggerReviewTaskGeneration()` on startup

- [ ] **Step 1: Trigger review task generation on app startup**

Add to the startup logic in App.tsx:

```typescript
useEffect(() => {
  window.api.triggerReviewTaskGeneration().catch(() => {});
}, []);
```

- [ ] **Step 2: Wire task completion to sync**

In TodayPage, when a task is completed:
1. Call `window.api.completeTickTickTask(taskId)`
2. If the task has bridge links with `sync_review=1`, call `window.api.createStudySession(...)` to record the time and update review logs

This logic lives in TodayPage's `handleComplete` function.

- [ ] **Step 3: Wire focus timer completion to sync**

In FocusTimerPage, when a session ends:
1. Call `window.api.createTickTickFocusSession(input)`
2. Update the task's actual_minutes and pomodoro_sessions
3. If task has bridge link, call the sync handler

- [ ] **Step 4: Commit**

```bash
git add src/renderer/App.tsx src/renderer/pages/ticktick/TodayPage.tsx src/renderer/pages/ticktick/FocusTimerPage.tsx
git commit -m "feat: wire up TickTick sync bridge on task complete and focus session end"
```

---

### Task 23: Final Verification

- [ ] **Step 1: TypeScript compilation check**

```bash
npx tsc --noEmit
npx tsc -p tsconfig.main.json --noEmit
```
Expected: No errors.

- [ ] **Step 2: App launch test**

```bash
npm run dev
```
Expected: App launches. Mode toggle visible. Switching to TickTick mode shows the sidebar and TodayPage. Creating a task works. Calendar loads. Focus timer starts and saves.

- [ ] **Step 3: Database verification**

Open the app, switch to TickTick mode, create a list and a task. Close and reopen. Verify data persists.

- [ ] **Step 4: Commit any remaining changes**

---

## Phase 2 (Future)

Not implemented now — documented for reference:
- KanbanPage (drag-and-drop board view)
- EisenhowerPage (2x2 priority matrix)
- HabitsPage + habit tracking service

# Study Supervisor Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add service-layer regression tests for the study-supervisor supervision loop: task completion, task skipping, overdue rollover, and daily review aggregation.

**Architecture:** Reuse the existing `node:test` main-process harness, build minimal study-supervisor fixture rows directly in test code, and exercise the service methods that mutate supervision state. Focus assertions on status transitions and core side effects in `study_tasks`, `study_sessions`, `daily_reviews`, and `study_settings`.

**Tech Stack:** Node.js `node:test`, CommonJS `.test.cjs`, existing `tests/main/helpers/mainTestEnv.cjs`, `studySupervisorService`

## Global Constraints

- Keep this task inside the existing `tests/main/*.test.cjs` system.
- Do not add external fixture files; build the minimal supervision data directly in test code (SQL inserts via `runSql`, or service create methods).
- Focus on the supervision loop (`completeStudyTask`, `skipStudyTask`, `rolloverStudyTasks`, `saveDailyReview`), not the full CRUD surface.
- Use the real method name `rolloverStudyTasks(force)` — there is no `rolloverOverdueTasks`.
- Assert only core state transitions and side effects: `status`, `actual_minutes`, `completed_at`, `completion_quality`, `skipped_reason`, `task_date`, `defer_count`, `last_rollover_date`, and the `daily_reviews` summary fields.
- Keep time-dependent tests deterministic: derive dates from the service's `localDate()` notion of today (compute relative offsets); never hardcode a wall-clock date, and prefer `force = true` / seeded `last_rollover_date` to control rollover branches.
- Reset the DB per test (`beforeEach -> resetTestDatabase()`), clean up in `after` (same pattern as other main-process tests).
- Do not expand scope into dashboard aggregation (`getStudySupervisorDashboard`), risk-overview / `materialRisk`, materials CRUD, IPC, renderer, or Electron E2E.
- If a chosen fixture makes the service throw unexpectedly (real supervision bug), record it and hand back — do not modify production code in this task.

---

## Background

The current regression suite now covers schema initialization, backup/restore, structured import parsing, import batch deletion, review algorithm behavior, TickTick service boundaries, bridge sync, question bank flows, IPC contract scans, migration upgrade regression, and knowledge-map import coverage.

One remaining test gap is `studySupervisorService`. Its broad CRUD surface is less urgent than the supervision loop itself: task completion, skipping, overdue rollover, and daily review persistence are the parts most likely to regress in ways that affect real study tracking.

**How the supervision loop actually works (confirmed by reading `src/main/services/studySupervisorService.ts`; the implementer must re-confirm before writing the test):**

- **The rollover method is named `rolloverStudyTasks(force = false)` — NOT `rolloverOverdueTasks()`.** Earlier draft text used the wrong name; use `rolloverStudyTasks`. Its guard logic matters for a stable test:
  - if `!force` and `auto_rollover_enabled !== 0` and `settings.last_rollover_date === today` → returns `{ rolled: 0, skipped: true }` (no-op);
  - if `auto_rollover_enabled === 0` and `!force` → also a no-op.
  - So a deterministic test should either pass `force = true`, or ensure `last_rollover_date` is not today. It moves tasks with `task_date < today AND status IN ('未开始','进行中','部分完成')` to `today`, sets `defer_count = COALESCE(defer_count,0)+1`, `original_date = COALESCE(original_date, oldDate)`, and updates `study_settings.last_rollover_date` (row `id = 1`). Returns `{ rolled, skipped }`.
- `completeStudyTask(taskId, { actual_minutes?, completion_quality?, note? })` → sets `status = '已完成'`, writes `actual_minutes`, `completion_quality`, `note`, `completed_at`, `updated_at`. Returns the updated task (or `null` if the id doesn't exist). Note it does NOT create a `study_sessions` row itself.
- `skipStudyTask(taskId, reason)` → **throws `强度监督模式下，跳过任务必须填写原因。` if `reason` is empty/whitespace**; otherwise sets `status = '已跳过'`, `skipped_reason = reason.trim()`, `completed_at`, `updated_at`.
- `saveDailyReview(input)` → computes stats via `dailyTaskStats(db, date)` for `date = input.review_date || localDate()`, then upserts one `daily_reviews` row keyed by `review_date`. The derived fields:
  - `completed_task_count` = count of same-day `study_tasks` with `status IN ('已完成','已跳过')`;
  - `total_task_count` = count of same-day `study_tasks`;
  - `total_study_minutes` = `SUM(duration_minutes)` of same-day `study_sessions` (by `session_date`);
  - `completion_rate` = `round(completed / total * 100)` (0 when no tasks).
  - **Implication for the fixture:** to assert non-trivial daily-review numbers you must seed same-`date` `study_tasks` (some completed/skipped) AND at least one `study_sessions` row with a `duration_minutes` — otherwise minutes/rate come out zero and the test proves little.
- `ensureStudyBase()` auto-creates the singleton `study_settings` row (`id = 1`) if missing, so tests don't have to insert settings manually unless they need specific values (e.g. `last_rollover_date`, `auto_rollover_enabled`).

**Time handling — keep tests deterministic:** `localDate()` and `nowIso()` are derived from `new Date()`; rollover/daily-review logic compares against `localDate()` (today). Do NOT hardcode a calendar date as "today". Instead, in the test compute `today` and derived dates the same way the service does — e.g. build "yesterday"/"overdue" `task_date` values by subtracting days from the service's notion of today, and assert `task_date === <that computed today>` rather than a literal string. This mirrors the existing `reviewAlgorithm.test.cjs` approach of asserting relative day math, not wall-clock literals.

## Non-Goals

- No full `studySupervisorService` CRUD coverage.
- No dashboard or risk-summary validation.
- No renderer / IPC / E2E testing.
- No knowledge-map, import, or TickTick feature expansion in this task.
- No production refactor unless a real supervision bug is discovered.

## Scope

### In Scope

- Add one test file under `tests/main/` for supervision-loop behavior.
- Cover:
  - `completeStudyTask()`
  - `skipStudyTask()`
  - `rolloverStudyTasks()` (the overdue-rollover method)
  - `saveDailyReview()` or the direct daily-review write path it drives
- Seed the smallest useful set of rows in:
  - `study_settings`
  - `study_subjects`
  - `study_tasks`
  - `study_sessions` when needed
- Assert:
  - task status changes
  - minute fields and timestamps
  - rollover side effects
  - daily review summary fields

### Out of Scope

- Full materials/tasks CRUD matrix
- Dashboard/risk aggregation
- UI / IPC behavior

## Proposed Approach

### Approach A — Supervision-loop regression tests (recommended)

Test the four high-value state-transition paths directly with minimal fixture data and narrow assertions.

### Approach B — CRUD-first then supervision

Lower initial value because CRUD correctness is more mechanical than supervision-state logic.

### Approach C — Full service test sweep

Too broad for the first batch and likely to create brittle tests.

## Risks

- Time-sensitive logic can become flaky if tests do not control dates carefully.
- If assertions spread into dashboard/risk behavior, the tests will become too coupled to unrelated logic.
- `saveDailyReview()` may rely on properly seeded same-day task/session data, so incomplete fixtures can create false negatives.

## Acceptance Criteria

- A new `studySupervisorService` test file is added under `tests/main/`.
- The file covers task completion, skipping, rollover, and daily-review persistence.
- Fixture data is created directly in test code.
- Assertions stay focused on status transitions and core side effects.
- `npm test`, `npm run typecheck`, and `npm run build` pass.

## Task Breakdown

### Task 1: Add supervision-loop regression tests

**Files:**
- Create: `tests/main/studySupervisor.test.cjs`
- Review: `tests/main/helpers/mainTestEnv.cjs`
- Review: `src/main/services/studySupervisorService.ts`
- Review: `src/main/database/schema.ts`

**Interfaces:**
- Consumes: study-supervisor service methods and existing main-process test helpers
- Produces: repeatable regression coverage for study-supervisor state transitions

- [ ] **Step 1: Identify the supervision entrypoints and required fixture rows**

Confirm the mechanics documented in Background against the current source and harness:

```text
- get the service with requireMain('services/studySupervisorService.js')
- mainTestEnv.cjs exports: databaseService, resetTestDatabase, cleanupTestRoot, requireMain, testRoot
- beforeEach -> resetTestDatabase(); after -> cleanupTestRoot() (same as other tests/main/*.test.cjs)
- ensureStudyBase() auto-seeds study_settings id=1, so a settings row exists after the first service call
- seed study_subjects / study_tasks / study_sessions via databaseService SQL helpers (runSql) or requireMain('services/databaseService.js')
- read back state for assertions with allSql/oneSql on the same DB
- confirm exact column names against src/main/database/schema.ts before asserting
```

- [ ] **Step 2: Define the minimal supervision fixture**

Seed the smallest useful state directly in test code. Compute dates from the service's notion of today, never hardcode a literal date:

```text
study_settings : rely on ensureStudyBase() default (id=1); override only fields a test needs
                 (e.g. set last_rollover_date to a past date so rollover is not a no-op, or pass force=true)
study_subjects : 1 subject row (stable id) if a task requires a subject_id FK
study_tasks    : 1-2 rows with stable ids; set task_date relative to today
                 (an "overdue" task uses task_date = today - 1 day and an incomplete status like '未开始')
study_sessions : 1 row with a known duration_minutes and session_date = today, ONLY for the daily-review test
```

Use stable literal ids and relative dates so assertions can verify exact side effects without wall-clock coupling.

- [ ] **Step 3: Add completion and skip regression tests**

Cover `completeStudyTask()` and `skipStudyTask()`. Seed one `study_tasks` row per case, call the method, then re-read the task row and assert:

```text
completeStudyTask(taskId, { actual_minutes: 30, completion_quality: <valid quality> }):
  - status === '已完成'
  - actual_minutes === 30
  - completed_at is set (non-empty)
  - completion_quality === the passed value

skipStudyTask(taskId, '原因'):
  - status === '已跳过'
  - skipped_reason === '原因'
  - completed_at is set (non-empty)

skipStudyTask(taskId, '   ')  (or ''):
  - throws /必须填写原因/  (use assert.rejects)
```

Assert only these core fields; do not assert dashboard/risk-derived values.

- [ ] **Step 4: Add overdue rollover regression test**

Cover `rolloverStudyTasks()`. Seed an incomplete task with `task_date = today - 1` and make rollover run (pass `force = true`, or set `study_settings.last_rollover_date` to a past date). Then assert:

```text
- return value: { rolled: >=1, skipped: false }
- the overdue task's task_date now equals today (service's localDate())
- its defer_count incremented by 1
- its original_date is populated (the old date)
- study_settings.last_rollover_date (row id=1) equals today
```

Optionally add a no-op assertion: calling again immediately (without force, auto_rollover on, last_rollover_date === today) returns `{ rolled: 0, skipped: true }`.

- [ ] **Step 5: Add daily review aggregation persistence test**

Cover `saveDailyReview()`. Seed for a single `date = today`: 2 tasks (one `已完成`, one `未开始`) and one `study_sessions` row with `duration_minutes = 45`, `session_date = today`. Call `saveDailyReview({ review_date: today })`, then read `daily_reviews` for that date and assert:

```text
- completed_task_count === 1   (已完成/已跳过 count)
- total_task_count === 2
- total_study_minutes === 45    (sum of same-day study_sessions.duration_minutes)
- completion_rate === 50        (round(1/2*100))
```

This proves the aggregation uses same-day tasks + sessions. Keep the assertion to these summary fields.

- [ ] **Step 6: Verify the new test file**

Run:

```bash
npm test
npm run typecheck
npm run build
```

Expected:

```text
test suite passes
typecheck passes
build passes
```

- [ ] **Step 7: Commit**

```bash
git add tests/main/studySupervisor.test.cjs
git commit -m "test: add study supervisor coverage"
```

## Verification

- `npm test`
- `npm run typecheck`
- `npm run build`
- Review that the new tests stay narrowly focused on supervision-loop behavior

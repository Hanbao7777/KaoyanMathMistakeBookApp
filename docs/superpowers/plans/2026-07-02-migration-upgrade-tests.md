# Migration Upgrade Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add migration upgrade regression tests that verify a minimal old database snapshot with mistake-book and TickTick data upgrades safely to the current schema.

**Architecture:** Reuse the existing `node:test` main-process test harness and dynamically construct an old-schema database in test code. Trigger the current initialization/migration path, then assert data retention, schema backfill, index presence, and a small set of core read paths.

**Tech Stack:** Node.js `node:test`, CommonJS `.test.cjs`, sql.js, existing `tests/main/helpers/mainTestEnv.cjs`, current database initialization/migration code

## Global Constraints

- Keep this task inside the existing `tests/main/*.test.cjs` test system.
- Do not add binary `.db` fixtures to the repository. Build the old DB in-memory with sql.js in test code and write its bytes to the test data-root; nothing binary is committed.
- Cover both mistake-book data and TickTick data in one minimal old-database scenario.
- Verify both structure backfill and old-data retention, and keep the two assertion classes clearly separated in the test.
- Column-backfill assertions must target ALTER-migrated tables (`questions` / `review_logs`); for TickTick tables assert retention + index presence only (see Background).
- Do not expand scope into knowledge map import, study supervisor, renderer, or Electron E2E.
- Reuse existing test environment setup and cleanup patterns (`installElectronStub`, `setDataRoot`, `resetDatabaseConnection`, temp-dir cleanup in `after`).
- If the old shape makes current migration code throw, treat it as a discovered real bug: record it and hand back per Non-Goals — do not modify production code in this task, and do not weaken the fixture just to go green.

---

## Background

The current regression suite covers fresh schema initialization, backup/restore, structured import, import batch deletion, review algorithm behavior, TickTick task boundaries, bridge sync, question bank flows, and IPC contract scans. CI is now live and passing on GitHub Actions.

The main remaining high-risk gap in the data layer is migration upgrade coverage: today we verify only that a fresh database initializes correctly, not that an older database with real data upgrades safely to the current schema.

**How the current upgrade path actually works (confirmed by reading `src/main/services/databaseService.ts`; the implementer must re-confirm before writing assertions):**

- `initializeDatabase()` is the public entrypoint. It calls `getDatabase()`, which:
  1. reads the existing `.db` bytes from `getPaths().database` (via sql.js `new SQL.Database(fs.readFileSync(dbPath))`) if the file exists, otherwise creates an empty DB;
  2. runs `db.exec(schemaSql)` — every statement in `src/main/database/schema.ts` is `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, so missing tables and indexes are (re)created but existing tables are left as-is;
  3. runs `migrateDatabase(db)` — this is the ALTER-based backfill;
  4. calls `persistDatabase()` to write bytes back to disk.
- **Backfill asymmetry — this is the crux of a correct test.** `migrateDatabase()` only performs `ALTER TABLE ... ADD COLUMN` backfill on: `questions`, `review_logs`, `textbooks`, `knowledge_points`, `external_questions` (conditional), and a `question_images` table rebuild. It does **not** ALTER any `ticktick_*` table. TickTick tables therefore only get whatever `schemaSql`'s `CREATE TABLE IF NOT EXISTS` provides — i.e. if an old `ticktick_tasks` table already exists but lacks a modern column, the current code will **not** add that column.

Consequence for test design:
- **Column-backfill assertions** must target tables that truly backfill: use `questions` and/or `review_logs` (e.g. an old `questions` table missing `consecutive_correct` / `next_review_at` / `subject`, or an old `review_logs` missing `reviewed_at`).
- For **TickTick tables**, assert **data retention** and **index presence** (indexes come from `CREATE INDEX IF NOT EXISTS`, e.g. `idx_ticktick_tasks_list`, `idx_ticktick_bridge_task`). Do **not** assert TickTick column backfill unless you intend to document a discovered gap.
- If a chosen "old" shape makes current migration throw (e.g. it assumes a column exists), that is a **real migration bug** — report it per Non-Goals; do not silently weaken the test to pass.

## Non-Goals

- No migration framework redesign.
- No historical multi-version matrix.
- No renderer or Electron end-to-end testing.
- No knowledge map import or study supervisor coverage in this task.
- No production code refactor unless a real migration bug is discovered.

## Scope

### In Scope

- Add one migration upgrade regression test file under `tests/main/`.
- Dynamically create an old-schema database state in test code.
- Seed minimal old data for `questions`, `review_logs`, `ticktick_lists`, and `ticktick_tasks`.
- Run current initialization/migration logic.
- Assert:
  - old data survives
  - key current columns exist
  - key current indexes exist
  - a small number of core read paths still work

### Out of Scope

- Static binary old database fixtures
- Multi-era upgrade chains
- Non-database service test expansion

## Proposed Approach

### Approach A — Dynamic old schema fixture + current migration path (recommended)

Build the old database shape directly in the test, omit selected modern columns/indexes, insert minimal old rows, then run the current database initialization path and verify the upgraded result.

### Approach B — Static old `.db` fixture

Use a checked-in binary old database sample. More realistic at first glance, but harder to review and maintain. Not recommended.

### Approach C — Version-by-version migration replay

Replay every historical migration step. Most complete, but unjustified without a formal migration framework. Not recommended for this batch.

## Risks

- The test may expose a real migration bug instead of passing immediately.
- If the “old schema” is chosen poorly, the test could miss the actual compatibility risk.
- If the read-path assertions are too broad, the test becomes brittle and over-coupled to unrelated logic.

## Acceptance Criteria

- A new migration regression test is added under `tests/main/`.
- The test dynamically constructs an old-schema database; no binary fixture is added.
- The test covers both mistake-book and TickTick old data.
- The test verifies data retention, key column backfill, key index presence, and at least one or two core reads after upgrade.
- `npm test`, `npm run typecheck`, and `npm run build` pass.

## Task Breakdown

### Task 1: Define the minimal old-database fixture and upgrade assertions

**Files:**
- Create: `tests/main/migrationUpgrade.test.cjs`
- Review: `tests/main/helpers/mainTestEnv.cjs`
- Review: `tests/main/schema.test.cjs`
- Review: `src/main/database/schema.ts`
- Review: `src/main/services/databaseService.ts`

**Interfaces:**
- Consumes: current database initialization/migration entrypoint, existing main-process test environment helpers
- Produces: a reproducible old-schema regression test fixture and assertions for upgraded state

- [ ] **Step 1: Identify the migration trigger and reusable test hooks**

Review the current database startup path and the existing test harness (`tests/main/helpers/mainTestEnv.cjs`) to confirm the mechanics you will drive:

```text
- mainTestEnv exports: databaseService, resetTestDatabase, cleanupTestRoot, requireMain, testRoot
- resetTestDatabase() calls resetDatabaseConnection(), wipes data-root, setDataRoot(...), then initializeDatabase()
- initializeDatabase() is the migration trigger (exec schemaSql -> migrateDatabase -> persistDatabase)
- the on-disk db file lives at pathService getPaths().database (under the test data-root)
- assertions read through databaseService exports (getQuestion, listReviewLogs, allSql, oneSql) or a fresh sql.js open of the db file
```

Key difference from other test files: those call `resetTestDatabase()` to get a *fresh* current-schema DB. This test must instead **write an old-schema DB file to `getPaths().database` BEFORE calling `initializeDatabase()`**, so the upgrade path runs against old bytes rather than an empty DB.

- [ ] **Step 2: Define the minimal old schema**

Construct the old DB in test code with sql.js directly (sql.js is already a dependency; `require('sql.js')` and build an in-memory `new SQL.Database()`), then write its `.export()` bytes to `getPaths().database`. The old shape must:

- create `questions`, `review_logs`, `ticktick_lists`, `ticktick_tasks` with a **subset** of current columns;
- intentionally OMIT current columns that `migrateDatabase()` is known to backfill, so the upgrade has something to do. Concretely, at least:

```text
questions:    omit consecutive_correct, next_review_at, subject   (all added by migrateDatabase)
review_logs:  omit reviewed_at                                     (added + backfilled by migrateDatabase)
```

- intentionally OMIT a current index that `schemaSql` recreates, e.g. `idx_ticktick_tasks_list`, so index-presence assertions are meaningful;
- include only the columns the old rows actually need (id + a few core fields). Document each omission with an inline comment stating which current migration step is expected to add it back.

Note (from Background): do NOT omit a TickTick *column* expecting it to be backfilled — TickTick tables are not ALTER-migrated. Omit TickTick *indexes* (recreated by `CREATE INDEX IF NOT EXISTS`) instead.

- [ ] **Step 3: Seed minimal old data**

Insert stable, literal rows into the old DB before exporting its bytes:

```text
questions:      1-2 rows (stable id, title/content, mastery_level using an OLD value like '有点懂' to exercise the mastery remap)
review_logs:    >= 1 row referencing a seeded question (populate an old date column such as review_date/created_at, NOT reviewed_at)
ticktick_lists: 1 row (stable id + name)
ticktick_tasks: 1-2 rows (stable id, title, list_id referencing the seeded list)
```

Use fixed literal values (no timestamps from `Date.now()`) so post-upgrade assertions can check exact retention. Seeding the old `questions.mastery_level` with a legacy value also lets you assert the mastery-remap `UPDATE` ran.

- [ ] **Step 4: Trigger upgrade and assert structural backfill + data retention**

Call `initializeDatabase()` (the migration trigger). Then assert the two result classes the spec requires, kept distinct:

Data retention:
```text
- seeded questions rows still present, core field values unchanged (by stable id)
- seeded review_logs row still present and still linked to its question
- seeded ticktick_lists / ticktick_tasks rows still present with unchanged core values
```

Structure backfill + indexes:
```text
- questions now has consecutive_correct / next_review_at / subject  (PRAGMA table_info(questions))
- review_logs now has reviewed_at, and reviewed_at was backfilled from the old date column (not NULL)
- omitted index recreated: idx_ticktick_tasks_list present (query sqlite_master WHERE type='index')
- an index migrateDatabase creates is present, e.g. idx_review_logs_reviewed_at
```

- [ ] **Step 5: Assert core read paths stay usable**

After upgrade, run **one or two** narrow reads through the current service layer to prove upgraded data is consumable — no broader service behavior testing:

```text
- databaseService.getQuestion(seededId) returns the row with backfilled defaults populated
- databaseService.listReviewLogs(seededId) returns the retained review log
```

Do not pull in dashboard/stats/import/bridge service calls here — that widens scope beyond migration upgrade.

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
git add tests/main/migrationUpgrade.test.cjs
git commit -m "test: add migration upgrade regression coverage"
```

## Verification

- `npm test`
- `npm run typecheck`
- `npm run build`
- Review that the new test file stays narrowly focused on migration upgrade behavior

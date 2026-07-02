# Knowledge Map Import Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add service-layer regression tests for manual knowledge-map zip import and a minimal seed-import smoke path.

**Architecture:** Reuse the existing `node:test` main-process harness, generate minimal zip fixtures dynamically in test code, and test `knowledgeMapService` import entrypoints directly. Focus the assertions on import parsing, core data persistence, and import-batch recording without widening scope into query or UI behavior.

**Tech Stack:** Node.js `node:test`, CommonJS `.test.cjs`, `adm-zip`, existing `tests/main/helpers/mainTestEnv.cjs`, `knowledgeMapService`

## Global Constraints

- Keep this task inside the existing `tests/main/*.test.cjs` system.
- Do not add binary zip fixtures to the repository. Build every zip in-memory/temp with `adm-zip` in test code.
- Manual zip import is the primary path (happy + 3 failure branches); seed import gets one smoke test only.
- Drive manual import via the dialog seam: override `electron.dialog.showOpenDialog` per test (same pattern as `tests/main/import.test.cjs`). Do not add args to the service functions.
- The seed zip must be written to `dist/main/resources/knowledge_map_seed.zip` (where the compiled service looks) and removed after the test; do not commit or leave it behind.
- Assert both business tables (`textbooks`, `knowledge_points`) and import-batch tables (`import_batches`, `import_batch_items`).
- Reset the DB per test (`beforeEach`) — `node_id` is globally unique and the service throws on duplicates.
- Do not expand scope into knowledge-map queries (`listKnowledgeTree`, stats, review selection), PDF/`bindTextbookPdf`/`openTextbookPage`, `rematchKnowledgePoints`, IPC, renderer, or Electron E2E.
- If a chosen fixture makes the import throw unexpectedly (real parsing/persistence bug), record it and hand back — do not modify production code in this task.

---

## Background

The current regression suite now covers fresh schema initialization, backup/restore, structured import parsing, import batch deletion, review algorithm behavior, TickTick service boundaries, bridge sync, question bank flows, IPC contract scans, and migration upgrade regression.

One remaining data-safety gap is `knowledgeMapService` import coverage. This service directly parses zip contents and writes `textbooks`, `knowledge_points`, `import_batches`, and `import_batch_items`, so it belongs in the same regression tier as other import-path tests.

**How the two import entrypoints actually work (confirmed by reading `src/main/services/knowledgeMapService.ts`; the implementer must re-confirm before writing the test):**

- `importKnowledgeMapZip()` takes **no arguments**. It calls `chooseKnowledgeZip()`, which calls `dialog.showOpenDialog(...)` and returns `result.filePaths[0]` (or `null` if canceled). So the manual-import test drives file selection exactly like `tests/main/import.test.cjs` does: override `electron.dialog.showOpenDialog` to return `{ canceled: false, filePaths: [zipPath] }` (see `import.test.cjs:25`). Returning `{ canceled: true }` makes the function return `null` without importing.
- The zip is extracted to a temp dir, then the service requires two entries at the zip root: `textbooks.json` and `knowledge_points.json`. It throws specific errors when they are missing or malformed:
  - missing `textbooks.json` → `知识地图包缺少 textbooks.json`
  - missing `knowledge_points.json` → `知识地图包缺少 knowledge_points.json`
  - `knowledge_points.json` not an array → `knowledge_points.json 必须是数组`
- `seedImportKnowledgeMap()` also takes **no arguments** and resolves its zip from `resourcesDir`. When not packaged it uses `path.join(__dirname, '../../resources')`. Because tests run against the compiled output, `__dirname` is `dist/main/main/services/`, so the resolved path is **`dist/main/resources/knowledge_map_seed.zip`** — NOT the source `resources/` dir. The seed smoke test must therefore write its dynamically-built `knowledge_map_seed.zip` into `dist/main/resources/` before calling the function, and clean it up afterward. This is the brittle seam the spec warns about; do not try to redirect it any other way.
- Both entrypoints share the same body after extraction: `createImportBatch({ type: 'knowledge_map', ... })`, `upsertTextbook(...)`, `upsertKnowledgePoint(...)` per row (parent/child linked by `node_id` / `parent_node_id`), `recordImportBatchItem(db, batchId, targetTable, targetId)`, then `finalizeImportBatch`.

**Fixture JSON shapes (from the service's parsing code):**

```text
textbooks.json      -> a single JSON OBJECT (not array): { "title", "subject", "edition"?, "file_name"?, "note"? }
knowledge_points.json -> a JSON ARRAY of objects: [ { "node_id", "title", "parent_node_id"?, "subject"?, "category"?, "level"?, "sort_order"? }, ... ]
```

Note `node_id` is globally unique — the service throws if a `node_id` already exists. Use fresh stable ids per test and reset the DB in `beforeEach` so runs don't collide.

## Non-Goals

- No query-path testing (`listKnowledgeTree`, stats, review question selection, etc.).
- No `rematchKnowledgePoints()` coverage.
- No PDF binding or `shell` / Electron behavior.
- No renderer / IPC / E2E testing.
- No production refactor unless a real import bug is discovered.

## Scope

### In Scope

- Add one test file under `tests/main/` for `knowledgeMapService` import paths.
- Cover manual `knowledge_map_import.zip` import:
  - happy path
  - missing-file failure
  - `knowledge_points.json` structure failure
- Cover `seedImportKnowledgeMap()` with one success-path smoke test.
- Assert persistence into:
  - `textbooks`
  - `knowledge_points`
  - `import_batches`
  - `import_batch_items`

### Out of Scope

- Knowledge-map query APIs
- PDF / shell behavior
- Rematch flows
- UI / IPC

## Proposed Approach

### Approach A — Dynamic zip fixtures + manual import focus + seed smoke (recommended)

Build minimal import zips in the test itself, call the service entrypoints directly, and keep seed import coverage to one narrow smoke test.

### Approach B — Full manual + seed matrix

Test happy/error branches for both entrypoints. More complete, but repetitive and heavier than needed for the first batch.

### Approach C — Seed-only coverage

Cheapest to build, but misses the user-facing import path and is therefore not sufficient.

## Risks

- The import service spans zip extraction, JSON parsing, textbook upsert, knowledge-point upsert, and batch tracking, so weak assertions could miss real regressions.
- If the seed smoke test depends too much on environment-specific resources handling, it may become brittle.
- Over-asserting nonessential fields could make the test expensive to maintain when the import schema evolves.

## Acceptance Criteria

- A new `knowledgeMapService` import test file is added under `tests/main/`.
- Manual import covers happy path, missing-file failure, and `knowledge_points.json` structure failure.
- Seed import has one smoke test.
- Zip fixtures are generated dynamically in test code.
- Assertions cover `textbooks`, `knowledge_points`, `import_batches`, and `import_batch_items`.
- `npm test`, `npm run typecheck`, and `npm run build` pass.

## Task Breakdown

### Task 1: Add knowledge-map import regression tests

**Files:**
- Create: `tests/main/knowledgeMapImport.test.cjs`
- Review: `tests/main/helpers/mainTestEnv.cjs`
- Review: `tests/main/import.test.cjs`
- Review: `src/main/services/knowledgeMapService.ts`
- Review: `src/main/services/importBatchService.ts`

**Interfaces:**
- Consumes: `importKnowledgeMapZip()`, `seedImportKnowledgeMap()`, existing main-process test helpers
- Produces: repeatable service-layer regression coverage for knowledge-map import

- [ ] **Step 1: Identify the import entrypoints and test seams**

Confirm the mechanics documented in Background against the current source and harness:

```text
- importKnowledgeMapZip(): no args; file comes from dialog.showOpenDialog -> override electron.dialog.showOpenDialog in the test
- seedImportKnowledgeMap(): no args; reads dist/main/resources/knowledge_map_seed.zip (via __dirname/../../resources when not packaged)
- mainTestEnv.cjs exports: databaseService, resetTestDatabase, cleanupTestRoot, requireMain, testRoot
- get the service with requireMain('services/knowledgeMapService.js')
- for assertions use requireMain('services/databaseService.js') helpers (allSql/oneSql) or knowledgeMapService's own DB
- follow import.test.cjs style: require('electron') at top, reassign electron.dialog.showOpenDialog per test
```

- [ ] **Step 2: Define the minimal knowledge-map fixture data**

Create the smallest valid payloads. Match the exact shapes from Background (object vs array):

```text
textbooks.json (OBJECT):
  { "title": "测试教材", "subject": "高等数学", "edition": "1" }

knowledge_points.json (ARRAY, parent + child):
  [
    { "node_id": "km-test-root",  "title": "父节点", "parent_node_id": "" },
    { "node_id": "km-test-child", "title": "子节点", "parent_node_id": "km-test-root" }
  ]
```

Use stable literal `node_id`s so post-import assertions can look rows up exactly. Reset the DB per test (`beforeEach -> resetTestDatabase()`) so the globally-unique `node_id` guard never trips across tests.

- [ ] **Step 3: Build dynamic zip fixtures in test code**

Use `adm-zip` (already a dependency, as in `import.test.cjs`) to assemble each zip in a temp dir, adding JSON entries at the zip root via `zip.addFile('textbooks.json', Buffer.from(JSON.stringify(...)))`:

```text
valid knowledge_map_import.zip        -> textbooks.json (object) + knowledge_points.json (array)
zip missing textbooks.json            -> only knowledge_points.json
zip missing knowledge_points.json     -> only textbooks.json
zip with invalid knowledge_points.json -> knowledge_points.json holds a JSON object, not an array
minimal knowledge_map_seed.zip        -> same valid pair, written into dist/main/resources/ for the seed test
```

For manual-import tests, point `electron.dialog.showOpenDialog` at the built zip path. For the seed test, write the seed zip to `dist/main/resources/knowledge_map_seed.zip` and remove it in `after`/`afterEach` so the repo tree and other runs are unaffected.

- [ ] **Step 4: Implement manual import happy-path assertions**

Override the dialog to return the valid zip, call `importKnowledgeMapZip()`, then assert across all four required tables (use `allSql`/`oneSql` on the service DB):

```text
textbooks:          1 new row, title = '测试教材', subject = '高等数学'
knowledge_points:   2 rows; child.parent_node_id === root.node_id; titles/node_ids match fixture
import_batches:     1 row with type = 'knowledge_map'
import_batch_items: rows recorded for the imported textbook and knowledge points (targetTable/targetId populated)
```

Keep assertions to core fields (`node_id`, `title`, `parent_node_id`, batch `type`). Do not assert incidental columns that will churn as the schema evolves.

- [ ] **Step 5: Implement manual import failure-path assertions**

Override the dialog at each malformed zip and assert the service throws (use `assert.rejects` with a message match), without partial writes leaking when practical:

```text
missing textbooks.json          -> throws /textbooks\.json/ (知识地图包缺少 textbooks.json)
missing knowledge_points.json   -> throws /knowledge_points\.json/ (知识地图包缺少 knowledge_points.json)
knowledge_points.json not array -> throws /必须是数组/ (knowledge_points.json 必须是数组)
```

Assert it throws rather than silently returning; do not over-specify the full error string beyond a stable substring.

- [ ] **Step 6: Implement one seed-import smoke test**

Write a minimal valid `knowledge_map_seed.zip` to `dist/main/resources/`, call `seedImportKnowledgeMap()`, and assert only that basic persistence succeeded:

```text
- returns without throwing
- textbooks has the seeded textbook
- knowledge_points has the seeded node(s)
- an import_batches row with type = 'knowledge_map' exists
```

Clean up the written seed zip afterward. This is a single smoke test — do not replicate the manual-import error matrix here.

- [ ] **Step 7: Verify the new test file**

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

- [ ] **Step 8: Commit**

```bash
git add tests/main/knowledgeMapImport.test.cjs
git commit -m "test: add knowledge map import coverage"
```

## Verification

- `npm test`
- `npm run typecheck`
- `npm run build`
- Review that the new tests stay narrowly focused on import behavior

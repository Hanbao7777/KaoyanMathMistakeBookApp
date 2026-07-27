# Agent Control Plane Phase A Executable Implementation Plan

## Status and authority

This is the production implementation plan for Phase A of the accepted architecture in `docs/design/agent-control-plane.md`. It is intended for immediate coordinator dispatch after final acceptance. Completed task records under `docs/tasks/` are historical evidence, not active requirements.

The user-authorized Phase A scope is narrower than the original three-domain example in the architecture document: Phase A builds the control kernel and completes one end-to-end migration template for the questions domain. Review, task, knowledge, study, question-bank, import, and operations code is changed only where it currently writes question-owned data or must enter the common persistence/recovery kernel. Full migration of those domains remains deferred.

## Scope

Phase A delivers:

- Versioned internal agent command, query, result, error, data-version, event, and execution-context contracts.
- A durable `{ dataEpoch, dataRevision }` concurrency token stored in the business database.
- A single `DatabaseCoordinator` write queue, transaction boundary, durable publish boundary, and maintenance fence.
- Same-directory staged database writes, flush, integrity validation, Windows replace/retry, previous-generation fallback, and deterministic startup recovery.
- A versioned cross-database/filesystem operation journal with staging, quarantine, compensation, startup reconciliation, and `needs_recovery` fencing.
- Application Command Bus, Query Bus, handler registries, `ExecutionContext`, and an in-process domain event bus.
- A complete questions-domain migration, including every current route that writes `questions`, `question_images`, `tags`, `question_tags`, `review_logs`, or `question_knowledge_points`.
- Static and behavioral migration gates proving that no question-domain writer bypasses the command executor.

## Non-goals

- Agent Gateway, policy engine, approval records, client pairing, OAuth, scopes, audit ledger, jobs, change sets, MCP tools/resources/prompts, MCP HTTP server, stdio launcher, or control-center UI.
- Full migration of review, TickTick, study-supervisor, knowledge-map, question-bank, import, backup, restore, or path-management domains. Only their question-owned writes and required common-kernel integration are in scope.
- Renderer page changes, renderer question-filter changes, visual work, or replacement of the existing renderer API.
- Changes to the default data root or migration of real user data during development or validation.
- A general ORM, arbitrary SQL command API, or a second database owner.

## Architectural invariants

1. Electron main remains the only owner of the live `sql.js` database and live database file.
2. Every runtime database mutation after bootstrap executes in the `DatabaseCoordinator` queue. No adapter, timer, bridge, or service may call a mutating SQL helper or `persistDatabase()` outside the coordinator execution scope.
3. A command's database mutation and `dataRevision` increment commit in the same SQL transaction. The result is not successful until the new live database file is reopened and validated.
4. `dataRevision` is monotonic only within one `dataEpoch`. Epochs are opaque identities and are never lexically or temporally ordered.
5. Normal commands preserve the epoch and increment revision exactly once when they make a durable semantic change. A validated no-op returns the unchanged version. Failed or compensated commands do not publish a new visible version.
6. Database identity replacement operations create a fresh random epoch and revision `0` behind a maintenance fence. Old expected versions, approvals, caches, and future idempotency records are invalid.
7. A SQL transaction is not treated as atomic with filesystem changes. Every cross-resource command uses the operation journal and ends only as `completed`, `compensated`, or `needs_recovery`.
8. Domain events are immutable facts emitted only after durable live-file validation. Events are never emitted for rolled-back, failed-persistence, or compensated attempts.
9. Queries cannot mutate schema, seed defaults, clean rows, roll dates forward, or persist. Any current mixed read is split into an explicit internal/write command plus a pure query.
10. Existing Renderer IPC behavior and return payloads remain compatible in Phase A. IPC becomes an adapter over the application bus; it does not become an external agent contract.
11. The active renderer question-filter work in `src/renderer/pages/LibraryPage.tsx`, `src/renderer/pages/StatsPage.tsx`, `src/shared/questionFilters.ts`, and `tests/main/questionFilters.test.cjs` is user-owned and forbidden to all Phase A workers.
12. No future MCP question write may be registered until the migration gate in Task A12 passes.

## Prerequisites and dirty-worktree safeguards

- Before every dispatch, run `git status --short` and record the baseline. Do not stash, reset, checkout, clean, normalize, or commit unrelated work.
- The current baseline includes pre-existing changes to `AGENTS.md`, `ROADMAP.md`, `KNOWN_ISSUES.md`, renderer question-filter files, and untracked agent/design/task records. Workers must preserve them.
- Use the existing `node:test` harness and isolated temporary roots from `tests/main/helpers/mainTestEnv.cjs`. Never run tests against `D:\KaoyanMathMistakeBook`.
- The first implementation worker must add a control-plane test helper that creates a unique temp root and `userData` recovery root per test process. Tests that simulate restore, crash, or path replacement must use only those roots.
- Before editing a shared file, compare it with the dispatch baseline. If an unrelated concurrent edit touches the same lines, stop and return a conflict rather than overwriting it.
- Each worker runs the narrow validation listed in its task. The coordinator runs the completion suite only after all dependency gates pass.

## Target module boundaries

```text
src/shared/agent/
  v1/contracts.ts
  v1/schemas.ts
  errors.ts
  versions.ts
src/main/application/
  commandBus.ts
  queryBus.ts
  executionContext.ts
  domainEvents.ts
  questions/
src/main/persistence/
  databaseCoordinator.ts
  atomicPersist.ts
  revisionStore.ts
  recoveryState.ts
  operationJournal/
src/main/ipc/adapters/
  questionsIpc.ts
tests/main/controlPlane/
tests/ipc/
```

Names may be adjusted only to match an already-landed Phase A predecessor. Do not introduce parallel abstractions with equivalent responsibilities.

## Data-version semantics

The database gains a singleton control row, created by an idempotent schema migration:

```sql
CREATE TABLE control_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data_epoch TEXT NOT NULL,
  data_revision INTEGER NOT NULL CHECK (data_revision >= 0),
  schema_version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
```

- A legacy database without the row receives a cryptographically random epoch and revision `0`; that upgraded database is durably published before normal startup continues.
- A normal write checks `expectedVersion` after entering the queue and immediately before `BEGIN`. Strict question create/update/delete/review/link commands require epoch and revision. Explicit internal bootstrap commands may declare `concurrency: 'epoch-only'` or `concurrency: 'none'` in code, never by caller input.
- The handler returns `{ changed, value, events }`. When `changed` is true, the coordinator increments revision once in the same transaction. Multiple rows and tables changed by one command still consume one revision.
- A stale epoch returns `DATA_EPOCH_MISMATCH`; a stale revision returns `DATA_REVISION_CONFLICT`, including current version and affected entity references. Neither begins a mutation.
- Database replacement uses a maintenance fence, drains the queue, validates a consistency package, installs the candidate with a newly generated epoch and revision `0`, publishes `database.replaced`, then reopens writes.
- Revision overflow is treated as a maintenance error requiring an epoch rotation command; it must not wrap.

## Durable database publish algorithm

`AtomicPersist` receives exported bytes and the expected data version. Its stages are named and injectable: `beforeExport`, `afterExport`, `afterTempOpen`, `afterTempWrite`, `afterTempFlush`, `afterPreviousPublish`, `afterLivePublish`, `afterLiveReopen`, and `afterDirectoryFlush`.

1. The coordinator begins SQL, invokes one command handler, increments revision when changed, and commits the in-memory transaction.
2. Export bytes. Write them to a unique `.<database-name>.<requestId>.<nonce>.tmp` in the live database directory with exclusive create.
3. Flush the temp file handle. Attempt to flush the parent directory where supported; record `unsupported` separately from failure.
4. Open the temp bytes with `sql.js`, enable foreign keys, run `PRAGMA quick_check`, and verify the expected epoch/revision singleton. Reject malformed or mismatched bytes.
5. Remove only a stale, already-validated previous candidate selected by recovery policy. Rename live to the single-generation previous path, then rename temp to live. On Windows, retry only documented sharing errors with bounded exponential delay and a total deadline; never delete live to force progress.
6. Reopen live from disk and repeat quick-check plus epoch/revision validation. Flush the directory metadata after publication where supported.
7. Only after validation succeeds may the coordinator replace its in-memory handle with the reopened database, remove previous, publish events, and return success.
8. If failure occurs before live publication, delete/quarantine temp, reload the verified live database, and fail the command. If failure occurs after live may have changed, run candidate reconciliation. If one candidate is provably committed, load it; otherwise enter read-only `needs_recovery` and return an indeterminate persistence error without claiming success.

Startup examines live, previous, and all owned temp candidates. Invalid candidates are quarantined with evidence. Within one epoch, the highest valid revision wins. Across epochs, only a matching committed epoch-transition record in the external recovery index can select a winner; otherwise startup fences writes as `needs_recovery`. Recovery never orders epoch strings.

## Operation journal and recovery protocol

Each manifest is versioned, immutable in identity, and atomically rewritten for state changes:

```text
prepared -> files_staged -> db_committed -> files_committed -> completed
     \-> compensating -> compensated
any unsafe/ambiguous transition -> needs_recovery
```

Required fields include manifest/schema version, operation and request IDs, command type, source/client/trace, canonical input hash, data version before and planned after, affected entities, paths, content hashes, staging/quarantine locations, per-step status, compensation plan, timestamps, and last error. R4/database-identity manifests and the recovery index live under Electron `userData`, outside any replaced data root. Ordinary managed-file manifests may live under a controlled directory on the current data-root volume, with an indexed external pointer.

Files are staged on the target volume. Physical deletion becomes rename to managed quarantine. Manifest transitions use unique temp, file flush, same-directory replace, and directory flush when supported. Every transition and recovery action is idempotent. Startup recovery runs after path initialization and database candidate recovery, but before IPC registration. A manifest that cannot be safely completed or compensated fences its affected domain; database identity ambiguity fences all writes.

The questions template must cover: create/update with image copies; delete question with optional image quarantine; remove image with optional quarantine; structured import temp cleanup; import-batch deletion; question-bank add-to-mistakes image copy; and global clear/import/restore paths that replace or delete question-owned state.

## Task graph

Dependencies use task IDs. A task is dispatchable only when every dependency is accepted by the coordinator.

Every task and lettered subtask inherits this completion contract in addition to its specific fields: edit only its listed files; treat all other files as forbidden; preserve the recorded dirty baseline; on failure leave predecessor behavior authoritative and remove/disable only the incomplete owned integration through reviewed edits; never add a raw-persistence fallback; run the listed validation and `git diff --check` on owned files; self-review scope, failure behavior, and evidence; and return commands/outcomes, risks, and modified files. A task is accepted only when its acceptance criteria, tests, handoff evidence, and rollback/failure behavior are all demonstrated. Task-specific rollback text overrides this default only where it is stricter.

### A0 - Capture baseline and install isolated control-plane test environment

**Difficulty:** medium

**Dependencies:** none
**Objective:** establish reproducible, user-data-safe validation and record the dirty baseline.

**Expected files:**

- `tests/main/helpers/controlPlaneTestEnv.cjs` (new)
- `tests/main/controlPlane/testEnvironment.test.cjs` (new)

**Allowed edits:** only the two files above.

**Forbidden edits:** existing helper, source, renderer, package scripts, and all pre-existing task documents.

**Implementation:** derive a unique temp data root and `userData` recovery root; stub Electron paths; expose reset/cleanup helpers; assert that neither path equals or is inside the default real root. Preserve the existing build-then-CommonJS test style.

**Tests and validation:** `npm run build:main`; `node --test tests/main/controlPlane/testEnvironment.test.cjs`; `git diff --check -- <owned files>`.

**Acceptance:** tests prove isolation and cleanup; baseline `git status --short` is attached to handoff; no real data path is opened or changed.

**Handoff evidence:** commands, pass counts, temp-root examples with user-specific segments redacted, owned-file diff, and post-task status.

### A1 - Define versioned application contracts and runtime validation

**Difficulty:** hard

**Dependencies:** A0
**Objective:** create the versioned contract vocabulary used by all later kernel tasks.

**Expected files:**

- `src/shared/agent/v1/contracts.ts`
- `src/shared/agent/v1/schemas.ts`
- `src/shared/agent/errors.ts`
- `src/shared/agent/versions.ts`
- `src/shared/agent/index.ts`
- `tests/main/controlPlane/agentContracts.test.cjs`

**Allowed edits:** only the files above.

**Forbidden edits:** `src/shared/api.ts`, `src/shared/types.ts`, renderer, preload, IPC, and dependencies.

**Implementation:** define `agentApiVersion = 1`, `DataVersion`, strict `ExecutionContext`, command/query envelopes, `CommandResult`, `QueryResult`, stable error codes, event envelopes, and questions v1 command/query DTOs. Runtime validators must reject unknown discriminator values, missing context identity, invalid revisions, and malformed payloads. Use dependency-free TypeScript validators unless a validator is already present when dispatched; do not add a package.

**Tests and validation:** `npm run build:main`; contract test; `npm run typecheck`; `git diff --check`.

**Acceptance:** compile-time and runtime contracts share discriminators; every v1 question command has a validator; errors serialize without stacks or secrets; API version changes require an explicit new namespace/version.

**Handoff evidence:** contract inventory, validation matrix, commands, pass counts, and files.

### A2 - Implement atomic database publication and candidate inspection

**Difficulty:** hard

**Dependencies:** A0, A1
**Objective:** implement the durable file algorithm independently of command execution.

**Expected files:**

- `src/main/persistence/atomicPersist.ts`
- `src/main/persistence/databaseCandidate.ts`
- `src/main/persistence/fileDurability.ts`
- `tests/main/controlPlane/atomicPersist.test.cjs`

**Allowed edits:** only the files above.

**Forbidden edits:** database service, schema, startup, package files, and real paths.

**Implementation:** implement unique same-directory temp writes, flush, candidate quick-check/version inspection, previous/live publish, bounded Windows retry, live reopen validation, candidate enumeration, and typed failure injection. Dependency injection supplies filesystem operations, `sql.js` candidate opener, clock, retry sleeper, and hooks.

**Tests and validation:** targeted test must inject failures at export handoff, temp write, temp flush, temp reopen, live-to-previous rename, temp-to-live rename, live reopen, and directory flush. Verify at least one valid candidate remains, no false success occurs, and retry is bounded. Run `npm run build:main`, targeted test, `npm run typecheck`, and `git diff --check`.

**Acceptance:** algorithm matches the section above; candidates expose epoch/revision without mutating; cross-epoch ambiguity is not auto-resolved; tests use only A0 roots.

**Rollback/failure handling:** no production integration occurs in this task. A failed task is removed by deleting only its new files.

**Handoff evidence:** failure-stage table, candidate files observed per stage, Windows retry cases, commands, and pass counts.

### A3 - Add control metadata, revision store, and legacy bootstrap

**Difficulty:** hard

**Dependencies:** A0, A1
**Objective:** persist epoch/revision and make schema/bootstrap idempotent.

**Expected files:**

- `src/main/database/schema.ts`
- `src/main/persistence/revisionStore.ts`
- `src/main/persistence/databaseBootstrap.ts`
- `tests/main/controlPlane/dataVersion.test.cjs`
- `tests/main/migrationUpgrade.test.cjs` (only append focused assertions)
- `tests/main/schema.test.cjs` (only append focused assertions)

**Allowed edits:** only the files above.

**Forbidden edits:** `databaseService.ts`, startup, renderer, IPC, and package files.

**Implementation:** add singleton metadata DDL; implement read, assert, increment, and epoch-reset primitives against an injected database; bootstrap missing metadata with random UUID epoch and revision `0`; reject duplicate/malformed singleton rows and unsafe integer revisions. Do not persist from query helpers.

**Tests and validation:** legacy schema upgrade, repeated bootstrap, normal increment in caller transaction, rollback behavior, epoch reset, malformed metadata, and revision overflow. Run build-main, the three focused tests, typecheck, and diff check.

**Acceptance:** metadata is part of schema and survives export/reopen; revision mutation requires an existing transaction/execution token; legacy bootstrap is deterministic except epoch value.

**Handoff evidence:** schema diff, migration matrix, commands, pass counts, files.

### A4 - Implement operation journal, staging, quarantine, and recovery decisions

**Difficulty:** hard

**Dependencies:** A0, A1, A2
**Objective:** provide the generic cross-resource durability framework before any question file command migrates.

**Expected files:**

- `src/main/persistence/operationJournal/types.ts`
- `src/main/persistence/operationJournal/manifestStore.ts`
- `src/main/persistence/operationJournal/staging.ts`
- `src/main/persistence/operationJournal/quarantine.ts`
- `src/main/persistence/operationJournal/recovery.ts`
- `src/main/persistence/operationJournal/index.ts`
- `tests/main/controlPlane/operationJournal.test.cjs`

**Allowed edits:** only this directory and test.

**Forbidden edits:** existing file/image/import services, startup, database service, and package files.

**Implementation:** implement versioned manifests, legal state transitions, atomic manifest publication, hash verification, same-volume staging, quarantine moves with copy+flush+rename fallback where rename is impossible, idempotent compensation, manifest scanning, and typed recovery outcomes. Reject path escape and manifest downgrade.

**Tests and validation:** inject failure before/after each transition and simulate restart. Cover staged create, replacement, quarantine deletion, compensation, hash mismatch, missing file, malformed manifest, and ambiguous state. Run build-main, targeted test, typecheck, and diff check.

**Acceptance:** every test ends as `completed`, `compensated`, or `needs_recovery`; repeated recovery is idempotent; R4 manifests can use external `userData` storage.

**Handoff evidence:** state-transition coverage, restart matrix, commands, pass counts, files.

### A5 - Implement Database Coordinator and startup database recovery

**Difficulty:** hard

**Dependencies:** A1, A2, A3
**Objective:** establish the sole runtime database mutation owner.

**Expected files:**

- `src/main/persistence/databaseCoordinator.ts`
- `src/main/persistence/recoveryState.ts`
- `src/main/persistence/index.ts`
- `tests/main/controlPlane/databaseCoordinator.test.cjs`
- `tests/main/controlPlane/databaseRecovery.test.cjs`

**Allowed edits:** only the files above.

**Forbidden edits:** `databaseService.ts`, schema, startup, services, IPC, and renderer.

**Implementation:** FIFO write queue; execution-scope token; expected-version check inside queue; SQL begin/commit/rollback; one revision increment per changed command; call A2 durable publication; reload verified disk state after failure; maintenance/read-only fences; startup candidate selection; deterministic shutdown drain. Prevent nested coordinator writes and direct reentrant execution.

**Tests and validation:** concurrent commands serialize; one of two same-version writes succeeds; stale epoch/revision fails before mutation; transaction and persist failures restore coherent memory/disk; events are not yet emitted; maintenance fence drains and blocks; recovery matrix covers live/temp/previous and cross-epoch ambiguity. Run build-main, both tests, typecheck, diff check.

**Acceptance:** no success before live validation; in-memory database version always equals selected live candidate after completion; indeterminate publication fences writes.

**Handoff evidence:** concurrency trace, fault matrix, commands, pass counts, files.

### A6 - Implement Command Bus, Query Bus, ExecutionContext, and domain events

**Difficulty:** hard

**Dependencies:** A1, A5
**Objective:** create the application use-case boundary shared by IPC and future adapters.

**Expected files:**

- `src/main/application/executionContext.ts`
- `src/main/application/commandBus.ts`
- `src/main/application/queryBus.ts`
- `src/main/application/domainEvents.ts`
- `src/main/application/index.ts`
- `tests/main/controlPlane/applicationBus.test.cjs`

**Allowed edits:** only the files above.

**Forbidden edits:** domain services, persistence modules, IPC, preload, renderer, and package files.

**Implementation:** explicit handler registration with duplicate/missing-handler errors; validation before execution; command bus delegates writes to coordinator; query bus receives a read-only database facade and rejects execution during unsafe recovery; context factories for renderer/internal sources; immutable ordered event publication after durable coordinator success. Listener failure is reported to diagnostics but cannot change an already-durable command result.

**Tests and validation:** context validation, duplicate handler, command error mapping, pure query behavior, event ordering/version, listener isolation, and no event on failed persistence. Run build-main, targeted test, typecheck, diff check.

**Acceptance:** all application writes require a command envelope and context; query handlers cannot obtain mutation helpers; events carry request/trace/source and before/after data versions.

**Handoff evidence:** registered test operations, event traces, commands, pass counts, files.

### A7 - Integrate kernel bootstrap, shutdown drain, and recovery-before-IPC

**Difficulty:** hard

**Dependencies:** A3, A4, A5, A6
**Objective:** wire the kernel into application lifecycle without migrating domain behavior yet.

**Expected files:**

- `src/main/services/databaseService.ts`
- `src/main/main.ts`
- `tests/main/controlPlane/startupRecovery.test.cjs`
- `tests/main/helpers/mainTestEnv.cjs` (minimal compatibility adjustment only if required)

**Allowed edits:** only the files above.

**Forbidden edits:** `registerIpc.ts`, all renderer/shared filter files, other services, schema, and package files.

**Implementation:** make database initialization run bootstrap and candidate recovery before accepting IPC; create one coordinator instance; expose read-only access separately from coordinator execution access; route shutdown persistence through coordinator drain rather than raw overwrite; scan operation manifests before IPC registration; preserve seed/category/rematch ordering temporarily but mark those calls for A10 migration. Keep startup error reporting and window behavior unchanged.

**Tests and validation:** normal legacy startup, pending manifest recovery, ambiguous candidate read-only startup, IPC registration ordering via static/runtime seam, and clean shutdown drain. Run build-main, startup test, existing schema/migration/load-state tests, typecheck, and diff check.

**Acceptance:** no runtime IPC is registered before database and journal recovery; the coordinator mutation API is available; every temporary raw `persistDatabase()` compatibility caller is enumerated for A10/A11 and the final gate; startup never touches real user data in tests.

**Rollback/failure handling:** if integration fails, preserve the last verified live file and surface startup recovery state; do not silently initialize a blank database over candidates.

**Handoff evidence:** lifecycle ordering trace, recovery cases, commands, pass counts, files.

### A8 - Implement questions application handlers and repository boundary

**Difficulty:** hard

**Dependencies:** A6, A7
**Objective:** move all question-owned business mutation logic behind command handlers while preserving read APIs.

**Expected files:**

- `src/main/application/questions/commands.ts`
- `src/main/application/questions/queries.ts`
- `src/main/application/questions/questionRepository.ts`
- `src/main/application/questions/registerQuestions.ts`
- `src/main/application/questions/index.ts`
- `src/main/services/databaseService.ts`
- `src/main/services/fileService.ts`
- `tests/main/controlPlane/questionsCommands.test.cjs`
- `tests/main/reviewAlgorithm.test.cjs` (focused compatibility assertions only)

**Allowed edits:** only the files above.

**Forbidden edits:** renderer, shared question filters, IPC, import/question-bank/knowledge/bridge services, startup, and schema.

**Implementation:** handlers for create, update, delete, remove image, mark mastery, submit review, link knowledge points, category migration, rematch links, bulk/import-owned insertion primitives, global question-state replacement/clear hooks, and question queries. Repository methods require the coordinator execution token for mutation. Integrate A4 journal for image staging/quarantine. Remove transaction/persist ownership from legacy question service functions; keep temporary wrappers only when a known caller still needs migration in A9-A10, and mark them internal with static-gate allowlist entries that expire in A12.

**Tests and validation:** current question CRUD/review behavior; image copy/delete crash stages; revision increments once per command; no revision/event on no-op/failure; stale version; question event payloads; rollback and compensation. Run build-main, questions/review tests, typecheck, diff check.

**Acceptance:** command handlers own question rules; repository cannot mutate outside coordinator scope; create/update file failure cannot leave an untracked file or committed broken reference.

**Handoff evidence:** command catalog, old-to-new function mapping, fault matrix, commands, pass counts, files.

### A9 - Migrate Renderer question/review/image IPC adapters

**Difficulty:** medium

**Dependencies:** A8
**Objective:** route direct Renderer question-domain channels through the command/query bus without changing renderer contracts.

**Expected files:**

- `src/main/ipc/adapters/questionsIpc.ts`
- `src/main/ipc/registerIpc.ts`
- `tests/ipc/questions-command-adapter.test.cjs`
- `tests/ipc/ipc-contract-check.test.cjs` (focused assertions only)

**Allowed edits:** only the files above.

**Forbidden edits:** `src/shared/api.ts`, preload, renderer, question filters, other IPC channel behavior, and services.

**Implementation:** migrate `questions:create/update/delete/markMastery`, `images:remove`, `reviews:add`, and `reviews:submitResult`; migrate question queries to Query Bus as practical without changing responses. Build renderer `ExecutionContext` in main; do not trust renderer-supplied client/source. Until renderer carries expected versions, the IPC adapter obtains the current version immediately before dispatch and documents that renderer conflict UX is deferred; tests must still prove bus-level stale-version rejection.

**Tests and validation:** static channel parity, unchanged success/error envelopes, command invocation assertions, actual CRUD/review integration. Run build-main, two IPC tests, relevant question tests, typecheck, diff check.

**Acceptance:** listed channels contain no direct domain-service mutation calls; preload/API names and renderer code are unchanged.

**Handoff evidence:** channel mapping, parity results, commands, pass counts, files.

### A10 - Migrate non-IPC and cross-domain question writers

**Difficulty:** hard

**Dependencies:** A8
**Objective:** route every service/startup path that writes question-owned tables through the command executor.

This task is split into parallel, file-exclusive subtasks after A8. Each subtask is independently accepted before A12.

#### A10a - Structured import adapter

**Files:** `src/main/services/structuredImportService.ts`, `tests/main/import.test.cjs`, `tests/main/controlPlane/structuredImportRecovery.test.cjs`.

**Implementation:** use either one bounded batch command or a sequence of independently journaled top-level row commands followed by a top-level finalization command. Nested coordinator commands are forbidden. Batch metadata, staged images, finalization, and cleanup must reflect explicit per-row outcomes; no raw question writer is called.

#### A10b - Question bank adapter

**Files:** `src/main/services/questionBankService.ts`, `tests/main/questionBankService.test.cjs`, `tests/main/controlPlane/questionBankQuestionMigration.test.cjs`.

**Implementation:** `addExternalQuestionToMistakes` becomes one coordinated cross-domain command so question creation, image copies, knowledge links, external-question flags, and attempt flags cannot report partial success. Import and deletion retain deferred-domain status but enter coordinator for all DB writes.

#### A10c - Import-batch deletion adapter

**Files:** `src/main/services/importBatchService.ts`, `tests/main/importBatchService.test.cjs`, `tests/main/controlPlane/importBatchRecovery.test.cjs`.

**Implementation:** deletion uses journal/quarantine and coordinator; question deletion and batch status are one operation; backup alone is not treated as full compensation.

#### A10d - Knowledge-map question-link adapter

**Files:** `src/main/services/knowledgeMapService.ts`, `tests/main/knowledgeMapImport.test.cjs`, `tests/main/controlPlane/knowledgeQuestionLinkMigration.test.cjs`.

**Implementation:** startup/manual rematch and link mutations dispatch question-link commands; knowledge-only writes remain deferred but execute through coordinator when touched.

#### A10e - Bridge/review adapter

**Files:** `src/main/services/bridgeService.ts`, `tests/main/bridgeService.test.cjs`, `tests/main/controlPlane/bridgeQuestionMigration.test.cjs`.

**Implementation:** review submission and undo are commands; TickTick completion plus review sync is one ordered command or explicit compensated outcome. Remove swallowed sync success where the parent currently reports success after a failed question write.

#### A10f - Startup question-writer adapter

**Files:** `src/main/main.ts`, `tests/main/controlPlane/startupQuestionCommands.test.cjs`.

**Implementation:** category migration and rematch execute as internal commands after recovery and before IPC; seed import uses coordinator/journal. Preserve current startup nonfatal policy only for safely failed/compensated operations; `needs_recovery` must fence writes.

**Common forbidden scope:** renderer, preload, shared filters, unrelated service files, package files, and full migration of the owning non-question domain.

**Common validation:** each subtask runs build-main, its focused existing/new tests, typecheck, and diff check. A10a-A10f may run in parallel because file ownership does not overlap; the coordinator must not dispatch another writer to any listed file.

**Acceptance:** no subtask invokes `createQuestion`, `submitReviewResult`, `linkQuestionKnowledgePoints`, mutating SQL against question-owned tables, or raw persistence outside the command executor.

**Handoff evidence:** direct-call search before/after, operation outcome tests, commands, pass counts, files.

### A10g - Contain deferred-domain writers behind the Database Coordinator

**Difficulty:** hard

**Dependencies:** A7, A8
**Objective:** make the coordinator the actual sole runtime database writer without claiming full application-command migration for deferred domains.

This is mechanical containment, not full domain migration: retain current service APIs and business behavior, but execute mutations through a named `executeLegacyMutation` adapter that supplies the coordinator-scoped database, one transaction, one durable publication, and one revision. Legacy operations use internal execution contexts and emit only a generic `legacy.operation_completed` diagnostic event; domain-specific contracts/events remain deferred.

The task is split into file-exclusive subtasks. A10g1-A10g3 may run in parallel after A8. A10g4 waits for A9 because both own `registerIpc.ts`.

#### A10g1 - Study-supervisor containment

**Files:** `src/main/services/studySupervisorService.ts`, `tests/main/studySupervisor.test.cjs`, `tests/main/controlPlane/studyCoordinatorContainment.test.cjs`.

**Implementation:** move schema/default seeding to an explicit startup mutation; make all list/get/dashboard functions pure; execute settings/material/task/session/review/rollover writers in coordinator scope. Preserve current results and rollover policy.

#### A10g2 - TickTick, focus, habit, and settings containment

**Files:** `src/main/services/ticktickService.ts`, `tests/main/ticktickService.test.cjs`, `tests/main/controlPlane/tickTickCoordinatorContainment.test.cjs`.

**Implementation:** wrap all list/task/focus/bridge/settings/habit writers; split tag cleanup and `app_settings` table creation out of reads; remove direct persistence. Preserve service signatures and existing local validation.

#### A10g3 - DeepSeek settings durability containment

**Files:** `src/main/services/deepseekService.ts`, `tests/main/controlPlane/deepSeekSettingsPersistence.test.cjs`.

**Implementation:** make settings save a coordinator mutation that is durable before success; keep network calls and secret-storage redesign out of scope; keep settings read pure.

#### A10g4 - Direct IPC and timer-callback containment

**Files:** `src/main/ipc/registerIpc.ts`, `tests/ipc/ipc-contract-check.test.cjs`, `tests/main/controlPlane/directIpcWriterContainment.test.cjs`.

**Implementation:** replace direct `getDatabase`/`db.run` white-noise and AI-import writes with internal commands; dispatch the focus session-end callback through the coordinator and observe completion/failure explicitly. Do not change window/widget/timer UI behavior or channel names.

**Common allowed edits:** only each subtask's listed files. **Common forbidden edits:** renderer, preload, shared question filters, command contracts, other service files, package files, and domain feature changes.

**Common tests and validation:** build-main; listed existing/new tests; a concurrent-write test with one question command and one contained legacy writer; typecheck; diff check.

**Common rollback/failure handling:** a contained operation must roll back and fail its caller on transaction/publish error. The timer callback records failure without reporting a persisted focus session. No subtask may fall back to raw persistence.

**Acceptance:** study, TickTick, focus, habit, bridge settings, DeepSeek settings, AI-import metadata, and direct white-noise writes contain no raw persistence or mutable database acquisition outside coordinator scope; read channels no longer mutate.

**Handoff evidence:** per-file before/after bypass search, compatibility test results, concurrency trace, commands, pass counts, files.

### A11 - Migrate global replacement, clear, backup/restore, and root-switch kernel paths

**Difficulty:** hard

**Dependencies:** A4, A5, A7, A8, A9, A10a, A10b, A10c, A10d, A10e, A10f, A10g1, A10g2, A10g3, A10g4
**Objective:** ensure operations that replace/delete question-owned state obey maintenance, epoch, atomic publish, and journal rules.

**Expected files:**

- `src/main/services/backupService.ts`
- `src/main/services/pathService.ts`
- `src/main/services/databaseService.ts`
- `src/main/ipc/registerIpc.ts`
- `tests/main/backupService.test.cjs`
- `tests/main/controlPlane/databaseReplacement.test.cjs`
- `tests/main/controlPlane/rootSwitchRecovery.test.cjs`

**Allowed edits:** only the files above. Because `databaseService.ts` and `registerIpc.ts` were previously owned by A8/A9/A10g4, A11 is strictly sequential after those tasks.

**Forbidden edits:** renderer, preload, shared filters, import services, and package files.

**Implementation:** route JSON import, clear-all, restore, and root switch through maintenance commands. Create and verify consistency packages; stage root migration and atomically publish config; use a fresh epoch/revision `0` for database identity replacement; keep old root/current database until acceptance. Manual/daily backup copies only a coordinator-flushed verified live candidate. Backup deletion remains journaled filesystem work. Do not claim database-only backup makes managed files recoverable.

**Tests and validation:** replacement candidate validation; bad backup rejection; restore crash stages; clear with image quarantine; root copy/hash/config-switch crash stages; old version invalidation; insufficient-space rejection seam. Run build-main, backup and new tests, typecheck, diff check.

**Acceptance:** all replacement operations fence writes, select one coherent epoch, and finish explainably; a failed root switch leaves the prior root authoritative.

**Handoff evidence:** replacement/recovery matrix, epoch assertions, commands, pass counts, files.

### A12 - Enforce the questions migration gate and complete regression acceptance

**Difficulty:** hard

**Dependencies:** A9, A10a, A10b, A10c, A10d, A10e, A10f, A10g1, A10g2, A10g3, A10g4, A11
**Objective:** mechanically prove the questions domain has no bypass before future MCP write exposure.

**Expected files:**

- `tests/main/controlPlane/questionWriterGate.test.cjs`
- `tests/main/controlPlane/databaseWriterGate.test.cjs`
- `tests/main/controlPlane/questionsEndToEnd.test.cjs`
- `tests/ipc/questions-command-adapter.test.cjs` (append gate cases only)
- `docs/tasks/2026-07-15-agent-control-plane-write-entry-inventory.md` (update dispositions/evidence only in the implementation session that owns this gate)

**Allowed edits:** only the files above.

**Forbidden edits:** production source, renderer, package files, architecture docs, and unrelated task records.

**Implementation:** static scan all `src/main/**/*.ts` for mutating SQL naming question-owned tables, `persistDatabase`, mutable `getDatabase`, direct mutating helper imports, and legacy writer calls. Allow only schema/bootstrap, coordinator-scoped repositories/adapters, atomic persistence, and explicitly documented read-only SQL. Fail on new files or patterns not classified in the inventory. A global companion gate proves every non-bootstrap DB mutation is coordinator-scoped. Behavioral E2E runs Renderer IPC -> command bus -> coordinator -> durable reopen -> event for create/update/review/delete with image staging and stale conflict.

**Tests and validation:** `npm run build:main`; gate test; questions E2E; IPC contract tests; all main tests; `npm test`; `npm run typecheck`; `npm run build`; `git diff --check`.

**Acceptance:** zero unallowlisted question writers and zero raw runtime database writers; every inventory Phase A question row is `migrated`, `coordinator-wrapped global operation`, or evidence-backed `read-only`; deferred domains are explicitly `coordinator-contained`; no renderer filter file changed; all tests pass.

**Hard completion gate:** the coordinator must reject any future MCP question-write task unless A12 remains green on that branch.

**Handoff evidence:** complete scan patterns and counts, allowlist with reasons, end-to-end event/version trace, full command outcomes, dirty-worktree comparison, and modified-file list.

## Parallelism and file ownership

- A0 starts first.
- A1 follows A0 because it defines the shared version contracts.
- After A1, A2 and A3 may run in parallel because they own disjoint files and consume the accepted contracts.
- A4 depends on A2; A5 depends on A1-A3. They may overlap only if neither changes the other's files; A5 consumes accepted interfaces and should normally start after A2/A3 acceptance.
- A6 follows A5. A7 follows A3-A6.
- A8 follows A7.
- A9, A10a-A10e, and A10g1-A10g3 may run in parallel after A8; each has exclusive files. A10f waits until A7's `main.ts` ownership is released. A10g4 waits for A9's `registerIpc.ts` ownership release.
- A11 waits for every A9/A10 adapter and containment task before it removes the final compatibility persistence paths and reopens `databaseService.ts`/`registerIpc.ts`.
- A12 runs only after every migration subtask and A11 is accepted.
- No two active workers may own `databaseService.ts`, `registerIpc.ts`, `main.ts`, or the same test file. The coordinator records ownership in every dispatch.

## Baseline and completion validation

Baseline commands, before implementation:

```powershell
git status --short
npm run build:main
npm run test:main
npm run typecheck
```

Task-level commands are listed above. Final coordinator acceptance:

```powershell
git status --short
npm run build:main
node --test tests/main/controlPlane/*.test.cjs
npm run test:main
npm test
npm run typecheck
npm run build
git diff --check
```

Do not run packaging, install, restore, real migration, or tests against the real data root. A pre-existing baseline failure must be recorded and isolated; it must not be hidden by broad edits.

## Rollback and failure policy

- Source rollback is by reverting only the failing task's owned changes through normal reviewed edits; never use destructive worktree commands.
- Runtime database failure before publish reloads verified live. Ambiguous publish enters read-only recovery.
- Cross-resource failure follows its manifest compensation. Missing evidence or hash mismatch becomes `needs_recovery`, never success.
- Startup recovery failure prevents IPC write registration. Read-only availability is allowed only when the selected live database is verified and the affected-domain fence is explicit.
- Each task must leave predecessor tests green. If an interface must change, return to the owning predecessor task rather than adding a compatibility bypass.

## Phase A completion gates

1. Contracts are runtime validated and versioned.
2. Legacy and new databases expose a durable valid data version.
3. Concurrent same-version writes produce one success and one explicit conflict.
4. Every atomic-persist failure seam leaves a verified candidate or an explicit recovery fence.
5. Journal restart tests end only in `completed`, `compensated`, or `needs_recovery`.
6. Events publish only after durable validation and contain before/after versions.
7. Startup recovery completes before IPC registration.
8. All question-owned writers pass through the command executor, including startup, imports, question bank, import deletion, bridge sync, clear/import/restore, and root switch.
9. Renderer API behavior remains compatible and renderer question-filter work is untouched.
10. A12 static and behavioral gates pass, and no MCP/Gateway/UI implementation was added.

## Recommended dispatch sequence

| Order | Task | Difficulty | Dispatch rule |
| --- | --- | --- | --- |
| 1 | A0 test isolation | medium | Single worker, current workspace |
| 2 | A1 contracts | hard | After A0 |
| 3 | A2 atomic persistence | hard | Parallel with A3 after A1 |
| 3 | A3 revision/bootstrap | hard | Parallel with A2 after A1 |
| 4 | A4 operation journal | hard | After A2 |
| 5 | A5 coordinator/recovery | hard | After A1-A3 |
| 6 | A6 buses/context/events | hard | After A5 |
| 7 | A7 lifecycle integration | hard | After A3-A6 |
| 8 | A8 questions handlers/repository | hard | After A7 |
| 9 | A9 IPC adapter | medium | Parallel with A10a-A10e after A8 |
| 9 | A10a-A10e adapters | hard each | Parallel, one writer per listed file set |
| 9 | A10g1-A10g3 legacy containment | hard each | Parallel, one writer per listed file set |
| 10 | A10f startup adapter | hard | After A8 and A7 ownership release |
| 10 | A10g4 direct IPC containment | hard | After A9 releases `registerIpc.ts` |
| 11 | A11 global replacement/root paths | hard | Sequential after every A9/A10 task |
| 12 | A12 migration gate/acceptance | hard | Only after all prior migration tasks |

For hard tasks use the repository's current hard-task primary model and `medium` thinking after Paseo provider discovery. For A9 use the current medium-task primary model. Every dispatch must repeat objective, allowed/forbidden scope, exact ownership, dependencies, validation, response format, and dirty-worktree warning.

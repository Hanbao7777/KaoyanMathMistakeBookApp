# Import Batch Deletion Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a narrow regression slice for `deleteImportBatch()` covering destructive behavior, protection backup creation, and minimum asset handling.

**Architecture:** Test `importBatchService.ts` at the main-service layer using the existing `node:test` harness and temp data-root isolation. Focus on wrong-questions batch deletion side effects and `before_delete_import` protection, not broad import workflows or UI entrypoints.

**Tech Stack:** Node.js built-in test runner, CommonJS `.test.cjs`, shared Electron/path test helper, compiled main-process services

## Global Constraints

- Do not introduce new test dependencies.
- Do not touch renderer/UI code.
- Reuse `tests/main/helpers/mainTestEnv.cjs`.
- Keep scope limited to `deleteImportBatch()` and its immediate side effects.
- Prefer the smallest stable destructive-path slice over broad import lifecycle coverage.
- Verification must include `npm test`, `npm run typecheck`, and `npm run build`.

---

### Task 1: Add Import Batch Deletion Regression Tests

**Files:**
- Create: `tests/main/importBatchService.test.cjs`
- Modify: `../tasks/2026-06-27-minimal-test-system.md`

**Interfaces:**
- Consumes:
  - `requireMain('services/importBatchService.js')`
  - `requireMain('services/databaseService.js')`
  - `requireMain('services/importBatchService.js')` batch helpers if needed
  - `resetTestDatabase()`
  - `cleanupTestRoot()`
- Produces:
  - Service-level regression tests for destructive batch deletion behavior
  - Updated task tracking in the task document

- [ ] Confirm the smallest safe coverage slice for `deleteImportBatch()`
- [ ] Add coverage for `before_delete_import` protection backup creation
- [ ] Add coverage for wrong-questions batch deleting linked `questions`
- [ ] Add one narrow asset/trash behavior only if it stays deterministic
- [ ] Update task documentation to reflect the actual completed deletion coverage
- [ ] Run full verification and prepare commit

### Task 2: Review and Accept the Deletion Slice

**Files:**
- Review: `tests/main/importBatchService.test.cjs`
- Review: `../tasks/2026-06-27-minimal-test-system.md`

**Interfaces:**
- Consumes:
  - Test results from `npm test`
  - Current delete behavior in `src/main/services/importBatchService.ts`
- Produces:
  - Accepted destructive-path coverage slice
  - Decision on the next remaining high-risk backlog item

- [ ] Check assertions against current delete side effects, backup creation, and asset-move behavior
- [ ] Check isolation boundaries and temp data-root usage
- [ ] Confirm verification output is green
- [ ] Decide next narrow slice after acceptance

## Acceptance Criteria

- Import-batch deletion coverage exists under `tests/main/`.
- Tests cover `before_delete_import` backup creation.
- Tests cover deletion of wrong-questions batch data from the database.
- Tests verify real DB or filesystem side effects, not just return values.
- No production refactor is introduced unless a real bug is found.
- `npm test`, `npm run typecheck`, and `npm run build` all pass.

## Risks

- Destructive-path tests can become flaky if they depend on unstable timestamps or non-deterministic trash paths.
- Asset-moving assertions must stay narrow and path-root aware.
- Linked-question preservation branches may require a second slice if they make the first test unstable.

## Verification

- Run targeted import-batch deletion tests first.
- Run full `npm test`.
- Run `npm run typecheck`.
- Run `npm run build`.

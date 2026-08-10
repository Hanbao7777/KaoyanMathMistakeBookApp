# Bridge Service Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a narrow Batch 4 bridge-service regression slice that protects the most valuable TickTick ↔ mistake-book sync paths.

**Architecture:** Test `bridgeService.ts` at the main-service layer through the existing `node:test` harness and temp data-root isolation. Focus on sync side effects in `review_logs`, `ticktick_tasks`, and related bridge rows rather than UI behavior or broad end-to-end TickTick flows.

**Tech Stack:** Node.js built-in test runner, CommonJS `.test.cjs`, shared Electron/path test helper, compiled main-process services

## Global Constraints

- Do not introduce new test dependencies.
- Do not touch renderer/UI code.
- Reuse `tests/main/helpers/mainTestEnv.cjs`.
- Keep scope limited to `bridgeService.ts`.
- Prefer one narrow bridge slice over broad multi-service coverage.
- Verification must include `npm test`, `npm run typecheck`, and `npm run build`.

---

### Task 1: Add Bridge Service Regression Tests

**Files:**
- Create: `tests/main/bridgeService.test.cjs`
- Modify: `../tasks/2026-06-27-minimal-test-system.md`

**Interfaces:**
- Consumes:
  - `requireMain('services/bridgeService.js')`
  - `requireMain('services/ticktickService.js')`
  - `requireMain('services/databaseService.js')`
  - `resetTestDatabase()`
  - `cleanupTestRoot()`
- Produces:
  - Service-level regression tests for the highest-value bridge sync paths
  - Updated Batch 4 tracking in the task document

- [ ] Confirm the exact exported bridge entrypoints and choose the smallest safe coverage slice
- [ ] Add coverage for TickTick task completion → review log sync when `sync_review=1`
- [ ] Add coverage for duplicate-protection / repeat sync behavior if stable enough
- [ ] Add one additional bridge path only if it stays narrow and deterministic
- [ ] Update Batch 4 documentation to reflect the actual completed bridge coverage
- [ ] Run full verification and prepare commit

### Task 2: Review and Accept the Bridge Slice

**Files:**
- Review: `tests/main/bridgeService.test.cjs`
- Review: `../tasks/2026-06-27-minimal-test-system.md`

**Interfaces:**
- Consumes:
  - Test results from `npm test`
  - Current bridge behavior in `src/main/services/bridgeService.ts`
- Produces:
  - Accepted bridge-service coverage slice
  - Decision on next Batch 4 target

- [ ] Check assertions against current bridge side effects and duplicate-guard behavior
- [ ] Check isolation boundaries and temp data-root usage
- [ ] Confirm verification output is green
- [ ] Decide next narrow Batch 4 slice after acceptance

## Acceptance Criteria

- Bridge service coverage exists under `tests/main/`.
- Tests cover at least one review-log sync path from TickTick completion.
- Tests verify real DB side effects, not just function return values.
- No production refactor is introduced unless a real bug is found.
- `npm test`, `npm run typecheck`, and `npm run build` all pass.

## Risks

- Some bridge paths depend on date-sensitive duplicate guards and may need careful assertions.
- Bridge behavior spans multiple tables, so setup must stay narrow and explicit.
- Auto-review task generation may be broader than this slice and should only be included if it stays deterministic.

## Verification

- Run targeted bridge-service tests first.
- Run full `npm test`.
- Run `npm run typecheck`.
- Run `npm run build`.

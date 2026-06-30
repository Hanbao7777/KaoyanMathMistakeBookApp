# Review Algorithm Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Batch 3 review-algorithm regression coverage with the smallest safe change set, reusing the existing main-service test harness.

**Architecture:** Test `submitReviewResult()` as a black-box main-service flow through the existing `node:test` + compiled `dist/main` setup. Do not refactor `databaseService.ts` in this batch unless testing exposes a real correctness bug that cannot be validated otherwise.

**Tech Stack:** Node.js built-in test runner, CommonJS `.test.cjs`, shared Electron stub helper, compiled main-process services

## Global Constraints

- Do not introduce new test dependencies.
- Do not touch renderer/UI code.
- Reuse `tests/main/helpers/mainTestEnv.cjs`.
- Keep scope limited to review algorithm coverage.
- Verification must include `npm test`, `npm run typecheck`, and `npm run build`.

---

### Task 1: Add Review Algorithm Regression Tests

**Files:**
- Create: `tests/main/reviewAlgorithm.test.cjs`
- Modify: `docs/tasks/2026-06-27-minimal-test-system.md`

**Interfaces:**
- Consumes:
  - `requireMain('services/databaseService.js')`
  - `resetTestDatabase()`
  - `cleanupTestRoot()`
  - `createQuestion()`
  - `submitReviewResult()`
  - `getQuestion()`
- Produces:
  - Service-level regression tests for review interval and mastery transitions
  - Updated Batch 3 tracking in the task document

- [ ] Confirm actual algorithm entrypoints and helper usage
- [ ] Define the minimal question fixture shape for review tests
- [ ] Add first-pass coverage for `correct`, `wrong`, and `no_idea`
- [ ] Add progression coverage for consecutive correct answers
- [ ] Add reset coverage after an incorrect answer
- [ ] Update Batch 3 documentation from “pure function” wording to actual service-level coverage if needed
- [ ] Run full verification and prepare commit

### Task 2: Review and Accept the Batch 3 Slice

**Files:**
- Review: `tests/main/reviewAlgorithm.test.cjs`
- Review: `docs/tasks/2026-06-27-minimal-test-system.md`

**Interfaces:**
- Consumes:
  - Test results from `npm test`
  - Current algorithm behavior in `src/main/services/databaseService.ts`
- Produces:
  - Accepted review-algorithm coverage slice
  - Decision on whether to move directly to import parsing tests

- [ ] Check assertions against current interval and mastery rules
- [ ] Check isolation boundaries and temporary data-root usage
- [ ] Confirm verification output is green
- [ ] Decide next dispatch target for remaining Batch 3 work

## Acceptance Criteria

- Review algorithm coverage exists under `tests/main/`.
- Tests cover first correct, wrong, no_idea, consecutive correct growth, and reset-after-mistake behavior.
- No production refactor is introduced unless a real bug is found.
- `npm test`, `npm run typecheck`, and `npm run build` all pass.

## Risks

- Review logic is embedded inside `databaseService.ts`, so tests should start as black-box service tests rather than forcing premature extraction.
- Time-based assertions must avoid flaky wall-clock assumptions.
- If actual algorithm behavior differs from Batch 3 assumptions, the task doc must be corrected before more tests are added.

## Verification

- Run targeted review-algorithm tests first.
- Run full `npm test`.
- Run `npm run typecheck`.
- Run `npm run build`.

# Import Parsing Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Batch 3 import parsing regression coverage for structured import flows with the smallest safe change set, reusing the existing main-service test harness.

**Architecture:** Test import parsing at the service layer against compiled `dist/main`, using temporary files and the existing Electron/path isolation helper. Focus on malformed input tolerance and minimum happy-path verification, not UI flows or broad import feature expansion.

**Tech Stack:** Node.js built-in test runner, CommonJS `.test.cjs`, shared Electron stub helper, compiled main-process services, `adm-zip`, `xlsx`

## Global Constraints

- Do not introduce new test dependencies.
- Do not touch renderer/UI code.
- Reuse `tests/main/helpers/mainTestEnv.cjs` where possible.
- Keep scope limited to import parsing coverage.
- Prefer generating tiny fixtures during test setup over committing large binary fixtures.
- Verification must include `npm test`, `npm run typecheck`, and `npm run build`.

---

### Task 1: Add Structured Import Parsing Regression Tests

**Files:**
- Create: `tests/main/import.test.cjs`
- Modify: `docs/tasks/2026-06-27-minimal-test-system.md`

**Interfaces:**
- Consumes:
  - `requireMain('services/structuredImportService.js')`
  - existing temp-path/test harness utilities
  - file generation utilities for `.xlsx`, `.json`, `.zip`
- Produces:
  - Service-level regression tests for malformed and valid structured import inputs
  - Updated Batch 3 tracking in the task document

- [ ] Confirm the exact exported import-preparation entrypoints to test
- [ ] Define the minimal temporary fixture strategy for malformed Excel/zip and valid zip cases
- [ ] Add malformed input coverage with assertions on non-crash behavior and invalid row reporting
- [ ] Add minimum happy-path coverage for at least one valid structured import path
- [ ] Update Batch 3 documentation to reflect the actual tested entrypoints and completed cases
- [ ] Run full verification and prepare commit

### Task 2: Review and Accept the Batch 3 Import Slice

**Files:**
- Review: `tests/main/import.test.cjs`
- Review: `docs/tasks/2026-06-27-minimal-test-system.md`

**Interfaces:**
- Consumes:
  - Test results from `npm test`
  - Current import behavior in `src/main/services/structuredImportService.ts`
- Produces:
  - Accepted import parsing coverage slice
  - Decision on whether Batch 3 is complete or needs one more narrow addition

- [ ] Check assertions against current structured import behavior and exported entrypoints
- [ ] Check isolation boundaries, temporary file cleanup, and path safety
- [ ] Confirm verification output is green
- [ ] Decide whether remaining Batch 3 scope is complete

## Acceptance Criteria

- Import parsing coverage exists under `tests/main/`.
- Tests cover malformed input handling and at least one valid path.
- Tests assert on preview/result behavior rather than UI state.
- No production refactor is introduced unless a real bug is found.
- `npm test`, `npm run typecheck`, and `npm run build` all pass.

## Risks

- Some import functions are file-picker oriented; tests may need to target lower-level helpers or safe exported preparation flows without involving real dialogs.
- Zip and Excel generation can create brittle tests if fixtures are larger than necessary.
- Knowledge map import may belong to a separate service boundary from generic structured import and may need to be split if the scope grows.

## Verification

- Run targeted import parsing tests first.
- Run full `npm test`.
- Run `npm run typecheck`.
- Run `npm run build`.

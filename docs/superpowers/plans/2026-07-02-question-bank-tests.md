# Question Bank Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a narrow Batch 4 question-bank regression slice that protects the most valuable external-question data flows.

**Architecture:** Test `questionBankService.ts` at the main-service layer through the existing `node:test` harness and temp data-root isolation. Focus on side effects in `external_questions`, `external_question_attempts`, and the created mistake-book question link rather than broad zip-import coverage or UI flows.

**Tech Stack:** Node.js built-in test runner, CommonJS `.test.cjs`, shared Electron/path test helper, compiled main-process services

## Global Constraints

- Do not introduce new test dependencies.
- Do not touch renderer/UI code.
- Reuse `tests/main/helpers/mainTestEnv.cjs`.
- Keep scope limited to `questionBankService.ts`.
- Prefer one narrow question-bank slice over broad import + review + asset coverage.
- Verification must include `npm test`, `npm run typecheck`, and `npm run build`.

---

### Task 1: Add Question Bank Regression Tests

**Files:**
- Create: `tests/main/questionBankService.test.cjs`
- Modify: `docs/tasks/2026-06-27-minimal-test-system.md`

**Interfaces:**
- Consumes:
  - `requireMain('services/questionBankService.js')`
  - `requireMain('services/databaseService.js')`
  - `resetTestDatabase()`
  - `cleanupTestRoot()`
- Produces:
  - Service-level regression tests for the highest-value question-bank paths
  - Updated Batch 4 tracking in the task document

- [ ] Confirm the smallest safe coverage slice in `questionBankService.ts`
- [ ] Add coverage for `recordExternalQuestionAttempt` writing a valid attempt row
- [ ] Add coverage for `addExternalQuestionToMistakes` updating external-question state and linking the created mistake question
- [ ] Add one duplicate/guard behavior only if it stays deterministic and narrow
- [ ] Update Batch 4 documentation to reflect the actual completed question-bank coverage
- [ ] Run full verification and prepare commit

### Task 2: Review and Accept the Question Bank Slice

**Files:**
- Review: `tests/main/questionBankService.test.cjs`
- Review: `docs/tasks/2026-06-27-minimal-test-system.md`

**Interfaces:**
- Consumes:
  - Test results from `npm test`
  - Current question-bank behavior in `src/main/services/questionBankService.ts`
- Produces:
  - Accepted question-bank coverage slice
  - Decision on next narrow backlog item

- [ ] Check assertions against current DB side effects and guard behavior
- [ ] Check isolation boundaries and temp data-root usage
- [ ] Confirm verification output is green
- [ ] Decide next narrow slice after acceptance

## Acceptance Criteria

- Question-bank coverage exists under `tests/main/`.
- Tests cover attempt creation in `external_question_attempts`.
- Tests cover add-to-mistakes linkage and resulting state update.
- No production refactor is introduced unless a real bug is found.
- `npm test`, `npm run typecheck`, and `npm run build` all pass.

## Risks

- Full zip-import coverage may be broader than this slice and should stay out unless it remains deterministic.
- Question-bank side effects span multiple tables, so setup must stay explicit.
- Asset/path handling for papers and images should not be pulled into this batch unless strictly needed.

## Verification

- Run targeted question-bank tests first.
- Run full `npm test`.
- Run `npm run typecheck`.
- Run `npm run build`.

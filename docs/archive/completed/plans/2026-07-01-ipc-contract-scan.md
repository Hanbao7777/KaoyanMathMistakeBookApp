# IPC Contract Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a low-cost static IPC contract scan that detects drift between `AppApi`, `preload`, and main-process IPC registration.

**Architecture:** Implement a static test/script under `tests/ipc/` that reads source files and compares method/channel definitions without launching Electron. Focus on observable contract mismatches, not runtime behavior or end-to-end IPC execution.

**Tech Stack:** Node.js built-in test runner, CommonJS `.cjs`, source-file scanning via existing Node stdlib and repo source files

## Global Constraints

- Do not introduce new test dependencies.
- Do not start Electron.
- Do not touch renderer/UI code.
- Keep scope limited to static contract scanning.
- Prefer simple, inspectable parsing over fragile broad regex if possible.
- Verification must include `npm test`, `npm run typecheck`, and `npm run build`.

---

### Task 1: Add IPC Contract Static Scan

**Files:**
- Create: `tests/ipc/ipc-contract-check.test.cjs`
- Modify: `package.json`
- Modify: `../tasks/2026-06-27-minimal-test-system.md`

**Interfaces:**
- Consumes:
  - `src/shared/api.ts`
  - `src/preload/preload.ts`
  - `src/main/ipc/registerIpc.ts`
- Produces:
  - Static coverage for `AppApi` ↔ preload ↔ main IPC registration alignment
  - Updated Batch 4 tracking in the task document

- [ ] Confirm which source-level contract elements are authoritative in each file
- [ ] Define the minimal extraction strategy for API method names and IPC channel names
- [ ] Add mismatch detection for `AppApi` methods missing from preload exposure
- [ ] Add mismatch detection for preload `invoke`/`send` channels missing from main registration
- [ ] Update Batch 4 documentation to reflect the actual completed static coverage
- [ ] Run full verification and prepare commit

### Task 2: Review and Accept the IPC Scan Slice

**Files:**
- Review: `tests/ipc/ipc-contract-check.test.cjs`
- Review: `../tasks/2026-06-27-minimal-test-system.md`

**Interfaces:**
- Consumes:
  - Test results from `npm test`
  - Current source contracts in `api.ts`, `preload.ts`, `registerIpc.ts`
- Produces:
  - Accepted IPC contract scan slice
  - Decision on whether to continue with another Batch 4 service test

- [ ] Check assertions against current source structure and naming patterns
- [ ] Check that the scan fails clearly on real mismatch cases
- [ ] Confirm verification output is green
- [ ] Decide next Batch 4 target after acceptance

## Acceptance Criteria

- Static IPC scan exists under `tests/ipc/`.
- Test covers `AppApi` method exposure in preload.
- Test covers preload channel usage against main IPC registration.
- No Electron runtime boot is required.
- `npm test`, `npm run typecheck`, and `npm run build` all pass.

## Risks

- Source parsing can become brittle if it assumes formatting that may change.
- `registerIpc.ts` may contain multiple channel registration patterns that need explicit handling.
- A static scan proves naming alignment, not runtime payload correctness.

## Verification

- Run targeted IPC contract scan first.
- Run full `npm test`.
- Run `npm run typecheck`.
- Run `npm run build`.

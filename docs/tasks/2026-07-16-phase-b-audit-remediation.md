# Phase B Audit Remediation Plan

## Status and authority

This document records the accepted findings from the read-only Phase B review of
`efb07ea9e649dea1148ffc42a914670229f403c9...HEAD`. It is an active remediation
plan authorized by the user. It does not rewrite the historical Phase A or Phase B
implementation plans.

The remediation preserves the Phase B architecture: external callers enter only
through `AgentGateway`, the Electron main process owns persistence, Renderer code
uses typed preload APIs, and no Phase C transport is introduced.

## Accepted findings

### F1 — broken high-autonomy trust selection (blocking)

`AgentControlCenterPage` renders `high_autonomy`, while the shared `TrustProfile`
contract accepts `autonomous`. The UI cast hides the mismatch from TypeScript and
the main-process validator rejects the submitted value.

Required outcome:

- The control center uses the canonical `TrustProfile` value `autonomous`.
- The visible Chinese label remains “高自治”.
- A regression test proves every rendered trust option belongs to
  `trustProfiles` and that the production page contains no forged trust cast/value.
- Existing access-update, session invalidation, and Electron flows remain green.

### F2 — unmigrated question writes are externally reachable (blocking)

Phase B permits external business access only for the B6 question/image/review
tranche and B7 task/focus tranche. The catalog and policy currently allow a
properly scoped external principal to reach unmigrated question commands,
including migration, rematching, bulk import, replacement, and clearing.

Required outcome:

- Define one code-owned Phase B external business-operation allowlist matching the
  operations that passed the B6/B7 Renderer/Gateway migration gates.
- An external principal is denied before workflow creation, admission, receipt,
  audit-success, or business dispatch for every operation outside that allowlist.
- Internal application callers keep their Phase A commands; this change must not
  delete or weaken internal handlers.
- The Renderer allowlist remains independently fixed and cannot be widened by
  caller input.
- Tests prove allowed B6/B7 external operations still work, every unmigrated
  question write is denied without side effects, and catalog/policy invariants
  cannot weaken the exposure boundary.

### F3 — misleading management allowlist name (structural)

`managementRecoveryAllowlist` is the source of truth for Renderer management
operations available while external control is disabled. Rename it to express the
actual Renderer-management boundary. Preserve exported API compatibility unless a
private-only rename is sufficient.

### F4 — duplicated sql.js row helpers (structural)

Five agent persistence modules duplicate the same prepared-statement `one`/`all`
resource-management logic.

Required outcome:

- Introduce one private agent-persistence helper module with narrow typed row
  lookup/list functions.
- Preserve binding, stepping, row order, error propagation, and unconditional
  statement cleanup.
- Replace the five duplicate implementations without exposing mutable database or
  coordinator capabilities.
- Add focused helper tests or equivalent consumer regressions, and keep the static
  database-writer gate green.

## Task ownership and ordering

### R1 — trust contract correction

Owned files:

- `src/renderer/pages/AgentControlCenterPage.tsx`
- `tests/electron/agentControlCenter.e2e.cjs`

R1 is independent and may run in parallel.

### R2 — external exposure boundary and allowlist naming

Primary owned files:

- `src/shared/agent/v1/operationCatalog.ts`
- `src/main/agent/policyEngine.ts`
- focused B3/B6/B10 tests needed to prove the boundary

R2 may add a narrow shared contract field or helper only when required to make the
boundary explicit and tamper-resistant. It must not remove internal application
commands or introduce Phase C transport code.

### R3 — sql.js helper consolidation

Primary owned files:

- a new helper under `src/main/agent/`
- `src/main/agent/auditLedger.ts`
- `src/main/agent/idempotencyStore.ts`
- `src/main/agent/workflows.ts`
- `src/main/agent/clientRegistry.ts`
- `src/main/agent/executionReceipts.ts`
- focused tests and the static writer inventory only if mechanically required

R3 is independent of R1 and R2. It must not change schema, SQL text, transaction
ownership, audit semantics, receipt semantics, or public interfaces.

## Acceptance matrix

All remediation work uses isolated temporary roots and never accesses
`D:\KaoyanMathMistakeBook`.

Minimum combined acceptance:

- `npm run build`
- focused trust-option Electron/static tests
- focused policy, authentication, Gateway, B6/B7 parity, receipt, workflow, audit,
  and database-writer tests affected by the edits
- `node --test tests/main/agent/*.test.cjs`
- `node --test tests/electron/agentControlCenter.e2e.cjs`
- `npm run test:main`
- `npm test`
- `npm run typecheck`
- `git diff --check`
- final `git status --short` contains only the authorized remediation files before
  the coordinator commits them

## Completion gate

The remediation is complete only when the coordinator directly verifies all three
worker results, confirms that external principals cannot execute unmigrated writes,
confirms that the high-autonomy UI path submits `autonomous`, and reruns the full
acceptance matrix. Structural refactoring must remain behavior-preserving.

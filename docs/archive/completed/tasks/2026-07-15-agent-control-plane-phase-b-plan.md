# Agent Control Plane Phase B Executable Implementation Plan

## Status and authority

This is the directly dispatchable production plan for Phase B of `docs/design/agent-control-plane.md`. It consumes landed Phase A; it does not amend Phase A. The controlling decision is a deep `AgentGateway` Module with exactly `execute(commandEnvelope, principal)` and `query(queryEnvelope, principal)`. Its Interface is the test surface. Approval, preview, apply, audit, policy, and client administration are workflow commands/queries, not shallow public pass-through Modules.

## Prerequisites, non-goals, and safety

### Prerequisites

- Phase A gates remain green: `tests/main/controlPlane/questionWriterGate.test.cjs`, `tests/main/controlPlane/databaseWriterGate.test.cjs`, and `tests/main/controlPlane/questionsEndToEnd.test.cjs`.
- Capture `git status --short` before each dispatch. Preserve all unrelated changes; never reset, clean, stash, or access `D:\KaoyanMathMistakeBook`.
- Every test uses a unique data root and Electron `userData` root from `tests/main/helpers/controlPlaneTestEnv.cjs`; assert neither is equal to or contained by the real default root.
- Worker owns only the listed files. A concurrent conflicting edit to an owned line is a blocker, not permission to overwrite it.

### Non-goals

- No MCP SDK, HTTP listener, stdio launcher, OAuth endpoint, public-key protocol, discovery file, package/distribution work, or any Phase C transport implementation.
- No uncontrolled broad migration. Phase B exposes only questions/images+reviews, then TickTick tasks/focus, after their Renderer paths use the same Gateway.
- No second queue, direct database mutation, direct renderer access to registry/audit tables, or a Gateway fallback around `CommandBus`, `QueryBus`, or `DatabaseCoordinator`.
- No raw credential accepted by Gateway, no renderer pairing/OAuth, no persistent blanket R4 approval, no audit deletion Interface, and no tests/builds against real data.

## Current and planned path inventory

All **current** paths below exist at plan authoring time. **Planned** paths do not exist until their owning task creates them.

| Kind | Paths and evidence | Phase B use |
| --- | --- | --- |
| Current | `src/shared/agent/v1/contracts.ts`, `src/shared/agent/v1/schemas.ts`, `src/shared/agent/errors.ts`, `src/shared/agent/index.ts` | Extend v1 contracts/errors without parallel agent vocabulary. |
| Current | `src/main/application/commandBus.ts`, `queryBus.ts`, `executionContext.ts`, `domainEvents.ts`, `questions/` | Gateway dispatches once to these landed Phase A Modules. |
| Current | `src/main/persistence/databaseCoordinator.ts`, `revisionStore.ts`, `operationJournal/`, `src/main/services/databaseService.ts` | The sole write queue, version/recovery authority, bootstrap integration. |
| Current | `src/main/ipc/adapters/questionsIpc.ts`, `src/main/ipc/registerIpc.ts`, `src/preload/preload.ts`, `src/shared/api.ts` | Existing renderer Adapter and IPC exposure to replace domain-by-domain. |
| Current | `src/main/services/ticktickService.ts`, `src/main/services/bridgeService.ts`, `src/renderer/pages/ticktick/`, `src/renderer/pages/SettingsPage.tsx`, `src/renderer/App.tsx` | Second migration tranche and control-center host. |
| Current | `tests/main/helpers/controlPlaneTestEnv.cjs`, `tests/main/controlPlane/*.test.cjs`, `tests/ipc/*.test.cjs` | Isolated main/IPC test conventions. |
| Planned | `src/shared/agent/v1/gatewayContracts.ts`, `src/shared/agent/v1/gatewaySchemas.ts`, `src/main/agent/`, `src/main/ipc/adapters/agentControlCenterIpc.ts` | Gateway contracts, deep implementation, and renderer Adapter. |
| Planned | `src/renderer/pages/AgentControlCenterPage.tsx`, `src/renderer/styles/agent-control-center.css`, `tests/main/agent/`, `tests/ipc/agentControlCenter.test.cjs`, `tests/electron/agentControlCenter.e2e.cjs` | Control center and focused verification. |

## Planned module layout

```text
src/shared/agent/v1/
  gatewayContracts.ts          # planned: principal, envelopes, outcomes, pages, errors
  gatewaySchemas.ts            # planned: runtime validation/canonicalization
  operationCatalog.ts          # planned: code-defined versioned descriptors
src/main/agent/
  agentGateway.ts              # planned: sole two-method external Interface
  executionReceipts.ts         # planned: receipt/audit transaction hook implementation
  clientAuthenticator.ts       # planned: raw credentials -> AgentPrincipal seam
  clientRegistry.ts            # planned: registry persistence, revocation, sessions
  policyEngine.ts              # planned: descriptor-bounded risk/trust decision
  idempotencyStore.ts          # planned: durable admission/replay
  workflows.ts                 # planned: approvals/change sets/R4 grants workflow commands
  auditLedger.ts               # planned: append-only chained segments/search/export
  pagination.ts                # planned: cursor signing, limits, redaction
  rendererAdapter.ts           # planned: trusted first-party credential adapter
  bootstrap.ts                 # planned: schema upgrade, recovery, module composition
src/main/application/
  questions/registerQuestions.ts       # planned edit: gateway-visible registrations
  ticktick/registerTickTick.ts         # planned: tasks/focus application registrations
src/main/ipc/adapters/
  agentControlCenterIpc.ts     # planned: typed Electron renderer Adapter
src/renderer/pages/
  AgentControlCenterPage.tsx   # planned: control-center presentation Adapter
src/renderer/e2e/
  AgentControlCenterHarness.tsx # planned: compiled test-only renderer scenario
src/renderer/styles/
  agent-control-center.css     # planned styling
tests/main/agent/
tests/ipc/
tests/electron/
  launchElectron.cjs           # planned: child_process runner for installed Electron
```

`AgentGateway` owns orchestration and is deep; `clientRegistry`, `policyEngine`, `idempotencyStore`, `executionReceipts`, `workflows`, and `auditLedger` are internal Implementation collaborators. They are not separately exposed to callers. Local-substitutable adapters (clock, UUID/hash, ledger storage, and Renderer credentials) are injected only at internal seams, with production and test adapters.

## Contracts and one responsibility sequence

### Typed Interfaces

```ts
interface AgentPrincipal {
  readonly kind: 'agent-principal'; readonly clientId: string; readonly subjectId: string;
  readonly displayName: string; readonly scopes: readonly Scope[]; readonly trust: TrustProfile;
  readonly credentialBinding: string; readonly authenticatedAt: string; readonly renderer: boolean;
}
interface ClientAuthenticator { authenticate(credentials: RawClientCredentials): Promise<AgentPrincipal>; }
interface AgentGateway {
  execute(envelope: AgentCommandEnvelope, principal: AgentPrincipal): Promise<AgentExecuteOutcome>;
  query(envelope: AgentQueryEnvelope, principal: AgentPrincipal): Promise<AgentQueryOutcome>;
}
interface OperationDescriptor {
  readonly name: OperationName; readonly catalogVersion: string; readonly requiredScopes: readonly Scope[];
  readonly inputSchema: Schema; readonly outputSchema: Schema; readonly idempotency: 'required' | 'none';
  resolveRisk(input: unknown, state: ResolvedState): RiskLevel;
  readonly policyBounds: DescriptorPolicyBounds; readonly recovery: RecoveryRequirement;
}
interface OperationCatalog { readonly version: string; readonly hash: string; resolve(name: OperationName): OperationDescriptor; }
interface PolicyDecision { readonly disposition: 'execute' | 'requires_approval' | 'requires_changeset' | 'deny'; readonly risk: RiskLevel; readonly reasonCode: string; }
interface AgentExecuteOutcome { readonly kind: 'completed' | 'replayed' | 'pending_approval' | 'pending_changeset' | 'rejected'; readonly result?: CommandResult; readonly workflow?: WorkflowRef; readonly error?: SerializedAgentError; }
interface AgentQueryOutcome { readonly kind: 'completed' | 'rejected'; readonly result?: QueryResult; readonly page?: PageInfo; readonly error?: SerializedAgentError; }
interface ExecutionReceipt { readonly clientId: string; readonly requestId: string; readonly payloadHash: string; readonly status: ReceiptStatus; readonly dataVersion?: DataVersion; }
```

`AgentCommandEnvelope` contains `operation`, validated payload, `requestId`, optional expected version, and optional workflow reference; `AgentQueryEnvelope` contains `operation`, payload, field selection/detail level, and cursor/page size. Contracts define `ApprovalRecord`, `ChangeSet`, `R4Grant`, `IdempotencyRecord`, `AuditRecord`, `AuditCursor`, and `RedactionProfile` as immutable, versioned DTOs. Error codes add stable `EXTERNAL_CONTROL_DISABLED`, `CLIENT_REVOKED`, `SCOPE_DENIED`, `POLICY_DENIED`, `APPROVAL_REQUIRED`, `APPROVAL_INVALID`, `IDEMPOTENCY_CONFLICT`, `CATALOG_VERSION_MISMATCH`, `CURSOR_INVALID`, and `AUDIT_INTEGRITY_FAILURE`; they serialize no secrets, raw payload, or stack.

### Atomic call sequence and internal seam

`AgentGateway` never mutates SQL. It uses an internal `GatewayCommandDispatcher` seam implemented by `CommandBus`; that Module owns the only `executeWithExecutionReceipt` capability. The capability supplies a `PreparedReceipt` to `DatabaseCoordinator`'s `executeBusinessWrite` request. It is inaccessible to adapters and is not a third Gateway method. `DatabaseCoordinator` exposes only composition-internal `executeBusinessWrite` and `executeControlWrite`, each on its existing one physical FIFO queue and atomic publisher. Persistence uses an internal `DatabaseGeneration = { dataEpoch, dataRevision, controlRevision }`; the public optimistic-concurrency token remains `DataVersion = { dataEpoch, dataRevision }`.

1. A transport Adapter authenticates raw credential material through `ClientAuthenticator`; the Renderer Adapter supplies a constrained local management or migrated-domain principal.
2. Gateway validates, canonicalizes, resolves descriptor/state/risk, and evaluates policy exactly once. Disabled external control denies external principals here; Renderer management receives only its narrow recovery catalog allowlist.
3. For a business write, `executeControlWrite` atomically creates/reads the `{clientId,requestId}` receipt, rejects a mismatched hash, appends `admitted`, and, for R4, reserves exactly one grant with client/request/payload/affected-set/base-version/catalog bindings. It increments only `controlRevision`.
4. A terminal receipt replays without a Command Bus call. A non-terminal receipt is not retried until startup reconciliation determines it was pre-commit.
5. Gateway passes the prepared receipt to `CommandBus.executeWithExecutionReceipt` once. In the coordinator's one business SQL transaction the domain handler runs, `dataRevision` increments at most once for a semantic domain change, and the receipt hook verifies reservation/bindings then writes terminal receipt/idempotency, R4 consumption, and terminal audit record/hash before `COMMIT`; because control rows changed, `controlRevision` also increments exactly once. A semantic no-op preserves `dataRevision` but still advances `controlRevision` with its terminal receipt.
6. The coordinator atomically publishes/reopens the one database image. Only then are domain events published and the Gateway result returned. A lost response is replayed from the terminal receipt.
7. Query completion, denial, admission, client/policy change, and restart reconciliation append their required audit record in `executeControlWrite`; they increment `controlRevision`, never `dataRevision`, and return only after verified publication.

There is no second queue, no Gateway direct database write, and no post-command best-effort audit path. Receipt/audit construction failure rolls back the business transaction; an ambiguous atomic publication is an external-write fence, not a retryable success.

## Persistence, migration, retention, and restart

All tables are added by idempotent schema migrations through the Phase A bootstrap/coordinator path, have UTC ISO timestamps, and use strict validated canonical JSON where normalized child rows are not required. Foreign keys are enabled after every reopen. `control_metadata` gains `control_revision INTEGER NOT NULL CHECK (control_revision >= 0)`; only coordinator-owned capabilities increment it. `dataRevision` remains the sole caller concurrency token for business data. Atomic persistence and candidate inspection validate the full internal generation. Within one epoch recovery orders candidates lexicographically by `(dataRevision, controlRevision)`; it never orders opaque epochs without transition evidence. Fresh epoch replacement resets both revisions to zero.

| Table | Constraints and indexes | Lifecycle |
| --- | --- | --- |
| `agent_control_settings` | singleton `id=1`; enabled, catalog/policy/privacy revisions; strict canonical JSON policy override plus hash | Bootstrap defaults disabled. Catalog mismatch fences external business writes but keeps the renderer management recovery allowlist. |
| `agent_clients` / `agent_client_scopes` | PK client; unique credential binding; `trust` CHECK enum; normalized scope rows FK client/catalog with unique `(client_id,scope)`; indexes `(revoked_at,last_active_at)` and scope lookup | Revocation invalidates sessions/grants immediately. |
| `agent_sessions` | PK session_id; FK client; unique credential/session binding; terminated_at; index `(client_id,expires_at)` | Phase B renderer session is process-local durable record; restart terminates active sessions. |
| `agent_idempotency` (execution receipts) | unique `(client_id,request_id)`; payload/catalog/affected/base hashes; status CHECK `admitted|completed|failed|indeterminate|interrupted_precommit`; terminal outcome canonical JSON/hash; index `(status,updated_at)` | Same hash replays terminal receipt; mismatched hash conflicts; ordinary terminal rows retain 30 days. |
| `agent_r4_grants` | PK; exact operation/target/catalog bindings; status CHECK `active|reserved|consumed|revoked|expired`; `reserved_request_id` unique where reserved; indexes `(client_id,status,expires_at)` and reserve lookup | Reserve atomically in control write; consume only in matching business receipt transaction. |
| `agent_approvals` | PK; unique nonce; client/catalog/payload/affected/version hashes; consumed/revoked/expires; index `(status,expires_at)` | One use; invalidated on client revoke, policy/catalog/version mismatch, expiry, or changed base. |
| `agent_changesets` / `agent_changeset_operations` | immutable planned operations; FK; base epoch/revision; status CHECK; canonical operation JSON/hash; index `(client_id,status,expires_at)` | Audit lifecycle; restart preserves pending state and revalidation requirement. |
| `agent_audit_segments` | PK segment; previous closing hash; opened/closed sequence/hash | Cleanup closes and anchors a segment before opening successor. |
| `agent_audit_events` | append-only sequence PK; unique `(segment_id,sequence)`; event kind CHECK `admission|denial|query|success|failure|indeterminate|reconciliation|control`; previous/hash; indexes `(occurred_at,client_id,risk,operation)` and `(receipt_client_id,receipt_request_id)` | R0-R2 180 days; R3/R4/auth/pair/revoke/policy/catalog >=1 year. No update/delete path. |

Canonical payload hashing uses deterministic JSON after schema validation (sorted object keys, normalized strings/numbers, no omitted-vs-null ambiguity) and a versioned hash algorithm. Audit hashes commit canonical redacted summaries, prior hash, segment, sequence, catalog/policy versions, receipt identity, and outcome references. Ledger verification runs on startup and before export. Startup first completes Phase A candidate recovery using the full internal generation, then verifies the ledger and reconciles receipts: a selected candidate with terminal receipt is authoritative; `admitted`/`reserved` without terminal receipt becomes one control-mode `interrupted_precommit` receipt/audit and releases the reservation; any candidate/ledger ambiguity fences external writes. Audit materialization failure before transaction commit rolls back; an audit record cannot be missing from a successful terminal receipt. Cleanup is an R4 catalog operation executed through Gateway, creates a new verifiable segment, and cannot be invoked by clients to remove arbitrary audit events.

### Crash matrix and audit return semantics

| Crash/failure point | Selected durable state and response | Restart action |
| --- | --- | --- |
| Before control admission | No receipt/audit; no execution | Treat as never received. |
| After admission/reservation | `admitted`/`reserved`, admission audit, no business mutation | Mark `interrupted_precommit`, append reconciliation audit, release reservation. |
| During domain transaction or audit-hook construction | SQL rollback; no terminal receipt/audit/domain change | Write known failed control receipt/audit and release reservation; if process crashed first, same reconciliation. |
| After SQL commit before atomic publish | Live candidate has the admitted generation; any published candidate carries the higher data and/or control generation with terminal receipt | Select by full same-epoch generation; reconcile the selected receipt, while cross-epoch or generation ambiguity fences. |
| After atomic commit before response | Terminal receipt, terminal audit, domain change, R4 consumption together | Replay exact terminal outcome; never execute again. |
| Audit materialization/publish failure | Pre-commit audit failure rolls back; ambiguous publication returns no success and fences | Verify candidate/ledger before reopening external writes. |
| Query/denial audit control-write failure | No business mutation; return `AUDIT_UNAVAILABLE`, not an unaudited result | Retry only the control query/denial after recovery. |

## Task DAG and dispatch rules

Each task inherits: isolated roots; no real data; exact owned files only; narrow tests plus `npm run build:main`, `npm run typecheck`, and `git diff --check -- <owned files>` unless explicitly superseded; report the worker-manual format; preserve predecessor behavior on failure; no raw-persistence fallback. The coordinator validates returned claims, file scope, tests, and `git status` before accepting a dependency.

| ID | Depends on | Exclusive ownership / parallelism | Checkpoint |
| --- | --- | --- | --- |
| B0 | none | test helper plus planned `tests/electron/launchElectron.cjs`; first and alone | Isolated roots and a real installed-Electron smoke launcher accepted. |
| B1 | B0 | shared contracts/catalog + contract tests; alone | Receipt/control-mode contracts and validators accepted before source changes. |
| B2 | B1 | `schema.ts`, coordinator/revision/CommandBus and receipt-hook tests; alone | One queue, `controlRevision`, and atomic receipt hook accepted. |
| B3 | B2 | client/auth/policy/pagination plus schema migration/tests; alone | Principals, disabled allowlist, descriptors, and policy bounds accepted. |
| B4 | B3 | idempotency/audit/workflow plus schema migration/tests; alone | Receipt reserve/finalize/reconcile and chained ledger accepted. |
| B5 | B4 | Gateway composition/bootstrap/database integration/tests; alone | Two-method Gateway passes crash/replay internal tests. |
| B6 | B5 | questions registrations, questions IPC adapter, Gateway migration tests; alone | Questions/images+reviews Renderer/Gateway parity gate. |
| B7 | B6 | TickTick application, IPC Adapter/register, and TickTick source/tests; alone | Tasks/focus migration gate. |
| B8 | B7 | control-center shared API/preload/main IPC; alone after TickTick releases IPC | Typed control-center contract available. |
| B9 | B8 | `App.tsx`, `SettingsPage.tsx`, new page/style, test-only Electron harness, Electron tests; alone | Full hard-gate UI works through typed IPC. |
| B10 | B6-B9 | gates and Electron tests only; alone | Final product completion matrix with no historical document edit. |

### B0 - Isolated Phase B environment

**Objective:** extend the Phase A helper with unique agent database/userData/ledger roots, deterministic clock/UUID, and a real-process Electron launcher; assert the real data root is never opened.

**Owned files:** `tests/main/helpers/controlPlaneTestEnv.cjs`, `tests/main/agent/testEnv.test.cjs`, `tests/electron/launchElectron.cjs`, `tests/electron/electronLaunch.test.cjs`.

**Implementation/tests/acceptance:** use Node `child_process.spawn`, `require('electron')` (the installed binary declared in `package.json`), and the built main/renderer output. Delete inherited `ELECTRON_RUN_AS_NODE`; pass a unique `--user-data-dir`, `KAOYAN_E2E_HARNESS=1`, and owned result-file path; enforce timeout/kill/exit capture and assert all paths lie under B0's temporary root. No Playwright, Spectron, browser driver, new dependency, or package/config edit is assumed. The smoke test starts the binary, waits for a structured harness-ready file, then terminates it. Later B9 supplies the harness route/IPC scenario; B0 proves only launch mechanics. Failure deletes only B0 files.

### B1 - Gateway contract vocabulary

**Owned files:** `src/shared/agent/v1/gatewayContracts.ts`, `gatewaySchemas.ts`, `operationCatalog.ts`, `src/shared/agent/v1/contracts.ts`, `schemas.ts`, `errors.ts`, `index.ts`, `tests/main/agent/gatewayContracts.test.cjs`.

**Implementation:** define receipt/control-write, audit-kind, R4 reservation, disabled-management allowlist, strict DTO validators, canonical form, cursor/redaction DTOs, catalog version/hash, and stable workflow discriminators. Extend existing App unions only through explicit versioned registrations; do not loosen `CallerExecutionContext` or accept a principal from caller input.

**Acceptance/failure:** tests reject unknown fields, forged principal-shaped values, invalid UUIDs/cursors, malformed catalog, wildcard R4 grant, mismatched catalog hash, invalid receipt transition, and unbounded page size. A failing contract change is reverted by reviewed edits to B1 files only.

### B2 - Coordinator control mode and atomic execution receipt seam

**Owned files:** `src/main/database/schema.ts`, `src/main/persistence/databaseCoordinator.ts`, `revisionStore.ts`, `atomicPersist.ts`, `databaseCandidate.ts`, `recoveryState.ts`, `src/main/persistence/index.ts`, `src/main/application/commandBus.ts`, `tests/main/agent/coordinatorReceipt.test.cjs`, `tests/main/controlPlane/databaseCoordinator.test.cjs`, `atomicPersist.test.cjs`, `databaseRecovery.test.cjs` (focused appends).

**Implementation:** add `control_revision` migration/constraints; implement coordinator-owned business/control modes, table-family guards, and the CommandBus internal receipt hook capability. Extend atomic publication, database-candidate inspection, expected-generation validation, and same-epoch recovery to use `DatabaseGeneration`, ordered by data revision then control revision; keep cross-epoch transition evidence mandatory. The business hook runs after the handler and before `COMMIT`; it writes an injected receipt/audit payload in the same transaction as domain changes, increments data revision once only for semantic domain change, and increments control revision once for terminal control rows. Control writes are serialized and atomically published but only change `controlRevision`. Gateway cannot import coordinator capability.

**Tests/acceptance/failure:** prove business write plus receipt/audit is one transaction/image, semantic business revision increments once, control writes and receipt-only no-ops preserve public data version while advancing control generation, table-family violations/nested writes fail, and receipt-hook failure rolls back domain mutation. Candidate tests prove control-only and receipt-only generations select the newest durable image, corrupt/ambiguous generations fence, and opaque epochs are never ordered. Inject crash points during transaction, post-commit/pre-publish, and post-publish/pre-response candidate selection. A failed coordinator change leaves Phase A behavior authoritative through reviewed B2-only rollback.

### B3 - Client authenticator, registry, catalog, and policy Modules

**Owned files:** `src/main/database/schema.ts`, `src/main/agent/clientRegistry.ts`, `clientAuthenticator.ts`, `rendererAdapter.ts`, `policyEngine.ts`, `pagination.ts`, `src/main/agent/bootstrap.ts`, `tests/main/agent/clientRegistry.test.cjs`, `clientAuthenticator.test.cjs`, `policyEngine.test.cjs`, `paginationRedaction.test.cjs`.

**Implementation:** add settings/client/scope/session schema with normalized scope rows and strict canonical policy JSON; compose renderer and test adapters with `ClientAuthenticator`; immutable principal issuer is private. Implement catalog descriptor bounds, resolved risk, and the disabled external-principal denial / renderer-management allowlist. Renderer Adapter identifies only the local app principal and never accepts a renderer-supplied client ID.

**Tests/acceptance:** credential binding uniqueness, disabled/revoked external denial, renderer allowlist denial for business operations, session restart/termination, scope narrowing, immutable principal, policy invariant protection, R4 permanent/wildcard denial, and no raw credential in error/audit material. Phase C adapters implement only `ClientAuthenticator`; Gateway stays untouched.

### B4 - Durable receipts, R4 reservation, workflows, and ledger

**Owned files:** `src/main/database/schema.ts`, `src/main/agent/idempotencyStore.ts`, `executionReceipts.ts`, `auditLedger.ts`, `workflows.ts`, `tests/main/agent/idempotency.test.cjs`, `r4GrantReservation.test.cjs`, `auditLedger.test.cjs`, `receiptRecovery.test.cjs`.

**Implementation:** add receipt, grant, approval, changeset, segment, and audit schema/constraints/indexes. Implement control-mode admission, terminal receipt construction for B2 hook, atomic R4 reserve, same-transaction consume, known-failure release, ledger chain, audit search/export, and startup reconciliation. No generic audit/idempotency control writer is exposed outside these internal collaborators.

**Tests/acceptance:** same-hash replay, mismatch conflict, denial/admission/success/failure/indeterminate audit records, changed/deleted/reordered chain detection, retention, and every crash-matrix row. Two concurrent R4 requests prove exactly one `reserved`, one executor, consumption only with terminal business receipt, release only after definite pre-commit failure, and ambiguous/restart fencing rather than release. No audit update/delete Interface exists.

### B5 - Deep AgentGateway composition and startup reconciliation

**Owned files:** `src/main/agent/agentGateway.ts`, `src/main/agent/bootstrap.ts`, `src/main/services/databaseService.ts`, `tests/main/agent/agentGateway.test.cjs`, `workflowStateMachine.test.cjs`.

**Implementation:** compose B2-B4 behind exactly two Gateway methods. Convert only verified principal to trusted context; use control admission then CommandBus receipt dispatch for writes and QueryBus plus control audit for queries. Startup performs Phase A candidate recovery, ledger verification, and receipt/grant reconciliation before external admission; catalog mismatch fences external business writes but keeps renderer-management recovery catalog available.

**Tests/acceptance:** call sequence asserts one authenticator call outside Gateway, one policy decision, one control admission, exactly one receipt-enabled CommandBus call, and zero Gateway coordinator calls. Test disabled control, renderer allowlist, stale approval, revocation after preview, replay, audit outcomes, recovery fence, and maintenance fence. No method other than `execute`/`query` is public on Gateway.

### B6 - Questions/images+reviews Renderer migration gate

**Owned files:** `src/main/application/questions/registerQuestions.ts`, `src/main/ipc/adapters/questionsIpc.ts`, `src/main/ipc/registerIpc.ts`, `tests/main/agent/questionsGatewayParity.test.cjs`, `tests/ipc/questions-command-adapter.test.cjs`, `tests/main/agent/questionsGatewayGate.test.cjs`.

**Implementation:** register catalog descriptor-to-application mappings; Renderer Adapter calls Gateway with its authenticated first-party principal rather than Command/Query Bus directly. External and Renderer writes share schemas, canonical hash, idempotency, policy/risk, version/recovery, audit, events, and error mapping. Preserve renderer public return shapes through its IPC Adapter; do not expose a Phase C transport.

**Acceptance/failure:** prove create/update/delete/image removal/review Renderer and Gateway parity, exactly-one side effect under retries, stable stale conflict, correct audit chain, and no question write bypasses Gateway. A failed migration leaves existing adapter authoritative; it must not add a direct fallback beside the Gateway path.

### B7 - TickTick tasks/focus application migration gate

**Owned files:** `src/main/application/ticktick/contracts.ts`, `commands.ts`, `queries.ts`, `registerTickTick.ts`, `src/main/ipc/adapters/ticktickIpc.ts`, `src/main/ipc/registerIpc.ts`, `src/main/services/ticktickService.ts`, `src/main/services/bridgeService.ts`, `tests/main/agent/tickTickGatewayParity.test.cjs`, `tests/main/agent/tickTickGatewayGate.test.cjs`, `tests/main/ticktickService.test.cjs`.

**Implementation:** first migrate task create/update/complete/uncomplete/delete and focus create/list through application handlers, then Renderer Gateway Adapter. Preserve bridge correctness and Phase A coordinator containment; no broad list/habit/settings migration. Catalog risk distinguishes single task/focus R2 from recursive/batch R3 and drives required approval/change set.

**Acceptance:** Renderer/Gateway parity for tasks/focus, review bridge behavior remains atomic/compensated as Phase A requires, direct writer static gate is green, and no unmigrated TickTick operation becomes externally exposed.

### B8 - Control-center shared, main, and preload Adapter

**Owned files:** `src/shared/api.ts`, `src/preload/preload.ts`, `src/main/ipc/adapters/agentControlCenterIpc.ts`, `src/main/ipc/registerIpc.ts`, `tests/ipc/agentControlCenter.test.cjs`.

**Implementation:** add a narrow typed `agentControl` namespace that invokes Gateway workflow commands/queries. Main owns enable/status, client list/revoke, scopes/trust, R4 grants, pending approvals/change sets, sessions/terminate, audit search/export, policy/catalog versions, and privacy disclosure. Disabled external control remains denied; this Adapter invokes the Renderer management allowlist only. Preload exposes only fixed functions and validates IPC result envelopes; it exposes neither registry storage nor generic command forwarding.

**Acceptance:** channels reject arbitrary operation names, no token/key/absolute sensitive path crosses preload, revoke/terminate takes effect on next request, and every control mutation has audit evidence.

### B9 - External-agent control-center hard gate

**Owned files:** `src/main/main.ts`, `src/preload/preload.ts`, `src/renderer/App.tsx`, `src/renderer/pages/SettingsPage.tsx`, `src/renderer/pages/AgentControlCenterPage.tsx`, `src/renderer/e2e/AgentControlCenterHarness.tsx`, `src/renderer/styles/agent-control-center.css`, `tests/electron/agentControlCenter.e2e.cjs`.

**Implementation:** mount a dedicated control-center route from Settings. It renders enable/status; clients/revoke; scopes/trust; operation-bound R4 grants; pending approvals/change sets; sessions/terminate; audit filter/search/export with verification status; policy/catalog versions; and a clear privacy disclosure of cloud-model data sharing. It is a presentation Adapter only: no policy/risk/auth implementation in renderer and no direct database access.

**Electron tests/acceptance:** B9 uses B0's `child_process` launcher and installed Electron binary, not Playwright or a missing test runner. Only when `KAOYAN_E2E_HARNESS=1` is set by that launcher, `main.ts` loads the compiled harness route and exposes a fixed, test-only result-file IPC channel whose path is validated as B0-owned; production builds and ordinary development reject this channel. The harness drives the same typed preload `agentControl` functions, writes assertion results through that channel, and exits. The real isolated process verifies disabled state, enable flow, client row, scope/trust change, R4 grant details/expiry, approval display/apply/reject, immediate revoke/session termination, audit search/export, catalog/policy display, and privacy copy. Test reload/restart preserving durable state; no real root is touched.

### B10 - Completion gates and recovery matrix

**Owned files:** `tests/main/agent/phaseBCompletion.test.cjs`, `tests/main/agent/agentGatewayStaticGate.test.cjs`, `tests/electron/agentControlCenter.e2e.cjs`.

**Implementation:** static scan proves no migrated Renderer/external write bypasses Gateway and no Gateway direct coordinator call. Complete cross-process restart and isolated-root matrix. Keep Phase A documents historical: Phase B evidence stays in these gate tests and this plan; B10 must not edit `2026-07-15-agent-control-plane-write-entry-inventory.md`. Do not edit production source to make a gate pass.

**Final validation:** `npm run build:main`; `node --test tests/main/agent/*.test.cjs`; focused Phase A gates; `npm run test:main`; `npm test`; `npm run typecheck`; targeted Electron test; `git diff --check`; final `git status --short`. Existing unrelated failures are recorded, not masked.

## Renderer migration gates

1. **Questions/images+reviews:** B6 requires current Phase A gates green, descriptor/schema/runtime validator, Renderer and external Adapter parity, durable idempotency, audit assertion, revision conflict test, image journal failure/restart test, and static proof that listed renderer IPC writes use Gateway. Only then may Phase C register corresponding external operations.
2. **TickTick tasks/focus:** B7 starts only after B6 acceptance. It requires handler/catalog coverage, coordinator ownership, Renderer/Gateway parity, bridge compensation test, task/focus revision/idempotency/audit tests, and a static gate for the explicitly migrated set. All other TickTick features stay non-exposed.

## Measurable completion matrix

| Area | Required measurable evidence |
| --- | --- |
| Principal/authentication | forged/raw credential rejected; revoke/terminate denies next request; restart ends Phase B sessions. |
| Full control/R4 | trusted Codex R0-R3 auto executes; every R4 requires descriptor/target/catalog-bound one-use or expiry grant. |
| Catalog/policy | all descriptors tested allow/deny; persisted policy cannot weaken an invariant. |
| Idempotency | three same-hash retries have one durable effect; mismatch conflicts; terminal receipt restart replay has no second bus call. |
| Audit | admission/denial/query/success/failure/indeterminate records verify; alteration detected; required retention classes; cleanup starts anchored segment. |
| Migration | questions first then tasks/focus parity/gates green; no unmigrated external writes. |
| Control center | all ten hard-gate areas render through shared/preload/main ownership and Electron test. |
| Isolation/recovery | every main/Electron test proves unique roots; all crash-matrix receipt/audit/grant outcomes survive restart as specified. |

## Phase C handoff contract

Phase C may add HTTP OAuth and stdio public-key `ClientAuthenticator` Adapters plus MCP protocol Adapters. Each authenticates raw material and emits the same immutable `AgentPrincipal`, then calls only `AgentGateway.execute` or `.query`. It must not change Gateway Interface, catalog/policy semantics, application handler mapping, idempotency keys, audit records, workflow DTOs, or Renderer behavior. Transport session/OAuth/key validation remains outside Gateway; Phase B test and renderer adapters remain valid regression adapters.

## Risks, rollback, and recovery

- **Schema migration or ledger verification failure:** keep database authoritative, fence only external writes, surface status in control center, and preserve evidence; never initialize a blank ledger over existing records.
- **Gateway integration failure:** retain the last accepted Renderer Adapter until B6/B7 gate is ready; remove incomplete owned integration by reviewed edit, never a hidden bypass.
- **R4 or cleanup failure:** reservation is consumed only in the terminal receipt transaction; ambiguous durable state remains reserved and becomes an external-write recovery fence, never success or reusable authority.
- **Control-center UI failure:** keep external control disabled by default; no client gets authority merely because UI state is incomplete.
- **Rollback:** revert only the failing task's owned files after preserving migration/ledger evidence. Runtime recovery uses Phase A coordinator/journal behavior; no destructive Git command and no real-data restoration.

## Dispatch order

Dispatch B0, then B1, B2, B3, B4, and B5 sequentially: B2, B3, and B4 each exclusively own `src/main/database/schema.ts`, and B2 also owns the coordinator/CommandBus receipt seam consumed by all later tasks. Dispatch B6, then B7, then B8 because all three own `src/main/ipc/registerIpc.ts`. B9 follows B8 because it reopens `src/main/main.ts` and `src/preload/preload.ts` for the test harness. B10 follows B6-B9. Every hard task uses the configured hard-task model with medium thinking and repeats exact ownership, non-goals, validation, and the worker response format.

# Agent Control Plane Phase C Implementation Plan

## Status and authority

This is the executable Phase C plan confirmed by the user on 2026-07-16 after a
decision-by-decision grilling session. It refines the sequencing in
`docs/design/agent-control-plane.md` without weakening the accepted Phase A/B
safety invariants.

Revision 1 incorporates the independent acceptance review completed on
2026-07-16. C0 is the only dispatchable task until its evidence gate passes; C1
through C15 remain gated by the corrected dependencies below.

Revision 2 replaces unavailable Claude Desktop with the installed Claude Code CLI
as the second hard client. Claude Desktop becomes an optional compatibility target
and cannot block Phase C.

Revision 3 records the 2026-07-22 product decision after packaged C14 evidence:
Codex CLI remains the required real client. Claude Code's browser authorization
works but its token exchange is waived as a non-blocking compatibility gap.
DeepTutor is deferred to a separate product decision and does not enter Phase C.

Phase C turns the accepted `AgentGateway` into a real, installable MCP product.
It does not add a second business path: every external request authenticates into
an immutable `AgentPrincipal` and then calls only `AgentGateway.execute` or
`AgentGateway.query`.

The first usable milestone is stdio through a local launcher. Direct Streamable
HTTP OAuth remains a Phase C completion requirement, but it does not block early
personal use.

## Confirmed product decisions

1. **Transport order:** ship stdio first over an App-owned loopback service;
   implement direct HTTP OAuth in the second half of Phase C.
2. **Hard client:** Codex CLI is the required real-client acceptance target.
   Claude Code remains an optional compatibility target with its C14 token-exchange
   gap recorded explicitly; DeepTutor is outside Phase C.
3. **Pairing:** pairing starts in the App control center. The App installs a
   stable launcher and requests a per-client identity, while the launcher creates
   and owns the private key in Windows secure storage. The App registers only the
   public binding through audited Gateway management operations, configures the
   client with explicit consent, and offers a manual fallback.
4. **Default authority:** a new client starts read-only. The user may select the
   `trusted personal AI` preset: migrated read/write scopes, R0-R3 automatic
   execution, and operation-bound one-use/time-limited approval for every R4.
5. **Delivery gates:** the current 19 accepted B6/B7 operations form the first
   usable vertical slice. Phase C remains open until the planned domain waves,
   direct HTTP OAuth, and packaging matrix are complete.
6. **MCP primitives:** actions and dynamic bounded queries use tools; stable
   addressable views use resources/templates; reusable workflows use bilingual
   prompts. No generic `execute(operation, json)` tool exists.
7. **Exposure:** catalog metadata and shared validators are reused, but every MCP
   tool is explicitly registered. Internal commands never become external merely
   because they exist.
8. **Data disclosure:** trusted clients may receive full text; list responses are
   summarized and paginated; full objects are addressed resources; image access
   uses a separate scope and explicit request. Backups, exports, and raw import
   assets remain separately privileged.
9. **Lifecycle:** a launcher may start the App in background `agent-startup`
   mode. Disconnecting the last client does not automatically exit the App.
10. **Idempotency:** the launcher keeps a durable forwarding journal. All writes
    support explicit idempotency keys; R3/R4, batch, and cross-resource writes
    require one.
11. **Protocol compatibility:** MCP `2025-11-25` is the baseline. Add only the
    backward versions required by measured Codex CLI/Claude Code behavior, with an exact
    test matrix for every supported version.
12. **Domain order:** knowledge/textbooks/analytics; study supervision/plans;
    question bank/structured import; habits/calendar/remaining TickTick; then
    backup/restore/clear/root migration. UI navigation may arrive early but may
    not simulate clicks to bypass a domain boundary.
13. **Jobs:** Phase C implements a minimal durable job substrate for long MCP
    operations. Phase D retains autonomous scheduling, retry policy, dependency
    graphs, and day/week execution.
14. **UI behavior:** external events invalidate/refresh Renderer data. The App
    comes to foreground only after an explicit open/show request. Human-action
    states use Windows notifications and foreground only after the user clicks.
15. **Threat boundary:** discovery alone grants nothing; keys use Windows secure
    storage; replay/cross-client/revoked sessions are rejected. Arbitrary code
    execution as the same fully compromised OS user is outside the promised
    boundary.
16. **Privacy:** no automatic telemetry. Logs are local and redacted; diagnostic
    bundles are user-initiated and previewed before export.
17. **Configuration ownership:** the App backs up, merges, repairs, disconnects,
    and rolls back only its own Codex CLI/Claude Code configuration entries and launcher
    manifest.
18. **Launcher product:** TypeScript source, distributed as a standalone Windows
    executable that requires no separately installed Node.js. The exact
    executable technology is selected by a measured spike.
19. **Concurrency:** multiple trusted writers are supported for the personal
    setup; coordinator serialization and epoch/revision conflicts prevent silent
    overwrite. A single-writer policy remains available.
20. **Language:** stable protocol identifiers and base descriptions are English;
    prompts are Chinese/English; control-center UX is Chinese-first.
21. **AI import:** Codex CLI/Claude Code multimodal structured drafts are the primary
    import path. App OCR/DeepSeek are explicit fallbacks. Both enter the same
    validation, preview/change-set, idempotency, and recovery path.
22. **Capability upgrades:** App updates may publish new definitions but never
    silently expand an existing client's scopes. Clients see only authorized
    tools plus a safe capability-summary resource.
23. **Offline boundary:** MCP control, pairing, audit, and local operations need
    no project cloud account. Model connectivity belongs to the external client;
    optional App network processors declare their own boundary.
24. **Compatibility:** schemas evolve additively. Breaking changes get a new
    versioned tool/resource and an explicit deprecation window.
25. **Signing:** personal builds use version/hash mutual verification. Public
    release requires stable Windows code signing for App, launcher, and update
    manifests.
26. **R4 separation:** an AI may request and inspect approval but cannot approve
    its own request. Approval comes only from local user action and is bound to
    client, operation, payload, targets, version, catalog, nonce, and expiry.
27. **Prompt injection:** imported or stored content is untrusted data, never
    authority or server instructions. Provenance survives reads and imports.
28. **Emergency stop:** immediately deny new external admissions and sessions;
    already-admitted short transactions finish/rollback atomically and long/file
    operations stop only at journal-defined safe points.

## Verified external baselines at plan time

- MCP current protocol version is `2025-11-25`; version negotiation occurs during
  initialize and a session uses exactly one agreed version.
- stdio uses newline-delimited JSON-RPC; stdout contains protocol messages only
  and diagnostics use stderr.
- Streamable HTTP uses one endpoint supporting POST and GET; local servers bind
  localhost, validate Origin, and authenticate every connection.
- MCP HTTP authorization uses protected-resource metadata, authorization-server
  discovery, OAuth 2.1, PKCE S256, exact redirect validation, and RFC 8707
  resource/audience binding. The protected MCP resource identifier and
  authorization-server endpoints use HTTPS with ordinary TLS certificate
  validation; localhost binding is not by itself an HTTP exemption.
- Tasks are experimental in `2025-11-25`; the App job state machine is
  authoritative and Tasks are an optional negotiated projection.
- The official TypeScript SDK repository recommends production v1 until stable
  v2. At plan time npm reports `@modelcontextprotocol/sdk@1.29.0` as stable and
  `@modelcontextprotocol/server@2.0.0-beta.4` as pre-release. C1 pins v1.29.0
  exactly and records a future v2 upgrade gate; no caret range is permitted.
- Codex CLI supports stdio and Streamable HTTP/OAuth, shares MCP settings through
  `config.toml`, and supports CLI registration. Claude Code is the second hard CLI
  and its stdio/HTTP/OAuth behavior is measured independently through `claude mcp`.
  Claude Desktop remains an optional future `.mcpb`/local-config target; its
  absence or behavior is never used as evidence for or against Claude Code.

Official references:

- <https://modelcontextprotocol.io/specification/2025-11-25/basic/transports>
- <https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization>
- <https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks>
- <https://modelcontextprotocol.io/docs/learn/versioning>
- <https://github.com/modelcontextprotocol/typescript-sdk>
- <https://docs.anthropic.com/en/docs/mcp>
- <https://support.anthropic.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop>

## Architecture boundary

```text
Codex CLI / Claude Code CLI
           │ stdio JSON-RPC
           ▼
  standalone kaoyan-mcp.exe
  - stdout protocol only
  - discovery validation
  - client key challenge
  - durable forwarding journal
           │ authenticated loopback bridge
           ▼
 Electron main MCP host (127.0.0.1)
  - protocol/session adapter
  - authorized tool/resource/prompt registry
           │ immutable AgentPrincipal
           ▼
       AgentGateway
           │
 Application buses / DatabaseCoordinator / operation journal
```

The direct HTTP lane later terminates OAuth at a separate authenticator adapter
and joins at the same MCP protocol registry and `AgentGateway` seam. Raw public
keys, credentials, bearer tokens, OAuth codes, PKCE material, and MCP session IDs
never enter Gateway envelopes or audit payloads.

## Non-goals

- No direct database, service, CommandBus, QueryBus, IPC, or arbitrary operation
  access from MCP or launcher code.
- No broad exposure of all current IPC channels.
- No server-side general-purpose model loop or fixed model dependency.
- No permanent R4 approval and no model self-approval.
- No arbitrary filesystem read path. External files enter a managed inbox or a
  bounded staging/upload flow after user selection.
- No automatic telemetry or remote project account.
- No Phase D autonomous scheduler, dependency DAG, or week-long executor.
- No public release/signing claim during the personal-development milestone.

## Dependency graph

```text
C0 compatibility/build spikes
 ├─> C1 MCP contracts and explicit registry
 ├─> C2 loopback host, discovery, lifecycle
 └─> C3 Windows keys and authenticator adapters
          │
C1 + C2 + C3 ─> C4 stdio launcher and forwarding journal
                       │
                 C5 pairing/config lifecycle
                       │
C1 + C4 + accepted B6/B7 ─> C6 first 19-operation MCP slice
                       │
                 C7 real-client usable milestone
                       │
                 C8 minimal durable jobs
                       │
        C9-C13 sequential domain migration waves
                       │
C2 + C3 + C7 ─────────> C14 direct HTTPS OAuth
                       │
C5 + C7 + C8 + C9 + C10 + C11 + C12 + C13 + C14
                       └─> C15 packaging, upgrade, completion gates
```

Tasks sharing `operationCatalog.ts`, Gateway bootstrap, main lifecycle, package
metadata, or client configuration adapters are sequential. Read-only protocol
fixtures and isolated launcher-build experiments may run in parallel only with
disjoint file ownership.

## Task breakdown

### C0 — compatibility, secure-storage, and executable spikes

**Objective:** remove toolchain uncertainty before production interfaces are
committed.

**Owned scope:** new experiments/tests under `tests/mcp/spikes/`, temporary build
scripts under a dedicated non-production directory, and a recorded decision in
this document or a narrowly linked decision note. Do not edit Gateway behavior.

**Work:**

- Record installed Codex CLI and Claude Code versions. Test each exact product
  independently and record unsupported product/transport combinations as explicit
  no-go results. If Claude Desktop is absent, mark the optional target N/A without
  blocking C0.
- Prove tools, resources, templates, prompts, list-changed notifications, structured
  tool results, cancellation, and progress behavior for both clients.
- Verify exact v1.29.0 SDK support for required `2025-11-25` features; keep MCP
  Tasks off unless the client and SDK both negotiate them.
- Prove the selected SDK/bundler works with the current CommonJS Electron main
  build without a second runtime or an unsafe dynamic-loader workaround.
- Compare standalone launcher options, including startup latency, binary size,
  stdout fidelity, signing/hash verification, Windows Defender behavior, and
  portable upgrade. Select one; do not ship a script wrapper as the product.
- Prove the launcher can create, sign with, rotate, and delete a per-client
  asymmetric key using a persisted Windows CNG provider. DPAPI may protect
  launcher metadata but is not described as the asymmetric key store. The App
  receives only the public key/fingerprint; same-user full-process compromise
  remains outside the declared threat boundary.
- Determine the official Codex and Claude Code registration commands/config merge.
  Test backup, merge, conflict, disconnect, and rollback on disposable profiles
  only. Record Claude Desktop `.mcpb` information as optional documentation only.
- Prove a specification-conforming local HTTPS strategy for the complete later
  OAuth surface: the MCP Streamable HTTP endpoint and protected-resource
  identifier, protected-resource metadata, authorization-server issuer and
  metadata, authorization/token endpoints, and redirect/callback behavior.
  Measure certificate issuance, hostname/SAN validation, trust, rotation,
  removal, revocation behavior, and no-admin installation in every claimed hard
  client. Plain HTTP is an explicit no-go for C14.
- Exercise the proposed launcher journal through crash-before-forward,
  crash-after-forward, lost-response, and packaging prototypes without adding it
  to production. Confirm the current `AgentGateway` receipt model can remain the
  sole business outcome authority.

**Gate:** commit a versioned compatibility matrix containing exact client, App,
SDK, protocol, Windows, and launcher-build versions; per-feature pass/fail/N/A;
artifact hashes; negotiated capabilities; certificate-chain/trust evidence;
startup latency and binary size; and links to disposable-profile test output.
The matrix must state no-go criteria and the selected launcher/key/certificate
decisions. Any failure in HTTPS trust, stdout purity, exact-client support,
journal recovery, or portable packaging blocks its dependent production task.
No production dependency is installed before this gate is accepted.

### C1 — versioned MCP contracts and explicit registry

**Planned files:** `src/shared/mcp/v1/*`, `src/main/mcp/registry.ts`,
`src/main/mcp/resultMapping.ts`, narrowly owned exposure changes in
`src/shared/agent/v1/gatewayContracts.ts`,
`src/shared/agent/v1/gatewaySchemas.ts`,
`src/shared/agent/v1/operationCatalog.ts`, and `src/main/agent/policyEngine.ts`,
`tests/mcp/contracts.test.cjs`, package metadata and lockfile for the exact
accepted SDK dependency.

**Work:**

- Define protocol/server/capability/schema versions separately from App version.
- Build an explicit MCP registration descriptor that binds one public name to one
  accepted operation, input/output validator, required principal visibility,
  primitive type, pagination policy, and result mapper.
- Replace the temporary Phase B-named external boundary with a versioned,
  code-owned external exposure manifest whose initial business set is exactly the
  accepted 19 operations. `PolicyEngine` and MCP registration both consume this
  manifest. Later tasks may extend it only in the same reviewed change that proves
  the relevant domain migration gate; persisted policy cannot extend it.
- Reject registry entries missing catalog identity or handler mapping; reject any
  internal operation not explicitly listed.
- Define stable error mapping: invalid inputs are tool execution errors suitable
  for model correction; lifecycle/auth/protocol failures remain protocol/HTTP
  errors; secrets and absolute sensitive paths are redacted.
- Define English identifiers/descriptions and bilingual prompt identifiers.
- Keep the first 512 characters of server instructions self-contained and limited
  to cross-tool safety/workflow guidance; stored content never enters instructions.
- Add an owner/admin-authorized `agent.receipts.get_status` Gateway query contract
  that returns only the existing authoritative receipt state or exact terminal
  replay. It accepts `{clientId, requestId}` binding, exposes no generic mutation,
  and is the only recovery lookup used by transports.
- Add versioned Gateway management contracts and catalog descriptors for
  `agent.clients.register_key` and `agent.clients.rotate_key`. They accept only
  validated public-key bindings and expected registry generation, never private
  key material. Their mutation and audit semantics are completed in C3/C5.

**Gate:** exhaustive registry tests, schema bounds, receipt lookup ownership and
redaction tests, pairing/rotation contract tests, no generic execution entry, and
a static proof that this layer imports no persistence or domain service.

### C2 — App loopback host, discovery, and lifecycle

**Planned files:** `src/main/mcp/server.ts`, `src/main/mcp/transport/*`,
`src/main/mcp/discovery.ts`, lifecycle integration in `src/main/main.ts`, isolated
main/Electron tests.

**Work:**

- Bind only `127.0.0.1` on a dynamic port after Phase A recovery and Phase B audit
  verification/reconciliation succeed.
- Publish discovery atomically only after authenticated readiness; include pid,
  instance ID, port, protocol range, launcher range, and expiry but no secrets.
- Validate discovery owner/ACL, schema, PID, age, instance handshake, realpath,
  and stale cleanup.
- Validate Host/Origin/request size/content type and use a single MCP POST/GET
  endpoint per negotiated lane.
- External control disabled means no externally usable listener/session, while
  the App and Renderer remain fully functional.
- `agent-startup` uses the single-instance lock, background startup, one-time
  notification, and ordinary safe shutdown drain. Last disconnect does not quit.

**Gate:** real Electron tests cover disabled mode, readiness ordering, stale files,
port races, second instance, startup recovery, shutdown, and immediate stop.

### C3 — stdio public-key authentication and Windows key lifecycle

**Planned files:** `src/main/mcp/auth/stdioAuthenticator.ts`, launcher-owned key
modules, audited extensions to `src/main/agent/clientRegistry.ts`,
`src/main/agent/bootstrap.ts`, and focused authentication/registry tests.

**Work:**

- The App orchestrates one client identity per configured host; the launcher
  generates its asymmetric key inside the selected Windows secure-storage path
  and returns only the public binding/fingerprint for App registration.
- Private keys remain launcher-side in the C0-selected Windows secure storage;
  App persists only public binding/fingerprint and existing registry authority.
- Challenge includes random nonce, App instance, client ID, protocol/launcher
  versions, expiry, and audience. It is one-use and replay recorded.
- A successful proof issues a short-lived launcher bridge session bound to client,
  App instance, scopes, protocol, and transport. It cannot be used by direct HTTP.
- Revocation, scope narrowing, emergency stop, instance restart, key rotation, or
  challenge reuse denies the next request/session.
- The authenticator alone emits an existing immutable `AgentPrincipal`; Gateway
  remains credential-blind.
- Implement the C1 `agent.clients.register_key` and `agent.clients.rotate_key`
  management operations through the accepted control capability. Registration is
  default read-only until a separate user-approved access update. Rotation uses
  compare-and-swap registry generation, invalidates every old-key session in the
  same durable mutation, and emits an immutable audit event. Neither MCP, preload,
  nor the launcher receives direct `ClientRegistry` access.

**Gate:** registration, duplicate fingerprint, rotation, rotation race, session
invalidation, audit and restart tests pass; discovery-only, copied session,
cross-client, replay, expired challenge, revoked key, wrong instance, and altered
scope tests all deny without Gateway dispatch or secret logging.

### C4 — standalone stdio launcher and durable forwarding journal

**Planned files:** `packages/kaoyan-mcp-stdio/*`, launcher build configuration,
`tests/mcp/launcher/*`.

**Work:**

- Implement newline-delimited JSON-RPC with stdout reserved exclusively for MCP
  and bounded redacted diagnostics on stderr.
- Discover or start the App under a current-user startup lock; validate readiness
  and re-discover after App restart/port change.
- Authenticate with the per-client key and attach the issued bridge session to
  every forwarded request; caller payload cannot select identity.
- Treat the public write `requestId` as the canonical idempotency key. MCP
  JSON-RPC message IDs remain transport correlation only and are never substituted
  for it. Gateway identity is exactly `{clientId, requestId}` plus the existing
  canonical operation/payload/catalog/version binding.
- The launcher journal is forwarding evidence, never a second business truth.
  Store one versioned, per-client, root-confined record per write with operation,
  canonical payload hash, Gateway request ID, catalog/version binding, state,
  optional receipt reference, and timestamps; omit raw content and credentials.
  States are `prepared`, `forwarded`, `terminal`, and `needs_lookup`. Publish every
  transition using same-directory temp write, file flush, atomic replace, and
  supported directory flush. Terminal payloads are cached only after exact Gateway
  replay/response and are verified by outcome hash.
- On restart, `prepared` may forward once; `forwarded`/`needs_lookup` must call the
  C1 Gateway receipt-status query before retry. `terminal` returns the verified
  exact result. Missing/unknown receipt evidence never becomes success and never
  dispatches a different payload. Mismatched reuse conflicts.
- R3/R4, batch, and cross-resource calls without explicit idempotency reject
  before Gateway admission.
- Strip/handle `ELECTRON_RUN_AS_NODE`; implement bounded startup timeouts,
  cancellation, signal handling, and clean exit without killing an App it does
  not exclusively own.

**Gate:** protocol conformance, byte/line fuzzing, stdout purity, journal atomic
phase/crash injection, receipt lookup/replay, concurrent launchers, App
absent/running/restarting, lost response, duplicate/mismatched request ID, and
process termination tests pass with isolated roots. Executor count remains one
across every lost-response case.

### C5 — control-center pairing and client configuration lifecycle

**Planned files:** typed shared/preload/IPC APIs, control-center UI, Gateway
registration/rotation composition, per-client configuration adapters, launcher
manifest installer, Electron tests.

**Work:**

- Add guided “Connect Codex” and “Connect Claude Code” flows with verified
  target identity, requested scopes, trust preset, disclosure notice, and explicit
  confirmation.
- Prefer current official client registration mechanisms proven by C0; otherwise
  perform an atomic, syntax-aware merge with backup and conflict detection.
- Store only stable launcher path and non-secret client identifier in client
  config. Install versioned launcher under LocalAppData and atomically switch a
  current manifest after self-test.
- Provide connection health, reload/restart instruction, manual configuration,
  repair, disconnect, key rotation, uninstall-if-unused, and restore-before-change.
- Capability updates never expand scopes. New scopes appear as user-actionable
  authorization suggestions.
- Pair and rotate only by invoking the C1/C3 audited Gateway management operations.
  The UI, preload, IPC adapter, config adapter, and launcher must not import or
  receive `ClientRegistry`, coordinator capability, or private-key access.

**Gate:** real disposable Codex CLI/Claude Code profiles prove connect, reload, health,
repair, external modification conflict, disconnect, rollback, and no unrelated
configuration loss.

### C6 — first 19-operation MCP vertical slice

**Planned files:** `src/main/mcp/tools/*`, resources/templates/prompts registries,
explicit exposure tests, real-client fixtures.

**Work:**

- Expose exactly `externalPhaseBBusinessOperations`: ten question/review/image,
  seven task, and two focus operations. No other internal question/TickTick command
  is visible or callable.
- Map writes and bounded dynamic queries to tools; add stable single-entity and
  summary resources/templates; add first Chinese/English daily-review prompts.
- Filter list results by principal scopes; expose a safe capability-summary
  resource for unauthorized/requestable domains.
- Return structured result, the canonical request/idempotency binding, affected
  entities, current data version, and recovery/approval state. A receipt ID is
  returned only when the accepted Gateway outcome actually supplies one; clients
  use `agent.receipts.get_status` after an uncertain response.
- Full text is scope-controlled; lists summarize/page; images require explicit
  image scope/resource access and enforce size/type/dimension bounds.
- Publish existing domain events for Renderer invalidation. C6 does not add
  `ui.navigate`, simulate clicks, or foreground the App. A non-authoritative route
  hint may be ordinary result metadata; an actual navigation operation requires a
  later explicit catalog/application/Gateway migration and local-focus policy.

**Gate:** Codex CLI/Claude Code parity with Renderer, exact exposure list, replay/conflict,
R4 request behavior, capability filtering, prompt-injection fixtures, data-size
bounds, audit, restart, and no bypass of Gateway.

### C7 — first usable personal milestone

**Objective:** make the accepted stdio slice genuinely usable before broad domain
migration.

**Acceptance:**

- Codex CLI and Claude Code install from the control center, reload, initialize,
  list only authorized tools, read a resource, use a Chinese prompt, create/update
  data, survive App restart, replay a lost response, detect a concurrent revision
  conflict, receive a revoked-session denial, and disconnect cleanly.
- App-disabled mode, emergency stop, recovery fence, and ordinary no-MCP operation
  are verified in a real Electron process.
- A development/win-unpacked artifact installs the launcher in a stable
  LocalAppData location and survives App restart. Portable embedding, moved-App
  confirmation, and packaged upgrade/rollback remain C15 gates.

This milestone permits daily personal use but does not close Phase C.

### C8 — minimal durable job substrate

**Owned files:** migration in `src/main/database/schema.ts`; contracts/validators
under `src/shared/agent/v1/jobs.ts`; `src/main/agent/jobStore.ts`,
`src/main/agent/jobExecutor.ts`, `src/main/agent/jobRecovery.ts`; narrow composition
in `src/main/agent/bootstrap.ts` and `src/main/services/databaseService.ts`; MCP job
tools/resources under `src/main/mcp/jobs/*`; schema, executor, recovery, Tasks, and
retention tests. These files are owned sequentially; no other wave edits them while
C8 is active.

**Work:**

- Add a constrained `agent_jobs` table and indexes for owner client, creating
  session, operation/catalog/version binding, canonical input hash, receipt ID,
  operation-journal ID, status, bounded progress, externalized result reference and
  hash, redacted error, cancellation request, lease/attempt, timestamps, and
  retention class. Terminal rows are immutable; result blobs live in an App-owned
  managed agent-job result root and are hash/size verified. Tests replace it with
  the isolated B0 result root.
- States: `queued`, `running`, `waiting_approval`, `completed`, `failed`,
  `cancelled`, `interrupted`. Terminal states are immutable.
- `JobStore` mutations execute only through the existing coordinator control mode;
  `JobExecutor` is the sole FIFO admission/lease owner and dispatches business work
  only through `AgentGateway`. It is not a second database writer queue and cannot
  receive a coordinator capability. A job binds one canonical Gateway request ID,
  so receipt and operation-journal evidence remain authoritative.
- Startup calls `JobRecovery` only after database candidate recovery, audit
  verification, receipt reconciliation, and operation-journal reconciliation.
  It derives terminal state only from verified receipt/journal/result evidence;
  otherwise `running` becomes `interrupted` and requires an explicit safe retry.
- Provide `jobs.create/get/list/cancel/result` with owner-client access, creating-
  session visibility rules, and admin override. Cancellation records intent and
  acts only at handler-declared checkpoints before/after side-effect phases; it
  never interrupts a database transaction or invents compensation.
- Map to experimental MCP Tasks only when both sides negotiate support; the App job
  ID/state remains authoritative. Mapping is: `queued`/`running` -> `working`,
  `waiting_approval` -> `input_required`, `completed` -> `completed`, `failed` or
  `interrupted` -> `failed`, and `cancelled` -> `cancelled`. `tasks/get`,
  `tasks/result`, and `tasks/cancel` enforce the same owner binding; Task IDs are
  projections of App job IDs. Non-Tasks clients use ordinary job tools/resources.

**Gate:** schema migration/reopen, FIFO leases, restart at every transition,
receipt/journal reconciliation, cancellation at every safe checkpoint, client and
session isolation, retention, result-size/hash failures, Tasks state/API mapping,
Tasks/non-Tasks parity, and static proof of no second writer/coordinator queue.

### C9 — knowledge, textbooks, and analytics wave

**Owned files:** a committed C9 write-entry inventory; new application handlers
under `src/main/application/knowledge/*`; migrated writer seams in
`src/main/services/knowledgeMapService.ts` and the textbook/analytics services;
narrow Renderer IPC adapters; the exposure manifest/catalog; `src/main/mcp`
knowledge resources/tools; parity, bypass, receipt, and migration tests.

**Exact proposed external set:** read operations `knowledge.list_nodes`,
`knowledge.get_node`, `knowledge.list_links`, `textbooks.list`, `textbooks.get`,
`analytics.get_weak_areas`; writes `knowledge.link_question`,
`knowledge.unlink_question`, and `knowledge.bind_textbook`. No import, seed,
rematch-all, arbitrary graph SQL, or physical textbook-file mutation is exposed.

**Gate:** inventory every knowledge/textbook/analytics Renderer, IPC, startup,
import, rematch, and internal writer; migrate each writer needed by the external
set to application handlers before registering its tool. Renderer/external parity,
bounded pagination, provenance, idempotency/revision/audit, static service/SQL
bypass, and exact manifest/catalog/MCP registration tests pass.

### C10 — study supervision, daily plans, and review wave

**Owned files:** a committed C10 writer inventory; application handlers under
`src/main/application/study/*`; migrated seams in
`src/main/services/studySupervisorService.ts` and related plan/review services;
Renderer adapters; exposure/catalog entries; MCP tools/resources/prompts; parity,
schedule-boundary, and static bypass tests.

**Exact proposed external set:** `study.get_today`, `study.get_week_summary`,
`study.create_plan_draft`, `study.apply_plan_adjustment`, and
`study.record_manual_progress`. Prompts `study.daily_review.zh_en` and
`study.weekly_review.zh_en` may orchestrate only these and already-public tools;
prompts hold no hidden authority.

**Gate:** plan-generation, rollover, supervisor initialization, timer, review, and
adjustment writers are inventoried; every exposed write has one application/Gateway
path and Renderer parity. Deterministic scheduling tests, no-op/revision behavior,
receipt/audit, prompt-injection fixtures, exact exposure, and static bypass gates
pass. Autonomous schedules, retry policy, dependency graphs, and week-long
execution remain absent for Phase D.

### C11 — multimodal draft and structured-import wave

**Owned files:** a committed C11 inventory; versioned draft contracts/validators;
application import handlers; migrated seams in
`src/main/services/structuredImportService.ts`,
`src/main/services/questionBankService.ts`, and App OCR/DeepSeek import adapters;
managed inbox/staging modules; exposure/catalog entries; MCP tools/resources;
operation-journal, job, parity, and static bypass tests.

**Exact proposed external set:** `imports.create_draft`, `imports.add_draft_image`,
`imports.validate_draft`, `imports.preview_draft`, `imports.apply_draft`,
`imports.get`, and `imports.cancel`. No arbitrary path, recursive directory,
database replacement, raw archive extraction, or model-secret operation is exposed.

**Gate:** inventory structured import, question-bank, AI/OCR, batch deletion, temp
cleanup, image binding, and Renderer writers. External multimodal and App
OCR/DeepSeek outputs use the same bounded draft schema, provenance, validation,
deduplication, preview, change-set/job, idempotency, and journal recovery path.
Only user-selected managed inbox assets are readable. Single-item/batch risk,
network disclosure, crash phases, restart, parity, and exact exposure/bypass tests
pass before registration.

### C12 — habits, calendar, and remaining task integrations

**Owned files:** a committed C12 inventory; application handlers under
`src/main/application/ticktick/*`; migrated seams in
`src/main/services/ticktickService.ts`, bridge/calendar adapters, and related IPC;
exposure/catalog entries; MCP tools/resources; remote-compensation, parity, and
static bypass tests.

**Exact proposed external set:** `ticktick.lists.list`, `ticktick.lists.create`,
`ticktick.lists.update`, `ticktick.habits.list`, `ticktick.habits.create`,
`ticktick.habits.update`, `ticktick.calendar.list_events`,
`ticktick.bridges.get`, and `ticktick.bridges.update`. Settings secrets, DeepSeek
credentials, generic external-process launch, and arbitrary remote API calls remain
unexposed.

**Gate:** list/settings/habit/bridge/calendar Renderer, timer, startup, and network
writers are inventoried. Exposed operations use application/Gateway handlers;
network and local outcomes are separately recorded and compensations are tested at
every phase. Scope/redaction, remote replay, revision/audit, Renderer parity, exact
exposure, and static bypass tests pass.

### C13 — destructive/global R4 wave

**Owned files:** a committed C13 inventory; global application handlers; migrated
seams in `src/main/services/backupService.ts`, `databaseService.ts`,
`pathService.ts`, global import/export and import-batch services; exposure/catalog
entries; MCP job tools/resources; R4 approval UI adapters; recovery, parity, and
static bypass tests.

**Exact proposed external set:** lower-risk jobs `backups.list`, `backups.create`,
`exports.create`, and `exports.get`; R4 requests `backups.delete`,
`database.restore`, `database.replace_from_import`, `database.clear_all`,
`imports.delete_batch`, and `data_root.migrate`. No raw database-file path, generic
filesystem delete, or implicit root selection is exposed.

**Gate:** inventory backup/export/import replacement, physical deletion, restore,
clear, batch deletion, and root-switch writers. Every operation resolves the exact
affected asset set, verified recovery package, hashes, required/free disk space,
and epoch/revision before approval. AI may request but cannot approve; local UI
shows all binding fields. Crash injection covers every journal/publication/config
phase and lost response; ambiguous outcomes fence writes. Renderer parity, jobs,
R4 reservation/consume, exact exposure, and static bypass gates pass.

### C14 — direct Streamable HTTPS OAuth

**Planned files:** HTTP authenticator/authorization-server modules, metadata and
token stores, browser/control-center consent route, protocol compatibility tests.

**Work:**

- Keep the localhost MCP resource server separate from stdio bridge credentials.
  The direct resource endpoint has an HTTPS protected-resource identifier and
  serves Streamable HTTP only through the C0-accepted certificate lifecycle.
- Implement protected-resource and authorization-server metadata, authorization
  code + PKCE S256, exact redirect/state/nonce validation, and RFC 8707 `resource`
  in authorization and token requests.
- Serve the MCP endpoint, protected-resource metadata, issuer metadata,
  authorization endpoint, and token endpoint through the C0-accepted HTTPS and
  certificate lifecycle. Redirect/callback URIs follow the exact registered-client
  rules. No localhost/plain-HTTP exception is assumed; any standards exception
  requires current primary-source evidence and real-client proof before planning.
- Access tokens are short-lived and bound to client, scopes, audience, token ID,
  and App instance. Refresh tokens rotate; reuse revokes the family and audits.
- Bind bearer token, MCP session ID, client ID, instance, and negotiated protocol.
- Restart, revoke, scope narrowing, emergency stop, denylist, expiry, wrong Origin,
  and cross-client session use deny immediately.
- Raw OAuth material never reaches Gateway or ordinary logs/database fields.

**Gate:** official OAuth discovery/conformance plus the required Codex CLI
HTTP/OAuth matrix. Claude Code and Claude Desktop are optional compatibility
targets and are credited only for their exact passing behavior. Code replay, PKCE mismatch,
wrong resource/audience, invalid certificate, redirect mismatch, refresh reuse,
stale instance, and token/session mixing all deny.

### C15 — packaging, upgrade, diagnostics, and Phase C completion

**Owned files:** `package.json` and lockfile, launcher build scripts/configuration,
`electron-builder` resource manifest, installer/upgrade modules, diagnostics,
user documentation, packaged-artifact and completion-matrix tests. C15 starts only
after C5 and C7-C14 are accepted and owns shared packaging metadata exclusively.

- Compile the launcher and protocol assets before `electron-builder`. Emit the
  standalone executable, public manifest, and hashes into a dedicated
  `extraResources` directory outside ASAR; do not rely on executing an ASAR member
  or an unpacked Node script. `asarUnpack` remains limited to assets that genuinely
  require it.
- Packaging fails if the launcher is missing, unexpectedly inside ASAR, lacks its
  version/hash manifest, fails its packaged self-test, or disagrees with the App,
  protocol, SDK, or manifest compatibility range.
- On first pairing, copy the hash-verified launcher from `process.resourcesPath`
  into a versioned LocalAppData directory, self-test it, and atomically switch the
  current manifest. Never discover it relative to the moved portable executable
  after installation; failed install/upgrade preserves the previous verified
  launcher and client configuration.
- Verify development, win-unpacked, portable, stable launcher path, moved portable,
  App absent/running, concurrent launchers, SDK upgrade, launcher rollback, old/new
  compatibility, and config repair.
- Add local redacted logs and previewable user-initiated diagnostic bundle; no
  telemetry endpoint.
- Personal artifacts use mutual version/hash verification. Add an explicit public
  release gate requiring Windows signing; do not claim public-ready before it.
- Publish user docs for pairing, scopes, cloud-model disclosure, R4, emergency
  stop, disconnect, repair, offline behavior, prompt injection, and threat boundary.

**Gate:** artifact inspection proves the launcher exists outside ASAR with the
declared hash in win-unpacked and portable outputs. Clean install, moved App,
upgrade, forced self-test/hash failure, rollback, no-App startup, uninstall-if-
unused, and incompatible-version matrices pass. C8-C14 evidence is linked in one
Phase C completion matrix; packaging success cannot mask an incomplete domain wave.

## Domain migration gate

No task may add an MCP write until all of the following are true for that exact
domain/operation variant:

1. Every Renderer, IPC, startup, timer, AI, bridge, and internal write entry is
   inventoried.
2. All domain writers use the accepted application/Gateway/coordinator boundary;
   registered read-only exceptions are static and evidence-backed.
3. Runtime schemas, catalog descriptor, resolved-state risk, scopes, pagination,
   epoch/revision, idempotency, recovery, events, audit, and error mapping exist.
4. Renderer and external principal parity tests pass.
5. Static tests prove no direct fallback and exact external registration parity.
6. Cross-resource operations have phase-boundary crash/restart tests.
7. Capability publication does not silently expand existing client scopes.

## Failure and recovery matrix

| Failure point | Required outcome |
| --- | --- |
| Before listener readiness | No discovery; App reports local startup failure; Gateway remains safe |
| After listen, before discovery publish | Listener closes; no discoverable instance |
| Stale/malformed discovery | Launcher rejects and re-discovers/starts under lock; never trusts fields alone |
| Challenge/session replay | Deny and audit; no Gateway dispatch |
| App restart during request | Old session invalid; same idempotency binding resolves receipt or explicit unknown/recovery state |
| Response lost after durable commit | Replay exact terminal result; executor count remains one |
| Launcher crash before forwarding | Durable journal remains pre-dispatch and can safely retry |
| Launcher crash after forwarding | `forwarded` becomes `needs_lookup`; query the authoritative Gateway receipt by `{clientId, requestId}` before any retry; mismatched payload conflicts |
| Journal temp/replace/flush failure | Do not claim forwarding/terminal state; recover the last validated record and use receipt lookup when dispatch may have occurred |
| Client config write fails | Original config remains or verified backup is restored |
| Launcher upgrade self-test fails | Current manifest remains on previous working version |
| Job interrupted | Reconcile from receipt/journal evidence; never infer success |
| Emergency stop during transaction | New admissions denied; admitted transaction finishes/rolls back atomically |
| Emergency stop during file operation | Stop at journal safe point; complete/compensate/needs_recovery only |
| OAuth code/token/refresh replay | Deny, revoke relevant material/family, audit without secrets |
| Audit persistence ambiguity | External writes fence until candidate recovery and verification |

## Test and release matrix

Every test uses a unique `kaoyan-*` OS temporary root and must reject any overlap
with `D:\KaoyanMathMistakeBook` before opening paths or spawning Electron.

### Per-change automation

- shared MCP contracts and registry exhaustion
- protocol initialize/version/capability negotiation
- tools/resources/templates/prompts and list-change behavior
- auth, policy, exposure filtering, idempotency, audit, revision, recovery
- launcher stdout purity, forwarding journal, discovery, startup locks
- main-process and Renderer/Gateway regression suites
- typecheck, builds, diff checks, static writer/exposure gates

### Milestone/transport-change real clients

- Codex CLI current installed version
- Claude Code current installed version
- Claude Desktop only as an optional, separately labeled compatibility target
- stdio initial install, reload, operation, restart, revoke, disconnect
- direct HTTPS OAuth discovery, login, scope increase/decrease, refresh, revoke for
  every exact product/transport combination marked supported by C0
- record client/App/launcher/SDK/protocol/schema versions with results

### Portable release candidate

- App not running / already running / recovering
- one and multiple launcher processes
- moved portable executable and re-confirmed App path
- upgrade, failed upgrade, rollback, repair, disconnect, uninstall-if-unused
- disabled external control and emergency stop
- no-MCP App behavior remains complete

## Phase C completion gate

Phase C is complete only when:

1. Codex CLI passes the stdio and direct HTTPS OAuth matrices for its accepted
   version. Claude Code's failed C14 token exchange is an explicit product waiver,
   not a passing result; Claude Desktop and DeepTutor are not credited toward this
   gate. Unsupported combinations remain documented rather than silently
   substituted products.
2. The first 19-operation slice and every subsequently declared Phase C domain
   wave pass the migration gate; undeclared/unmigrated operations remain absent.
3. Tools, resources/templates, prompts, instructions, notifications, structured
   results, pagination, and capability filtering work without a generic bypass.
4. Pairing, key storage, config lifecycle, revocation, emergency stop, discovery,
   restart, and concurrent client behavior are measurable and reliable.
5. Minimal jobs survive restart and remain usable by clients without MCP Tasks.
6. Multimodal external-brain import and App OCR/DeepSeek fallback share one safe
   draft/apply/recovery contract.
7. Portable launcher install, move, upgrade, rollback, and repair pass in a real
   packaged build.
8. External control disabled leaves the full standalone App functional.
9. Documentation states local/cloud data boundaries, prompt-injection treatment,
   R4 approval, same-user threat limits, diagnostics, and public-signing gate.
10. Full repository validation passes and the working tree contains only reviewed
    Phase C changes before each accepted commit.

## Recommended dispatch order

1. C0 only.
2. After C0 acceptance, C1-C3 may be decomposed with strictly disjoint file
   ownership; lifecycle and shared contract edits remain sequential.
3. C4, then C5 and C6, then C7 acceptance and a committed usable milestone.
4. C8 before any long-running import/export/global operation.
5. C9-C13 in order, each independently gated and committed.
6. C14 may begin after C7 with separate auth/transport ownership, but final
   integration waits for the current registry and packaging baseline.
7. C15 runs only after all declared domain waves and C14 are accepted.

The coordinator directly inspects each worker's owned diff and validation. No
independent reviewer is created unless the user explicitly requests one for that
turn.

# Agent Control Plane Phase C Completion

## Decision

**Phase C is CLOSED as of 2026-07-22 for the accepted personal-use scope.**

The App now exposes the declared MCP operations through one authenticated
`AgentGateway.execute/query` boundary, supports the standalone stdio launcher and
direct Streamable HTTPS OAuth, preserves local approval and audit boundaries, and
ships in a verified Windows portable package. Codex CLI is the required passing
client.

This decision does not claim public-release readiness or universal MCP-client
compatibility.

## Completion matrix

| Range | Accepted implementation/evidence |
| --- | --- |
| C0 | `e627875` compatibility evidence plus the CurrentUser HTTPS trust renewal recorded in the C0 and C14 evidence files |
| C1 | `869fe0a` versioned MCP contracts, exact catalog projection, validators, and no generic business bypass |
| C2 | `b8280b5` authenticated loopback lifecycle, discovery, emergency stop, and disabled-control behavior |
| C3 | `8817368` CurrentUser public-key client authentication, rotation, revocation, and session binding |
| C4 | `5d9f27a` standalone launcher, durable journal, replay handling, startup election, and stdout purity |
| C5 | `96fa57d` stable launcher installation, client configuration ownership, repair, rotation, disconnect, and compensation |
| C6-C7 | `85d7a70`, `45791b0`, and `2026-07-18-agent-control-plane-phase-c7-evidence.md` for the first usable real-client slice |
| C8 | `f1adcbc` durable owner-bound jobs, restart recovery, cancellation checkpoints, and MCP Tasks projection |
| C9 | `a9f19c1` plus the committed C9 inventory for knowledge, textbooks, and analytics |
| C10 | `9ef76f3` plus the committed C10 inventory for study supervision, daily plans, and review |
| C11 | `e516487` plus the committed C11 inventory for bounded multimodal drafts and structured import |
| C12 | `eb78c55` plus the committed C12 inventory for TickTick habits, lists, calendar, and bridges |
| C13 | `04a8427` plus the committed C13 inventory for recovery-bound global and R4 operations |
| C14 | `fc61335`, `c57ddc7`, and `2026-07-21-agent-control-plane-c14-http-oauth-evidence.md` for fixed-authority HTTPS OAuth, CurrentUser CNG trust, browser consent, and Codex success |
| C15 | `2026-07-22-agent-control-plane-c15-evidence.md` for package identity, move/repair lifecycle, diagnostics, full regression, and packaged startup |

## Closure gate disposition

1. Codex CLI `0.144.3` passed stdio lifecycle and direct HTTPS OAuth against the
   fixed resource `https://127.0.0.1:39458/mcp` using disposable profiles.
2. Declared C6 and C9-C13 business operations have exact contracts, catalog and
   exposure tests, Gateway enforcement, domain inventories, and bypass gates.
3. Authentication, scopes, approvals, idempotency, audit, recovery, jobs,
   discovery, revocation, emergency stop, and capability filtering remain green
   in the 700-test repository suite.
4. The launcher is a standalone Windows executable outside ASAR with exact
   manifest/hash verification. Install, repair, rollback/failure, disconnect,
   App-absent/running, concurrency, and moved-App paths are covered.
5. The final win-unpacked and moved/renamed portable artifacts both started with
   isolated data roots. External-control-disabled behavior remains green.
6. User documentation covers the local MCP boundary, least-privilege scopes,
   trust installation, emergency stop, revocation, and diagnostic privacy.
7. Full validation passed: `700` tests, `699` passed, `0` failed, `1` opt-in CNG
   test skipped; typecheck, builds, package verification, and focused C15 tests
   passed.

## Explicit non-claims

- **Claude Code:** browser authorization completes, but token exchange remains
  incompatible. The user waived this as a Phase C blocker; it is not reported as
  passing.
- **DeepTutor:** evaluation and integration are deferred until after the user has
  tried DeepTutor. No DeepTutor support is claimed.
- **Public release:** the personal Windows package is unsigned. Public
  distribution remains blocked until the App, launcher, and future update
  manifests have stable Windows code signing and release evidence.

Future Claude or DeepTutor compatibility work may build on this MCP surface, but
neither reopens Phase C unless product scope explicitly changes.

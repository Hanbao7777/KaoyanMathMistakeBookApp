# Agent Control Plane C15 Packaging and Completion Plan

## Status and authority

**Implementation status: COMPLETE (2026-07-22).** Validation and artifact
evidence is recorded in
`docs/tasks/2026-07-22-agent-control-plane-c15-evidence.md`; the Phase C closure
decision is recorded in
`docs/tasks/2026-07-22-agent-control-plane-phase-c-completion.md`.

This plan closes the remaining Phase C delivery work after C14 landed on
`main`. It preserves the accepted single-Gateway, local-first, CurrentUser-only
trust, and standalone-launcher boundaries. The 2026-07-22 product decision makes
Codex CLI the required direct HTTPS OAuth client; Claude Code is a documented
non-blocking compatibility gap. DeepTutor is outside C15.

C15 does not add MCP business operations, change scopes, change OAuth behavior,
or introduce an updater/network service. It packages and verifies the behavior
already implemented by C7-C14.

## Existing accepted substrate

- `pack:win` builds the App, standalone launcher, launcher manifest, win-unpacked
  directory, and portable executable.
- `PairingService` installs the verified launcher under versioned LocalAppData,
  publishes `current.json`, self-tests before/after publication, preserves the
  previous manifest on failure, repairs owned configuration, and removes the
  launcher after the final disconnect.
- C7 real-process tests cover App absent/running, concurrent launchers, replay,
  restart, revocation, stable LocalAppData installation, and configuration
  repair with disposable roots.
- C14 packaged interactive evidence covers fixed-authority HTTPS trust, Codex
  browser consent/login, and exact CurrentUser Root/My/CNG cleanup.

## C15 owned files

- `package.json`
- `scripts/build-mcp-launcher-manifest.cjs`
- new `scripts/verify-phase-c-package.cjs`
- `src/main/mcp/pairing/pairingService.ts`
- new `src/main/mcp/diagnostics/diagnosticBundle.ts`
- `src/main/ipc/adapters/agentControlCenterIpc.ts`
- `src/main/ipc/registerIpc.ts`
- `src/preload/preload.ts`
- `src/shared/api.ts`
- `src/renderer/pages/AgentControlCenterPage.tsx`
- focused C15 tests under `tests/mcp/c15/`, `tests/main/controlPlane/`, and
  `tests/ipc/`
- `docs/tasks/2026-07-22-agent-control-plane-c15-evidence.md`
- `docs/tasks/2026-07-22-agent-control-plane-phase-c-completion.md`
- relevant user-facing MCP documentation in `README.md`

No schema, Gateway catalog, OAuth token, Root CA, business-domain, stdio
protocol, or external-client default-profile file is owned by C15.

## C15.1 Release manifest and artifact verification

Extend the generated launcher manifest additively with App version, MCP SDK
version, protocol baseline, and an explicit compatibility object. Keep the
existing launcher/pairing fields so already-built personal artifacts remain
parseable. `loadPackagedLauncherArtifact` validates all new fields for new
manifests and continues to fail closed on unknown major manifest versions,
hash mismatch, missing launcher, link/junction escapes, or incompatible
pairing/launcher versions.

Add `verify-phase-c-package.cjs` to inspect `release/win-unpacked` and the
portable executable after `electron-builder`. It must prove:

- launcher and manifest are outside ASAR under `resources/mcp-stdio`;
- no executable launcher copy is present inside `app.asar`;
- the exact packaged launcher hash matches the manifest;
- App/package/SDK/protocol/launcher compatibility fields match source metadata;
- portable and win-unpacked outputs exist and are non-empty;
- production `asarUnpack` remains limited to `sql-wasm.wasm`.

`pack:win` runs this verifier and fails when any invariant is false.

## C15.2 Upgrade, rollback, repair, move, and uninstall matrix

Do not create an automatic updater. Expand injected/disposable PairingService
tests to prove:

- an older valid installed launcher remains active when a new artifact fails
  hash verification, copy verification, self-test, or manifest publication;
- a valid newer artifact becomes current only after self-test and durable
  manifest publication, and existing App-owned client configuration is repaired
  to the new stable path without touching unrelated entries;
- restart reconciliation completes or compensates each interrupted install,
  repair, rotate, and final-uninstall phase;
- moving the portable App does not change an already-installed stable launcher
  path; a later repair reads the launcher only from the new App resources path;
  launcher execution never depends on the old portable location;
- disconnecting the last owned client removes only the App-owned versioned
  launcher tree and manifest; conflicts preserve external client configuration.

Use only generated `%TEMP%\\kaoyan-c15-*` roots. Tests must reject any path
related to `D:\\KaoyanMathMistakeBook` before opening or spawning it.

## C15.3 Local diagnostic preview and export

Add a main-process diagnostic module with one deep interface:

```ts
interface AgentDiagnosticBundle {
  preview(): Promise<DiagnosticPreview>;
  export(targetDirectory: string): Promise<DiagnosticExportResult>;
}
```

The preview is a bounded DTO containing only versions, feature/status flags,
redacted error codes, artifact hashes, audit verification counts, and included
file names/sizes. It contains no database rows, question text, images, absolute
paths, environment variables, OAuth material, private/public keys, authorization
codes, bearer/refresh tokens, PKCE values, client profile content, or raw logs.

Export requires an explicit renderer action after preview. Main owns the target
path and writes a bounded ZIP containing generated JSON summaries only. It does
not recursively collect directories or copy existing log/config/database files.
The renderer receives no filesystem capability and cannot name arbitrary input
files. Symlink/junction targets, existing output conflicts, oversized output,
and paths related to the protected data root fail closed.

Add a compact control-center preview dialog and export command with success/error
feedback. No telemetry or automatic upload endpoint is added.

## C15.4 Real package and completion evidence

Run and record:

- `npm run typecheck`
- `npm run build:main`
- focused C15 tests
- `npm test`
- `npm run pack:win`
- `git diff --check`
- package verifier against win-unpacked and portable outputs
- disposable launch of win-unpacked from its build location and a copied/moved
  directory, using isolated userData/data roots
- launcher self-test and stable-install/repair/uninstall matrix
- disabled-external-control App smoke

The evidence records exact App, Node, Electron, MCP SDK, launcher, Codex CLI,
and protocol versions. Public code signing remains an explicit release gate;
personal unsigned artifacts may pass C15 but must not be called public-ready.

## Phase C closure decision

The completion record maps every Phase C item to committed evidence and labels
unsupported combinations explicitly. Phase C may close when:

1. C8-C14 evidence is linked and their accepted gates remain green.
2. Codex stdio and direct HTTPS OAuth evidence passes; Claude's token-exchange
   gap is recorded as waived by product decision, not misreported as passing.
3. C15 package, move, upgrade/rollback, repair, uninstall, diagnostic, and
   disabled-control gates pass.
4. Full repository validation passes on `main` with only reviewed changes.
5. DeepTutor is recorded as a later product decision and is not counted toward
   Phase C completion.

## Validation gates

- Manifest parsing is backward-compatible only within the explicitly accepted
  major version and fails closed on mismatched new compatibility fields.
- Package verification is deterministic and offline.
- No default Codex/Claude profiles or real study data are read or modified.
- Diagnostic tests use canary secrets/paths/question text and prove none appear
  in preview, ZIP bytes, ordinary logs, IPC results, or evidence output.
- Existing external-control, pairing, OAuth, Gateway, and standalone App suites
  remain green.

## Risks

- `electron-builder` can leave stale `release/` artifacts. The verifier checks
  source/version/hash identity rather than existence alone.
- Windows may lock portable or launcher files. Tests stop exact disposable
  processes and verify resolved paths before cleanup; cleanup failure is reported
  rather than hidden.
- A diagnostics feature can become an accidental exfiltration path. C15 exports
  generated allowlisted summaries only and never copies raw files.
- Packaging success can hide an incomplete domain or transport gate. The final
  completion matrix links evidence and preserves every explicit waiver.

# C15 Packaging and Completion Evidence

## Status

**COMPLETE** for the accepted unsigned personal-build scope on Windows x64.
Public distribution is not claimed and remains gated on stable Windows code
signing for the App, launcher, and future update manifests.

## Version matrix

| Component | Accepted version |
| --- | --- |
| App | `0.1.0` |
| Node used for validation | `v24.15.0` |
| Electron | `38.4.0` |
| electron-builder | `26.8.1` |
| MCP TypeScript SDK | `1.29.0` |
| MCP protocol baseline | `2025-11-25` |
| Standalone launcher | `1.0.0` (`node22-win-x64`) |
| Codex CLI | `0.144.3` |
| Claude Code observed during regression | `2.1.217` |

## Delivered C15 behavior

- The launcher manifest contains App, SDK, MCP protocol, launcher, pairing API,
  and exact SHA-256 identity. Same-major legacy manifests without the additive
  release block remain readable; newly built packages require and verify it.
- `pack:win` fails unless the launcher and manifest are non-empty and outside
  ASAR, the launcher hash and release metadata match, portable and win-unpacked
  outputs exist, and `asarUnpack` remains limited to `sql-wasm.wasm`. The verifier
  parses `app.asar` itself and rejects launcher binaries, test fixtures, manifests,
  or launcher build sources under `dist/mcp-stdio` or `dist/launcher-build`.
- Pairing reports a missing installed launcher as repairable. A moved portable
  App repairs from its new resources while retaining the stable LocalAppData
  launcher path, and final disconnect removes only App-owned launcher state.
- The control center previews and exports a user-initiated diagnostic ZIP. It is
  generated from an allowlist of versions, state flags, audit counts, and hashes;
  no raw file or log collection is performed.

## Automated validation

Accepted final commands:

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run build:main` | PASS |
| Focused C15, pairing, and control-center IPC tests | PASS, `13/13` |
| `npm test` | PASS, `700` tests: `699` passed, `0` failed, `1` opt-in CNG test skipped |
| `npm run pack:win` | PASS |

One preceding full-suite run saw Codex complete `mcp add` successfully but the
Windows command wrapper crossed its 20-second exit timeout. The isolated matrix
then passed, and the per-command bound was raised to 45 seconds. The accepted
full rerun above passed without changing client-profile or product semantics.

## Package verifier result

```json
{
  "ok": true,
  "kind": "kaoyan-phase-c-package-v1",
  "appVersion": "0.1.0",
  "portableBytes": 112673146,
  "launcherBytes": 57847071,
  "launcherSha256": "be6055fee398101c4715ff8919d2fa542f78ab4eb33f9f86adf1bc0ded47f269",
  "resources": "outside-asar"
}
```

The portable output is `release/考研高数错题本 0.1.0.exe`; the unpacked output is
under `release/win-unpacked`. The default Electron icon warning and Renderer
chunk-size warning are non-blocking packaging warnings, not verification
failures.

## Packaged startup evidence

The final package was launched twice with separate `%TEMP%\kaoyan-c15-*`
userData and study-data roots:

| Lane | Result |
| --- | --- |
| `release/win-unpacked/考研高数错题本.exe` | PASS: process started and created non-empty `data/mistakes.db` |
| Copied, moved, and renamed portable EXE | PASS: process started and created non-empty `data/mistakes.db` |

Both process trees were terminated after the database readiness check. The
unique temporary root was removed. The harness explicitly rejected overlap with
`D:\KaoyanMathMistakeBook`; the protected root was not opened or modified.

## Privacy and safety evidence

- Diagnostic canaries for a secret, question text, and absolute database path
  were absent from preview DTOs, ZIP bytes, `summary.json`, and `manifest.json`.
- Diagnostic output rejects the protected data root, link/junction paths,
  non-canonical paths, existing output conflicts, and bundles above 256 KiB.
- Real-client tests used disposable `CODEX_HOME` and `CLAUDE_CONFIG_DIR` roots.
  Default profiles were not read or modified.
- External control disabled remains covered by the main lifecycle and Gateway
  regression suite; the normal standalone App continues to start.

## Accepted limitations

- Codex CLI is the required and passing Phase C client for stdio and direct HTTPS
  OAuth. Its packaged interactive OAuth evidence is in the C14 evidence record.
- Claude Code browser authorization succeeds but token exchange does not; this is
  a product-approved, documented compatibility gap rather than a pass.
- DeepTutor integration is deferred and was not used as Phase C evidence.
- The generated personal artifact is unsigned. A public release requires code
  signing and a separate release decision.

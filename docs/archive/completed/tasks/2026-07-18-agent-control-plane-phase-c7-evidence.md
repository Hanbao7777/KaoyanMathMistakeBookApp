# Phase C7 First Usable Personal Milestone Evidence

**Status:** C7 acceptance evidence complete for the local stdio slice. This does not
close Phase C. C14 remains NO-GO and the portable/moved-App/upgrade matrix remains
deferred to C15.

## Environment and isolation

| Item | Observed value |
| --- | --- |
| Repository baseline | C6 accepted at `85d7a70` |
| Windows / Node / npm | Windows host, Node `v24.15.0`, npm `11.12.1` |
| Electron / App | Electron `38.4.0`, App `0.1.0` |
| Codex CLI | `codex-cli 0.144.3` |
| Claude Code | `2.1.214` |
| MCP SDK | `@modelcontextprotocol/sdk@1.29.0` |

All C7 writes use generated `%TEMP%\kaoyan-c7-*` roots. Codex and Claude Code
profiles, LocalAppData, userData, discovery, journal, and data roots are disposable
and removed in `finally`. The tests reject relationship with
`D:\KaoyanMathMistakeBook`; that literal appears only in isolation guards. No default
client configuration, credentials, real data, or secrets are read or modified.

## PASS evidence

| Gate | Command | Result |
| --- | --- | --- |
| Build and type safety | `npm run typecheck`, `npm run build:main`, `npm run build:launcher`, `npm run build` | PASS |
| C4 launcher and real process | `node --test tests/mcp/launcher/launcher.test.cjs tests/mcp/launcher/realProcess.test.cjs` | 31 pass, 0 fail |
| C5 real disposable profiles | `node --test tests/mcp/pairing/realClients.test.cjs tests/mcp/pairing/packaging.test.cjs` | 3 pass, 0 fail |
| C6 protocol/Gateway/image slice | `node --test tests/mcp/c6Protocol.test.cjs tests/mcp/c6GatewayIntegration.test.cjs tests/mcp/c6ImagePolicy.test.cjs` | 7 pass, 0 fail |
| C7 real process and Electron slice | `node --test tests/mcp/c7/*.test.cjs tests/electron/c7ControlPlane.e2e.cjs` | 7 pass, 0 fail |
| Main-process suite | `npm run test:main` | 402 pass, 0 fail |
| Full repository suite | `npm test` | 525 pass, 0 fail |
| Diff whitespace | `git diff --check` | PASS |

The two C7 real-client tests independently prove for Codex and Claude Code:

- The production `PairingService` used by the control-center adapter installs a
  hash-verified launcher under disposable LocalAppData and reloads the isolated
  client profile. Existing UI/preload/IPC tests cover the typed control-center
  wiring; this real-client test does not claim a literal automated button click.
- A real launcher process performs initialize, `tools/list`, resource read, and
  Chinese prompt retrieval. The authorized business exposure is exactly 19 tools;
  generic execute/query/catalog management names are absent.
- Create and update use the exact C6 MCP envelope fields, including request ID,
  idempotency key, and expected data version.
- A stale expected revision returns structured `DATA_REVISION_CONFLICT` evidence.
- A lost response is recovered from the authoritative receipt without a second
  executor; the launcher journal remains metadata-only.
- App restart causes fresh bridge authentication, revoked sessions are denied, and
  the launcher exits cleanly with newline-delimited JSON-RPC stdout.

The artifact test passes for both `development` and the available
`win-unpacked` resources. It verifies the launcher is outside ASAR, installs to
`LocalAppData\KaoyanMathMistakeBook\bin\1.0.0`, publishes `current.json`, verifies
the hash/self-test, and reloads the pairing service with the same stable path.

The real Electron tests prove disabled host state, emergency stop, recovery in the
same Electron process, and recovery-fence startup with no discovery file. Existing
C4 real-process coverage additionally proves same-launcher App restart replay and
fresh authentication.

## Environment-blocked limitation

The tests intentionally do not claim model-generated `tools/call` evidence. External
model dispatch was not used because provider/model dispatch is environment-dependent.
The C7 client tests use an actual Codex/Claude profile and actual standalone launcher,
with a protocol-faithful disposable App process that records JSON-RPC/result evidence.
Authoritative create/update Gateway behavior remains covered by the accepted C6
composition test (`tests/mcp/c6GatewayIntegration.test.cjs`). No model prose is
counted as tool evidence.

## Deferred gates

- C14 HTTPS/OAuth remains NO-GO. No HTTPS trust, OAuth discovery, PKCE, resource
  audience, token rotation, or real HTTP/OAuth client proof was added.
- C15 remains open for portable embedding, moved-App confirmation, packaged
  upgrade/rollback, installer/uninstaller matrix, public signing, and release
  diagnostics. Passing the `win-unpacked` launcher installation gate is not a C15
  completion claim.

## Changes and self-review

Narrow C7 defects found by real-process evidence were fixed:

- Control-center external-control changes now start/disable the already-composed
  loopback host, making pairing usable after an ordinary disabled startup.
- Startup awaits daily-backup maintenance before starting the MCP host, preventing a
  real maintenance-state race.
- Launcher receipt replay now maps the same affected entities/recovery metadata as
  direct MCP results and accepts/returns standard MCP `structuredContent` tool
  results while preserving the older direct fixture shape.
- Receipt recovery requests a principal-filtered public MCP projection from the
  App. The launcher validates and replays that projection instead of reconstructing
  public output from the raw Gateway terminal, preventing lost-response recovery
  from bypassing image-scope and path redaction.

Static exact-exposure, no-bypass, Gateway-only, stdout, redaction, isolation, and
real-path protections are included in the 525-test full-suite result. Generated
launcher/build artifacts and disposable client profiles are not part of the source
change set.

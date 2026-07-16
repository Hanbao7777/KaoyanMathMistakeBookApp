# Phase C0 Compatibility and Build Spike Evidence

**Decision revision:** C0-E3 (2026-07-16)
**Decision:** **GO for C1-C5 implementation feasibility; NO-GO for C14.** Both revised
hard clients performed a real authenticated-client stdio initialization against the
isolated SDK server using their default login internally and temporary MCP configuration.
Neither reached a traced `tools/call`, so real-client invocation/recovery remains an
acceptance gap for C4/C7, not a reason to block C1-C5 implementation. C14 remains
blocked by the separate HTTPS/no-admin trust and OAuth gate.

## Scope, isolation, and environment

All writable probes used a freshly generated `%TEMP%\kaoyan-c0-*` root. The committed
harness uses case-insensitive, `path.relative` descendant checks, resolves existing
paths, rejects symbolic-link/junction path segments before writes/spawns, and rejects
overlap with `D:\KaoyanMathMistakeBook`; it deletes its test root in `test.after`. Disposable
`CODEX_HOME` and `CLAUDE_CONFIG_DIR` roots were removed in `finally`. No real client
profile, `D:\KaoyanMathMistakeBook`, production source, package metadata, lockfile, or
repository `node_modules` was modified.

E3 used the existing default client login internally only. It did not inspect, print,
copy, hash, or modify any credential/configuration file, and did not run `mcp add` or
`mcp remove` against either default profile. Codex used `exec --ephemeral` plus process
`-c` configuration overrides; Claude Code used a temporary `--mcp-config` with
`--strict-mcp-config` and `--no-session-persistence`.

| Component | Observed version / result | Evidence class |
| --- | --- | --- |
| Baseline HEAD | `0f1a71e6eac86b53eb0a9e007f0e5c9f24d00c0d` | runtime Git |
| Windows | Windows 10 Pro `10.0.19045`; PowerShell `7.6.3` | runtime |
| Node / npm | `v24.15.0` / `11.12.1` | runtime |
| App / Electron | package `0.1.0`; installed Electron `38.4.0` | local metadata |
| Codex CLI | `codex-cli 0.144.3` | runtime |
| Claude Code | `2.1.211` | runtime hard client |
| Claude Desktop | absent at observed standard locations; optional | N/A |
| MCP SDK | `@modelcontextprotocol/sdk@1.29.0`, npm integrity `sha512-zo37mZA9hJWpULgkRpowewez1y6ML5GsXJPY8FI0tBBCd77HEvza4jDqRKOXgHNn867PVGCyTdzqpz0izu5ZjQ==`; tarball SHA-1 `79786d8b525e269de850ac82b1f1f757f3915f44`; SHA-256 `1C51470ECA288AE744A5D8BB48E217D3EAB5869EB2CBAF587FC29F336D6B096C`; 572,539 bytes | isolated npm runtime |
| MCP protocol baseline | `2025-11-25` | plan/specification baseline; not negotiated with a hard client |
| selected launcher candidate | `@yao-pkg/pkg@6.21.0` | isolated runtime build |

## Reproducible commands and results

Commands were run from `D:\codex\KaoyanMathMistakeBookApp` unless stated otherwise.
Exact disposable paths include a generated GUID and are intentionally not retained.

| Command / procedure | Result |
| --- | --- |
| `node --test tests/mcp/spikes/*.test.cjs` | Superseded by final E3 validation below. E2 added junction rejection, journal phase injection, and forced CNG cleanup; E3 adds authenticated-client trace evidence. |
| `codex --version`, `codex mcp --help`, `codex mcp add --help` | Codex version above. Help exposes stdio `-- <COMMAND>...`, Streamable HTTP `--url`, bearer-token env var, OAuth client ID, and OAuth resource. |
| `CODEX_HOME=<kaoyan temp>; codex mcp add kaoyan-c0 -- node --version; codex mcp get kaoyan-c0; codex mcp remove kaoyan-c0` | PASS: add/get/remove worked in disposable `CODEX_HOME`. Codex warned that temporary home directories cannot receive PATH aliases; registration still succeeded. No connection or protocol session was attempted. |
| `claude --version`, `claude mcp --help`, `claude mcp add --help` | Claude **Code** only: supports `stdio`, `sse`, and `http`; help documents callback port and client ID. |
| `CLAUDE_CONFIG_DIR=<kaoyan temp>; claude mcp add --transport http kaoyan-c0 http://127.0.0.1:1/mcp; claude mcp get ...; claude mcp remove ...` | PASS for disposable Claude Code config lifecycle. Connection deliberately failed because port 1 has no server. This is not Claude Desktop evidence. |
| `npm pack @modelcontextprotocol/sdk@1.29.0 --pack-destination <kaoyan temp>` plus `Get-FileHash -Algorithm SHA256` | PASS. Tarball SHA-1 and SHA-256 are recorded in the environment matrix; 572.5 kB packed, 4.3 MB unpacked. |
| `npm install --prefix <kaoyan temp> --no-save --ignore-scripts @modelcontextprotocol/sdk@1.29.0`; CJS `require(.../dist/cjs/server/mcp.js)` and experimental Tasks import | PASS: `McpServer` is a function; CJS distribution exists. Tasks exports include `ExperimentalMcpServerTasks`, task schemas, and in-memory stores. Tasks are experimental and unnegotiated. |
| `npx --yes @yao-pkg/pkg@6.21.0 --target node22-win-x64 ...` | PASS: generated and executed standalone `.exe`; details below. |
| `node_modules\electron\dist\electron.exe --version` five times | Electron binary comparison only; it is not an acceptable standalone launcher because the product cannot rely on an installed Electron runtime. |
| disposable SDK install; `node tools/mcp-spikes/realMcpProbeServer.cjs` with raw stdio initialize/list/read/get/call requests | PASS: negotiated `2025-11-25`; advertised tools/resources/prompts `listChanged`; listed bounded echo and progress/cancel tools, stable resource, resource template, and bounded prompt; read the resource, fetched the prompt, and returned structured echo content. A progress-token request emitted three `notifications/progress` messages. The cancellation hook is present but was not triggered without an authenticated client. |
| disposable `CODEX_HOME`; `codex mcp add ... -- node tools/mcp-spikes/realMcpProbeServer.cjs`; `codex exec --ephemeral ...` | Registration PASS. Session blocked before MCP use: OpenAI Responses WebSocket and HTTPS both returned `401 Unauthorized: Missing bearer or basic authentication`. No real credential was read. |
| disposable `CLAUDE_CONFIG_DIR`; `claude -p --bare --no-session-persistence --strict-mcp-config --mcp-config=<temp file> ...` | Configuration loaded but session blocked before MCP use: `Not logged in - Please run /login`. `--bare` explicitly excludes OAuth/keychain auth and no real credential was read. |
| default-auth `codex exec --ephemeral --ignore-user-config -c <temporary MCP server overrides>` | PASS for actual stdio initialization, using default login internally. Trace: `initialize` protocol `2025-06-18`, capability keys `elicitation`; then `notifications/initialized`, `tools/list`. Client reported its local MCP tool start/call as failed/cancelled before any traced `tools/call`. The fixed model prose `echo:C0_FIXED_TOKEN` is not credited as tool evidence. Exit `0`. |
| default-auth `claude -p --no-session-persistence --strict-mcp-config --mcp-config=<temp file>` | PASS for actual stdio initialization, using default login internally. Trace: `initialize` protocol `2025-11-25`, capability keys `elicitation`, `roots`; then `notifications/initialized`, `tools/list`, `prompts/list`, `resources/list`. Model dispatch failed with redacted fact `403 group does not allow /v1/messages dispatch` before any traced `tools/call`. Exit `1`. |

## Feature matrix

`PASS` means a contained runtime proof. `DOC` means primary documentation only.
`N/A` means the exact product was unavailable or outside C0's permitted interaction.
`FAIL/NO-GO` is a dependent-task blocker, not a claim about an uninstalled product.

| Feature | Codex CLI 0.144.3 | Claude Code 2.1.211 | SDK / launcher spike | C0 result |
| --- | --- | --- | --- | --- |
| stdio config / install route | PASS ephemeral `-c` server override, no default config write | PASS non-persistent `--mcp-config` load | SDK server starts | PASS for C1-C5 feasibility |
| stdio tools, resources/templates, prompts, list-changed, structured results, cancellation, progress | PASS initialize and `tools/list`; tool call failed before server receipt | PASS initialize plus tools/prompts/resources lists; model dispatch 403 before tool call | PASS direct SDK protocol probe exposes bounded probes | GO implementation feasibility; C4/C7 real invocation remains open |
| initialize/version negotiation | PASS `2025-06-18`, capability `elicitation` | PASS `2025-11-25`, capabilities `elicitation`, `roots` | PASS raw `2025-11-25` initialize | GO: support `2025-06-18` and `2025-11-25` in C1 pending exact contract tests |
| MCP Tasks | client did not negotiate Tasks | client did not negotiate Tasks | SDK exposes experimental Tasks APIs | N/A; keep Tasks disabled |
| Streamable HTTP / OAuth client configuration | DOC/help and disposable `--url` registration only | DOC/help and disposable HTTP config only | no authenticated OAuth session | FAIL/NO-GO for C14 |
| SDK v1.29.0 CommonJS feasibility | n/a | n/a | PASS isolated CJS server, no dynamic loader | conditional PASS for C1 dependency |
| stdout purity | n/a | n/a | PASS fixture and SDK raw stdio JSON-RPC | conditional PASS for C4 implementation |
| durable journal crash/replay | n/a | n/a | PASS **prototype**: versioned records, exclusive temp, file flush, atomic replace, supported directory flush, bounded temp cleanup, injected crash phases, binding conflict | conditional only; no real forwarding or Gateway receipt integration |
| standalone portable executable | n/a | n/a | PASS `@yao-pkg/pkg` fixture build/run | conditional candidate selection, see limits |
| persisted asymmetric key | n/a | n/a | PASS CNG RSA sign/verify/delete and forced-failure `finally` cleanup | conditional C3 choice: CNG RSA, metadata DPAPI only if needed |
| direct HTTPS full surface and trust | no real OAuth test | no real OAuth test | PASS only Node TLS: default rejection, success with explicitly supplied CA and matching SAN | FAIL/NO-GO for C14 |
| config backup/merge/conflict/disconnect/rollback | add/remove only; no syntax-aware merge probe | ephemeral config load only; no merge probe | n/a | FAIL/NO-GO for C5 |
| portable App packaging / upgrade / hash verification | n/a | n/a | executable hash only; no Electron portable artifact | N/A until C15's scheduled packaging gate |

## Launcher comparison

The source fixture writes exactly one JSON-RPC result line and has no Node dependency
after packaging. Values are five sequential launches on this machine; the first pkg
launch includes process/image cold start, and remaining samples are warm-cache samples.

| Candidate | Version | Build / run | Size | SHA-256 | Startup samples (ms) | Stdout fidelity | Decision |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| `@yao-pkg/pkg` | `6.21.0`, target `node22-win-x64` | PASS | 57,529,801 bytes | `158D3246B287256A39FF3EF60E0AD6B4EC2D8EF7044339271A989199988E3EFB` | `1848.6807, 52.9052, 49.4264, 50.5755, 50.3984` | PASS exact JSON line | Select for C4 prototype only, contingent on repeatable production build, signing/hash-manifest, Defender observation, and upgrade tests. |
| Electron executable comparison | `38.4.0` | PASS executable invocation, not standalone launcher product | 209,830,400 bytes | `77883F1C8631D501913F0205AE891AA8587673CE2112FFC6D6F47295C6E48AEA` | `149.998, 169.7793, 175.4688, 177.913, 173.6175` | not a launcher fixture | Reject for launcher: wrong delivery/runtime shape and larger binary. |
| `pkg@5.8.1`, `nexe@5.0.0-beta.4` | npm metadata observed | not built | N/A | N/A | N/A | N/A | N/A, no decision evidence. |

Portable signing, Windows Defender reputation/scan behavior, and real App package
embedding were not testable without a production package/signing workflow. They remain
C15 gates, not passes.

## Security and HTTPS findings

1. The CNG spike creates a named, non-ephemeral RSA key in the current-user Microsoft
   Software Key Storage Provider, signs and verifies data using only its public blob,
   then deletes it in PowerShell `finally` and confirms `CngKey.Exists` is false. A
   forced post-signing failure also leaves no named key. Select persisted CNG RSA for
   launcher private keys; DPAPI may protect non-key launcher metadata only.
2. The TLS spike generates a temporary RSA/SHA-256 certificate with SAN
   `kaoyan-c0.local` using .NET, starts only on `127.0.0.1`, and removes all files with
   the temp root. A Node HTTPS request fails as `DEPTH_ZERO_SELF_SIGNED_CERT` by
   default, then succeeds only when the generated PEM is supplied explicitly as `ca`.
   This proves no implicit localhost trust and does **not** prove an installable
   current-user trust route for either hard client.
3. The MCP `2025-11-25` transport specification says stdio is newline-delimited
   JSON-RPC and stdout must contain only valid MCP messages. It requires Streamable
   HTTP POST/GET at one endpoint, Origin validation, localhost binding, and auth. The
   authorization specification requires HTTPS authorization-server endpoints,
   protected-resource metadata, PKCE S256, exact redirect validation, and RFC 8707
   `resource`; localhost is permitted only for redirect URIs, not a blanket HTTP
   resource-server exception. Sources: plan links to MCP Transports and Authorization
   specifications, fetched 2026-07-16.

## Client configuration finding

Codex's observed CLI is the selected C5 configuration mechanism: `codex mcp add NAME --
COMMAND` for stdio and `--url URL` for Streamable HTTP, with `get` and `remove` for
health/rollback composition. C0 proved only isolated add/get/remove, not merge conflict
handling. Claude Code's observed `--mcp-config=<temp file>` and `--strict-mcp-config`
provide a non-persistent isolated server route. Its `mcp add` command also documents
stdio, SSE, and HTTP routes. No conflict/backup/repair flow was tested. Claude Desktop
is optional and has no bearing on this revised matrix.

## Dependency decision matrix

| Task | Decision | Reason / required condition to change decision |
| --- | --- | --- |
| C1 | GO for implementation feasibility | SDK CommonJS and both exact client initialize versions are measured. C1 must support `2025-06-18` and `2025-11-25`; keep Tasks disabled. |
| C2 | GO for implementation feasibility | Hard-client stdio startup/initialize is proven. C2's Electron listener/lifecycle tests remain its own acceptance gate. |
| C3 | GO for implementation feasibility | CNG persisted RSA lifecycle and forced-failure cleanup passed. Pairing/auth challenge and App public-binding registration remain C3 acceptance work. |
| C4 | GO for implementation feasibility | Launcher technology, stdout fixture, journal prototype, and both hard-client initialization pass. Real tool invocation, crash-after-real-forwarding, and portable integration remain C4/C7 acceptance gates. |
| C5 | GO for implementation feasibility | Codex command-line configuration and Claude Code ephemeral configuration are measured. Backup/merge/conflict/rollback remain C5 acceptance work. |
| C14 | NO-GO | Complete HTTPS/OAuth surface and trust have no real Codex CLI or Claude Code OAuth proof. Plain HTTP is not acceptable. |
| C15 | N/A until its scheduled packaging phase | No packaged App, external resource placement, signing, move, upgrade, or rollback proof exists yet; these are C15 gates, not a C0 implementation blocker. |

## Owned artifacts and self-review

- `tests/mcp/spikes/c0-spikes.test.cjs`: eight isolated Node tests; reviewed for
  resolved root/link guards before write/spawn, journal fault seams, certificate/key
  cleanup including forced CNG failure, no real config path, and bounded fixture behavior.
- `tools/mcp-spikes/spikeSafety.cjs`: root guard and safe write/spawn helpers; reviewed
  to reject the real data root and require a `%TEMP%\kaoyan-*` child.
- `tools/mcp-spikes/stdioProbeLauncher.cjs`: non-production stdout/journal model;
  reviewed to keep diagnostic output on stderr and never infer a receipt outcome. This is
  a prototype, not production forwarding durability proof.
- `tools/mcp-spikes/realMcpProbeServer.cjs`: isolated SDK v1.29.0 stdio server;
  reviewed to require disposable roots, expose only bounded non-production probes, and
  write optional root-confined metadata-only traces outside stdout.
- This document: reviewed against command outputs above. Documentation-only conclusions
  are labeled `DOC`; absent clients and unmeasured transports are `N/A`/`NO-GO`.

Final validation completed after the E3 edits: `node --test tests/mcp/spikes/*.test.cjs`
passed with 8 tests and 0 failures; owned-file `git diff --check` passed; `git status`
showed only the assigned C0 evidence, `tests/mcp/`, and `tools/mcp-spikes/` paths. No
real data/config root was touched and no persisted CNG key remained after either probe.

# C0 HTTPS OAuth Renewal Evidence for C14

**Decision revision:** C0-E5 (2026-07-21)

**Decision:** **NO-GO for production C14 implementation dispatch; GO for an
environment-CA development spike.** The currently installed Codex CLI and Claude
Code expose candidate HTTP/OAuth registration inputs. A per-process CA bundle
via environment variables is proven enough for both client processes to reach the
local HTTPS mock, and Codex completes the mock authorization-code/token flow.
However, Claude Code's no-browser path still requires the user/browser to open
the authorization URL, and browser trust does not inherit CLI environment
variables. Production C14 still needs a user-facing trust route such as an
explicitly approved current-user Root CA lifecycle or another supported
certificate deployment path.

## Scope and isolation

All writable CLI probes used a fresh `%TEMP%\kaoyan-c0-*` root as `CODEX_HOME` or
`CLAUDE_CONFIG_DIR`, then removed it in `finally`. The HTTPS mock bound only to
`127.0.0.1`, used a temporary one-day self-signed certificate with DNS SAN
`localhost`, and was never imported into the Windows user or machine trust store.
The mock trace records only request method and path, never query strings or headers.
No default client profile, real credential file, token, authorization code, refresh
token, PKCE material, production source, or C13 file was read or modified.

## Installed client observations

| Client | Exact version | Direct HTTP/OAuth surface |
| --- | --- | --- |
| Codex CLI | `codex-cli 0.144.3` | `codex mcp add NAME --url URL --oauth-client-id CLIENT_ID --oauth-resource RESOURCE`; `codex mcp login NAME [--scopes SCOPE,SCOPE]` |
| Claude Code | `2.1.216 (Claude Code)` | `claude mcp add --transport http --client-id CLIENT_ID --callback-port PORT NAME URL`; `claude mcp login NAME [--no-browser]` |

`codex mcp add --help` does not expose a CA-file, certificate, insecure-TLS, or
per-server trust setting. `claude mcp add --help` and `claude mcp login --help` do
not expose one either. This is a help-surface observation, not a claim that an
undocumented environment override is safe or supported.

## Disposable registration probes

| Client | Disposable command shape | Result | Registration conclusion |
| --- | --- | --- | --- |
| Codex CLI | `CODEX_HOME=<temp>; codex mcp add kaoyan-c0-renewal --url https://127.0.0.1:1/mcp --oauth-client-id kaoyan-codex-local --oauth-resource https://kaoyan-c0.local/mcp; codex mcp get ...; codex mcp remove ...` | PASS add/get/remove. `get` displayed streamable HTTP URL but did not display the configured OAuth client ID or resource. | Candidate static pre-registration inputs are client ID `kaoyan-codex-local` and the exact resource supplied to `--oauth-resource`; persistence and reload behavior are not enough to prove an OAuth session. |
| Claude Code | `CLAUDE_CONFIG_DIR=<temp>; claude mcp add --scope user --transport http --callback-port 39457 --client-id kaoyan-claude-local kaoyan-c0-renewal https://127.0.0.1:1/mcp; claude mcp get ...; claude mcp remove --scope user ...` | PASS add/get/remove. `get` reported client ID configured and callback port `39457`; the isolated `.claude.json` was removed. | Candidate static pre-registration inputs are client ID `kaoyan-claude-local` and exact callback URI `http://127.0.0.1:39457/...` only after the CLI reveals the callback path during an interactive successful flow. The path is not measured. |

Neither client supplied an automatic reload command. Codex configuration is registered
through its global MCP config in `CODEX_HOME`; Claude Code user-scope configuration is
registered in `CLAUDE_CONFIG_DIR/.claude.json`. Both configuration lifecycles are
disposable-profile results only. They are not a C14 client-registration acceptance.

## No-admin HTTPS trust probe

The reusable mock at `tools/mcp-spikes/httpsOAuthProbeServer.cjs` serves these
non-secret endpoints over `https://localhost:<ephemeral-port>`:

- `/.well-known/oauth-protected-resource...`
- `/issuer/.well-known/oauth-authorization-server`
- `/authorize`
- `/token`
- `/mcp`

It returns protected-resource and authorization-server metadata sufficient to observe
discovery only. All other routes return an RFC-style bearer challenge. The certificate
is supplied as a temporary PFX to Node; no trust-store mutation occurs.

| Client | Contained attempt | Result | Trace evidence |
| --- | --- | --- | --- |
| Claude Code | Add the live `https://localhost:<port>/mcp` server in disposable user scope, then `claude mcp get kaoyan-c0-tls`. | `Status: x Failed to connect`. | No mock trace file was created, so Claude Code did not reach an HTTP request path. This is consistent with TLS rejection before metadata discovery, but its CLI does not surface the TLS error text. |
| Claude Code | `claude mcp login --no-browser kaoyan-c0-tls` in disposable config. | Rejected because this non-interactive session has no terminal for redirect pasteback. | No request reached the mock; this cannot establish redirect URI/path behavior. |
| Codex CLI | Add the live HTTPS server in disposable `CODEX_HOME`, then run `codex mcp login kaoyan-c0-tls` in a bounded 20-second job. | Registration completed; login remained blocked until terminated after 20 seconds. | No request reached the mock. The CLI has no documented no-browser or CA/trust option, so this does not prove successful discovery or TLS trust. |

The earlier C0 Node TLS fixture remains relevant: Node rejects this class of temporary
self-signed certificate unless an explicit PEM CA is supplied. No equivalent,
supported per-client explicit-CA configuration was measured for either required CLI.

## E5 environment-CA follow-up

After C0-E4, the mock was expanded to answer the actual well-known paths requested
by the clients, including protected-resource metadata, authorization-server
metadata, authorize, and token routes.

A disposable local Root CA and localhost server certificate were generated under
a temporary kaoyan-c0 root. The CA was not imported into Windows trust. The
client processes received the PEM through NODE_EXTRA_CA_CERTS, SSL_CERT_FILE,
CURL_CA_BUNDLE, and REQUESTS_CA_BUNDLE.

| Client | Disposable command shape | Result | Trace evidence |
| --- | --- | --- | --- |
| Codex CLI | Disposable CODEX_HOME; codex mcp add with --url, --oauth-client-id kaoyan-codex-local, and --oauth-resource equal to the MCP URL; then codex mcp login. | PASS for client-process trust and mock OAuth. Codex printed an authorization URL, followed it, exchanged a token, and reported successful login. | GET /mcp, GET /.well-known/oauth-protected-resource, GET /.well-known/oauth-authorization-server, GET /authorize, POST /token. |
| Claude Code | Disposable CLAUDE_CONFIG_DIR; claude mcp add --transport http with --callback-port 39617 and --client-id kaoyan-claude-local; then claude mcp login --no-browser. | PASS for client-process trust and authorization URL generation; incomplete for browser/callback. Claude printed an authorization URL and waited for the user to open it and complete the redirect. | GET /.well-known/oauth-protected-resource/mcp, GET /.well-known/oauth-authorization-server. |

E5 changes the trust diagnosis: the clients can trust a per-process CA bundle.
It does not complete the production C14 gate because a normal user authorization
step still needs a browser or equivalent UX that trusts the same localhost HTTPS
authority. The environment variables are useful for development and automated
client-process probes, but they are not by themselves a durable product trust
mechanism for a user clicking an authorization URL.

## C14 decision and unblock condition

C14 remains **NO-GO for production implementation dispatch**. The development
registration inputs below are now measured, but the production certificate/UX
route is not accepted:

- Codex client ID: kaoyan-codex-local
- Codex redirect URI pattern observed: http://127.0.0.1:<ephemeral>/callback/<nonce>
- Codex resource value: exact MCP URL supplied through --oauth-resource
- Claude client ID: kaoyan-claude-local
- Claude callback URI pattern observed: http://localhost:<configured-port>/callback
- Claude resource value: exact MCP URL discovered from the configured server URL

The external change required to unblock C14 is one of the following, followed by a
fresh disposable-profile matrix for both clients:

1. Vendor-documented, per-client no-admin trust configuration that accepts a
   temporary local CA/certificate, plus an authorization UX that reaches
   protected-resource metadata, authorization, token, and MCP endpoints for both
   clients.
2. A repository-approved, no-admin certificate issuance/trust mechanism that both
   installed clients and the user authorization surface validate without disabling
   TLS verification. The leading candidate is a current-user Root CA lifecycle
   with explicit user consent, install verification, rotation, and removal tests.
3. Explicit authorization to use a trusted certificate deployment path, with its
   installation/removal/revocation behavior measured for both clients.

Until then, stdio remains the accepted local transport and C14 must not be dispatched.

## Reproduction and validation

Commands run from repository root:

```text
codex --version
codex mcp --help
codex mcp add --help
codex mcp login --help
claude --version
claude mcp --help
claude mcp add --help
claude mcp login --help
node --check tools/mcp-spikes/httpsOAuthProbeServer.cjs
node --test tests/mcp/spikes/*.test.cjs
git diff --check -- docs/tasks/2026-07-21-agent-control-plane-c14-http-oauth-plan.md
git diff --no-index --check -- NUL docs/tasks/2026-07-21-agent-control-plane-c0-http-oauth-renewal.md
git diff --no-index --check -- NUL tools/mcp-spikes/httpsOAuthProbeServer.cjs
```

The CLI lifecycle and login commands above were run with the disposable environment
variables and cleanup described in this document, not against default profiles.

# C14 Direct HTTPS OAuth Implementation Evidence

## Baseline and scope

- Base commit: `5dfa9178e52430e936e60f340a674f92fe6ce19a`
- Authority: `https://127.0.0.1:39458`
- Protected resource: `https://127.0.0.1:39458/mcp`
- Issuer: `https://127.0.0.1:39458`
- Bind address: IPv4 `127.0.0.1` only
- MCP baseline: `2025-11-25`, with the existing `2025-06-18` compatibility lane

Only hashes, UUID identifiers, certificate thumbprints, and public certificate
metadata are durable. Raw authorization codes, PKCE verifiers, bearer values,
access tokens, refresh tokens, and private-key material are held only in the
authentication boundary or transient client process memory.

## Implementation inventory

- `oauthContracts.ts` validates RFC 9728 metadata, RFC 8707 resource binding,
  authorization-code + PKCE S256 requests, exact Codex loopback redirects, and
  exact Claude callback URIs.
- `oauthMetadata.ts` publishes the protected-resource and authorization-server
  metadata plus the bearer challenge target.
- `oauthAuthorizationServer.ts` implements local consent-gated authorization,
  authorization-code issuance, token exchange, refresh, revocation, and pending
  consent projections.
- `oauthTokenStore.ts` stores only hashes and non-reversible token IDs; codes are
  one-use, access tokens are instance/resource/audience bound, refresh tokens
  rotate, and reuse revokes the family.
- `httpBearerAuthenticator.ts` validates bearer and MCP session material on each
  request and emits only an immutable `AgentPrincipal` to the existing MCP
  protocol handler and `AgentGateway.execute/query` path.
- `httpsOAuthHttp.ts` binds the direct resource to the fixed port, rejects wrong
  Host/Origin/content type/body size/Accept values, publishes metadata, and has
  no plain-HTTP or ephemeral-port fallback.
- `currentUserKeyStore.ts`, `currentUserRootCa.ts`, and
  `localHttpsCertificate.ts` implement CurrentUser Windows CNG/root trust and
  localhost certificate lifecycle boundaries. The PowerShell store paths are
  escaped at the TypeScript boundary, and LocalMachine Root is not used.
- `schema.ts` and `clientRegistry.ts` add durable authority, registration,
  authorization-code, access-token, refresh-family, and revocation projections.
- `server.ts` composes the direct host into the Electron main-process loopback
  lifecycle. It is absent unless the persisted direct authority is explicitly
  enabled and includes both the approved CurrentUser Root thumbprint and the
  non-exportable CurrentUser CNG key handle. Startup verifies that handle before
  issuing the leaf certificate; missing metadata, CNG verification failure,
  certificate issuance failure, and fixed-port bind failure leave the direct
  lane disabled. This path never installs or changes a root certificate.
- `localHttpsCertificate.ts` creates a fresh in-memory PFX passphrase, passes it
  only to the issuance child process and `https.createServer`, and returns it
  only with the in-memory PFX object. It is not emitted in metadata, discovery,
  database records, ordinary logs, or the temporary PFX file.
- The control-center status now reports the public direct-host runtime state and
  fail-closed reason (`not_enabled`, `trust_not_authorized`,
  `certificate_unavailable`, or `bind_failed`) without exposing key material or
  OAuth secrets.

## Denial matrix

The focused tests cover malformed metadata and requests, unknown fields, weak
PKCE, duplicate scopes, missing/wrong resource, malformed redirects, code replay,
PKCE mismatch, token audience mismatch, stale instance, refresh reuse, revoked
clients, narrowed scopes, wrong Origin/Host, missing bearer, token/session mixing,
missing Accept, unsafe content type, oversized body, session invalidation, and
CurrentUser Root stale-thumbprint cleanup.

## Validation evidence

Passed:

- `npm run build`
- `npm test` (676 tests: 675 passed, 0 failed, 1 skipped)
- `npm run typecheck`
- `npm run build:main`
- `node --check tools/mcp-spikes/httpsOAuthProbeServer.cjs`
- `node --test tests/mcp/spikes/*.test.cjs` (8 passed)
- `node --test tests/mcp/c14HttpsTransport.test.cjs` (4 passed): generated a
  disposable encrypted PFX outside certificate stores, started the configured
  direct host through the CNG-verification composition path, and received HTTPS
  authorization-server metadata. The host could start only because Node TLS
  received the matching transient passphrase.
- C14 focused OAuth, HTTPS transport, CNG Root, authenticator, registry,
  persistence, control-center, and disposable real-client tests (20 passed)
- Existing MCP contracts, loopback host, CNG key lifecycle, authenticator,
  registry, and database writer-gate tests (34 passed)
- `git diff --check`

The aggregate invocation previously skipped the two real-client tests because
the Windows resolver selected extensionless npm shims; the owned test resolver
now prefers executable `.cmd`/`.exe` entries. The full suite is therefore the
authoritative final count above. The repository's legacy migration assertion
also passes in isolation.

Secret/private-key scans passed for the owned C14 implementation and evidence:
only hashes, UUIDs, certificate thumbprints, public certificate metadata, and
explicit test fixtures are present in durable/test evidence; no raw OAuth value
or private-key material is logged or persisted. Static scans also found no
`Cert:\\LocalMachine\\Root` implementation path.

The commit hook rebuilt the code-review graph to 2,898 indexed rows and analyzed
the staged C14 change set: 249 nodes, 1,939 edges, 161 changed functions/classes,
zero affected flows, and risk score 0.60. It reported test gaps for broad existing
bootstrap/query helpers; the focused lifecycle and encrypted-PFX startup path is
covered by the direct HTTPS transport test above.

CurrentUser Root cleanup verification used one disposable short-lived
certificate and the exact thumbprint `49668E6546D5526CBE3220A850B415F20AB8614F`:

- `CurrentUser` count after install: `1`
- `CurrentUser` count after exact-thumbprint removal: `0`
- matching `LocalMachine` count: `0`
- disposable temporary certificate root removed: `True` (does not exist)

## Real-client evidence

Installed versions:

| Client | Version | Disposable registration |
| --- | --- | --- |
| Codex CLI | `codex-cli 0.144.3` | PASS: add/get/remove with `--oauth-client-id kaoyan-codex-local` and exact `--oauth-resource` |
| Claude Code | `2.1.216 (Claude Code)` | PASS: add/get/remove with `--transport http`, callback port `39457`, and `--client-id kaoyan-claude-local` |

Both probes used unique temporary `CODEX_HOME` / `CLAUDE_CONFIG_DIR` roots and
removed them in `finally`; the final root existence check was false. No default
profile was opened or modified. Earlier C0-E6 evidence records root-trusted
Codex and Claude authorization-code/token behavior against the measured mock.

This worker also completed the C14 registration matrix directly with both
installed clients using disposable profiles: Codex `mcp add/get/remove` with
`--oauth-client-id kaoyan-codex-local` and exact `--oauth-resource`, and Claude
`mcp add/get/remove` with HTTP transport, callback port `39457`, and
`--client-id kaoyan-claude-local`. Claude status reported the expected
connection failure because no direct HTTPS host was running during registration.
The full packaged interactive consent/tool matrix remains externally blocked by
the absence of a running packaged Electron host and consent callback in this
worker; C0-E6 contains the measured root-trusted authorization-code/token
client evidence.

## Remaining risks

- A packaged Electron run with a freshly issued certificate and an interactive
  control-center consent callback remains the final end-to-end evidence step.
  The current OAuth server is intentionally fail-closed by queuing authorization
  requests until a control-center consent callback is composed; no existing IPC
  API safely authorizes trust installation or resolves those requests.
- Root CA installation remains intentionally absent from the Electron startup
  path. A future focused control-center authorization flow must persist the
  explicit user decision before it can create/install/rotate a CurrentUser Root
  CA and enable this lane; there is no silent trust fallback.
- Packaged client registration, interactive consent resolution, and installer
  distribution remain C15 evidence work.

# C14 Direct Streamable HTTPS OAuth Plan

## Status and authority

This is the proposed C14 execution plan after accepted C13 commit
`04a8427 feat(global): add C13 global R4 control plane`.

C14 implements the direct Streamable HTTPS OAuth lane described in
`docs/tasks/2026-07-16-agent-control-plane-phase-c-plan.md`. It must not add
a second business path: every accepted HTTP request authenticates into an
immutable `AgentPrincipal` and then reaches business capabilities only through
`AgentGateway.execute` or `AgentGateway.query`.

This plan is not dispatchable until an independent reviewer accepts it.

## C0 Renewal Gate

**C0-E6 (2026-07-21): GO for implementation planning with an explicitly
approved current-user Root CA lifecycle.** See
`docs/tasks/2026-07-21-agent-control-plane-c0-http-oauth-renewal.md`.
Codex CLI 0.144.3 and Claude Code 2.1.216 expose usable HTTP/OAuth
registration inputs. A temporary Root CA installed only into Windows
CurrentUser Root made the local HTTPS mock trusted by Windows HTTPS clients and
both mandatory MCP clients without admin rights or LocalMachine trust changes.
Codex completed the mock authorization-code/token login. Claude Code generated
the authorization URL, accepted a browser-equivalent CurrentUser-trusted
callback, posted to the token endpoint, and exited successfully.

C14 may proceed only on this selected trust route. The implementation must make
the CurrentUser Root CA lifecycle explicit and user-approved: consent before
install, thumbprint-scoped install verification, short validity, rotation,
disable/emergency removal, uninstall cleanup, stale-thumbprint denial, audit,
and two-client evidence. C14 must never write to `Cert:\\LocalMachine\\Root`.

## Primary-source checkpoint

Planning was checked against the Phase C baseline MCP `2025-11-25`
authorization and transport references, RFC 9728 protected-resource metadata,
RFC 8707 resource indicators, and RFC 8252 native-app loopback redirects:

- MCP Authorization `2025-11-25`: protected resources publish OAuth protected
  resource metadata and advertise authorization-server locations.
- MCP Streamable HTTP transport `2025-11-25`: HTTP sessions and protocol
  headers remain transport concerns and cannot substitute for authorization.
- RFC 9728: protected resources publish metadata describing themselves and the
  authorization servers that can issue access tokens for them.
- RFC 8707: authorization and token requests carry a `resource` indicator so
  access tokens are audience-bound to the intended MCP protected resource.
- RFC 8252 section 7.3: a native-app loopback redirect may use a dynamically
  assigned port, but the authorization server still constrains the registered
  loopback host and path and records the exact redirect used for the code flow.

Before implementation starts, the Worker must re-check the exact installed MCP
client behavior for Codex CLI and Claude Code. If a newer MCP release candidate
is present but not accepted by this repository's Phase C baseline, document it
as non-authoritative compatibility information only.

## C14 scope

### In scope

- A localhost-only HTTPS protected MCP resource endpoint for direct Streamable
  HTTP clients.
- Local authorization-server endpoints for:
  - protected-resource metadata;
  - authorization-server metadata;
  - authorization request;
  - token request;
  - refresh-token rotation;
  - revoke / deny / emergency-stop invalidation.
- Authorization Code + PKCE S256.
- Exact redirect URI validation, including the RFC 8252 native-loopback port
  exception only where explicitly registered; `state`, `nonce`, client
  identity, requested scopes, and RFC 8707 `resource` validation.
- Short-lived access tokens bound to client, scopes, resource audience, token
  ID, App instance, negotiated MCP protocol, and current external-control state.
- Refresh-token family storage with one-use rotation and reuse detection.
- HTTP session binding across bearer token, `Mcp-Session-Id`, client ID, App
  instance, and negotiated protocol.
- Control-center consent flow for direct HTTP clients, using the same audited
  management boundary as existing client authorization and scope decisions.
- Real-client evidence for Codex CLI and Claude Code HTTP/OAuth behavior.

### Out of scope

- Remote network exposure beyond `127.0.0.1`.
- Plain HTTP exceptions for OAuth or protected MCP resources.
- Reusing stdio public-key credentials as HTTP bearer credentials.
- Passing raw OAuth material to `AgentGateway`, business handlers, ordinary
  logs, discovery files, or business tables.
- Generic HTTP operation executors, raw database/file path access, or any new
  bypass around the operation catalog.
- C15 portable packaging, upgrade, rollback, and release-candidate completion
  matrix, except for the minimal build-script changes required to run C14 tests.

## Owned files

Expected ownership for C14 workers is exact and intentionally excludes stdio
credential files unless a test proves a shared contract must move:

- `src/main/mcp/server.ts` only to compose the direct HTTPS OAuth resource host
  beside the existing stdio/loopback host without changing stdio auth behavior.
- New `src/main/mcp/transport/httpsOAuthHttp.ts` for the direct HTTPS
  Streamable HTTP resource endpoint and session bridge.
- Existing `src/main/mcp/transport/loopbackHttp.ts` only if the HTTPS host needs
  a shared, extracted request parser; any extraction must keep stdio and
  loopback behavior covered by existing tests.
- New `src/main/mcp/tls/currentUserRootCa.ts`,
  `src/main/mcp/tls/currentUserKeyStore.ts`, and
  `src/main/mcp/tls/localHttpsCertificate.ts` for the C0-E6 current-user Root
  CA lifecycle, current-user private-key custody, and localhost/IP SAN server
  certificate issuance, and only for direct HTTPS binding or certificate
  identity reuse. These modules may touch `Cert:\\CurrentUser\\Root` only after
  explicit user approval and must never write to `Cert:\\LocalMachine\\Root`.
- New `src/main/mcp/auth/oauthMetadata.ts`,
  `src/main/mcp/auth/oauthAuthorizationServer.ts`,
  `src/main/mcp/auth/oauthTokenStore.ts`, and
  `src/main/mcp/auth/httpBearerAuthenticator.ts` for OAuth metadata,
  authorization-code/token/refresh handling, durable token-family projection,
  and HTTP principal authentication.
- `src/main/mcp/discovery.ts` only for non-secret direct-HTTP endpoint,
  issuer/resource metadata, certificate identity, App instance, and protocol
  publication.
- `src/main/database/schema.ts` only for durable OAuth authorization-code,
  access-token-ID, refresh-family, revocation, redirect/client metadata, and
  restart-recovery tables/indexes.
- `src/main/agent/bootstrap.ts` and `src/main/agent/clientAuthenticator.ts`
  only to add a registry-backed HTTP principal authenticator.
- `src/main/agent/clientRegistry.ts` only for audited HTTP client registration,
  OAuth credential/token-family state, revocation queries, scope narrowing, and
  restart invalidation.
- `src/main/ipc/adapters/agentControlCenterIpc.ts`, `src/preload/preload.ts`,
  and the existing Renderer agent-control-center page only for local
  consent/status UX.
- `src/shared/mcp/v1/contracts.ts`, `src/shared/mcp/v1/schemas.ts`, and a new
  `src/shared/mcp/v1/oauthContracts.ts` only for transport/auth DTOs and exact
  validators.
- Focused tests under `tests/main/agent/`, `tests/main/controlPlane/`,
  `tests/mcp/`, and launcher/client compatibility tests that prove C14
  behavior.
- A committed C14 evidence or inventory document after implementation is
  accepted.

Do not edit C9-C13 domain handlers unless C14 tests prove a direct dependency.
Do not change C13 global operation behavior while implementing OAuth transport.

## Architecture constraints

- Discovery grants nothing. It may publish endpoint metadata, process identity,
  instance identity, certificate identity, and protocol versions, but no bearer
  token, authorization code, refresh token, PKCE verifier, or client secret.
- The authorization server and protected resource must be separate in code from
  the stdio public-key authenticator, even if they share registry reads.
- The protected MCP resource identifier must be stable for the current App
  instance and must be the audience requested through RFC 8707 `resource`.
- Access-token validation must happen before MCP tool/resource/prompt dispatch.
- MCP session validation must reject token/session mixing, stale App instance,
  revoked clients, narrowed scopes, expired tokens, wrong Origin, disabled
  external control, emergency stop, and denied token IDs.
- Refresh-token reuse revokes the whole token family and produces an audited
  control event without logging raw tokens.
- OAuth denials are HTTP authorization failures, not tool-level correction
  errors.
- Gateway receives only an `AgentPrincipal`; raw OAuth claims and token strings
  are not payload fields.
- C14 cannot silently widen an existing client's scopes. Scope increase requires
  a fresh user-visible consent and audited management write.
- The selected direct HTTPS authority is the fixed, persisted loopback origin
  `https://127.0.0.1:<directHttpsPort>`, with product default port `39458`
  unless the user explicitly chooses another port before client registration.
  C14 must not fall back to an ephemeral port. If the persisted port is
  occupied or cannot bind, direct HTTPS OAuth stays disabled, no discovery file
  is published for HTTP OAuth, and the control center requires an explicit
  authority-change flow.
- The protected resource identifier is exactly
  `https://127.0.0.1:<directHttpsPort>/mcp`. The OAuth issuer is exactly
  `https://127.0.0.1:<directHttpsPort>`, with authorization-server metadata at
  `/.well-known/oauth-authorization-server` and protected-resource metadata at
  both the RFC 9728 resource-derived path and the client-observed base/path
  variants required by the C0 probe. These values are persistent product
  authorities from the C0-E6 current-user Root CA lifecycle, not per-port
  secrets.
  They remain stable across App restart while the port is unchanged. Individual
  access tokens and MCP sessions remain bound to the current App instance.
  After restart, discovery republishes the same resource/issuer plus the new
  App instance, existing access tokens fail, and an unrevoked rotated refresh
  family may obtain a new instance-bound access token for the same persistent
  resource audience.
- Changing `directHttpsPort`, resource, or issuer after registration is a new
  authority. It revokes existing direct-HTTP sessions/token families, requires
  audited user approval, and requires Codex CLI and Claude Code re-registration;
  refresh must not bridge across an authority change.
- Root CA install is an R4-level local trust change. It requires explicit
  user approval and must be reversible through disable, uninstall, and emergency
  stop paths that remove the exact thumbprint and verify no stale root remains.
- The Root CA private key is held only as a persisted, non-exportable
  CurrentUser Windows CNG key through `currentUserKeyStore.ts`. Direct HTTPS
  OAuth remains disabled unless the key can be created or reopened and verified
  as CurrentUser-scoped, CNG-backed, and non-exportable. Raw private-key material
  must not be written to the database, discovery files, logs, temp traces, or
  project config. A missing, corrupt, non-CNG, or exportable key fails closed;
  there is no silent replacement or provider fallback, and the UI offers only
  audited rotation/removal recovery.

## Client-registration decision

C14 uses local pre-registration through the App control center as the initial
registration route:

- **Selected route:** local pre-registration through the App control center for
  Codex CLI and Claude Code. The App records client name, product, installed
  version evidence, redirect URI allowlist, supported grant type, allowed scopes,
  trust profile, resource audience, and whether refresh tokens are permitted.
  Authorization requests from unknown client IDs fail before consent.
- **Measured Codex CLI binding:** client ID `kaoyan-codex-local`; resource
  value is the exact stable MCP URL supplied by
  `codex mcp add --oauth-resource`, which must equal
  `https://127.0.0.1:<directHttpsPort>/mcp`. C0-E6 observed the native
  loopback redirect pattern `http://127.0.0.1:<ephemeral>/callback/<nonce>`.
  C14 therefore registers a Codex-specific RFC 8252 loopback rule rather than
  a wildcard URI: scheme `http`; host exactly `127.0.0.1`; numeric port
  `1..65535`; path exactly `/callback/<nonce>` where `<nonce>` is one
  non-empty URL-safe path segment; no userinfo, query, fragment, encoded slash,
  host alias, IPv6, or trailing path segment. The authorization code stores
  the exact requested redirect URI, and the token request must match that exact
  URI when a redirect URI is supplied.
- **Measured Claude Code binding:** client ID `kaoyan-claude-local`; resource
  value is the exact configured MCP server URL discovered during login and must
  equal `https://127.0.0.1:<directHttpsPort>/mcp`. Callback URI pattern
  observed in C0-E6 is `http://localhost:<configured-port>/callback`; C14
  records the exact configured callback URI at registration and rejects any
  authorization request that differs in scheme, host, port, path, query, or
  fragment.
- **Conditional route:** Client ID Metadata Documents are allowed only if a real
  mandatory client requires them. If used, metadata fetches must be localhost or
  file-system safe according to an explicit allowlist, bounded by size/time,
  cached with hash evidence, denied on redirects to private/remote networks not
  explicitly allowed, and never allowed to fetch arbitrary App/user data. The
  fetched redirect URI, logo/name, contacts, and policy fields are public display
  evidence only until the user approves and the audited registry stores the
  exact binding.
- **Out of initial route:** Dynamic Client Registration is not part of the first
  C14 implementation unless both mandatory clients require it. If added, it must
  be a separate reviewed subtask with its own storage, replay, and denial tests.

The Worker must preserve these measured bindings unless fresh client evidence
shows a narrower or safer binding is required. Any route beyond
pre-registration is out of scope unless a focused reviewer accepts it first.
Fresh evidence that changes the Codex redirect host/path, Claude callback path,
or either client's resource handling blocks implementation until the plan is
updated and re-reviewed.

## Execution sequence

### C14.0 Reviewer gate

An independent reviewer must inspect this plan before implementation dispatch.
The reviewer should check:

- whether file ownership is narrow enough;
- whether OAuth material is kept out of Gateway and ordinary logs;
- whether the plan matches MCP `2025-11-25`, RFC 9728, RFC 8707, RFC 8252,
  and Phase C C14 gates;
- whether Codex CLI and Claude Code real-client evidence is explicitly required;
- whether the plan leaves C15 packaging and release completion out of scope.

Implementation must not start until the reviewer reports `completed` or
`accepted` with no blocking findings.

### C14.1 Contracts and metadata

- Add shared validators for protected-resource metadata, authorization-server
  metadata, authorization requests, token requests, refresh/revoke requests, and
  safe public DTOs.
- Add tests proving unknown fields, raw paths, malformed redirect URIs, weak PKCE
  methods, missing `resource`, duplicate scopes, and secret reflection are
  rejected.
- Add RFC 9728 tests for the exact protected-resource metadata paths, exact
  resource identifier equality, advertised authorization-server issuer, and
  `WWW-Authenticate: Bearer resource_metadata="..."` challenge behavior.
- Gate: contract tests pass and static scans show no generic OAuth payload
  forwarding.

### C14.2 Token, authorization, and TLS key storage

- Add registry-backed durable state for authorization codes, access token IDs,
  refresh token families, token revocation, reuse detection, and App-instance
  invalidation.
- Store only hashes or non-reversible identifiers for codes/tokens/verifiers.
- Reuse existing audited control writes for consent, revoke, scope change, and
  emergency invalidation.
- Persist client-registration bindings: client ID, product, version evidence,
  redirect URI allowlist, metadata hash if used, scope grants, trust profile,
  resource audience, issuer, and refresh-token eligibility.
- Persist the fixed `directHttpsPort`, resource identifier, issuer, active Root
  CA thumbprint, pending/previous rotation thumbprints, public certificate
  metadata, and non-secret current-user key handle. Do not persist raw private
  keys, raw tokens, authorization codes, PKCE verifiers, or bearer strings.
- Persist the refresh sequence needed after App restart: old access tokens and
  MCP sessions fail because the instance changed; a valid refresh family may
  mint exactly one new access token for the persistent resource/issuer and the
  new App instance.
- Gate: key-custody tests prove a persisted non-exportable CurrentUser CNG key
  can be created, reopened, and verified; non-CNG or exportable handles are
  rejected without silent replacement/provider fallback; no raw private-key
  material enters database, logs, discovery, project config, or temporary
  traces; LocalMachine writes are denied; rotation rollback leaves exactly one
  accepted active root or disables direct HTTPS OAuth with stale roots removed.
- Gate: restart, replay, reuse, expiry, revoked client, and scope narrowing tests
  pass.

### C14.3 HTTPS resource server and OAuth endpoints

- Serve protected-resource metadata, issuer metadata, authorization endpoint,
  token endpoint, revocation/status endpoints if required, and the direct MCP
  Streamable HTTP endpoint over the C0-E6 current-user Root CA lifecycle.
- Bind only to `127.0.0.1:<directHttpsPort>` and reject wrong Origin, wrong
  Host, unsafe content type, oversized bodies, and unauthenticated MCP
  requests. Port collision, certificate/key load failure, or metadata/resource
  mismatch must fail closed with direct HTTPS OAuth disabled and no dynamic-port
  fallback.
- Implement Streamable HTTP interoperability explicitly: `Accept` negotiation,
  JSON response and event-stream response handling, POST notification/response
  `202`, unsupported or terminated GET/DELETE behavior as `405` or the
  repository's documented supported behavior, session termination `404`, and
  bearer validation on every GET/POST/DELETE.
- Gate: transport tests prove no plain-HTTP fallback, no discovery-secret leak,
  correct `WWW-Authenticate` challenges, and correct HTTP authorization
  failures.

### C14.4 Principal authentication and MCP session binding

- Convert validated HTTP bearer/session material into `AgentPrincipal` through
  a dedicated authenticator.
- Bind bearer token, `Mcp-Session-Id`, protocol version, client ID, scopes,
  audience, and App instance on every request.
- Reuse existing operation catalog, policy, idempotency, receipt, and audit
  paths.
- Prove resource/issuer restart behavior: discovery after restart republishes
  the same fixed authority/resource/issuer and the new App instance; refresh
  succeeds only for an unrevoked family and never for stale access-token replay.
  A configured-port change is treated as a new authority requiring
  re-registration, not refresh continuity.
- Gate: direct HTTP query/write parity with stdio for representative C6/C9-C13
  operations, including replay/conflict/revocation behavior.

### C14.5 Control-center consent UX

- Add local Renderer control-center surfaces for pending direct-HTTP
  authorization requests, requested scopes, redirect URI, client identity,
  trust preset, approval, rejection, revoke, and token-family status.
- Preserve local management recovery behavior when external control is disabled.
- Gate: Renderer/preload/IPC parity tests prove the UI cannot inject caller
  identity, raw tokens, or unreviewed scopes.

### C14.6 Real-client matrix

- Measure Codex CLI direct HTTPS OAuth: discovery, login, tool/resource list,
  read, write, replay, restart, revoke, scope narrowing, and clean disconnect.
- Measure Claude Code direct HTTPS OAuth with the same matrix.
- Record client version, protocol version, OAuth behavior, certificate behavior,
  and any unsupported combination explicitly.
- Gate: both mandatory clients pass or the task is blocked with exact client
  evidence.

### C14.7 Final C14 evidence

- Add C14 evidence/inventory documentation listing operations exposed through
  HTTP OAuth, denial matrix, real-client results, known limitations, and
  remaining C15 packaging dependencies.
- Run targeted C14 tests and full `npm test`.
- Generate code-review-graph review context and affected-flow summary.
- Gate: reviewer/coordinator acceptance, full repository validation, and a clean
  staged project-only commit.

## Validation matrix

C14 is not accepted unless these pass:

- Contract validators reject malformed OAuth metadata, authorization requests,
  token requests, redirect URIs, PKCE methods, duplicate scopes, missing
  `resource`, and unknown fields.
- HTTP endpoint rejects wrong Origin, wrong Host, plain HTTP, invalid
  certificate, oversized body, missing bearer token, stale MCP session, and
  wrong protocol.
- Protected-resource metadata follows RFC 9728 paths and content rules; OAuth
  failures advertise `WWW-Authenticate: Bearer resource_metadata="..."`; the
  authorization and token requests require exact RFC 8707 `resource` equality.
- Streamable HTTP tests cover `Accept` negotiation, POST notification/response
  `202`, unsupported GET/DELETE `405` or documented supported behavior,
  session termination `404`, and bearer validation on every GET/POST/DELETE.
- Authorization code replay, PKCE mismatch, redirect mismatch, wrong resource,
  wrong audience, expired access token, refresh reuse, stale App instance,
  revoked client, narrowed scopes, disabled external control, emergency stop,
  and token/session mixing all deny before Gateway dispatch.
- Client registration tests prove the chosen route for both mandatory clients:
  Codex's RFC 8252 loopback rule accepts only the measured
  `127.0.0.1:<ephemeral>/callback/<nonce>` class, including boundary ports `1`
  and `65535`, and rejects port `0`, missing/non-numeric/out-of-range ports,
  scheme, host, path, query, fragment, encoded-slash, and token-request redirect
  mismatches. Claude Code requires the exact registered callback URI. If
  metadata documents are required, bounded fetch/cache/redirect-denial behavior
  and exact redirect URI persistence also pass.
- Stable-authority tests prove the persisted default/user-selected port, exact
  resource `https://127.0.0.1:<directHttpsPort>/mcp`, exact issuer
  `https://127.0.0.1:<directHttpsPort>`, no dynamic-port fallback, fail-closed
  port collision, and audited re-registration after any authority change.
- TLS key-custody tests prove the Root CA private key is a persisted,
  non-exportable CurrentUser Windows CNG key that can be reopened and verified;
  non-CNG/exportable handles are rejected without fallback; raw key material
  never enters database/log/discovery/temp/config; LocalMachine writes are
  impossible; rotation rollback is fail-closed; and disable/uninstall/emergency
  removal leave no stale trusted root.
- Restart tests prove the persistent issuer/resource identity, post-restart
  discovery, stale access-token/session denial, and refresh-to-new-instance
  sequence for Codex CLI and Claude Code.
- Successful direct HTTP requests produce the same Gateway receipts, audit
  records, idempotency behavior, pagination bounds, resource filtering, image
  policy, R4 approval handling, and job projections as existing accepted paths.
- Raw authorization codes, access tokens, refresh tokens, PKCE verifiers, bearer
  strings, and MCP session IDs are absent from discovery files, ordinary logs,
  business payloads, and non-auth database fields.
- Codex CLI and Claude Code direct HTTPS OAuth matrices pass with recorded
  versions.
- `npm test` passes.

## Risks and mitigations

- **Spec drift:** MCP authorization may evolve. Mitigation: pin implementation
  to the repository's accepted `2025-11-25` baseline and record newer behavior
  separately until explicitly adopted.
- **Credential leakage:** OAuth strings can accidentally enter logs or Gateway
  payloads. Mitigation: add redaction/static tests and keep token storage hashed.
- **Dual authorization paths:** stdio and HTTP credentials could blur together.
  Mitigation: separate authenticators and tests proving cross-transport reuse is
  denied.
- **Session confusion:** bearer token and MCP session could be mixed across
  clients. Mitigation: bind client, token ID, session ID, protocol, and App
  instance on every request.
- **Authority drift:** changing the loopback port would silently change issuer
  and audience. Mitigation: persist `directHttpsPort`, forbid ephemeral fallback,
  fail closed on collision, and require audited re-registration for authority
  changes.
- **Root CA private-key custody:** losing or leaking the signing key would make
  certificate rotation unsafe. Mitigation: mandatory persisted non-exportable
  CurrentUser Windows CNG storage, no provider/exportability fallback, no raw
  key persistence, thumbprint/key-handle audits, fail-closed missing-key
  behavior, and rotation rollback/removal tests.
- **Real-client variance:** Codex CLI and Claude Code may differ in OAuth
  metadata handling. Mitigation: test both mandatory clients before acceptance
  and document unsupported behavior instead of substituting products.

## Definition of done

- Reviewer accepts this plan.
- C14 implementation lands in the owned files only, with any scope expansion
  explicitly justified.
- Codex CLI and Claude Code pass direct HTTPS OAuth real-client matrices.

## Scope Decision (2026-07-22)

The product scope is revised after the packaged interactive run. Codex CLI is
the current required direct HTTPS OAuth client. Claude Code is explicitly
waived from the C14 acceptance gate because its browser authorization completes
but its token exchange remains incompatible with this server; that result is
recorded in the companion evidence document. Existing Claude registration and
transport code remains in place for a later compatibility fix, but Claude is no
longer a release blocker.

DeepTutor is the next planned external client. Its OAuth registration,
least-privilege scope mapping, and real-client MCP call evidence will be a
separate follow-up task; this decision does not authorize adding DeepTutor
implementation to C14.
- Full repository validation passes.
- C14 evidence document is committed.
- Working tree contains only reviewed project changes and explicitly excluded
  local tool configuration.

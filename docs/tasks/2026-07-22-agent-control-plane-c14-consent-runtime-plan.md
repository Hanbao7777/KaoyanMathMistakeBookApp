# C14 Trust And OAuth Consent Runtime Plan

## Status

Proposed follow-up to C14 implementation commits 655844a, 85b3e69, and
2fb9c7f. Those commits remain unmerged until this plan is independently
accepted and implemented.

The branch contains the HTTPS resource, OAuth server, durable token state,
fixed authority, transient encrypted-PFX passphrase, and Electron startup
composition. It fails closed because the product has no approved main-process
authority for issuing/installing the CurrentUser root or deciding pending OAuth
consent.

## Decisions

1. Renderer never supplies certificate DER, key handles, thumbprints, OAuth
   redirects, scopes, or approval outcomes as trusted facts. It sends only a
   user command containing a server-issued intent ID and confirmation.
2. A main-process DirectHttpsOAuthController owns root creation, trust-store
   mutation, OAuth pending consent, host lifecycle, authority refresh, audit,
   and recovery. Electron startup and IPC call this controller; neither calls
   TLS backends or LocalOAuthAuthorizationServer directly.
3. Root certificate material is issued in main from the verified persisted
   non-exportable CurrentUser CNG key. The issuer verifies provider, scope,
   export policy, public-key binding, CA constraints, subject, validity, and
   thumbprint before installation.
4. CurrentUser Root install/remove/rotation is an explicit R4 trust intent. A
   confirmation can execute only the exact unexpired intent shown to that
   renderer session. There is no startup install and no LocalMachine backend.
5. LocalOAuthAuthorizationServer exposes a narrow pending-consent port owned
   by the controller. Client, redirect, resource, PKCE, state, scopes, and
   expiry validate before a request becomes pending. HTTP does not wait on UI.
6. Pending requests expose safe DTOs only. Raw authorization codes, PKCE
   challenges/verifiers, bearer/refresh tokens, nonce, and full redirect query
   values never cross IPC.
7. Approval/denial revalidates current client status, exact scopes, fixed
   authority/resource, expiry, App instance, and external-control state.
   Decisions are one-use and replay fails.
8. Authority changes, root removal/rotation, disable, shutdown, emergency stop,
   and client revocation invalidate pending consent and relevant credentials.

## Owned Files

- New src/main/mcp/runtime/directHttpsOAuthController.ts.
- New src/main/mcp/tls/currentUserRootIssuer.ts.
- Existing C14 TLS modules for verified issuer/lifecycle ports and cleanup.
- oauthAuthorizationServer.ts for a pending-consent port and one-use decisions.
- server.ts and main.ts only to delegate lifecycle to the controller and avoid
  captured stale authority state.
- clientRegistry.ts and database/schema.ts for durable trust intents, pending
  projections, authority state, and audited transitions. No secret material.
- auditLedger.ts only through its existing append boundary.
- Agent control IPC, preload, shared API/types, renderer control center, focused
  tests, this plan, and the existing C14 evidence document.

No C9-C13 domain handler, stdio auth behavior, remote binding, DeepTutor work,
C15 packaging, or real client profile is in scope.

## Controller Interface

DirectHttpsOAuthController exposes only:

- status with non-secret authority, resource/issuer, App instance,
  certificate thumbprints, state, and bounded reason code;
- prepareTrustInstall returning opaque intent ID plus display-only subject,
  thumbprint, expiry, authority/resource, and consequences;
- confirmTrustInstall(intentId, confirmed);
- prepareTrustRemoval and confirmTrustRemoval;
- listPendingConsent returning request ID, client display identity, requested
  scopes, resource, safe redirect display, and timestamps;
- decideConsent(requestId, decision);
- startIfAuthorized, refresh, disable, and stop.

The controller owns current host and OAuth server references. It reloads the
authority before every trust mutation, start, refresh, and consent decision. A
later trust approval starts the host without restarting Electron. Authority
change stops the old host first, revokes old credentials, requires client
re-registration, and never falls back to another port.

## Root Trust State Machine

States: unconfigured, intent_pending, installing, ready, disabled,
rotation_pending, removing, error.

- prepareTrustInstall verifies or creates the CurrentUser CNG key, then issues
  a short-lived self-signed CA whose public key equals that handle. Persist only
  intent ID, key name, public certificate DER, thumbprint, metadata, hashes,
  expiry, renderer-session binding, and audit linkage. DER never enters IPC.
- confirmTrustInstall requires ownership, confirmation, unexpired intent,
  unchanged authority/key binding, and current external-control policy. Install
  only into Cert:\CurrentUser\Root, verify exactly one thumbprint, persist
  authorized authority, start HTTPS, and append audit evidence.
- Failure after install removes the exact new thumbprint and verifies zero
  matches. Cleanup failure sets error, keeps HTTPS disabled, and permits only
  emergency removal.
- Removal stops host and invalidates OAuth/session state before exact root
  deletion, verifies zero matches, then clears trust metadata. CNG deletion is
  a separate confirmed action or uninstall step.
- Rotation verifies new root/host before switching identity, then revokes old
  authority and removes old root. Partial failure never leaves two usable
  authorities or silently restores an unverified host.

## OAuth Consent State Machine

States: pending, approved, denied, expired, invalidated, consumed.

- Only fully validated requests enter pending. Safe IPC DTOs derive in main.
- The authorization endpoint returns a same-origin bounded waiting response
  tied to an opaque request ID. It cannot reveal another request.
- Approval transactionally revalidates, marks once, issues a one-use code,
  appends audit, then completes the originating flow. Denial and expiry are
  terminal and audited. Crash/restart invalidates pending requests.
- Consent never widens registered scopes. Scope increases use the separate
  audited registration update and require a fresh authorization request.

### Browser continuation protocol

- After full validation, GET /oauth/authorize creates an opaque 128-bit request
  ID and a separate 256-bit browser capability. Only the capability hash is
  stored. The raw capability is set as a Secure, HttpOnly, SameSite=Strict,
  host-only cookie scoped to the authorization continuation paths. Neither
  value is accepted from renderer IPC.
- The endpoint returns 202 HTML with no external script. Its bounded script
  polls GET /oauth/authorize/status/{requestId}. The status endpoint requires
  the capability cookie, exact Host and Origin/Sec-Fetch-Site constraints, and
  returns only pending, ready, denied, expired, or invalidated. It never returns
  a code, state, redirect URI, or token.
- When status becomes ready or denied, the page navigates the top-level browser
  to GET /oauth/authorize/continue/{requestId}. That endpoint again verifies
  the cookie and atomically consumes the terminal result. It returns the sole
  302 to the exact registered redirect URI with code+state, or the RFC OAuth
  error+state. It clears the cookie and a replay returns 410.
- Poll interval is at least one second, total lifetime is at most five minutes,
  response bodies are no-store, request IDs are unguessable, and a capability
  never addresses another request. Closing the browser leaves a bounded record
  that expires. App restart marks all pending/ready-but-unconsumed flows
  invalidated; clients start a new authorization flow.

### Durable OAuth decision protocol

- Add targeted registry transactions rather than rewriting the complete token
  snapshot. The decision transaction revalidates client, scopes, authority,
  resource, redirect, App instance, capability hash, state, PKCE challenge, and
  expiry; changes pending to approved/denied once; inserts the authorization
  code hash for approval; and appends the required audit event in the same
  DatabaseCoordinator write transaction.
- The raw authorization code exists only in the controller's terminal-result
  memory until continue consumes it. If the process dies after the decision
  transaction, startup reconciliation marks the unreachable unused code and
  consent row invalidated/revoked and appends a reconciliation audit event in
  one transaction. No raw code is persisted to recover an abandoned browser.
- Audit append failure rolls back the decision and code insert. Concurrent
  decisions use a conditional pending-state update and exactly one succeeds.
  Continue consumes the code delivery state once; token exchange independently
  consumes the stored code hash once.

## Durable Trust And Audit Protocol

Certificate-store mutation is a recoverable saga because it cannot share a
SQLite transaction.

1. prepare persists the exact intent, public certificate hash/DER, key name,
   expected thumbprint, authority generation, renderer binding, expiry, and
   intent-created audit event in one control-write transaction.
2. confirm transactionally checks the renderer binding and unchanged inputs,
   changes intent to install_pending/removal_pending, and appends a
   user-confirmed audit event. If audit fails, no certificate-store command runs.
3. The controller performs the single external side effect, then independently
   verifies CurrentUser My/Root counts, key association, thumbprint, and chain.
   HTTPS remains stopped during this phase.
4. finalize changes the durable authority and intent to ready/completed and
   appends success audit in one transaction. Only after finalize commits may the
   controller start HTTPS from a fresh authority read.
5. If verification or finalize fails, the controller attempts the exact inverse
   side effect and verifies it. A failure-result transaction records the result
   and audit. If either compensation or audit is unavailable, durable state is
   recovery_required, HTTPS stays disabled, and startup reconciliation is the
   only permitted operation besides emergency removal.

Startup reconciliation scans nonterminal intents before host creation. For
install_pending it counts and verifies the exact expected root: zero becomes a
failed audited intent; exactly one valid root may be finalized because durable
user confirmation predates the side effect; any mismatch or multiple match is
recovery_required and disabled. Removal_pending with zero matches finalizes;
with one match it retries exact removal; ambiguity disables. Rotation uses
separate new-root-installed and old-root-removal checkpoints, never publishes
the new authority until its finalize transaction, and never enables both.

All authority mutation, token/session invalidation, and audit rows that are
database state share one DatabaseCoordinator control-write transaction. Store
side effects occur only after a committed intent audit. The existing full OAuth
snapshot delete/reinsert API is not used for consent decisions.

## Trusted Renderer Caller Binding

- ipcMain handlers receive Electron's IpcMainInvokeEvent. The registration layer
  verifies senderFrame is the main frame and its URL is the exact packaged file
  URL or configured development renderer origin before calling the adapter.
- Main owns a renderer-session record {webContentsId, navigationGeneration}.
  navigationGeneration increments on every committed top-level navigation,
  reload, window replacement, or renderer crash. The adapter derives this
  context from the event and never accepts it in preload arguments.
- Trust intents bind durably to that context. Confirmation requires the same
  live BrowserWindow, webContents ID, and generation; reload, replacement,
  cross-window calls, detached frames, and stale intents fail. OAuth consent
  decisions use the same caller check, but the browser capability remains a
  separate HTTPS-only credential and never crosses IPC.
- Closing/reloading the bound control-center window invalidates its outstanding
  trust intents. A new session must prepare and display a fresh intent.

## Exact CNG Certificate Association

- currentUserRootIssuer opens the exact persisted key name with Microsoft
  Software Key Storage Provider in CurrentUser scope and constructs RSACng from
  that CngKey. It uses .NET CertificateRequest to create the self-signed CA with
  BasicConstraints CA=true, keyCertSign+cRLSign usage, bounded subject/serial,
  and at most 30-day validity.
- The resulting certificate is added to Cert:\CurrentUser\My while retaining
  its private-key association to that exact persistent CNG key. Only the public
  DER is copied to Cert:\CurrentUser\Root after confirmation. No PFX or raw
  private-key export is used for the root.
- Verification reopens the My certificate by exact thumbprint, requires
  HasPrivateKey, requires GetRSAPrivateKey to be RSACng with the exact provider
  and CngKey.UniqueName, compares its SubjectPublicKeyInfo byte-for-byte with
  CurrentUserKeyStore.verify, signs a random challenge and verifies it with the
  public certificate, and checks the CA extensions and validity.
- Leaf issuance no longer ignores rootKeyName. It either signs through the exact
  reopened RSACng key or verifies that the exact My certificate selected as
  signer has the rootKeyName association above before signing. A disposable
  actual-Windows test must create/reopen/sign/verify a leaf chain, then delete
  the exact My/Root thumbprints and key and verify zero remnants.

## Audit Requirements

Append redacted events for trust intent creation/confirmation/denial/expiry,
root install/remove/rotation outcome, authority enable/disable/change, OAuth
pending creation, approval/denial/expiry/invalidation, and emergency cleanup.
Include opaque IDs, client ID, scope names, authority identity hash,
thumbprints, result/reason, and timestamps. Exclude DER, PFX, passphrases,
tokens, codes, PKCE, session IDs, nonce/state, and redirect query strings.

## Validation Gates

- Renderer cannot install arbitrary DER, choose a key handle, substitute a
  thumbprint, replay a decision, or address another session's intent.
- Root issuer proves CurrentUser Microsoft Software KSP, RSA, non-exportable
  handle, public-key equality, CA constraints/key usage, bounded validity, and
  exact thumbprint before installation.
- No LocalMachine Root command/API exists and startup never mutates trust.
- Install, removal, rotation, port collision, invalid CNG, stale authority,
  restart, audit failure, and cleanup failure all fail closed.
- Injected-backend tests drive unconfigured to ready and ready to disabled with
  zero matching roots; no real store is touched by default tests.
- OAuth tests cover safe DTOs, exact revalidation, approve/deny/expire/replay,
  concurrent decisions, restart invalidation, and one-use code exchange.
- Browser tests cover capability-cookie theft/replay/cross-request denial,
  bounded polling, ready/denied continue redirects, exact state preservation,
  cookie clearing, 410 replay, and Codex/Claude callback completion.
- Crash-point tests cover every committed trust checkpoint, audit failure before
  side effects, finalize failure compensation, recovery_required, and startup
  reconciliation with zero/one/mismatched roots.
- IPC tests prove main-frame URL validation and webContents/navigation-generation
  binding across reload, replacement, iframe, crash, and cross-window calls.
- Controller tests prove approval starts HTTPS without Electron restart and
  refresh never uses captured startup authority.
- Full C14, IPC, build, spike, secret-scan, graph, and repository tests pass.
- Packaged Codex and Claude interactive consent/tool evidence remains the final
  C14 acceptance gate after implementation.

## Dispatch Gate

An independent reviewer must accept ownership, issuance, audit, state machines,
IPC exposure, rollback, and validation before implementation dispatch. Any
renderer-supplied certificate, startup auto-install, omitted audit, raw OAuth
secret persistence, or stale authority reuse is a blocker.

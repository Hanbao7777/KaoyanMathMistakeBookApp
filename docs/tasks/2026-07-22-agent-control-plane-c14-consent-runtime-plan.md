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

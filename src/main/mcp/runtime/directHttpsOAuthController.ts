import { createHash, randomUUID } from 'node:crypto';
import type { Database } from 'sql.js';
import type { AgentControlWriteExecutor, AuditLedger } from '../../agent/auditLedger';
import { all } from '../../agent/sqlRows';
import type { HttpOAuthAuthorityState } from '../../agent/clientRegistry';
import type { DatabaseMutationScope } from '../../persistence/databaseCoordinator';
import type { CurrentUserKeyStore, CurrentUserCngKeyHandle } from '../tls/currentUserKeyStore';
import type { CurrentUserRootCaLifecycle, RootCertificateMaterial } from '../tls/currentUserRootCa';
import type { CurrentUserRootIssuer } from '../tls/currentUserRootIssuer';
import type { DirectHttpsOAuthHost } from '../transport/httpsOAuthHttp';
import type { LocalOAuthAuthorizationServer, PendingOAuthAuthorizationRequest } from '../auth/oauthAuthorizationServer';
import type { OAuthStoredCode } from '../auth/oauthTokenStore';
import { createOAuthMetadata } from '../auth/oauthMetadata';

export interface RendererTrustContext { readonly webContentsId: number; readonly navigationGeneration: number; }
export interface DirectHttpsOAuthControllerDependencies {
  readonly authority: () => Promise<HttpOAuthAuthorityState>;
  readonly updateAuthority: (value: Partial<HttpOAuthAuthorityState> & { readonly appInstanceId: string }) => Promise<HttpOAuthAuthorityState>;
  readonly updateAuthorityInTransaction?: (database: Database, scope: DatabaseMutationScope, value: Partial<HttpOAuthAuthorityState> & { readonly appInstanceId: string }) => void;
  readonly executeControlWrite: AgentControlWriteExecutor;
  readonly audit: AuditLedger;
  readonly keyStore: Pick<CurrentUserKeyStore, 'create' | 'verify'> & Partial<Pick<CurrentUserKeyStore, 'remove'>>;
  readonly issuer: Pick<CurrentUserRootIssuer, 'issue' | 'verify'> & Partial<Pick<CurrentUserRootIssuer, 'remove'>>;
  readonly roots: Pick<CurrentUserRootCaLifecycle, 'install' | 'remove' | 'count'>;
  readonly oauth: LocalOAuthAuthorizationServer;
  readonly oauthTokenRecovery?: () => Promise<void>;
  readonly refreshAuthenticator?: (authority: HttpOAuthAuthorityState) => void;
  readonly createHost: (authority: HttpOAuthAuthorityState) => DirectHttpsOAuthHost | undefined;
  readonly now?: () => Date;
  readonly randomUUID?: () => string;
}

type IntentStatus = 'pending' | 'install_pending' | 'removal_pending' | 'completed' | 'failed' | 'recovery_required' | 'expired' | 'invalidated';
type IntentRow = Record<string, unknown>;
const controlClientId = 'local-control';
const sqlRun = (db: Database, sql: string, args: readonly unknown[] = []) => {
  const run = (db as unknown as { run(sql: string, args?: readonly unknown[]): void }).run;
  run.call(db, sql, args);
};
const rows = (db: Database, sql: string, args: readonly (string | number | null | Uint8Array)[] = []) => all(db, sql, args) as IntentRow[];

function validContext(context: RendererTrustContext): void {
  if (!Number.isSafeInteger(context.webContentsId) || context.webContentsId < 1 || !Number.isSafeInteger(context.navigationGeneration) || context.navigationGeneration < 0) throw new Error('renderer_context_invalid');
}

function materialFromIntent(intent: IntentRow): RootCertificateMaterial {
  if (typeof intent.certificate_der !== 'object' || intent.certificate_der === null || typeof intent.thumbprint !== 'string' || typeof intent.certificate_not_after !== 'string' || typeof intent.subject !== 'string') throw new Error('trust_intent_material_missing');
  const der = intent.certificate_der instanceof Uint8Array ? intent.certificate_der : Buffer.from(intent.certificate_der as ArrayBuffer);
  if (der.length < 128 || Date.parse(intent.certificate_not_after) <= Date.now()) throw new Error('trust_intent_certificate_invalid');
  return Object.freeze({ der, thumbprint: intent.thumbprint, notAfter: new Date(intent.certificate_not_after).toISOString(), subject: intent.subject });
}
function certificateHash(der: Uint8Array): string { return `sha256-v1:${createHash('sha256').update(der).digest('hex')}`; }

export class DirectHttpsOAuthController {
  private host: DirectHttpsOAuthHost | undefined;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private lastStatus: Readonly<Record<string, unknown>> | undefined;

  constructor(private readonly deps: DirectHttpsOAuthControllerDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.randomUUID = deps.randomUUID ?? randomUUID;
    deps.oauth.setConsentObserver({
      pending: (value) => this.persistConsent(value),
      decided: (requestId, decision, codeHash, record) => this.persistConsentDecision(requestId, decision, codeHash, record),
      invalidated: (requestId, reason = 'invalidated') => this.persistConsentStatus(requestId, reason)
    });
  }

  statusSnapshot(): Readonly<Record<string, unknown>> | undefined { return this.lastStatus; }

  async status(): Promise<Readonly<Record<string, unknown>>> {
    const authority = await this.deps.authority();
    const runtime = this.host?.status();
    const value = Object.freeze({
      port: authority.port,
      authority: authority.authority,
      resource: authority.resource,
      issuer: authority.issuer,
      appInstanceId: authority.appInstanceId,
      enabled: authority.enabled,
      state: runtime?.state ?? 'disabled',
      ...(authority.rootCaThumbprint ? { rootCaThumbprint: authority.rootCaThumbprint } : {}),
      ...(runtime?.certificateThumbprint ? { certificateThumbprint: runtime.certificateThumbprint } : {}),
      ...(runtime?.reason ? { reason: runtime.reason } : {})
    });
    this.lastStatus = value;
    return value;
  }

  async prepareTrustInstall(context: RendererTrustContext): Promise<Readonly<Record<string, string>>> {
    validContext(context);
    const authority = await this.deps.authority();
    if (authority.enabled) throw new Error('trust_already_authorized');
    const intentId = this.randomUUID();
    const keyName = `kaoyan-http-root-${intentId.replace(/-/g, '')}`;
    const key = await this.deps.keyStore.create(keyName);
    try {
      const material = await this.deps.issuer.issue(key, `CN=Kaoyan Local HTTPS Root ${intentId.slice(0, 8)}`);
      const now = this.now();
      const expires = new Date(now.getTime() + 5 * 60_000).toISOString();
      await this.deps.executeControlWrite({ requestId: `c14-trust-prepare-${intentId}`, execute: (db, scope) => {
        sqlRun(db, `INSERT INTO agent_https_trust_intents
          (intent_id,kind,status,renderer_web_contents_id,navigation_generation,key_name,certificate_der,certificate_hash,thumbprint,certificate_not_after,subject,authority,expires_at,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [intentId, 'install', 'pending', context.webContentsId, context.navigationGeneration, keyName, Buffer.from(material.der), certificateHash(material.der), material.thumbprint, material.notAfter, material.subject, authority.authority, expires, now.toISOString(), now.toISOString()]);
        this.deps.audit.appendAdmissionInTransaction(db, scope, { clientId: controlClientId, requestId: intentId, summary: { event: 'https_trust_intent_created', intentId, thumbprint: material.thumbprint, certificateHash: certificateHash(material.der), authority: authority.authority } });
        return { changed: true, value: undefined };
      }});
      return Object.freeze({ intentId, subject: material.subject, thumbprint: material.thumbprint, expiresAt: expires, authority: authority.authority, resource: authority.resource });
    } catch (error) {
      try { await this.deps.keyStore.remove?.(keyName); } catch { /* best-effort key cleanup before any trust side effect */ }
      throw error;
    }
  }

  async confirmTrustInstall(intentId: string, confirmed: boolean, context: RendererTrustContext): Promise<void> {
    validContext(context);
    if (!confirmed) { await this.invalidateIntent(intentId, context, 'invalidated'); return; }
    const before = await this.deps.authority();
    const intent = await this.transitionIntent(intentId, 'pending', 'install_pending', context, before.authority);
    const material = materialFromIntent(intent);
    let installed = false;
    let finalized = false;
    try {
      const key = await this.deps.keyStore.verify(String(intent.key_name));
      await this.deps.issuer.verify(key, material.thumbprint);
      await this.deps.roots.install(material, true);
      installed = true;
      if (await this.deps.roots.count(material.thumbprint) !== 1) throw new Error('root_install_verification_failed');
      const authority = await this.deps.authority();
      if (authority.authority !== before.authority || authority.resource !== before.resource || authority.issuer !== before.issuer || authority.appInstanceId !== before.appInstanceId) throw new Error('authority_changed');
      await this.finalizeIntent(intentId, 'completed', 'https_root_installed', {
        ...authority,
        rootCaThumbprint: material.thumbprint,
        currentUserKeyHandle: String(intent.key_name),
        enabled: true
      });
      finalized = true;
      await this.startIfAuthorized();
    } catch (error) {
      if (finalized) {
        await this.disableAfterHostFailure(intentId);
        await this.stop();
        throw error;
      }
      let compensated = true;
      if (installed) {
        try { await this.deps.roots.remove(material.thumbprint); compensated = (await this.deps.roots.count(material.thumbprint)) === 0; } catch { compensated = false; }
      }
      await this.completeFailure(intentId, compensated ? 'failed' : 'recovery_required', compensated ? 'https_root_install_failed' : 'https_root_install_recovery_required');
      await this.stop();
      throw error;
    }
  }

  async prepareTrustRemoval(context: RendererTrustContext): Promise<Readonly<Record<string, string>>> {
    validContext(context);
    const authority = await this.deps.authority();
    if (!authority.enabled || !authority.rootCaThumbprint) throw new Error('trust_not_authorized');
    const thumbprint = authority.rootCaThumbprint;
    const intentId = this.randomUUID();
    const now = this.now();
    const expires = new Date(now.getTime() + 5 * 60_000).toISOString();
    await this.deps.executeControlWrite({ requestId: `c14-trust-remove-prepare-${intentId}`, execute: (db, scope) => {
      sqlRun(db, `INSERT INTO agent_https_trust_intents
        (intent_id,kind,status,renderer_web_contents_id,navigation_generation,thumbprint,authority,expires_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, [intentId, 'remove', 'pending', context.webContentsId, context.navigationGeneration, thumbprint, authority.authority, expires, now.toISOString(), now.toISOString()]);
      this.deps.audit.appendAdmissionInTransaction(db, scope, { clientId: controlClientId, requestId: intentId, summary: { event: 'https_trust_removal_intent_created', intentId, thumbprint, authority: authority.authority } });
      return { changed: true, value: undefined };
    }});
    return Object.freeze({ intentId, thumbprint, authority: authority.authority, resource: authority.resource, expiresAt: expires });
  }

  async confirmTrustRemoval(intentId: string, confirmed: boolean, context: RendererTrustContext): Promise<void> {
    validContext(context);
    if (!confirmed) { await this.invalidateIntent(intentId, context, 'invalidated'); return; }
    const before = await this.deps.authority();
    const intent = await this.transitionIntent(intentId, 'pending', 'removal_pending', context, before.authority);
    const thumbprint = String(intent.thumbprint);
    await this.stop();
    this.deps.oauth.invalidatePending();
    try {
      await this.deps.roots.remove(thumbprint);
      if (await this.deps.roots.count(thumbprint) !== 0) throw new Error('root_removal_verification_failed');
      const authority = await this.deps.authority();
      await this.finalizeIntent(intentId, 'completed', 'https_root_removed', { ...authority, rootCaThumbprint: null as unknown as string, currentUserKeyHandle: null as unknown as string, certificateThumbprint: null as unknown as string, certificateNotAfter: null as unknown as string, enabled: false });
    } catch (error) {
      await this.completeFailure(intentId, 'recovery_required', 'https_root_removal_recovery_required');
      throw error;
    }
  }

  listPendingConsent(): readonly PendingOAuthAuthorizationRequest[] { return this.deps.oauth.listPending(); }

  async decideConsent(requestId: string, decision: 'approve' | 'deny', context: RendererTrustContext): Promise<void> {
    validContext(context);
    const authority = await this.deps.authority();
    if (!authority.enabled || !this.host) throw new Error('https_disabled');
    this.deps.oauth.setMetadata(createOAuthMetadata({ authority }));
    await this.deps.oauth.decidePending(requestId, decision);
  }

  async startIfAuthorized(): Promise<void> {
    const authority = await this.deps.authority();
    if (!authority.enabled || !authority.rootCaThumbprint || !authority.currentUserKeyHandle) { await this.stop(); await this.status(); return; }
    try {
      if (await this.deps.roots.count(authority.rootCaThumbprint) !== 1) {
        await this.stop();
        await this.disableAuthorityForTrustFailure(authority, 'https_root_count_invalid');
        await this.status();
        return;
      }
    } catch {
      await this.stop();
      await this.disableAuthorityForTrustFailure(authority, 'https_root_verification_failed').catch(() => undefined);
      await this.status();
      return;
    }
    this.deps.oauth.setMetadata(createOAuthMetadata({ authority }));
    this.deps.refreshAuthenticator?.(authority);
    await this.stop();
    this.host = this.deps.createHost(authority);
    if (!this.host) throw new Error('https_host_unavailable');
    try { await this.host.start(); } catch { await this.status(); return; }
    await this.status();
  }

  async refresh(): Promise<void> { await this.startIfAuthorized(); }
  async disable(): Promise<void> { await this.stop(); this.deps.oauth.invalidatePending(); await this.status(); }
  async stop(): Promise<void> { const host = this.host; this.host = undefined; await host?.stop(); await this.status(); }

  async reconcile(): Promise<void> {
    await this.stop();
    this.deps.oauth.invalidatePending();
    await this.deps.oauthTokenRecovery?.();
    await this.invalidatePersistedConsents();
    const expiredIntents = (await this.deps.executeControlWrite({ requestId: 'c14-trust-expired-read', execute: (db) => ({ changed: false, value: rows(db, "SELECT * FROM agent_https_trust_intents WHERE status = 'pending' AND expires_at <= ?", [this.now().toISOString()]) }) })).value;
    for (const intent of expiredIntents) {
      let cleaned = true;
      try { if (intent.kind === 'install' && typeof intent.thumbprint === 'string') await this.deps.issuer.remove?.(intent.thumbprint); if (intent.kind === 'install' && typeof intent.key_name === 'string') await this.deps.keyStore.remove?.(intent.key_name); } catch { cleaned = false; }
      await this.invalidatePersistedIntent(String(intent.intent_id), cleaned ? 'expired' : 'recovery_required');
    }
    const intents = (await this.deps.executeControlWrite({ requestId: 'c14-trust-reconcile-read', execute: (db) => ({ changed: false, value: rows(db, "SELECT * FROM agent_https_trust_intents WHERE status IN ('install_pending','removal_pending')") }) })).value;
    for (const intent of intents) {
      try {
        if (intent.status === 'install_pending') {
          const material = materialFromIntent(intent);
          const count = await this.deps.roots.count(String(intent.thumbprint));
          if (count === 0) { await this.completeFailure(String(intent.intent_id), 'failed', 'https_root_install_missing_after_restart'); continue; }
          if (count !== 1) { await this.completeFailure(String(intent.intent_id), 'recovery_required', 'https_root_install_ambiguous_after_restart'); continue; }
          const key = await this.deps.keyStore.verify(String(intent.key_name));
          await this.deps.issuer.verify(key, material.thumbprint);
          const authority = await this.deps.authority();
          await this.finalizeIntent(String(intent.intent_id), 'completed', 'https_root_install_reconciled', { ...authority, rootCaThumbprint: material.thumbprint, currentUserKeyHandle: String(intent.key_name), enabled: true });
        } else {
          const thumbprint = String(intent.thumbprint);
          const count = await this.deps.roots.count(thumbprint);
          if (count > 1) { await this.completeFailure(String(intent.intent_id), 'recovery_required', 'https_root_removal_ambiguous_after_restart'); continue; }
          if (count === 1) { await this.deps.roots.remove(thumbprint); if (await this.deps.roots.count(thumbprint) !== 0) throw new Error('root_removal_reconcile_failed'); }
          const authority = await this.deps.authority();
          await this.finalizeIntent(String(intent.intent_id), 'completed', 'https_root_removal_reconciled', { ...authority, rootCaThumbprint: null as unknown as string, currentUserKeyHandle: null as unknown as string, enabled: false });
        }
      } catch {
        await this.completeFailure(String(intent.intent_id), 'recovery_required', 'https_trust_reconcile_failed');
      }
    }
  }

  private async invalidatePersistedConsents(): Promise<void> {
    await this.deps.executeControlWrite({ requestId: 'c14-consent-reconcile', execute: (db, scope) => {
      const pending = rows(db, "SELECT request_id FROM agent_oauth_pending_consents WHERE status IN ('pending','approved')");
      for (const value of pending) {
        sqlRun(db, 'UPDATE agent_oauth_pending_consents SET status = ?, decided_at = ? WHERE request_id = ? AND status IN (?, ?)', ['invalidated', this.now().toISOString(), value.request_id, 'pending', 'approved']);
        this.deps.audit.appendReconciliationInTransaction(db, scope, { clientId: controlClientId, requestId: String(value.request_id), summary: { event: 'oauth_consent_restart_invalidated', requestId: String(value.request_id) } });
      }
      return { changed: pending.length > 0, value: undefined };
    }});
  }

  private async persistConsent(value: PendingOAuthAuthorizationRequest): Promise<void> {
    await this.deps.executeControlWrite({ requestId: `c14-consent-pending-${value.requestId}`, execute: (db, scope) => {
      sqlRun(db, `INSERT OR REPLACE INTO agent_oauth_pending_consents
        (request_id,client_id,product,scopes_json,resource,redirect_display,status,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?)`, [value.requestId, value.clientId, value.product, JSON.stringify(value.scopes), value.resource, value.redirectDisplay, 'pending', value.createdAt, value.expiresAt]);
      this.deps.audit.appendAdmissionInTransaction(db, scope, { clientId: controlClientId, requestId: value.requestId, summary: { event: 'oauth_consent_pending', requestId: value.requestId, clientId: value.clientId, scopes: [...value.scopes] } });
      return { changed: true, value: undefined };
    }});
  }

  private async persistConsentDecision(requestId: string, decision: 'approve' | 'deny', codeHash?: string, record?: OAuthStoredCode): Promise<void> {
    await this.persistConsentStatus(requestId, decision === 'approve' ? 'approved' : 'denied', codeHash, record);
  }

  private async persistConsentStatus(requestId: string, status: 'approved' | 'denied' | 'invalidated' | 'expired', codeHash?: string, record?: OAuthStoredCode): Promise<void> {
    await this.deps.executeControlWrite({ requestId: `c14-consent-status-${requestId}-${status}`, execute: (db, scope) => {
      if (status === 'approved') {
        if (!record || !codeHash || record.codeHash !== codeHash) throw new Error('oauth_consent_code_missing');
        sqlRun(db, `INSERT INTO agent_oauth_authorization_codes
          (code_hash, client_id, redirect_uri, resource, issuer, scopes_json, code_challenge, nonce_hash, app_instance_id, expires_at, used_at, refresh_tokens_allowed)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`, [record.codeHash, record.clientId, record.redirectUri, record.resource, record.issuer, JSON.stringify(record.scopes), record.codeChallenge, record.nonceHash ?? null, record.appInstanceId, record.expiresAt, record.refreshTokensAllowed ? 1 : 0]);
      }
      sqlRun(db, 'UPDATE agent_oauth_pending_consents SET status = ?, decided_at = ? WHERE request_id = ? AND status = ?', [status, this.now().toISOString(), requestId, 'pending']);
      if ((db as unknown as { getRowsModified(): number }).getRowsModified() !== 1) throw new Error('oauth_consent_not_pending');
      this.deps.audit.appendTerminalSuccessInTransaction(db, scope, { clientId: controlClientId, requestId, summary: { event: `oauth_consent_${status}`, requestId, ...(codeHash ? { codeHash } : {}) } });
      return { changed: true, value: undefined };
    }});
  }

  private async transitionIntent(intentId: string, from: IntentStatus, to: IntentStatus, context: RendererTrustContext, expectedAuthority: string): Promise<IntentRow> {
    return (await this.deps.executeControlWrite({ requestId: `c14-intent-transition-${intentId}-${to}`, execute: (db, scope) => {
      const intent = rows(db, 'SELECT * FROM agent_https_trust_intents WHERE intent_id = ?', [intentId])[0];
      if (!intent || intent.status !== from || intent.authority !== expectedAuthority || Number(intent.renderer_web_contents_id) !== context.webContentsId || Number(intent.navigation_generation) !== context.navigationGeneration || Date.parse(String(intent.expires_at)) <= this.now().getTime()) throw new Error('trust_intent_invalid');
      sqlRun(db, 'UPDATE agent_https_trust_intents SET status = ?, updated_at = ? WHERE intent_id = ? AND status = ?', [to, this.now().toISOString(), intentId, from]);
      if ((db as unknown as { getRowsModified(): number }).getRowsModified() !== 1) throw new Error('trust_intent_replay');
      this.deps.audit.appendWorkflowControlInTransaction(db, scope, { clientId: controlClientId, requestId: intentId, summary: { event: 'https_trust_intent_confirmed', intentId, status: to } });
      return { changed: true, value: intent };
    }})).value;
  }

  private async finalizeIntent(intentId: string, status: IntentStatus, event: string, authority: HttpOAuthAuthorityState): Promise<void> {
    await this.deps.executeControlWrite({ requestId: `c14-intent-finalize-${intentId}-${status}`, execute: (db, scope) => {
      if (this.deps.updateAuthorityInTransaction) this.deps.updateAuthorityInTransaction(db, scope, authority);
      else throw new Error('authority_transaction_boundary_unavailable');
      sqlRun(db, 'UPDATE agent_https_trust_intents SET status = ?, updated_at = ? WHERE intent_id = ? AND status IN (?, ?)', [status, this.now().toISOString(), intentId, 'install_pending', 'removal_pending']);
      if ((db as unknown as { getRowsModified(): number }).getRowsModified() !== 1) throw new Error('trust_intent_finalize_replay');
      this.deps.audit.appendTerminalSuccessInTransaction(db, scope, { clientId: controlClientId, requestId: intentId, summary: { event, intentId, status } });
      return { changed: true, value: undefined };
    }});
  }

  private async completeFailure(intentId: string, status: 'failed' | 'recovery_required', event: string): Promise<void> {
    try {
      await this.deps.executeControlWrite({ requestId: `c14-intent-failure-${intentId}-${status}`, execute: (db, scope) => {
        sqlRun(db, 'UPDATE agent_https_trust_intents SET status = ?, updated_at = ? WHERE intent_id = ? AND status IN (?, ?, ?, ?)', [status, this.now().toISOString(), intentId, 'install_pending', 'removal_pending', 'invalidated', 'expired']);
        if ((db as unknown as { getRowsModified(): number }).getRowsModified() !== 1) return { changed: false, value: undefined };
        this.deps.audit.appendTerminalFailureInTransaction(db, scope, { clientId: controlClientId, requestId: intentId, summary: { event, intentId, status } });
        return { changed: true, value: undefined };
      }});
    } catch {
      if (status !== 'recovery_required') {
        await this.deps.executeControlWrite({ requestId: `c14-intent-recovery-${intentId}`, execute: (db, scope) => {
          sqlRun(db, 'UPDATE agent_https_trust_intents SET status = ?, updated_at = ? WHERE intent_id = ?', ['recovery_required', this.now().toISOString(), intentId]);
          this.deps.audit.appendIndeterminateInTransaction(db, scope, { clientId: controlClientId, requestId: intentId, summary: { event: 'https_trust_recovery_required', intentId } });
          return { changed: true, value: undefined };
        }});
      }
    }
  }

  private async disableAfterHostFailure(intentId: string): Promise<void> {
    try {
      const authority = await this.deps.authority();
      await this.deps.executeControlWrite({ requestId: `c14-host-start-failure-${intentId}`, execute: (db, scope) => {
        if (this.deps.updateAuthorityInTransaction) this.deps.updateAuthorityInTransaction(db, scope, { ...authority, enabled: false });
        this.deps.audit.appendTerminalFailureInTransaction(db, scope, { clientId: controlClientId, requestId: intentId, summary: { event: 'https_host_start_failed', intentId } });
        return { changed: true, value: undefined };
      }});
    } catch {
      // The committed trust intent remains durable; startup reconciliation is the recovery fence.
    }
  }

  private async disableAuthorityForTrustFailure(authority: HttpOAuthAuthorityState, event: string): Promise<void> {
    await this.deps.executeControlWrite({ requestId: `c14-trust-runtime-${this.randomUUID()}`, execute: (db, scope) => {
      if (!this.deps.updateAuthorityInTransaction) throw new Error('authority_transaction_boundary_unavailable');
      this.deps.updateAuthorityInTransaction(db, scope, { ...authority, enabled: false });
      this.deps.audit.appendTerminalFailureInTransaction(db, scope, { clientId: controlClientId, summary: { event, authority: authority.authority } });
      return { changed: true, value: undefined };
    }});
  }

  private async invalidateIntent(intentId: string, context: RendererTrustContext, status: 'invalidated' | 'expired'): Promise<void> {
    validContext(context);
    const intent = (await this.deps.executeControlWrite({ requestId: `c14-intent-invalidate-read-${intentId}`, execute: (db) => ({ changed: false, value: rows(db, 'SELECT * FROM agent_https_trust_intents WHERE intent_id = ?', [intentId])[0] }) })).value;
    await this.deps.executeControlWrite({ requestId: `c14-intent-invalidate-${intentId}`, execute: (db, scope) => {
      if (!intent || Number(intent.renderer_web_contents_id) !== context.webContentsId || Number(intent.navigation_generation) !== context.navigationGeneration || intent.status !== 'pending') throw new Error('trust_intent_invalid');
      sqlRun(db, 'UPDATE agent_https_trust_intents SET status = ?, updated_at = ? WHERE intent_id = ? AND status = ?', [status, this.now().toISOString(), intentId, 'pending']);
      this.deps.audit.appendTerminalFailureInTransaction(db, scope, { clientId: controlClientId, requestId: intentId, summary: { event: 'https_trust_intent_cancelled', intentId, status } });
      return { changed: true, value: undefined };
    }});
    if (intent.kind === 'install') {
      try { if (typeof intent.thumbprint === 'string') await this.deps.issuer.remove?.(intent.thumbprint); if (typeof intent.key_name === 'string') await this.deps.keyStore.remove?.(intent.key_name); }
      catch (error) { await this.completeFailure(intentId, 'recovery_required', 'https_trust_intent_cleanup_failed'); throw error; }
    }
  }

  private async invalidatePersistedIntent(intentId: string, status: 'expired' | 'invalidated' | 'recovery_required'): Promise<void> {
    await this.deps.executeControlWrite({ requestId: `c14-intent-expire-${intentId}`, execute: (db, scope) => {
      sqlRun(db, 'UPDATE agent_https_trust_intents SET status = ?, updated_at = ? WHERE intent_id = ? AND status = ?', [status, this.now().toISOString(), intentId, 'pending']);
      this.deps.audit.appendTerminalFailureInTransaction(db, scope, { clientId: controlClientId, requestId: intentId, summary: { event: status === 'recovery_required' ? 'https_trust_intent_cleanup_failed' : 'https_trust_intent_expired', intentId, status } });
      return { changed: true, value: undefined };
    }});
  }
}

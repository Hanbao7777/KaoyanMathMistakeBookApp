import { randomUUID } from 'node:crypto';
import type { Database } from 'sql.js';
import { AgentError } from '../../shared/agent/errors';
import { agentApiVersion } from '../../shared/agent/versions';
import {
  agentScopes,
  trustProfiles,
  type AgentPrincipalClaims,
  type AgentScope,
  type CatalogIdentity,
  type OperationPolicyOverride,
  type TrustProfile
} from '../../shared/agent/v1/gatewayContracts';
import {
  canonicalizeJson,
  hashCanonicalJson,
  validateGatewayManagementCommand,
  validateOperationPolicyOverride
} from '../../shared/agent/v1/gatewaySchemas';
import type { PublicKeyBindingInput, SafeClientKeyBindingResult } from '../../shared/agent/v1/gatewayContracts';
import { directHttpsAuthority, directHttpsDefaultPort, validateHttpOAuthClientRegistration, type DirectHttpsAuthority, type HttpOAuthClientRegistration } from '../../shared/mcp/v1/oauthContracts';
import type { OAuthStoredCode, OAuthTokenStoreSnapshot } from '../mcp/auth/oauthTokenStore';
import { resolveOperationDescriptor } from '../../shared/agent/v1/operationCatalog';
import {
  assertDatabaseMutationScope,
  type DatabaseControlWriteRequest,
  type DatabaseMutationResult,
  type DatabaseMutationScope,
  type DatabaseWriteResult
} from '../persistence/databaseCoordinator';
import { all, one, type SqlParameter } from './sqlRows';

export interface AgentControlSettings {
  readonly externalControlEnabled: boolean;
  readonly catalog: CatalogIdentity;
  readonly policyVersion: string;
  readonly overrides: readonly OperationPolicyOverride[];
  readonly policyHash: string;
  readonly privacyRevision: number;
}

export interface RegisteredAgentClient {
  readonly clientId: string;
  readonly subjectId: string;
  readonly displayName: string;
  readonly credentialFingerprint: string;
  readonly scopes: readonly AgentScope[];
  readonly trust: TrustProfile;
  readonly revokedAt?: string;
}

export interface RegisteredAgentSession {
  readonly sessionId: string;
  readonly clientId: string;
  readonly appInstanceId: string;
  readonly sessionFingerprint: string;
  readonly credentialFingerprint: string;
  readonly expiresAt: string;
  readonly terminatedAt?: string;
}

export interface ActiveClientKeyBinding {
  readonly clientId: string;
  readonly publicKey: string;
  readonly publicKeyFingerprint: string;
  readonly keyGeneration: number;
  readonly registryGeneration: number;
}

export interface AgentClientSummary {
  readonly clientId: string;
  readonly subjectId: string;
  readonly displayName: string;
  readonly scopes: readonly AgentScope[];
  readonly trust: TrustProfile;
  readonly revokedAt?: string;
  readonly lastActiveAt?: string;
}

export interface AgentSessionSummary {
  readonly sessionId: string;
  readonly clientId: string;
  readonly appInstanceId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastActiveAt: string;
  readonly terminatedAt?: string;
}

export interface ClientRegistration {
  readonly clientId: string;
  readonly subjectId: string;
  readonly displayName: string;
  readonly credentialFingerprint: string;
  readonly scopes: readonly AgentScope[];
  readonly trust: TrustProfile;
}

export interface HttpOAuthAuthorityState extends DirectHttpsAuthority {
  readonly appInstanceId: string;
  readonly rootCaThumbprint?: string;
  readonly previousRootCaThumbprint?: string;
  readonly currentUserKeyHandle?: string;
  readonly certificateThumbprint?: string;
  readonly certificateNotAfter?: string;
  readonly enabled: boolean;
}

export interface ClientRegistryDependencies {
  readonly executeControlWrite: <T>(request: DatabaseControlWriteRequest<T>) => Promise<DatabaseWriteResult<T>>;
  readonly appInstanceId: string;
  readonly catalog: CatalogIdentity;
  readonly now?: () => string;
  readonly randomUUID?: () => string;
}

function assertSafeIdentifier(value: string, field: string): void {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(value)) throw new AgentError('VALIDATION_ERROR', { field });
}

function assertFingerprint(value: string, field: string): void {
  if (!/^sha256-v1:[0-9a-f]{64}$/.test(value)) throw new AgentError('VALIDATION_ERROR', { field });
}

const canonicalTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function canonicalTimestampMs(value: string, field: string): number {
  if (!canonicalTimestamp.test(value)) throw new AgentError('VALIDATION_ERROR', { field });
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new AgentError('VALIDATION_ERROR', { field });
  }
  return milliseconds;
}

function normalizeScopes(scopes: readonly AgentScope[]): readonly AgentScope[] {
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((scope) => !agentScopes.includes(scope))) {
    throw new AgentError('VALIDATION_ERROR', { field: 'scopes' });
  }
  const normalized = [...scopes].sort();
  if (new Set(normalized).size !== normalized.length) throw new AgentError('VALIDATION_ERROR', { field: 'scopes' });
  return Object.freeze(normalized);
}

function assertTrust(trust: TrustProfile): void {
  if (!trustProfiles.includes(trust)) throw new AgentError('VALIDATION_ERROR', { field: 'trust' });
}

function toClient(row: Record<string, unknown>, scopes: readonly AgentScope[]): RegisteredAgentClient {
  return Object.freeze({
    clientId: String(row.client_id),
    subjectId: String(row.subject_id),
    displayName: String(row.display_name),
    credentialFingerprint: String(row.credential_fingerprint),
    scopes: Object.freeze([...scopes]),
    trust: row.trust as TrustProfile,
    ...(typeof row.revoked_at === 'string' ? { revokedAt: row.revoked_at } : {})
  });
}

function toClientSummary(row: Record<string, unknown>, scopes: readonly AgentScope[]): AgentClientSummary {
  return Object.freeze({
    clientId: String(row.client_id),
    subjectId: String(row.subject_id),
    displayName: String(row.display_name),
    scopes: Object.freeze([...scopes]),
    trust: row.trust as TrustProfile,
    ...(typeof row.revoked_at === 'string' ? { revokedAt: row.revoked_at } : {}),
    ...(typeof row.last_active_at === 'string' ? { lastActiveAt: row.last_active_at } : {})
  });
}

function toSessionSummary(row: Record<string, unknown>): AgentSessionSummary {
  return Object.freeze({
    sessionId: String(row.session_id),
    clientId: String(row.client_id),
    appInstanceId: String(row.app_instance_id),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    lastActiveAt: String(row.last_active_at),
    ...(typeof row.terminated_at === 'string' ? { terminatedAt: row.terminated_at } : {})
  });
}

function assertWindowLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 201) throw new AgentError('VALIDATION_ERROR', { field: 'limit' });
}

function executeOAuthSql(database: Database, sql: string, parameters: readonly SqlParameter[] = []): void {
  const run = (database as unknown as { readonly run: (statement: string, values?: readonly SqlParameter[]) => void })['run'];
  run.call(database, sql, parameters);
}

export class ClientRegistry {
  private readonly executeControlWrite: ClientRegistryDependencies['executeControlWrite'];
  private readonly appInstanceId: string;
  private readonly catalog: CatalogIdentity;
  private readonly now: () => string;
  private readonly randomUUID: () => string;
  private httpOAuthRevocationHook?: (clientId: string) => Promise<void> | void;

  constructor(dependencies: ClientRegistryDependencies) {
    assertSafeIdentifier(dependencies.appInstanceId, 'appInstanceId');
    this.executeControlWrite = dependencies.executeControlWrite;
    this.appInstanceId = dependencies.appInstanceId;
    this.catalog = Object.freeze({ ...dependencies.catalog });
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.randomUUID = dependencies.randomUUID ?? randomUUID;
  }

  async initialize(): Promise<void> {
    const timestamp = this.timestamp();
    const policyJson = canonicalizeJson([]);
    const policyHash = hashCanonicalJson([]);
    await this.write('agent-registry-bootstrap', (database) => {
      const existing = one(database, 'SELECT id FROM agent_control_settings WHERE id = 1');
      let changed = false;
      if (!existing) {
        database.run(`INSERT INTO agent_control_settings (
          id, external_control_enabled, catalog_version, catalog_hash, policy_version, policy_json, policy_hash,
          privacy_revision, created_at, updated_at
        ) VALUES (1, 0, ?, ?, 'agent-policy-v1@1', ?, ?, 1, ?, ?)`, [
          this.catalog.version, this.catalog.hash, policyJson, policyHash, timestamp, timestamp
        ]);
        changed = true;
      }
      database.run(
        'UPDATE agent_sessions SET terminated_at = ? WHERE terminated_at IS NULL',
        [timestamp]
      );
      const terminated = database.getRowsModified() > 0;
      return { changed: changed || terminated, value: undefined };
    });
  }

  async getSettings(): Promise<AgentControlSettings> {
    return this.read('agent-settings-read', (database) => {
      const row = one(database, 'SELECT * FROM agent_control_settings WHERE id = 1');
      if (!row) throw new AgentError('RECOVERY_FENCE');
      const text = String(row.policy_json);
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw new AgentError('POLICY_INVARIANT_VIOLATION'); }
      if (!Array.isArray(parsed) || canonicalizeJson(parsed) !== text || hashCanonicalJson(parsed) !== row.policy_hash) {
        throw new AgentError('POLICY_INVARIANT_VIOLATION');
      }
      const overrides = parsed as OperationPolicyOverride[];
      for (const override of overrides) {
        validateOperationPolicyOverride(override, resolveOperationDescriptor(override.operation), this.catalog);
      }
      return Object.freeze({
        externalControlEnabled: row.external_control_enabled === 1,
        catalog: Object.freeze({ version: String(row.catalog_version), hash: String(row.catalog_hash) }),
        policyVersion: String(row.policy_version),
        overrides: Object.freeze(overrides.map((override) => Object.freeze({ ...override }))),
        policyHash: String(row.policy_hash),
        privacyRevision: Number(row.privacy_revision)
      });
    });
  }

  async setExternalControlEnabled(enabled: boolean): Promise<void> {
    await this.write('agent-control-enabled', (database, scope) => this.setExternalControlEnabledInTransaction(database, scope, enabled));
  }

  setExternalControlEnabledInTransaction(database: Database, scope: DatabaseMutationScope, enabled: boolean): DatabaseMutationResult<void> {
    assertDatabaseMutationScope(scope, database);
    if (typeof enabled !== 'boolean') throw new AgentError('VALIDATION_ERROR', { field: 'enabled' });
    const current = one(database, 'SELECT external_control_enabled FROM agent_control_settings WHERE id = 1');
    if (!current) throw new AgentError('RECOVERY_FENCE');
    if ((current.external_control_enabled === 1) === enabled) return { changed: false, value: undefined };
    database.run('UPDATE agent_control_settings SET external_control_enabled = ?, updated_at = ? WHERE id = 1', [enabled ? 1 : 0, this.timestamp()]);
    return { changed: true, value: undefined };
  }

  async updatePolicy(policyVersion: string, overrides: readonly OperationPolicyOverride[]): Promise<void> {
    const normalized = this.normalizePolicy(policyVersion, overrides);
    await this.write('agent-policy-update', (database, scope) => this.updatePolicyInTransaction(database, scope, normalized.policyVersion, normalized.overrides));
  }

  updatePolicyInTransaction(
    database: Database,
    scope: DatabaseMutationScope,
    policyVersion: string,
    overrides: readonly OperationPolicyOverride[]
  ): DatabaseMutationResult<void> {
    assertDatabaseMutationScope(scope, database);
    const normalized = this.normalizePolicy(policyVersion, overrides);
    const policyJson = canonicalizeJson(normalized.overrides);
    const policyHash = hashCanonicalJson(normalized.overrides);
    const current = one(database, 'SELECT policy_version, policy_hash FROM agent_control_settings WHERE id = 1');
    if (!current) throw new AgentError('RECOVERY_FENCE');
    if (current.policy_version === normalized.policyVersion && current.policy_hash === policyHash) return { changed: false, value: undefined };
    database.run('UPDATE agent_control_settings SET policy_version = ?, policy_json = ?, policy_hash = ?, updated_at = ? WHERE id = 1', [
      normalized.policyVersion, policyJson, policyHash, this.timestamp()
    ]);
    return { changed: database.getRowsModified() > 0, value: undefined };
  }

  private normalizePolicy(policyVersion: string, overrides: readonly OperationPolicyOverride[]): {
    readonly policyVersion: string;
    readonly overrides: readonly OperationPolicyOverride[];
  } {
    assertSafeIdentifier(policyVersion, 'policyVersion');
    const seen = new Set<string>();
    const normalized = [...overrides].sort((left, right) => left.operation.localeCompare(right.operation));
    for (const override of normalized) {
      if (seen.has(override.operation)) throw new AgentError('VALIDATION_ERROR', { field: 'overrides' });
      seen.add(override.operation);
      validateOperationPolicyOverride(override, resolveOperationDescriptor(override.operation), this.catalog);
    }
    return Object.freeze({ policyVersion, overrides: Object.freeze(normalized) });
  }

  async registerClient(registration: ClientRegistration): Promise<RegisteredAgentClient> {
    assertSafeIdentifier(registration.clientId, 'clientId');
    assertSafeIdentifier(registration.subjectId, 'subjectId');
    if (!registration.displayName.trim() || registration.displayName.length > 200) throw new AgentError('VALIDATION_ERROR', { field: 'displayName' });
    assertFingerprint(registration.credentialFingerprint, 'credentialFingerprint');
    assertTrust(registration.trust);
    const scopes = normalizeScopes(registration.scopes);
    const timestamp = this.timestamp();
    return this.write(`agent-client-register-${registration.clientId}`, (database) => {
      database.run(`INSERT INTO agent_clients (
        client_id, subject_id, display_name, credential_fingerprint, trust, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
        registration.clientId, registration.subjectId, registration.displayName, registration.credentialFingerprint,
        registration.trust, timestamp, timestamp
      ]);
      for (const scope of scopes) {
        database.run('INSERT INTO agent_client_scopes (client_id, scope, catalog_version, created_at) VALUES (?, ?, ?, ?)', [
          registration.clientId, scope, this.catalog.version, timestamp
        ]);
      }
      return { changed: true, value: toClient({
        client_id: registration.clientId,
        subject_id: registration.subjectId,
        display_name: registration.displayName,
        credential_fingerprint: registration.credentialFingerprint,
        trust: registration.trust
      }, scopes) };
    });
  }

  setHttpOAuthRevocationHook(hook?: (clientId: string) => Promise<void> | void): void { this.httpOAuthRevocationHook = hook; }

  async registerHttpClient(registration: HttpOAuthClientRegistration): Promise<HttpOAuthClientRegistration> {
    validateHttpOAuthClientRegistration(registration);
    const scopes = normalizeScopes(registration.allowedScopes);
    const timestamp = this.timestamp();
    await this.write(`agent-http-client-register-${registration.clientId}`, (database) => {
      const credentialFingerprint = hashCanonicalJson({ kind: 'http-oauth-client', clientId: registration.clientId });
      const existing = one(database, 'SELECT revoked_at FROM agent_http_clients WHERE client_id = ?', [registration.clientId]);
      if (existing && existing.revoked_at === null) throw new AgentError('IDEMPOTENCY_CONFLICT');
      if (existing) {
        executeOAuthSql(database, 'UPDATE agent_clients SET subject_id = ?, display_name = ?, credential_fingerprint = ?, trust = ?, revoked_at = NULL, updated_at = ? WHERE client_id = ?', [`http-${registration.clientId}`, registration.product === 'codex' ? 'Codex CLI' : 'Claude Code', credentialFingerprint, registration.trust, timestamp, registration.clientId]);
        executeOAuthSql(database, 'DELETE FROM agent_client_scopes WHERE client_id = ?', [registration.clientId]);
        executeOAuthSql(database, 'UPDATE agent_http_clients SET product = ?, version_evidence = ?, redirect_mode = ?, exact_redirect_uri = ?, resource = ?, issuer = ?, scopes_json = ?, trust = ?, refresh_tokens_allowed = ?, metadata_hash = ?, revoked_at = NULL, updated_at = ? WHERE client_id = ?', [registration.product, registration.versionEvidence, registration.redirectMode, registration.exactRedirectUri ?? null, registration.resource, registration.issuer, canonicalizeJson(scopes), registration.trust, registration.refreshTokensAllowed ? 1 : 0, registration.metadataHash ?? null, timestamp, registration.clientId]);
      } else {
        executeOAuthSql(database, 'INSERT INTO agent_clients (client_id, subject_id, display_name, credential_fingerprint, trust, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [registration.clientId, `http-${registration.clientId}`, registration.product === 'codex' ? 'Codex CLI' : 'Claude Code', credentialFingerprint, registration.trust, timestamp, timestamp]);
        executeOAuthSql(database, `INSERT INTO agent_http_clients (client_id, product, version_evidence, redirect_mode, exact_redirect_uri, resource, issuer, scopes_json, trust, refresh_tokens_allowed, metadata_hash, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [registration.clientId, registration.product, registration.versionEvidence, registration.redirectMode, registration.exactRedirectUri ?? null, registration.resource, registration.issuer, canonicalizeJson(scopes), registration.trust, registration.refreshTokensAllowed ? 1 : 0, registration.metadataHash ?? null, timestamp, timestamp]);
      }
      for (const scope of scopes) executeOAuthSql(database, 'INSERT INTO agent_client_scopes (client_id, scope, catalog_version, created_at) VALUES (?, ?, ?, ?)', [registration.clientId, scope, this.catalog.version, timestamp]);
      return { changed: true, value: undefined };
    });
    return Object.freeze({ ...registration, allowedScopes: scopes });
  }

  async ensureHttpClient(registration: HttpOAuthClientRegistration): Promise<void> {
    validateHttpOAuthClientRegistration(registration);
    const scopes = normalizeScopes(registration.allowedScopes);
    const timestamp = this.timestamp();
    await this.write(`agent-http-client-ensure-${registration.clientId}`, (database) => {
      const existing = one(database, 'SELECT * FROM agent_http_clients WHERE client_id = ?', [registration.clientId]);
      if (existing) {
        if (typeof existing.revoked_at === 'string') return { changed: false, value: undefined };
        const exact = existing.product === registration.product && existing.version_evidence === registration.versionEvidence && existing.redirect_mode === registration.redirectMode
          && (existing.exact_redirect_uri ?? undefined) === registration.exactRedirectUri && existing.resource === registration.resource && existing.issuer === registration.issuer
          && existing.scopes_json === canonicalizeJson(scopes) && existing.trust === registration.trust && existing.refresh_tokens_allowed === (registration.refreshTokensAllowed ? 1 : 0)
          && (existing.metadata_hash ?? undefined) === registration.metadataHash;
        if (!exact) throw new AgentError('RECOVERY_FENCE');
        return { changed: false, value: undefined };
      }
      const credentialFingerprint = hashCanonicalJson({ kind: 'http-oauth-client', clientId: registration.clientId });
      executeOAuthSql(database, 'INSERT INTO agent_clients (client_id, subject_id, display_name, credential_fingerprint, trust, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [registration.clientId, `http-${registration.clientId}`, registration.product === 'codex' ? 'Codex CLI' : 'Claude Code', credentialFingerprint, registration.trust, timestamp, timestamp]);
      executeOAuthSql(database, `INSERT INTO agent_http_clients (client_id, product, version_evidence, redirect_mode, exact_redirect_uri, resource, issuer, scopes_json, trust, refresh_tokens_allowed, metadata_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [registration.clientId, registration.product, registration.versionEvidence, registration.redirectMode, registration.exactRedirectUri ?? null, registration.resource, registration.issuer, canonicalizeJson(scopes), registration.trust, registration.refreshTokensAllowed ? 1 : 0, registration.metadataHash ?? null, timestamp, timestamp]);
      for (const scope of scopes) executeOAuthSql(database, 'INSERT INTO agent_client_scopes (client_id, scope, catalog_version, created_at) VALUES (?, ?, ?, ?)', [registration.clientId, scope, this.catalog.version, timestamp]);
      return { changed: true, value: undefined };
    });
  }

  async getHttpClient(clientId: string): Promise<HttpOAuthClientRegistration | null> {
    assertSafeIdentifier(clientId, 'clientId');
    return this.read(`agent-http-client-${clientId}`, (database) => {
      const row = one(database, 'SELECT * FROM agent_http_clients WHERE client_id = ?', [clientId]); if (!row || typeof row.revoked_at === 'string') return null;
      let scopes: unknown; try { scopes = JSON.parse(String(row.scopes_json)); } catch { throw new AgentError('RECOVERY_FENCE'); }
      if (!Array.isArray(scopes) || scopes.some((scope) => !agentScopes.includes(scope as AgentScope))) throw new AgentError('RECOVERY_FENCE');
      return Object.freeze({ clientId, product: row.product as 'codex' | 'claude_code', versionEvidence: String(row.version_evidence), redirectMode: row.redirect_mode as 'codex-loopback' | 'claude-exact', ...(typeof row.exact_redirect_uri === 'string' ? { exactRedirectUri: row.exact_redirect_uri } : {}), resource: String(row.resource), issuer: String(row.issuer), allowedScopes: Object.freeze(scopes as AgentScope[]), trust: row.trust as TrustProfile, refreshTokensAllowed: row.refresh_tokens_allowed === 1, ...(typeof row.metadata_hash === 'string' ? { metadataHash: row.metadata_hash } : {}) });
    });
  }

  async isHttpClientActive(clientId: string): Promise<boolean> { return (await this.getHttpClient(clientId)) !== null && await this.read(`agent-http-client-active-${clientId}`, (database) => { const row = one(database, 'SELECT revoked_at FROM agent_http_clients WHERE client_id = ?', [clientId]); return !!row && row.revoked_at === null; }); }
  async getHttpClientScopes(clientId: string): Promise<readonly AgentScope[]> { const client = await this.getHttpClient(clientId); if (!client) throw new AgentError('CLIENT_REVOKED'); return client.allowedScopes; }

  async getHttpOAuthAuthority(): Promise<HttpOAuthAuthorityState | null> {
    return this.read('agent-http-authority', (database) => { const row = one(database, 'SELECT * FROM agent_http_oauth_config WHERE id = 1'); if (!row) return Object.freeze({ ...directHttpsAuthority(directHttpsDefaultPort), appInstanceId: this.appInstanceId, enabled: false }); const authority = directHttpsAuthority(Number(row.direct_https_port)); return Object.freeze({ ...authority, appInstanceId: String(row.app_instance_id), ...(typeof row.root_ca_thumbprint === 'string' ? { rootCaThumbprint: row.root_ca_thumbprint } : {}), ...(typeof row.previous_root_ca_thumbprint === 'string' ? { previousRootCaThumbprint: row.previous_root_ca_thumbprint } : {}), ...(typeof row.current_user_key_handle === 'string' ? { currentUserKeyHandle: row.current_user_key_handle } : {}), ...(typeof row.certificate_thumbprint === 'string' ? { certificateThumbprint: row.certificate_thumbprint } : {}), ...(typeof row.certificate_not_after === 'string' ? { certificateNotAfter: row.certificate_not_after } : {}), enabled: row.enabled === 1 }); });
  }

  async initializeHttpOAuthAuthority(input: Partial<HttpOAuthAuthorityState> & { readonly appInstanceId: string }): Promise<HttpOAuthAuthorityState> {
    const authority = directHttpsAuthority(input.port ?? directHttpsDefaultPort); const timestamp = this.timestamp();
    await this.write('agent-http-authority-init', (database) => { const existing = one(database, 'SELECT id FROM agent_http_oauth_config WHERE id = 1'); if (existing) return { changed: false, value: undefined }; executeOAuthSql(database, `INSERT INTO agent_http_oauth_config (id, direct_https_port, authority, resource, issuer, app_instance_id, enabled, updated_at) VALUES (1, ?, ?, ?, ?, ?, 0, ?)`, [authority.port, authority.authority, authority.resource, authority.issuer, input.appInstanceId, timestamp]); return { changed: true, value: undefined }; });
    const value = await this.getHttpOAuthAuthority(); if (!value) throw new AgentError('RECOVERY_FENCE'); return value;
  }

  async updateHttpOAuthAuthority(input: Partial<HttpOAuthAuthorityState> & { readonly appInstanceId: string }): Promise<HttpOAuthAuthorityState> {
    const prior = await this.getHttpOAuthAuthority();
    const merged = { ...(prior ?? { ...directHttpsAuthority(input.port ?? directHttpsDefaultPort), appInstanceId: input.appInstanceId, enabled: false }), ...input };
    const authority = directHttpsAuthority(merged.port ?? directHttpsDefaultPort);
    const authorityChanged = !!prior && (prior.authority !== authority.authority || prior.resource !== authority.resource || prior.issuer !== authority.issuer);
    await this.write('agent-http-authority-update', (database, scope) => this.updateHttpOAuthAuthorityInTransaction(database, scope, { ...merged, ...authority, appInstanceId: merged.appInstanceId, enabled: merged.enabled ?? false }));
    if (authorityChanged) { const ids = await this.read('agent-http-client-ids', (database) => all(database, 'SELECT client_id FROM agent_http_clients').map((row) => String(row.client_id))); for (const clientId of ids) await this.httpOAuthRevocationHook?.(clientId); }
    const value = await this.getHttpOAuthAuthority(); if (!value) throw new AgentError('RECOVERY_FENCE'); return value;
  }

  updateHttpOAuthAuthorityInTransaction(
    database: Database,
    scope: DatabaseMutationScope,
    input: Partial<HttpOAuthAuthorityState> & { readonly appInstanceId: string }
  ): DatabaseMutationResult<void> {
    assertDatabaseMutationScope(scope, database);
    const current = one(database, 'SELECT * FROM agent_http_oauth_config WHERE id = 1');
    const port = input.port ?? Number(current?.direct_https_port ?? directHttpsDefaultPort);
    const authority = directHttpsAuthority(port);
    const timestamp = this.timestamp();
    const previousAuthority = current ? String(current.authority) : authority.authority;
    const authorityChanged = previousAuthority !== authority.authority || String(current?.resource ?? authority.resource) !== authority.resource || String(current?.issuer ?? authority.issuer) !== authority.issuer;
    executeOAuthSql(database, `INSERT OR REPLACE INTO agent_http_oauth_config
      (id, direct_https_port, authority, resource, issuer, app_instance_id, root_ca_thumbprint, previous_root_ca_thumbprint, current_user_key_handle, certificate_thumbprint, certificate_not_after, enabled, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [authority.port, authority.authority, authority.resource, authority.issuer, input.appInstanceId, input.rootCaThumbprint !== undefined ? input.rootCaThumbprint : (typeof current?.root_ca_thumbprint === 'string' ? current.root_ca_thumbprint : null), input.previousRootCaThumbprint !== undefined ? input.previousRootCaThumbprint : (typeof current?.previous_root_ca_thumbprint === 'string' ? current.previous_root_ca_thumbprint : null), input.currentUserKeyHandle !== undefined ? input.currentUserKeyHandle : (typeof current?.current_user_key_handle === 'string' ? current.current_user_key_handle : null), input.certificateThumbprint !== undefined ? input.certificateThumbprint : (typeof current?.certificate_thumbprint === 'string' ? current.certificate_thumbprint : null), input.certificateNotAfter !== undefined ? input.certificateNotAfter : (typeof current?.certificate_not_after === 'string' ? current.certificate_not_after : null), input.enabled !== undefined ? (input.enabled ? 1 : 0) : (typeof current?.enabled === 'number' ? current.enabled : 0), timestamp]);
    if (authorityChanged) {
      executeOAuthSql(database, 'UPDATE agent_clients SET revoked_at = ?, updated_at = ? WHERE client_id IN (SELECT client_id FROM agent_http_clients)', [timestamp, timestamp]);
      executeOAuthSql(database, 'UPDATE agent_http_clients SET revoked_at = ?, updated_at = ?', [timestamp, timestamp]);
    }
    return { changed: true, value: undefined };
  }

  async loadOAuthTokenSnapshot(): Promise<OAuthTokenStoreSnapshot | undefined> {
    return this.read('agent-oauth-snapshot-load', (database) => {
      const codes = all(database, 'SELECT * FROM agent_oauth_authorization_codes').map((row) => Object.freeze({ codeHash: String(row.code_hash), clientId: String(row.client_id), redirectUri: String(row.redirect_uri), resource: String(row.resource), issuer: String(row.issuer), scopes: Object.freeze(JSON.parse(String(row.scopes_json)) as AgentScope[]), codeChallenge: String(row.code_challenge), ...(typeof row.nonce_hash === 'string' ? { nonceHash: row.nonce_hash } : {}), appInstanceId: String(row.app_instance_id), expiresAt: String(row.expires_at), used: typeof row.used_at === 'string', refreshTokensAllowed: row.refresh_tokens_allowed === 1 }));
      const accessTokens = all(database, 'SELECT * FROM agent_oauth_access_tokens').map((row) => Object.freeze({ tokenHash: String(row.token_hash), tokenId: String(row.token_id), clientId: String(row.client_id), scopes: Object.freeze(JSON.parse(String(row.scopes_json)) as AgentScope[]), resource: String(row.resource), issuer: String(row.issuer), appInstanceId: String(row.app_instance_id), ...(typeof row.family_id === 'string' ? { familyId: row.family_id } : {}), expiresAt: String(row.expires_at), revoked: typeof row.revoked_at === 'string' }));
      const refreshFamilies = all(database, 'SELECT * FROM agent_oauth_refresh_families').map((row) => Object.freeze({ familyId: String(row.family_id), clientId: String(row.client_id), resource: String(row.resource), issuer: String(row.issuer), appInstanceId: String(row.app_instance_id), scopes: Object.freeze(JSON.parse(String(row.scopes_json)) as AgentScope[]), currentTokenHash: String(row.current_token_hash), expiresAt: String(row.expires_at), revoked: typeof row.revoked_at === 'string' }));
      const refreshTokens = all(database, 'SELECT * FROM agent_oauth_refresh_tokens').map((row) => Object.freeze({ tokenHash: String(row.token_hash), familyId: String(row.family_id), used: typeof row.used_at === 'string' }));
      const revokedTokenIds = all(database, 'SELECT token_id FROM agent_oauth_revocations').map((row) => String(row.token_id));
      if (codes.length === 0 && accessTokens.length === 0 && refreshFamilies.length === 0 && refreshTokens.length === 0 && revokedTokenIds.length === 0) return undefined;
      return Object.freeze({ version: 1 as const, codes: Object.freeze(codes), accessTokens: Object.freeze(accessTokens), refreshFamilies: Object.freeze(refreshFamilies), refreshTokens: Object.freeze(refreshTokens), revokedTokenIds: Object.freeze(revokedTokenIds) });
    });
  }

  async persistOAuthTokenSnapshot(snapshot: OAuthTokenStoreSnapshot): Promise<void> {
    await this.write('agent-oauth-snapshot-save', (database) => {
      executeOAuthSql(database, 'DELETE FROM agent_oauth_authorization_codes'); executeOAuthSql(database, 'DELETE FROM agent_oauth_access_tokens'); executeOAuthSql(database, 'DELETE FROM agent_oauth_refresh_tokens'); executeOAuthSql(database, 'DELETE FROM agent_oauth_refresh_families'); executeOAuthSql(database, 'DELETE FROM agent_oauth_revocations');
      for (const value of snapshot.codes) executeOAuthSql(database, 'INSERT INTO agent_oauth_authorization_codes (code_hash, client_id, redirect_uri, resource, issuer, scopes_json, code_challenge, nonce_hash, app_instance_id, expires_at, used_at, refresh_tokens_allowed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [value.codeHash, value.clientId, value.redirectUri, value.resource, value.issuer, canonicalizeJson(value.scopes), value.codeChallenge, value.nonceHash ?? null, value.appInstanceId, value.expiresAt, value.used ? this.timestamp() : null, value.refreshTokensAllowed ? 1 : 0]);
      for (const value of snapshot.accessTokens) executeOAuthSql(database, 'INSERT INTO agent_oauth_access_tokens (token_id, token_hash, client_id, scopes_json, resource, issuer, app_instance_id, family_id, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [value.tokenId, value.tokenHash, value.clientId, canonicalizeJson(value.scopes), value.resource, value.issuer, value.appInstanceId, value.familyId ?? null, value.expiresAt, value.revoked ? this.timestamp() : null]);
      for (const value of snapshot.refreshFamilies) executeOAuthSql(database, 'INSERT INTO agent_oauth_refresh_families (family_id, client_id, resource, issuer, app_instance_id, scopes_json, current_token_hash, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [value.familyId, value.clientId, value.resource, value.issuer, value.appInstanceId, canonicalizeJson(value.scopes), value.currentTokenHash, value.expiresAt, value.revoked ? this.timestamp() : null]);
      for (const value of snapshot.refreshTokens) executeOAuthSql(database, 'INSERT INTO agent_oauth_refresh_tokens (token_hash, family_id, used_at) VALUES (?, ?, ?)', [value.tokenHash, value.familyId, value.used ? this.timestamp() : null]);
      for (const tokenId of snapshot.revokedTokenIds) executeOAuthSql(database, 'INSERT INTO agent_oauth_revocations (token_id, client_id, reason, revoked_at) SELECT ?, client_id, ?, ? FROM agent_oauth_access_tokens WHERE token_id = ?', [tokenId, 'oauth-revoked', this.timestamp(), tokenId]);
      return { changed: true, value: undefined };
    });
  }

  async persistOAuthAuthorizationCode(code: OAuthStoredCode): Promise<void> {
    await this.write(`agent-oauth-code-${code.codeHash.replace(':', '-')}`, (database) => {
      executeOAuthSql(database, `INSERT OR REPLACE INTO agent_oauth_authorization_codes
        (code_hash, client_id, redirect_uri, resource, issuer, scopes_json, code_challenge, nonce_hash, app_instance_id, expires_at, used_at, refresh_tokens_allowed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`, [code.codeHash, code.clientId, code.redirectUri, code.resource, code.issuer, canonicalizeJson(code.scopes), code.codeChallenge, code.nonceHash ?? null, code.appInstanceId, code.expiresAt, code.refreshTokensAllowed ? 1 : 0]);
      return { changed: true, value: undefined };
    });
  }

  async deleteOAuthAuthorizationCode(codeHash: string): Promise<void> {
    await this.write(`agent-oauth-code-delete-${codeHash.replace(':', '-')}`, (database) => {
      executeOAuthSql(database, 'DELETE FROM agent_oauth_authorization_codes WHERE code_hash = ?', [codeHash]);
      return { changed: true, value: undefined };
    });
  }

  registerPublicKeyInTransaction(
    database: Database,
    scope: DatabaseMutationScope,
    binding: PublicKeyBindingInput,
    rotation: boolean
  ): DatabaseMutationResult<SafeClientKeyBindingResult> {
    assertDatabaseMutationScope(scope, database);
    validateGatewayManagementCommand({ type: rotation ? 'agent.clients.rotate_key' : 'agent.clients.register_key', payload: binding });
    const timestamp = this.timestamp();
    const existingClient = one(database, 'SELECT * FROM agent_clients WHERE client_id = ?', [binding.clientId]);
    const existingKey = one(database, 'SELECT * FROM agent_client_keys WHERE client_id = ?', [binding.clientId]);
    if (rotation !== !!existingKey) throw new AgentError('CLIENT_REVOKED');
    if (!rotation) {
      if (existingClient || binding.expectedRegistryGeneration !== 0) throw new AgentError('IDEMPOTENCY_CONFLICT');
      const duplicate = one(database, 'SELECT client_id FROM agent_client_keys WHERE public_key_fingerprint = ?', [binding.publicKeyFingerprint]);
      if (duplicate) throw new AgentError('IDEMPOTENCY_CONFLICT');
      database.run(`INSERT INTO agent_clients (
        client_id, subject_id, display_name, credential_fingerprint, trust, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'observer', ?, ?)`, [
        binding.clientId, binding.clientId, binding.clientId, binding.publicKeyFingerprint, timestamp, timestamp
      ]);
      database.run('INSERT INTO agent_client_scopes (client_id, scope, catalog_version, created_at) VALUES (?, ?, ?, ?)', [
        binding.clientId, 'system.read', this.catalog.version, timestamp
      ]);
      database.run(`INSERT INTO agent_client_keys (
        client_id, public_key_format, public_key, public_key_fingerprint, signature_algorithm,
        key_generation, registry_generation, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)`, [
        binding.clientId, binding.publicKeyFormat, binding.publicKey, binding.publicKeyFingerprint,
        binding.signatureAlgorithm, timestamp, timestamp
      ]);
      return { changed: true, value: this.safeKeyResult(binding, 1, 1, 'registered') };
    }
    if (!existingClient || existingClient.revoked_at !== null || Number(existingKey!.registry_generation) !== binding.expectedRegistryGeneration) {
      throw new AgentError('IDEMPOTENCY_CONFLICT');
    }
    const duplicate = one(database, 'SELECT client_id FROM agent_client_keys WHERE public_key_fingerprint = ? AND client_id <> ?', [binding.publicKeyFingerprint, binding.clientId]);
    if (duplicate || existingKey!.public_key_fingerprint === binding.publicKeyFingerprint) throw new AgentError('IDEMPOTENCY_CONFLICT');
    const keyGeneration = Number(existingKey!.key_generation) + 1;
    const registryGeneration = Number(existingKey!.registry_generation) + 1;
    database.run(`UPDATE agent_client_keys SET public_key = ?, public_key_fingerprint = ?, key_generation = ?, registry_generation = ?, updated_at = ?
      WHERE client_id = ? AND registry_generation = ?`, [
      binding.publicKey, binding.publicKeyFingerprint, keyGeneration, registryGeneration, timestamp, binding.clientId, binding.expectedRegistryGeneration
    ]);
    if (database.getRowsModified() !== 1) throw new AgentError('IDEMPOTENCY_CONFLICT');
    database.run('UPDATE agent_clients SET credential_fingerprint = ?, updated_at = ? WHERE client_id = ?', [binding.publicKeyFingerprint, timestamp, binding.clientId]);
    database.run('UPDATE agent_sessions SET terminated_at = ? WHERE client_id = ? AND terminated_at IS NULL', [timestamp, binding.clientId]);
    return { changed: true, value: this.safeKeyResult(binding, keyGeneration, registryGeneration, 'rotated') };
  }

  async getActivePublicKey(clientId: string): Promise<ActiveClientKeyBinding> {
    assertSafeIdentifier(clientId, 'clientId');
    return this.read(`agent-client-key-${clientId}`, (database) => {
      const row = one(database, `SELECT k.* FROM agent_client_keys k JOIN agent_clients c ON c.client_id = k.client_id
        WHERE k.client_id = ? AND c.revoked_at IS NULL`, [clientId]);
      if (!row) throw new AgentError('CLIENT_REVOKED');
      return Object.freeze({ clientId, publicKey: String(row.public_key), publicKeyFingerprint: String(row.public_key_fingerprint), keyGeneration: Number(row.key_generation), registryGeneration: Number(row.registry_generation) });
    });
  }

  async hasActivePublicKeys(): Promise<boolean> {
    return this.read('agent-client-key-ready', (database) => !!one(database, `SELECT k.client_id FROM agent_client_keys k
      JOIN agent_clients c ON c.client_id = k.client_id WHERE c.revoked_at IS NULL LIMIT 1`));
  }

  async updateClientAccess(clientId: string, scopesInput: readonly AgentScope[], trust: TrustProfile): Promise<void> {
    await this.write(`agent-client-access-${clientId}`, (database, scope) => this.updateClientAccessInTransaction(database, scope, clientId, scopesInput, trust));
  }

  async getActiveClientSummary(clientId: string): Promise<AgentClientSummary> {
    assertSafeIdentifier(clientId, 'clientId');
    return this.read(`agent-client-active-${clientId}`, (database) => {
      const row = one(database, 'SELECT * FROM agent_clients WHERE client_id = ?', [clientId]);
      if (!row || typeof row.revoked_at === 'string') throw new AgentError('CLIENT_REVOKED');
      const scopes = all(database, 'SELECT scope FROM agent_client_scopes WHERE client_id = ? ORDER BY scope', [clientId])
        .map((entry) => entry.scope as AgentScope);
      return toClientSummary(row, scopes);
    });
  }

  updateClientAccessInTransaction(database: Database, scope: DatabaseMutationScope, clientId: string, scopesInput: readonly AgentScope[], trust: TrustProfile): DatabaseMutationResult<void> {
    assertDatabaseMutationScope(scope, database);
    assertSafeIdentifier(clientId, 'clientId');
    const scopes = normalizeScopes(scopesInput);
    assertTrust(trust);
    const timestamp = this.timestamp();
    const client = one(database, 'SELECT trust, revoked_at FROM agent_clients WHERE client_id = ?', [clientId]);
    if (!client) throw new AgentError('CLIENT_REVOKED');
    if (typeof client.revoked_at === 'string') throw new AgentError('CLIENT_REVOKED');
    const currentScopes = all(database, 'SELECT scope FROM agent_client_scopes WHERE client_id = ? ORDER BY scope', [clientId]).map((row) => String(row.scope));
    if (client.trust === trust && currentScopes.length === scopes.length && currentScopes.every((scope, index) => scope === scopes[index])) {
      return { changed: false, value: undefined };
    }
    database.run('DELETE FROM agent_client_scopes WHERE client_id = ?', [clientId]);
    for (const scope of scopes) database.run(
      'INSERT INTO agent_client_scopes (client_id, scope, catalog_version, created_at) VALUES (?, ?, ?, ?)',
      [clientId, scope, this.catalog.version, timestamp]
    );
    database.run('UPDATE agent_clients SET trust = ?, updated_at = ? WHERE client_id = ?', [trust, timestamp, clientId]);
    executeOAuthSql(database, 'UPDATE agent_http_clients SET scopes_json = ?, trust = ?, updated_at = ? WHERE client_id = ?', [canonicalizeJson(scopes), trust, timestamp, clientId]);
    return { changed: true, value: undefined };
  }

  assertActiveClientInTransaction(database: Database, scope: DatabaseMutationScope, clientId: string): void {
    assertDatabaseMutationScope(scope, database);
    assertSafeIdentifier(clientId, 'clientId');
    const client = one(database, 'SELECT revoked_at FROM agent_clients WHERE client_id = ?', [clientId]);
    if (!client || typeof client.revoked_at === 'string') throw new AgentError('CLIENT_REVOKED');
  }

  getActiveClientSummaryInTransaction(database: Database, scope: DatabaseMutationScope, clientId: string): AgentClientSummary {
    assertDatabaseMutationScope(scope, database);
    assertSafeIdentifier(clientId, 'clientId');
    const row = one(database, 'SELECT * FROM agent_clients WHERE client_id = ?', [clientId]);
    if (!row || typeof row.revoked_at === 'string') throw new AgentError('CLIENT_REVOKED');
    const scopes = all(database, 'SELECT scope FROM agent_client_scopes WHERE client_id = ? ORDER BY scope', [clientId])
      .map((entry) => entry.scope as AgentScope);
    return toClientSummary(row, scopes);
  }

  async revokeClient(clientId: string): Promise<void> {
    await this.write(`agent-client-revoke-${clientId}`, (database, scope) => this.revokeClientInTransaction(database, scope, clientId));
    await this.httpOAuthRevocationHook?.(clientId);
  }

  revokeClientInTransaction(database: Database, scope: DatabaseMutationScope, clientId: string): DatabaseMutationResult<void> {
    assertDatabaseMutationScope(scope, database);
    assertSafeIdentifier(clientId, 'clientId');
    const current = one(database, 'SELECT revoked_at FROM agent_clients WHERE client_id = ?', [clientId]);
    if (!current) throw new AgentError('CLIENT_REVOKED');
    if (typeof current.revoked_at === 'string') return { changed: false, value: undefined };
    const timestamp = this.timestamp();
    database.run('UPDATE agent_clients SET revoked_at = ?, updated_at = ? WHERE client_id = ?', [timestamp, timestamp, clientId]);
    executeOAuthSql(database, 'UPDATE agent_http_clients SET revoked_at = ?, updated_at = ? WHERE client_id = ?', [timestamp, timestamp, clientId]);
    database.run('UPDATE agent_sessions SET terminated_at = ? WHERE client_id = ? AND terminated_at IS NULL', [timestamp, clientId]);
    return { changed: true, value: undefined };
  }

  async createSession(clientId: string, credentialFingerprint: string, sessionFingerprint: string, expiresAt: string): Promise<RegisteredAgentSession> {
    assertSafeIdentifier(clientId, 'clientId');
    assertFingerprint(credentialFingerprint, 'credentialFingerprint');
    assertFingerprint(sessionFingerprint, 'sessionFingerprint');
    const timestamp = this.timestamp();
    const nowMilliseconds = canonicalTimestampMs(timestamp, 'now');
    const expiresMilliseconds = canonicalTimestampMs(expiresAt, 'expiresAt');
    if (expiresMilliseconds <= nowMilliseconds) throw new AgentError('VALIDATION_ERROR', { field: 'expiresAt' });
    const sessionId = this.randomUUID();
    return this.write(`agent-session-create-${sessionId}`, (database) => {
      const client = one(database, 'SELECT credential_fingerprint, revoked_at FROM agent_clients WHERE client_id = ?', [clientId]);
      if (!client || client.revoked_at !== null || client.credential_fingerprint !== credentialFingerprint) throw new AgentError('CLIENT_REVOKED');
      database.run(`INSERT INTO agent_sessions (
        session_id, client_id, app_instance_id, session_fingerprint, credential_fingerprint,
        created_at, expires_at, last_active_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
        sessionId, clientId, this.appInstanceId, sessionFingerprint, credentialFingerprint, timestamp, expiresAt, timestamp
      ]);
      return { changed: true, value: Object.freeze({
        sessionId, clientId, appInstanceId: this.appInstanceId, sessionFingerprint, credentialFingerprint, expiresAt
      }) };
    });
  }

  async terminateSession(sessionId: string): Promise<void> {
    await this.write(`agent-session-terminate-${sessionId}`, (database, scope) => this.terminateSessionInTransaction(database, scope, sessionId));
  }

  terminateSessionInTransaction(database: Database, scope: DatabaseMutationScope, sessionId: string): DatabaseMutationResult<void> {
    assertDatabaseMutationScope(scope, database);
    assertSafeIdentifier(sessionId, 'sessionId');
    const session = one(database, 'SELECT terminated_at FROM agent_sessions WHERE session_id = ?', [sessionId]);
    if (!session) throw new AgentError('CLIENT_REVOKED');
    if (typeof session.terminated_at === 'string') return { changed: false, value: undefined };
    database.run('UPDATE agent_sessions SET terminated_at = ? WHERE session_id = ?', [this.timestamp(), sessionId]);
    return { changed: true, value: undefined };
  }

  async listClientsWindow(filter: { readonly clientId?: string; readonly afterClientId?: string; readonly limit: number }): Promise<readonly AgentClientSummary[]> {
    assertWindowLimit(filter.limit);
    if (filter.clientId) assertSafeIdentifier(filter.clientId, 'clientId');
    if (filter.afterClientId) assertSafeIdentifier(filter.afterClientId, 'afterClientId');
    return this.read('agent-clients-list', (database) => {
      const clauses: string[] = [];
      const parameters: SqlParameter[] = [];
      if (filter.clientId) { clauses.push('client_id = ?'); parameters.push(filter.clientId); }
      if (filter.afterClientId) { clauses.push('client_id > ?'); parameters.push(filter.afterClientId); }
      parameters.push(filter.limit);
      const rows = all(database, `SELECT * FROM agent_clients ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY client_id LIMIT ?`, parameters);
      return Object.freeze(rows.map((row) => toClientSummary(row, all(database, 'SELECT scope FROM agent_client_scopes WHERE client_id = ? ORDER BY scope', [String(row.client_id)]).map((entry) => entry.scope as AgentScope))));
    });
  }

  async listSessionsWindow(filter: { readonly clientId?: string; readonly afterKey?: string; readonly limit: number }): Promise<readonly AgentSessionSummary[]> {
    assertWindowLimit(filter.limit);
    if (filter.clientId) assertSafeIdentifier(filter.clientId, 'clientId');
    let afterClientId: string | undefined;
    let afterSessionId: string | undefined;
    if (filter.afterKey) {
      const separator = filter.afterKey.indexOf('\0');
      if (separator < 1 || separator === filter.afterKey.length - 1) throw new AgentError('CURSOR_INVALID');
      afterClientId = filter.afterKey.slice(0, separator);
      afterSessionId = filter.afterKey.slice(separator + 1);
      assertSafeIdentifier(afterClientId, 'afterClientId');
      assertSafeIdentifier(afterSessionId, 'afterSessionId');
    }
    return this.read('agent-sessions-list', (database) => {
      const clauses: string[] = [];
      const parameters: SqlParameter[] = [];
      if (filter.clientId) { clauses.push('client_id = ?'); parameters.push(filter.clientId); }
      if (afterClientId && afterSessionId) {
        clauses.push('(client_id > ? OR (client_id = ? AND session_id > ?))');
        parameters.push(afterClientId, afterClientId, afterSessionId);
      }
      parameters.push(filter.limit);
      return Object.freeze(all(database, `SELECT * FROM agent_sessions ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY client_id, session_id LIMIT ?`, parameters).map(toSessionSummary));
    });
  }

  async authenticate(credentialFingerprint: string, sessionFingerprint: string): Promise<AgentPrincipalClaims> {
    assertFingerprint(credentialFingerprint, 'credentialFingerprint');
    assertFingerprint(sessionFingerprint, 'sessionFingerprint');
    const timestamp = this.timestamp();
    const nowMilliseconds = canonicalTimestampMs(timestamp, 'now');
    return this.write('agent-authenticate', (database) => {
      const settings = one(database, 'SELECT external_control_enabled FROM agent_control_settings WHERE id = 1');
      if (!settings || settings.external_control_enabled !== 1) throw new AgentError('EXTERNAL_CONTROL_DISABLED');
      const row = one(database, `SELECT c.*, s.session_id, s.app_instance_id, s.expires_at, s.terminated_at
        FROM agent_clients c JOIN agent_sessions s ON s.client_id = c.client_id
        WHERE c.credential_fingerprint = ? AND s.session_fingerprint = ? AND s.credential_fingerprint = ?`, [
        credentialFingerprint, sessionFingerprint, credentialFingerprint
      ]);
      let expiresMilliseconds = Number.NaN;
      try { expiresMilliseconds = canonicalTimestampMs(String(row?.expires_at), 'expiresAt'); } catch {}
      if (
        !row || row.revoked_at !== null || row.terminated_at !== null || row.app_instance_id !== this.appInstanceId ||
        !Number.isFinite(expiresMilliseconds) || expiresMilliseconds <= nowMilliseconds
      ) {
        throw new AgentError('CLIENT_REVOKED');
      }
      const scopes = all(database, 'SELECT scope FROM agent_client_scopes WHERE client_id = ? ORDER BY scope', [String(row.client_id)])
        .map((scopeRow) => scopeRow.scope as AgentScope);
      database.run('UPDATE agent_clients SET last_active_at = ? WHERE client_id = ?', [timestamp, String(row.client_id)]);
      database.run('UPDATE agent_sessions SET last_active_at = ? WHERE session_id = ?', [timestamp, String(row.session_id)]);
      return { changed: true, value: Object.freeze({
        apiVersion: agentApiVersion,
        kind: 'agent-principal' as const,
        clientId: String(row.client_id),
        subjectId: String(row.subject_id),
        displayName: String(row.display_name),
        scopes: Object.freeze(scopes),
        trust: row.trust as TrustProfile,
        credentialBinding: credentialFingerprint,
        sessionId: String(row.session_id),
        authenticatedAt: timestamp,
        renderer: false
      }) };
    });
  }

  private async read<T>(requestId: string, execute: (database: Database) => T): Promise<T> {
    const result = await this.executeControlWrite({ requestId, execute: (database) => ({ changed: false, value: execute(database) }) });
    return result.value;
  }

  private async write<T>(requestId: string, execute: DatabaseControlWriteRequest<T>['execute']): Promise<T> {
    const result = await this.executeControlWrite({ requestId, execute });
    return result.value;
  }

  private timestamp(): string {
    const value = this.now();
    canonicalTimestampMs(value, 'now');
    return value;
  }

  private safeKeyResult(binding: PublicKeyBindingInput, keyGeneration: number, registryGeneration: number, status: 'registered' | 'rotated'): SafeClientKeyBindingResult {
    return Object.freeze({
      apiVersion: agentApiVersion, kind: 'client-key-binding', clientId: binding.clientId,
      publicKeyFormat: binding.publicKeyFormat, publicKeyFingerprint: binding.publicKeyFingerprint,
      signatureAlgorithm: binding.signatureAlgorithm, keyGeneration, registryGeneration, status
    });
  }
}

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
  validateOperationPolicyOverride
} from '../../shared/agent/v1/gatewaySchemas';
import { resolveOperationDescriptor } from '../../shared/agent/v1/operationCatalog';
import type { DatabaseControlWriteRequest, DatabaseWriteResult } from '../persistence/databaseCoordinator';

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

export interface ClientRegistration {
  readonly clientId: string;
  readonly subjectId: string;
  readonly displayName: string;
  readonly credentialFingerprint: string;
  readonly scopes: readonly AgentScope[];
  readonly trust: TrustProfile;
}

export interface ClientRegistryDependencies {
  readonly executeControlWrite: <T>(request: DatabaseControlWriteRequest<T>) => Promise<DatabaseWriteResult<T>>;
  readonly appInstanceId: string;
  readonly catalog: CatalogIdentity;
  readonly now?: () => string;
  readonly randomUUID?: () => string;
}

type SqlParameter = string | number | null | Uint8Array;

function one(database: Database, sql: string, parameters: readonly SqlParameter[] = []): Record<string, unknown> | undefined {
  const statement = database.prepare(sql);
  try {
    statement.bind([...parameters]);
    return statement.step() ? statement.getAsObject() : undefined;
  } finally {
    statement.free();
  }
}

function all(database: Database, sql: string, parameters: readonly SqlParameter[] = []): Record<string, unknown>[] {
  const statement = database.prepare(sql);
  const rows: Record<string, unknown>[] = [];
  try {
    statement.bind([...parameters]);
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
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

export class ClientRegistry {
  private readonly executeControlWrite: ClientRegistryDependencies['executeControlWrite'];
  private readonly appInstanceId: string;
  private readonly catalog: CatalogIdentity;
  private readonly now: () => string;
  private readonly randomUUID: () => string;

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
    if (typeof enabled !== 'boolean') throw new AgentError('VALIDATION_ERROR', { field: 'enabled' });
    const timestamp = this.timestamp();
    await this.write('agent-control-enabled', (database) => {
      const current = one(database, 'SELECT external_control_enabled FROM agent_control_settings WHERE id = 1');
      if (!current) throw new AgentError('RECOVERY_FENCE');
      if ((current.external_control_enabled === 1) === enabled) return { changed: false, value: undefined };
      database.run('UPDATE agent_control_settings SET external_control_enabled = ?, updated_at = ? WHERE id = 1', [enabled ? 1 : 0, timestamp]);
      return { changed: true, value: undefined };
    });
  }

  async updatePolicy(policyVersion: string, overrides: readonly OperationPolicyOverride[]): Promise<void> {
    assertSafeIdentifier(policyVersion, 'policyVersion');
    const seen = new Set<string>();
    const normalized = [...overrides].sort((left, right) => left.operation.localeCompare(right.operation));
    for (const override of normalized) {
      if (seen.has(override.operation)) throw new AgentError('VALIDATION_ERROR', { field: 'overrides' });
      seen.add(override.operation);
      validateOperationPolicyOverride(override, resolveOperationDescriptor(override.operation), this.catalog);
    }
    const policyJson = canonicalizeJson(normalized);
    const policyHash = hashCanonicalJson(normalized);
    const timestamp = this.timestamp();
    await this.write('agent-policy-update', (database) => {
      const current = one(database, 'SELECT policy_version, policy_hash FROM agent_control_settings WHERE id = 1');
      if (!current) throw new AgentError('RECOVERY_FENCE');
      if (current.policy_version === policyVersion && current.policy_hash === policyHash) {
        return { changed: false, value: undefined };
      }
      database.run('UPDATE agent_control_settings SET policy_version = ?, policy_json = ?, policy_hash = ?, updated_at = ? WHERE id = 1', [
        policyVersion, policyJson, policyHash, timestamp
      ]);
      return { changed: database.getRowsModified() > 0, value: undefined };
    });
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

  async updateClientAccess(clientId: string, scopesInput: readonly AgentScope[], trust: TrustProfile): Promise<void> {
    assertSafeIdentifier(clientId, 'clientId');
    const scopes = normalizeScopes(scopesInput);
    assertTrust(trust);
    const timestamp = this.timestamp();
    await this.write(`agent-client-access-${clientId}`, (database) => {
      const client = one(database, 'SELECT trust FROM agent_clients WHERE client_id = ?', [clientId]);
      if (!client) throw new AgentError('CLIENT_REVOKED');
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
      return { changed: true, value: undefined };
    });
  }

  async revokeClient(clientId: string): Promise<void> {
    assertSafeIdentifier(clientId, 'clientId');
    const timestamp = this.timestamp();
    await this.write(`agent-client-revoke-${clientId}`, (database) => {
      const current = one(database, 'SELECT revoked_at FROM agent_clients WHERE client_id = ?', [clientId]);
      if (!current) throw new AgentError('CLIENT_REVOKED');
      if (typeof current.revoked_at === 'string') return { changed: false, value: undefined };
      database.run('UPDATE agent_clients SET revoked_at = ?, updated_at = ? WHERE client_id = ?', [timestamp, timestamp, clientId]);
      database.run('UPDATE agent_sessions SET terminated_at = ? WHERE client_id = ? AND terminated_at IS NULL', [timestamp, clientId]);
      return { changed: true, value: undefined };
    });
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
    assertSafeIdentifier(sessionId, 'sessionId');
    const timestamp = this.timestamp();
    await this.write(`agent-session-terminate-${sessionId}`, (database) => {
      const session = one(database, 'SELECT terminated_at FROM agent_sessions WHERE session_id = ?', [sessionId]);
      if (!session) throw new AgentError('CLIENT_REVOKED');
      if (typeof session.terminated_at === 'string') return { changed: false, value: undefined };
      database.run('UPDATE agent_sessions SET terminated_at = ? WHERE session_id = ?', [timestamp, sessionId]);
      return { changed: true, value: undefined };
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
}

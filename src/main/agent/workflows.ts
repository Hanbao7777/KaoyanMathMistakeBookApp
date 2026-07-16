import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Database } from 'sql.js';
import { AgentError } from '../../shared/agent/errors';
import { agentApiVersion } from '../../shared/agent/versions';
import type { DataVersion, EntityRef } from '../../shared/agent/v1/contracts';
import {
  type ApprovalRecord,
  type ApprovalSource,
  type ApprovalStatus,
  type CatalogIdentity,
  type ChangeSet,
  type ChangeSetStatus,
  type OperationName,
  type PlannedOperation,
  type R4Grant,
  type R4GrantStatus,
  type R4Reservation,
  type RecoveryRequirement
} from '../../shared/agent/v1/gatewayContracts';
import {
  canonicalizeJson,
  gatewayMaxChangeSetOperations,
  gatewayMaxR4GrantLifetimeMs,
  hashCanonicalJson,
  validateApprovalRecord,
  validateChangeSet,
  validateR4Grant,
  validateR4Reservation
} from '../../shared/agent/v1/gatewaySchemas';
import { assertDatabaseMutationScope, type DatabaseMutationResult, type DatabaseMutationScope } from '../persistence/databaseCoordinator';
import { AuditLedger, type AgentControlWriteExecutor } from './auditLedger';

type SqlParameter = string | number | null | Uint8Array;

export interface WorkflowStoreDependencies {
  readonly executeControlWrite: AgentControlWriteExecutor;
  readonly audit: AuditLedger;
  readonly now?: () => string;
  readonly randomUUID?: () => string;
}

export interface R4ReservationRequest {
  readonly grantId: string;
  readonly clientId: string;
  readonly requestId: string;
  readonly operation: OperationName;
  readonly payloadHash: string;
  readonly targetHash: string;
  readonly affectedSetHash: string;
  readonly baseVersion: DataVersion;
  readonly catalog: CatalogIdentity;
  readonly recovery: RecoveryRequirement;
  readonly maxAffectedEntities: number;
  readonly expiresAt: string;
}

export interface WorkflowBinding {
  readonly clientId: string;
  readonly operation: OperationName;
  readonly payloadHash: string;
  readonly affectedSetHash: string;
  readonly baseVersion: DataVersion;
  readonly catalog: CatalogIdentity;
}

export interface ChangeSetApplyBinding extends WorkflowBinding {
  readonly changeSetId: string;
}

const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const hashPattern = /^sha256-v1:[0-9a-f]{64}$/;
const safeEntityType = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const changeSetTransitions = {
  draft: ['waiting_approval', 'approved', 'rejected', 'expired'],
  waiting_approval: ['approved', 'rejected', 'expired'],
  approved: ['applied', 'rejected', 'expired'],
  applied: ['rolled_back'],
  rejected: [], expired: [], rolled_back: []
} satisfies Readonly<Record<ChangeSetStatus, readonly ChangeSetStatus[]>>;

function windowParts(value: string | undefined): readonly [string, string] | undefined {
  if (value === undefined) return undefined;
  const separator = value.indexOf('\0');
  if (separator < 1 || separator === value.length - 1) throw new AgentError('CURSOR_INVALID');
  return [value.slice(0, separator), value.slice(separator + 1)];
}

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

function timestamp(value: string, field: string): number {
  if (!timestampPattern.test(value)) throw new AgentError('VALIDATION_ERROR', { field });
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) throw new AgentError('VALIDATION_ERROR', { field });
  return milliseconds;
}

function equalHash(left: string, right: string): boolean {
  if (!hashPattern.test(left) || !hashPattern.test(right)) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function immutableJson<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(immutableJson)) as T;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) result[key] = immutableJson(entry);
  return Object.freeze(result) as T;
}

function normalizedEntities(entities: readonly EntityRef[], errorCode: 'APPROVAL_INVALID' | 'RECOVERY_FENCE'): readonly EntityRef[] {
  if (!Array.isArray(entities) || entities.length > 500) throw new AgentError(errorCode);
  const normalized = entities.map((entity) => {
    if (!entity || !safeEntityType.test(entity.entityType) || typeof entity.entityId !== 'string' || !entity.entityId || entity.entityId.length > 200) {
      throw new AgentError(errorCode);
    }
    return Object.freeze({ entityType: entity.entityType, entityId: entity.entityId });
  }).sort((left, right) => `${left.entityType}\0${left.entityId}`.localeCompare(`${right.entityType}\0${right.entityId}`));
  if (new Set(normalized.map((entity) => `${entity.entityType}\0${entity.entityId}`)).size !== normalized.length) {
    throw new AgentError(errorCode);
  }
  return Object.freeze(normalized);
}

function normalizedOperations(
  operations: readonly PlannedOperation[],
  affectedSetHash: string,
  errorCode: 'APPROVAL_INVALID' | 'RECOVERY_FENCE'
): readonly PlannedOperation[] {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > gatewayMaxChangeSetOperations) throw new AgentError(errorCode);
  const aggregate: EntityRef[] = [];
  const normalized = operations.map((operation) => {
    if (!equalHash(operation.payloadHash, hashCanonicalJson(operation.payload))) throw new AgentError(errorCode);
    const affectedEntities = normalizedEntities(operation.affectedEntities, errorCode);
    aggregate.push(...affectedEntities);
    return Object.freeze({ ...operation, payload: immutableJson(operation.payload), affectedEntities });
  });
  const aggregateEntities = normalizedEntities(aggregate, errorCode);
  if (!equalHash(affectedSetHash, hashCanonicalJson(aggregateEntities))) throw new AgentError(errorCode);
  return Object.freeze(normalized);
}

function assertBinding(row: Record<string, unknown>, binding: WorkflowBinding): void {
  if (
    row.client_id !== binding.clientId || row.operation !== binding.operation ||
    !equalHash(String(row.payload_hash), binding.payloadHash) ||
    !equalHash(String(row.affected_set_hash), binding.affectedSetHash) ||
    row.base_data_epoch !== binding.baseVersion.dataEpoch || row.base_data_revision !== binding.baseVersion.dataRevision ||
    row.catalog_version !== binding.catalog.version || !equalHash(String(row.catalog_hash), binding.catalog.hash)
  ) throw new AgentError('APPROVAL_INVALID');
}

function grantFromRow(row: Record<string, unknown>): R4Grant {
  const grant = Object.freeze({
    apiVersion: agentApiVersion,
    grantId: String(row.grant_id),
    clientId: String(row.client_id),
    operation: row.operation as OperationName,
    payloadHash: String(row.payload_hash),
    targetHash: String(row.target_hash),
    catalog: Object.freeze({ version: String(row.catalog_version), hash: String(row.catalog_hash) }),
    recovery: row.recovery as RecoveryRequirement,
    maxAffectedEntities: Number(row.max_affected_entities),
    maxUses: 1 as const,
    status: row.status as R4Grant['status'],
    issuedAt: String(row.issued_at),
    expiresAt: String(row.expires_at),
    ...(typeof row.consumed_at === 'string' ? { consumedAt: row.consumed_at } : {}),
    ...(typeof row.revoked_at === 'string' ? { revokedAt: row.revoked_at } : {})
  });
  validateR4Grant(grant);
  return grant;
}

function approvalFromRow(row: Record<string, unknown>): ApprovalRecord {
  let requiredScopes: unknown;
  try { requiredScopes = JSON.parse(String(row.required_scopes_json)); } catch { throw new AgentError('APPROVAL_INVALID'); }
  if (canonicalizeJson(requiredScopes) !== row.required_scopes_json || hashCanonicalJson(requiredScopes) !== row.required_scopes_hash) {
    throw new AgentError('APPROVAL_INVALID');
  }
  const approval = Object.freeze({
    apiVersion: agentApiVersion,
    approvalId: String(row.approval_id), nonce: String(row.nonce), clientId: String(row.client_id),
    credentialBinding: String(row.credential_binding), operation: row.operation as OperationName,
    payloadHash: String(row.payload_hash), affectedSetHash: String(row.affected_set_hash),
    baseVersion: Object.freeze({ dataEpoch: String(row.base_data_epoch), dataRevision: Number(row.base_data_revision) }),
    catalog: Object.freeze({ version: String(row.catalog_version), hash: String(row.catalog_hash) }),
    policyVersion: String(row.policy_version), risk: row.risk as ApprovalRecord['risk'],
    requiredScopes: Object.freeze(requiredScopes as ApprovalRecord['requiredScopes']), recovery: row.recovery as RecoveryRequirement,
    ...(typeof row.source === 'string' ? { source: row.source as ApprovalSource } : {}),
    status: row.status as ApprovalStatus, createdAt: String(row.created_at), expiresAt: String(row.expires_at),
    ...(typeof row.consumed_at === 'string' ? { consumedAt: row.consumed_at } : {}),
    ...(typeof row.revoked_at === 'string' ? { revokedAt: row.revoked_at } : {})
  });
  validateApprovalRecord(approval);
  return approval;
}

function operationFromRow(row: Record<string, unknown>, expectedIndex: number): PlannedOperation {
  let operation: unknown;
  let affectedEntities: unknown;
  try {
    operation = JSON.parse(String(row.operation_json));
    affectedEntities = JSON.parse(String(row.affected_entities_json));
  } catch { throw new AgentError('RECOVERY_FENCE'); }
  const parsed = operation as PlannedOperation;
  const normalizedAffected = normalizedEntities(parsed.affectedEntities, 'RECOVERY_FENCE');
  if (
    row.operation_index !== expectedIndex || row.operation !== parsed.operation ||
    canonicalizeJson(operation) !== row.operation_json || !equalHash(String(row.operation_hash), hashCanonicalJson(operation)) ||
    row.payload_hash !== parsed.payloadHash || !equalHash(parsed.payloadHash, hashCanonicalJson(parsed.payload)) ||
    canonicalizeJson(affectedEntities) !== row.affected_entities_json || canonicalizeJson(normalizedAffected) !== row.affected_entities_json ||
    !equalHash(String(row.affected_entities_hash), hashCanonicalJson(normalizedAffected))
  ) throw new AgentError('RECOVERY_FENCE');
  return immutableJson(parsed);
}

function changeSetFromRows(row: Record<string, unknown>, operations: readonly Record<string, unknown>[]): ChangeSet {
  const changeSet = Object.freeze({
    apiVersion: agentApiVersion, changeSetId: String(row.change_set_id), clientId: String(row.client_id),
    status: row.status as ChangeSetStatus,
    catalog: Object.freeze({ version: String(row.catalog_version), hash: String(row.catalog_hash) }),
    baseVersion: Object.freeze({ dataEpoch: String(row.base_data_epoch), dataRevision: Number(row.base_data_revision) }),
    risk: row.risk as ChangeSet['risk'], summary: String(row.summary),
    operations: Object.freeze(operations.map((operation, index) => operationFromRow(operation, index))), affectedSetHash: String(row.affected_set_hash),
    recovery: row.recovery as RecoveryRequirement,
    ...(typeof row.recovery_asset_id === 'string' ? { recoveryAssetId: row.recovery_asset_id } : {}),
    createdAt: String(row.created_at), expiresAt: String(row.expires_at),
    ...(typeof row.applied_at === 'string' ? { appliedAt: row.applied_at } : {})
  });
  try { validateChangeSet(changeSet); } catch { throw new AgentError('RECOVERY_FENCE'); }
  if (changeSet.operations.length !== row.operation_count) throw new AgentError('RECOVERY_FENCE');
  normalizedOperations(changeSet.operations, changeSet.affectedSetHash, 'RECOVERY_FENCE');
  return changeSet;
}

export class WorkflowStore {
  private readonly executeControlWrite: AgentControlWriteExecutor;
  private readonly audit: AuditLedger;
  private readonly now: () => string;
  private readonly randomUUID: () => string;

  constructor(dependencies: WorkflowStoreDependencies) {
    this.executeControlWrite = dependencies.executeControlWrite;
    this.audit = dependencies.audit;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.randomUUID = dependencies.randomUUID ?? randomUUID;
  }

  async createR4Grant(grant: R4Grant): Promise<R4Grant> {
    const result = await this.executeControlWrite({
      requestId: `agent-r4-create-${grant.grantId}`,
      execute: (database, scope) => this.createR4GrantInTransaction(database, scope, grant)
    });
    return result.value;
  }

  createR4GrantInTransaction(database: Database, scope: DatabaseMutationScope, grant: R4Grant): DatabaseMutationResult<R4Grant> {
    assertDatabaseMutationScope(scope, database);
    validateR4Grant(grant);
    if (grant.status !== 'active' || grant.consumedAt || grant.revokedAt) throw new AgentError('R4_GRANT_INVALID');
    if (Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt) > gatewayMaxR4GrantLifetimeMs) throw new AgentError('R4_GRANT_INVALID');
    database.run(`INSERT INTO agent_r4_grants (
      grant_id, client_id, operation, payload_hash, target_hash, catalog_version, catalog_hash,
      recovery, max_affected_entities, max_uses, status, issued_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?)`, [
      grant.grantId, grant.clientId, grant.operation, grant.payloadHash, grant.targetHash,
      grant.catalog.version, grant.catalog.hash, grant.recovery, grant.maxAffectedEntities, grant.issuedAt, grant.expiresAt
    ]);
    this.requiredAudit(() => this.audit.appendWorkflowControlInTransaction(database, scope, {
      clientId: grant.clientId, operation: 'agent.r4_grants.create', risk: 'R4',
      summary: Object.freeze({ action: 'r4_grant_created', grantId: grant.grantId, boundOperation: grant.operation })
    }));
    return { changed: true, value: grantFromRow(one(database, 'SELECT * FROM agent_r4_grants WHERE grant_id = ?', [grant.grantId])!) };
  }

  async getR4Grant(grantId: string): Promise<R4Grant | undefined> {
    const result = await this.executeControlWrite({ requestId: `agent-r4-get-${grantId}`, execute: (database) => ({
      changed: false,
      value: (() => { const row = one(database, 'SELECT * FROM agent_r4_grants WHERE grant_id = ?', [grantId]); return row ? grantFromRow(row) : undefined; })()
    }) });
    return result.value;
  }

  async listR4Grants(filter: { readonly clientId?: string; readonly status?: R4GrantStatus; readonly afterKey?: string; readonly limit: number }): Promise<readonly R4Grant[]> {
    this.assertListLimit(filter.limit);
    const result = await this.executeControlWrite({ requestId: 'agent-r4-list', execute: (database) => {
      const clauses: string[] = [];
      const parameters: SqlParameter[] = [];
      if (filter.clientId) { clauses.push('client_id = ?'); parameters.push(filter.clientId); }
      if (filter.status) { clauses.push('status = ?'); parameters.push(filter.status); }
      const after = windowParts(filter.afterKey);
      if (after) { clauses.push('(issued_at > ? OR (issued_at = ? AND grant_id > ?))'); parameters.push(after[0], after[0], after[1]); }
      parameters.push(filter.limit);
      return { changed: false, value: Object.freeze(all(database, `SELECT * FROM agent_r4_grants ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY issued_at, grant_id LIMIT ?`, parameters).map(grantFromRow)) };
    } });
    return result.value;
  }

  async revokeR4Grant(grantId: string, clientId: string): Promise<void> {
    await this.executeControlWrite({ requestId: `agent-r4-revoke-${grantId}`, execute: (database, scope) => this.revokeR4GrantInTransaction(database, scope, grantId, clientId) });
  }

  revokeR4GrantInTransaction(database: Database, scope: DatabaseMutationScope, grantId: string, clientId: string): DatabaseMutationResult<void> {
    assertDatabaseMutationScope(scope, database);
    const row = one(database, 'SELECT * FROM agent_r4_grants WHERE grant_id = ?', [grantId]);
    if (!row || row.client_id !== clientId || row.status === 'consumed') throw new AgentError('R4_GRANT_CONSUMED');
    if (row.status === 'revoked') return { changed: false, value: undefined };
    if (row.status === 'reserved') throw new AgentError('R4_GRANT_RESERVED');
    database.run("UPDATE agent_r4_grants SET status = 'revoked', revoked_at = ? WHERE grant_id = ?", [this.currentTimestamp(), grantId]);
    this.requiredAudit(() => this.audit.appendWorkflowControlInTransaction(database, scope, {
      clientId, operation: 'agent.r4_grants.revoke', risk: 'R4', summary: Object.freeze({ action: 'r4_grant_revoked', grantId })
    }));
    return { changed: true, value: undefined };
  }

  reserveR4GrantInTransaction(database: Database, scope: DatabaseMutationScope, request: R4ReservationRequest): R4Reservation {
    assertDatabaseMutationScope(scope, database);
    const now = this.currentTimestamp();
    const row = one(database, 'SELECT * FROM agent_r4_grants WHERE grant_id = ?', [request.grantId]);
    if (!row) throw new AgentError('R4_GRANT_REQUIRED');
    if (row.status === 'consumed') throw new AgentError('R4_GRANT_CONSUMED');
    if (row.status === 'reserved') throw new AgentError('R4_GRANT_RESERVED');
    if (row.status !== 'active' || String(row.expires_at) <= now) throw new AgentError('R4_GRANT_INVALID');
    if (
      row.client_id !== request.clientId || row.operation !== request.operation ||
      !equalHash(String(row.payload_hash), request.payloadHash) || !equalHash(String(row.target_hash), request.targetHash) ||
      row.catalog_version !== request.catalog.version || !equalHash(String(row.catalog_hash), request.catalog.hash) ||
      row.recovery !== request.recovery || row.max_affected_entities !== request.maxAffectedEntities
    ) throw new AgentError('R4_GRANT_INVALID');
    timestamp(request.expiresAt, 'reservation.expiresAt');
    if (request.expiresAt <= now || request.expiresAt > String(row.expires_at)) throw new AgentError('R4_GRANT_INVALID');
    const reservationId = this.randomUUID().toLowerCase();
    database.run(`UPDATE agent_r4_grants SET
      status = 'reserved', reservation_id = ?, reserved_client_id = ?, reserved_request_id = ?,
      reserved_payload_hash = ?, reserved_affected_set_hash = ?, reserved_base_epoch = ?, reserved_base_revision = ?,
      reserved_catalog_version = ?, reserved_catalog_hash = ?, reserved_at = ?, reservation_expires_at = ?
      WHERE grant_id = ? AND status = 'active'`, [
      reservationId, request.clientId, request.requestId, request.payloadHash, request.affectedSetHash,
      request.baseVersion.dataEpoch, request.baseVersion.dataRevision, request.catalog.version, request.catalog.hash,
      now, request.expiresAt, request.grantId
    ]);
    if (database.getRowsModified() !== 1) throw new AgentError('R4_GRANT_RESERVED');
    const reservation = Object.freeze({
      apiVersion: agentApiVersion, reservationId, grantId: request.grantId, clientId: request.clientId,
      requestId: request.requestId, operation: request.operation, payloadHash: request.payloadHash,
      affectedSetHash: request.affectedSetHash, baseVersion: Object.freeze({ ...request.baseVersion }),
      catalog: Object.freeze({ ...request.catalog }), reservedAt: now, expiresAt: request.expiresAt
    });
    validateR4Reservation(reservation);
    return reservation;
  }

  consumeR4ReservationInTransaction(database: Database, scope: DatabaseMutationScope, reservation: R4Reservation): void {
    assertDatabaseMutationScope(scope, database);
    validateR4Reservation(reservation);
    const row = one(database, 'SELECT * FROM agent_r4_grants WHERE grant_id = ?', [reservation.grantId]);
    if (!row || row.status === 'consumed') throw new AgentError('R4_GRANT_CONSUMED');
    if (
      row.status !== 'reserved' || row.reservation_id !== reservation.reservationId || row.reserved_client_id !== reservation.clientId ||
      row.reserved_request_id !== reservation.requestId || row.operation !== reservation.operation ||
      !equalHash(String(row.reserved_payload_hash), reservation.payloadHash) || !equalHash(String(row.reserved_affected_set_hash), reservation.affectedSetHash) ||
      row.reserved_base_epoch !== reservation.baseVersion.dataEpoch || row.reserved_base_revision !== reservation.baseVersion.dataRevision ||
      row.reserved_catalog_version !== reservation.catalog.version || !equalHash(String(row.reserved_catalog_hash), reservation.catalog.hash)
    ) throw new AgentError('R4_GRANT_INVALID');
    const now = this.currentTimestamp();
    database.run("UPDATE agent_r4_grants SET status = 'consumed', consumed_at = ? WHERE grant_id = ? AND status = 'reserved' AND reservation_id = ?", [
      now, reservation.grantId, reservation.reservationId
    ]);
    if (database.getRowsModified() !== 1) throw new AgentError('R4_GRANT_CONSUMED');
  }

  releaseR4ReservationInTransaction(database: Database, scope: DatabaseMutationScope, reservationId: string): boolean {
    assertDatabaseMutationScope(scope, database);
    const row = one(database, "SELECT status FROM agent_r4_grants WHERE reservation_id = ?", [reservationId]);
    if (!row || row.status !== 'reserved') return false;
    database.run(`UPDATE agent_r4_grants SET status = 'active', reservation_id = NULL, reserved_client_id = NULL,
      reserved_request_id = NULL, reserved_payload_hash = NULL, reserved_affected_set_hash = NULL,
      reserved_base_epoch = NULL, reserved_base_revision = NULL, reserved_catalog_version = NULL,
      reserved_catalog_hash = NULL, reserved_at = NULL, reservation_expires_at = NULL
      WHERE reservation_id = ? AND status = 'reserved'`, [reservationId]);
    return database.getRowsModified() === 1;
  }

  async createApproval(approval: ApprovalRecord): Promise<ApprovalRecord> {
    validateApprovalRecord(approval);
    if (approval.status !== 'pending' || approval.source || approval.consumedAt || approval.revokedAt) throw new AgentError('APPROVAL_INVALID');
    const scopesJson = canonicalizeJson(approval.requiredScopes);
    const result = await this.executeControlWrite({ requestId: `agent-approval-create-${approval.approvalId}`, execute: (database, scope) => {
      assertDatabaseMutationScope(scope, database);
      database.run(`INSERT INTO agent_approvals (
        approval_id, nonce, client_id, credential_binding, operation, payload_hash, affected_set_hash,
        base_data_epoch, base_data_revision, catalog_version, catalog_hash, policy_version, risk,
        required_scopes_json, required_scopes_hash, recovery, status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`, [
        approval.approvalId, approval.nonce, approval.clientId, approval.credentialBinding, approval.operation,
        approval.payloadHash, approval.affectedSetHash, approval.baseVersion.dataEpoch, approval.baseVersion.dataRevision,
        approval.catalog.version, approval.catalog.hash, approval.policyVersion, approval.risk,
        scopesJson, hashCanonicalJson(approval.requiredScopes), approval.recovery, approval.createdAt, approval.expiresAt
      ]);
      this.requiredAudit(() => this.audit.appendWorkflowControlInTransaction(database, scope, {
        clientId: approval.clientId, operation: 'agent.approvals.approve', risk: approval.risk,
        summary: Object.freeze({ action: 'approval_created', approvalId: approval.approvalId })
      }));
      return { changed: true, value: approvalFromRow(one(database, 'SELECT * FROM agent_approvals WHERE approval_id = ?', [approval.approvalId])!) };
    } });
    return result.value;
  }

  async getApproval(approvalId: string): Promise<ApprovalRecord | undefined> {
    const result = await this.executeControlWrite({ requestId: `agent-approval-get-${approvalId}`, execute: (database) => {
      const row = one(database, 'SELECT * FROM agent_approvals WHERE approval_id = ?', [approvalId]);
      return { changed: false, value: row ? approvalFromRow(row) : undefined };
    } });
    return result.value;
  }

  async listApprovals(filter: { readonly clientId?: string; readonly status?: ApprovalStatus; readonly afterKey?: string; readonly limit: number }): Promise<readonly ApprovalRecord[]> {
    this.assertListLimit(filter.limit);
    const result = await this.executeControlWrite({ requestId: 'agent-approval-list', execute: (database) => {
      const clauses: string[] = [];
      const parameters: SqlParameter[] = [];
      if (filter.clientId) { clauses.push('client_id = ?'); parameters.push(filter.clientId); }
      if (filter.status) { clauses.push('status = ?'); parameters.push(filter.status); }
      const after = windowParts(filter.afterKey);
      if (after) { clauses.push('(created_at > ? OR (created_at = ? AND approval_id > ?))'); parameters.push(after[0], after[0], after[1]); }
      parameters.push(filter.limit);
      return { changed: false, value: Object.freeze(all(database, `SELECT * FROM agent_approvals ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at, approval_id LIMIT ?`, parameters).map(approvalFromRow)) };
    } });
    return result.value;
  }

  async decideApproval(approvalId: string, status: 'approved' | 'rejected', source: ApprovalSource): Promise<ApprovalRecord> {
    const result = await this.executeControlWrite({ requestId: `agent-approval-decide-${approvalId}`, execute: (database, scope) => this.decideApprovalInTransaction(database, scope, approvalId, status, source) });
    return result.value;
  }

  decideApprovalInTransaction(
    database: Database,
    scope: DatabaseMutationScope,
    approvalId: string,
    status: 'approved' | 'rejected',
    source: ApprovalSource
  ): DatabaseMutationResult<ApprovalRecord> {
    assertDatabaseMutationScope(scope, database);
    const now = this.currentTimestamp();
    const row = one(database, 'SELECT * FROM agent_approvals WHERE approval_id = ?', [approvalId]);
    if (!row || row.status !== 'pending' || String(row.expires_at) <= now) throw new AgentError('APPROVAL_INVALID');
    database.run('UPDATE agent_approvals SET status = ?, source = ?, decided_at = ? WHERE approval_id = ? AND status = ?', [status, source, now, approvalId, 'pending']);
    this.requiredAudit(() => this.audit.appendWorkflowControlInTransaction(database, scope, {
      clientId: String(row.client_id), operation: status === 'approved' ? 'agent.approvals.approve' : 'agent.approvals.reject', risk: row.risk as ApprovalRecord['risk'],
      summary: Object.freeze({ action: `approval_${status}`, approvalId })
    }));
    return { changed: true, value: approvalFromRow(one(database, 'SELECT * FROM agent_approvals WHERE approval_id = ?', [approvalId])!) };
  }

  async consumeApproval(approvalId: string, binding: WorkflowBinding): Promise<ApprovalRecord> {
    const result = await this.executeControlWrite({ requestId: `agent-approval-consume-${approvalId}`, execute: (database, scope) => this.consumeApprovalInTransaction(database, scope, approvalId, binding) });
    return result.value;
  }

  consumeApprovalInTransaction(
    database: Database,
    scope: DatabaseMutationScope,
    approvalId: string,
    binding: WorkflowBinding
  ): DatabaseMutationResult<ApprovalRecord> {
    assertDatabaseMutationScope(scope, database);
    const now = this.currentTimestamp();
    const row = one(database, 'SELECT * FROM agent_approvals WHERE approval_id = ?', [approvalId]);
    if (!row || row.status !== 'approved' || String(row.expires_at) <= now) throw new AgentError('APPROVAL_INVALID');
    assertBinding(row, binding);
    database.run("UPDATE agent_approvals SET status = 'consumed', consumed_at = ?, decided_at = NULL WHERE approval_id = ? AND status = 'approved'", [now, approvalId]);
    this.requiredAudit(() => this.audit.appendWorkflowControlInTransaction(database, scope, {
      clientId: binding.clientId, operation: 'agent.approvals.approve', summary: Object.freeze({ action: 'approval_consumed', approvalId })
    }));
    return { changed: true, value: approvalFromRow(one(database, 'SELECT * FROM agent_approvals WHERE approval_id = ?', [approvalId])!) };
  }

  async createChangeSet(changeSet: ChangeSet): Promise<ChangeSet> {
    validateChangeSet(changeSet);
    if (!['draft', 'waiting_approval', 'approved'].includes(changeSet.status)) throw new AgentError('APPROVAL_INVALID');
    if (changeSet.operations.length > gatewayMaxChangeSetOperations) throw new AgentError('VALIDATION_ERROR', { field: 'changeSet.operations' });
    const operations = normalizedOperations(changeSet.operations, changeSet.affectedSetHash, 'APPROVAL_INVALID');
    const result = await this.executeControlWrite({ requestId: `agent-changeset-create-${changeSet.changeSetId}`, execute: (database, scope) => {
      assertDatabaseMutationScope(scope, database);
      database.run(`INSERT INTO agent_changesets (
        change_set_id, client_id, status, catalog_version, catalog_hash, base_data_epoch, base_data_revision,
        risk, summary, affected_set_hash, recovery, recovery_asset_id, operation_count, created_at, expires_at, applied_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        changeSet.changeSetId, changeSet.clientId, changeSet.status, changeSet.catalog.version, changeSet.catalog.hash,
        changeSet.baseVersion.dataEpoch, changeSet.baseVersion.dataRevision, changeSet.risk, changeSet.summary,
        changeSet.affectedSetHash, changeSet.recovery, changeSet.recoveryAssetId ?? null, operations.length,
        changeSet.createdAt, changeSet.expiresAt, changeSet.appliedAt ?? null
      ]);
      operations.forEach((operation, index) => {
        const operationJson = canonicalizeJson(operation);
        const affectedJson = canonicalizeJson(operation.affectedEntities);
        database.run(`INSERT INTO agent_changeset_operations (
          change_set_id, operation_index, operation, operation_json, operation_hash,
          payload_hash, affected_entities_json, affected_entities_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
          changeSet.changeSetId, index, operation.operation, operationJson, hashCanonicalJson(operation),
          operation.payloadHash, affectedJson, hashCanonicalJson(operation.affectedEntities)
        ]);
      });
      this.requiredAudit(() => this.audit.appendWorkflowControlInTransaction(database, scope, {
        clientId: changeSet.clientId, operation: 'agent.changesets.apply', risk: changeSet.risk,
        summary: Object.freeze({ action: 'changeset_created', changeSetId: changeSet.changeSetId, operationCount: operations.length })
      }));
      return { changed: true, value: this.readChangeSet(database, changeSet.changeSetId)! };
    } });
    return result.value;
  }

  async getChangeSet(changeSetId: string): Promise<ChangeSet | undefined> {
    const result = await this.executeControlWrite({ requestId: `agent-changeset-get-${changeSetId}`, execute: (database) => ({ changed: false, value: this.readChangeSet(database, changeSetId) }) });
    return result.value;
  }

  async listChangeSets(filter: { readonly clientId?: string; readonly status?: ChangeSetStatus; readonly afterKey?: string; readonly limit: number }): Promise<readonly ChangeSet[]> {
    this.assertListLimit(filter.limit);
    const result = await this.executeControlWrite({ requestId: 'agent-changeset-list', execute: (database) => {
      const clauses: string[] = [];
      const parameters: SqlParameter[] = [];
      if (filter.clientId) { clauses.push('client_id = ?'); parameters.push(filter.clientId); }
      if (filter.status) { clauses.push('status = ?'); parameters.push(filter.status); }
      const after = windowParts(filter.afterKey);
      if (after) { clauses.push('(created_at > ? OR (created_at = ? AND change_set_id > ?))'); parameters.push(after[0], after[0], after[1]); }
      parameters.push(filter.limit);
      const rows = all(database, `SELECT * FROM agent_changesets ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at, change_set_id LIMIT ?`, parameters);
      return { changed: false, value: Object.freeze(rows.map((row) => this.readChangeSet(database, String(row.change_set_id))!)) };
    } });
    return result.value;
  }

  async transitionChangeSet(changeSetId: string, nextStatus: ChangeSetStatus, binding?: WorkflowBinding): Promise<ChangeSet> {
    if (nextStatus === 'applied') {
      if (!binding) throw new AgentError('APPROVAL_INVALID');
      const result = await this.executeControlWrite({ requestId: `agent-changeset-transition-${changeSetId}`, execute: (database, scope) =>
        this.applyChangeSetInTransaction(database, scope, { ...binding, changeSetId }) });
      return result.value;
    }
    const result = await this.executeControlWrite({ requestId: `agent-changeset-transition-${changeSetId}`, execute: (database, scope) =>
      this.transitionChangeSetInTransaction(database, scope, changeSetId, nextStatus) });
    return result.value;
  }

  transitionChangeSetInTransaction(
    database: Database,
    scope: DatabaseMutationScope,
    changeSetId: string,
    nextStatus: Exclude<ChangeSetStatus, 'applied'>
  ): DatabaseMutationResult<ChangeSet> {
    assertDatabaseMutationScope(scope, database);
    const now = this.currentTimestamp();
    const row = one(database, 'SELECT * FROM agent_changesets WHERE change_set_id = ?', [changeSetId]);
    if (!row || !(changeSetTransitions[row.status as ChangeSetStatus] as readonly ChangeSetStatus[] | undefined)?.includes(nextStatus)) {
      throw new AgentError('APPROVAL_INVALID');
    }
    if (String(row.expires_at) <= now && nextStatus !== 'expired') throw new AgentError('APPROVAL_INVALID');
    database.run('UPDATE agent_changesets SET status = ?, applied_at = NULL WHERE change_set_id = ? AND status = ?', [
      nextStatus, changeSetId, String(row.status)
    ]);
    this.requiredAudit(() => this.audit.appendWorkflowControlInTransaction(database, scope, {
      clientId: String(row.client_id), operation: 'agent.changesets.apply', risk: row.risk as ChangeSet['risk'],
      summary: Object.freeze({ action: `changeset_${nextStatus}`, changeSetId })
    }));
    return { changed: true, value: this.readChangeSet(database, changeSetId)! };
  }

  applyChangeSetInTransaction(
    database: Database,
    scope: DatabaseMutationScope,
    binding: ChangeSetApplyBinding
  ): DatabaseMutationResult<ChangeSet> {
    assertDatabaseMutationScope(scope, database);
    const now = this.currentTimestamp();
    const row = one(database, 'SELECT * FROM agent_changesets WHERE change_set_id = ?', [binding.changeSetId]);
    if (!row || row.status !== 'approved' || String(row.expires_at) <= now) throw new AgentError('APPROVAL_INVALID');
    const changeSet = this.readChangeSet(database, binding.changeSetId);
    if (
      !changeSet || changeSet.clientId !== binding.clientId || changeSet.operations.length !== 1 ||
      changeSet.catalog.version !== binding.catalog.version || !equalHash(changeSet.catalog.hash, binding.catalog.hash) ||
      changeSet.baseVersion.dataEpoch !== binding.baseVersion.dataEpoch || changeSet.baseVersion.dataRevision !== binding.baseVersion.dataRevision ||
      !equalHash(changeSet.affectedSetHash, binding.affectedSetHash) ||
      changeSet.operations[0].operation !== binding.operation || !equalHash(changeSet.operations[0].payloadHash, binding.payloadHash)
    ) throw new AgentError('APPROVAL_INVALID');
    database.run("UPDATE agent_changesets SET status = 'applied', applied_at = ? WHERE change_set_id = ? AND status = 'approved'", [now, binding.changeSetId]);
    if (database.getRowsModified() !== 1) throw new AgentError('APPROVAL_INVALID');
    this.requiredAudit(() => this.audit.appendWorkflowControlInTransaction(database, scope, {
      clientId: binding.clientId, operation: 'agent.changesets.apply', risk: changeSet.risk,
      summary: Object.freeze({ action: 'changeset_applied', changeSetId: binding.changeSetId, plannedOperation: binding.operation })
    }));
    return { changed: true, value: this.readChangeSet(database, binding.changeSetId)! };
  }

  private readChangeSet(database: Database, changeSetId: string): ChangeSet | undefined {
    const row = one(database, 'SELECT * FROM agent_changesets WHERE change_set_id = ?', [changeSetId]);
    if (!row) return undefined;
    return changeSetFromRows(row, all(database, 'SELECT * FROM agent_changeset_operations WHERE change_set_id = ? ORDER BY operation_index', [changeSetId]));
  }

  private requiredAudit<T>(append: () => T): T {
    try { return append(); } catch (error) {
      if (error instanceof AgentError && error.code === 'AUDIT_INTEGRITY_FAILURE') throw error;
      throw new AgentError('AUDIT_UNAVAILABLE');
    }
  }

  private assertListLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 201) throw new AgentError('VALIDATION_ERROR', { field: 'limit' });
  }

  private currentTimestamp(): string {
    const value = this.now();
    timestamp(value, 'now');
    return value;
  }
}

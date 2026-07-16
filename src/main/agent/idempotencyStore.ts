import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Database } from 'sql.js';
import { AgentError, serializeAgentError, type SerializedAgentError } from '../../shared/agent/errors';
import { agentApiVersion } from '../../shared/agent/versions';
import type { CommandResult, DataVersion, EntityRef } from '../../shared/agent/v1/contracts';
import {
  type CatalogIdentity,
  type ExecutionReceipt,
  type JsonObject,
  type OperationName,
  type R4Reservation,
  type RiskLevel
} from '../../shared/agent/v1/gatewayContracts';
import {
  canonicalizeJson,
  gatewayMaxAffectedEntities,
  hashCanonicalJson,
  validateCatalogIdentity,
  validateExecutionReceipt
} from '../../shared/agent/v1/gatewaySchemas';
import { assertDatabaseMutationScope, type DatabaseMutationScope } from '../persistence/databaseCoordinator';
import { AuditLedger, type AgentControlWriteExecutor } from './auditLedger';
import { WorkflowStore, type R4ReservationRequest } from './workflows';
import { all, one, type SqlParameter } from './sqlRows';

export interface IdempotencyStoreDependencies {
  readonly executeControlWrite: AgentControlWriteExecutor;
  readonly audit: AuditLedger;
  readonly workflows: WorkflowStore;
  readonly now?: () => string;
  readonly randomUUID?: () => string;
}

export interface IdempotencyAdmissionRequest {
  readonly clientId: string;
  readonly requestId: string;
  readonly operation: OperationName;
  readonly payload: JsonObject;
  readonly affectedEntities?: readonly EntityRef[];
  readonly baseVersion?: DataVersion;
  readonly catalog: CatalogIdentity;
  readonly risk: RiskLevel;
  readonly policyVersion?: string;
  readonly r4?: Omit<R4ReservationRequest, 'clientId' | 'requestId' | 'operation' | 'payloadHash' | 'affectedSetHash' | 'baseVersion' | 'catalog'>;
}

export interface PreparedExecutionReceipt {
  readonly receiptId: string;
  readonly clientId: string;
  readonly requestId: string;
  readonly operation: OperationName;
  readonly payloadHash: string;
  readonly affectedSetHash?: string;
  readonly baseVersion?: DataVersion;
  readonly catalog: CatalogIdentity;
  readonly risk: RiskLevel;
  readonly policyVersion?: string;
  readonly createdAt: string;
  readonly reservation?: R4Reservation;
  readonly r4Authority?: {
    readonly grantId: string;
    readonly targetHash: string;
    readonly recovery: R4ReservationRequest['recovery'];
    readonly maxAffectedEntities: number;
    readonly reservationExpiresAt: string;
  };
}

export type AdmissionResult =
  | { readonly kind: 'admitted'; readonly prepared: PreparedExecutionReceipt }
  | { readonly kind: 'replayed'; readonly receipt: ExecutionReceipt; readonly outcome: CommandResult | SerializedAgentError }
  | { readonly kind: 'pending'; readonly receipt: ExecutionReceipt };

export interface ReceiptRecoveryEvidence {
  readonly selectedCandidate: true;
  readonly ledgerVerified: true;
}

const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const hashPattern = /^sha256-v1:[0-9a-f]{64}$/;

function timestamp(value: string, field: string): string {
  if (!timestampPattern.test(value) || new Date(value).toISOString() !== value) throw new AgentError('VALIDATION_ERROR', { field });
  return value;
}

function plusDays(value: string, days: number): string {
  return new Date(Date.parse(value) + days * 24 * 60 * 60 * 1000).toISOString();
}

function equalHash(left: string, right: string): boolean {
  return hashPattern.test(left) && hashPattern.test(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function affectedSet(entities: readonly EntityRef[] = []): readonly EntityRef[] {
  if (!Array.isArray(entities) || entities.length > gatewayMaxAffectedEntities) throw new AgentError('VALIDATION_ERROR', { field: 'affectedEntities' });
  const normalized = entities.map((entity) => Object.freeze({ entityType: entity.entityType, entityId: entity.entityId }))
    .sort((left, right) => `${left.entityType}\0${left.entityId}`.localeCompare(`${right.entityType}\0${right.entityId}`));
  if (new Set(normalized.map((entity) => `${entity.entityType}\0${entity.entityId}`)).size !== normalized.length) {
    throw new AgentError('VALIDATION_ERROR', { field: 'affectedEntities' });
  }
  return Object.freeze(normalized);
}

function immutableJson<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(immutableJson)) as T;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) result[key] = immutableJson(entry);
  return Object.freeze(result) as T;
}

function terminalValue(row: Record<string, unknown>): CommandResult | SerializedAgentError {
  if (typeof row.terminal_outcome_json !== 'string' || typeof row.terminal_outcome_hash !== 'string') throw new AgentError('RECOVERY_FENCE');
  let outcome: unknown;
  try { outcome = JSON.parse(row.terminal_outcome_json); } catch { throw new AgentError('RECOVERY_FENCE'); }
  if (canonicalizeJson(outcome) !== row.terminal_outcome_json || !equalHash(hashCanonicalJson(outcome), row.terminal_outcome_hash)) {
    throw new AgentError('RECOVERY_FENCE');
  }
  return immutableJson(outcome as CommandResult | SerializedAgentError);
}

function receiptFromRow(row: Record<string, unknown>): ExecutionReceipt {
  const terminal = row.status === 'admitted' ? undefined : terminalValue(row);
  const receipt = Object.freeze({
    apiVersion: agentApiVersion,
    receiptId: String(row.receipt_id), clientId: String(row.client_id), requestId: String(row.request_id),
    operation: row.operation as OperationName, payloadHash: String(row.payload_hash),
    ...(typeof row.affected_set_hash === 'string' ? { affectedSetHash: row.affected_set_hash } : {}),
    catalog: Object.freeze({ version: String(row.catalog_version), hash: String(row.catalog_hash) }),
    ...(typeof row.base_data_epoch === 'string' ? { baseVersion: Object.freeze({ dataEpoch: row.base_data_epoch, dataRevision: Number(row.base_data_revision) }) } : {}),
    status: row.status as ExecutionReceipt['status'],
    ...(typeof row.terminal_data_epoch === 'string' ? { dataVersion: Object.freeze({ dataEpoch: row.terminal_data_epoch, dataRevision: Number(row.terminal_data_revision) }) } : {}),
    ...(typeof row.terminal_outcome_hash === 'string' ? { outcomeHash: row.terminal_outcome_hash } : {}),
    ...(row.status !== 'admitted' && row.status !== 'completed' ? { error: terminal as SerializedAgentError } : {}),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  });
  validateExecutionReceipt(receipt);
  return receipt;
}

function assertSameBindings(row: Record<string, unknown>, request: {
  clientId: string; requestId: string; operation: OperationName; payloadHash: string; affectedSetHash?: string;
  baseVersion?: DataVersion; catalog: CatalogIdentity;
  r4Authority?: PreparedExecutionReceipt['r4Authority'];
}): void {
  if (
    row.client_id !== request.clientId || row.request_id !== request.requestId || row.operation !== request.operation ||
    !equalHash(String(row.payload_hash), request.payloadHash) ||
    (row.affected_set_hash ?? undefined) !== request.affectedSetHash ||
    (row.base_data_epoch ?? undefined) !== request.baseVersion?.dataEpoch ||
    (row.base_data_revision ?? undefined) !== request.baseVersion?.dataRevision ||
    row.catalog_version !== request.catalog.version || !equalHash(String(row.catalog_hash), request.catalog.hash) ||
    (row.grant_id ?? undefined) !== request.r4Authority?.grantId ||
    (request.r4Authority ? !equalHash(String(row.r4_target_hash), request.r4Authority.targetHash) : row.r4_target_hash !== null) ||
    (row.r4_recovery ?? undefined) !== request.r4Authority?.recovery ||
    (row.r4_max_affected_entities ?? undefined) !== request.r4Authority?.maxAffectedEntities ||
    (row.r4_reservation_expires_at ?? undefined) !== request.r4Authority?.reservationExpiresAt
  ) throw new AgentError('IDEMPOTENCY_CONFLICT');
}

export class IdempotencyStore {
  private readonly executeControlWrite: AgentControlWriteExecutor;
  private readonly audit: AuditLedger;
  private readonly workflows: WorkflowStore;
  private readonly now: () => string;
  private readonly randomUUID: () => string;

  constructor(dependencies: IdempotencyStoreDependencies) {
    this.executeControlWrite = dependencies.executeControlWrite;
    this.audit = dependencies.audit;
    this.workflows = dependencies.workflows;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.randomUUID = dependencies.randomUUID ?? randomUUID;
  }

  async admit(request: IdempotencyAdmissionRequest): Promise<AdmissionResult> {
    validateCatalogIdentity(request.catalog);
    const payloadJson = canonicalizeJson(request.payload);
    const payloadHash = hashCanonicalJson(request.payload);
    const entities = affectedSet(request.affectedEntities);
    const affectedSetHash = entities.length ? hashCanonicalJson(entities) : undefined;
    if (request.r4 && (!request.baseVersion || !affectedSetHash)) throw new AgentError('R4_GRANT_INVALID');
    const r4Authority = request.r4 ? Object.freeze({
      grantId: request.r4.grantId,
      targetHash: request.r4.targetHash,
      recovery: request.r4.recovery,
      maxAffectedEntities: request.r4.maxAffectedEntities,
      reservationExpiresAt: request.r4.expiresAt
    }) : undefined;
    const result = await this.executeControlWrite<AdmissionResult>({
      requestId: `agent-admit-${request.requestId}`,
      execute: (database, scope) => {
        assertDatabaseMutationScope(scope, database);
        const existing = one(database, 'SELECT * FROM agent_idempotency WHERE client_id = ? AND request_id = ?', [request.clientId, request.requestId]);
        if (existing) {
          assertSameBindings(existing, {
            clientId: request.clientId, requestId: request.requestId, operation: request.operation, payloadHash,
            affectedSetHash, baseVersion: request.baseVersion, catalog: request.catalog, r4Authority
          });
          const receipt = receiptFromRow(existing);
          return { changed: false, value: receipt.status === 'admitted'
            ? Object.freeze({ kind: 'pending' as const, receipt })
            : Object.freeze({ kind: 'replayed' as const, receipt, outcome: terminalValue(existing) }) };
        }
        const createdAt = this.currentTimestamp();
        const receiptId = this.randomUUID().toLowerCase();
        database.run(`INSERT INTO agent_idempotency (
          receipt_id, client_id, request_id, operation, payload_json, payload_hash, affected_set_hash,
          catalog_version, catalog_hash, base_data_epoch, base_data_revision, risk, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admitted', ?, ?)`, [
          receiptId, request.clientId, request.requestId, request.operation, payloadJson, payloadHash, affectedSetHash ?? null,
          request.catalog.version, request.catalog.hash, request.baseVersion?.dataEpoch ?? null,
          request.baseVersion?.dataRevision ?? null, request.risk, createdAt, createdAt
        ]);
        let reservation: R4Reservation | undefined;
        if (request.r4) {
          reservation = this.workflows.reserveR4GrantInTransaction(database, scope, {
            ...request.r4, clientId: request.clientId, requestId: request.requestId, operation: request.operation,
            payloadHash, affectedSetHash: affectedSetHash!, baseVersion: request.baseVersion!, catalog: request.catalog
          });
          database.run(`UPDATE agent_idempotency SET reservation_id = ?, grant_id = ?, r4_target_hash = ?, r4_recovery = ?,
            r4_max_affected_entities = ?, r4_reservation_expires_at = ? WHERE receipt_id = ?`, [
            reservation.reservationId, reservation.grantId, r4Authority!.targetHash, r4Authority!.recovery,
            r4Authority!.maxAffectedEntities, r4Authority!.reservationExpiresAt, receiptId
          ]);
          this.requiredAudit(() => this.audit.appendGrantReservedInTransaction(database, scope, {
            clientId: request.clientId, requestId: request.requestId, operation: request.operation, risk: 'R4',
            policyVersion: request.policyVersion, receiptId, receiptClientId: request.clientId, receiptRequestId: request.requestId,
            summary: Object.freeze({ action: 'r4_grant_reserved', grantId: reservation!.grantId, reservationId: reservation!.reservationId })
          }));
        }
        this.requiredAudit(() => this.audit.appendAdmissionInTransaction(database, scope, {
          clientId: request.clientId, requestId: request.requestId, operation: request.operation, risk: request.risk,
          policyVersion: request.policyVersion, receiptId, receiptClientId: request.clientId, receiptRequestId: request.requestId,
          summary: Object.freeze({ action: 'command_admitted', payloadHash, ...(affectedSetHash ? { affectedSetHash } : {}) }),
          affectedEntities: entities
        }));
        const prepared = Object.freeze({
          receiptId, clientId: request.clientId, requestId: request.requestId, operation: request.operation,
          payloadHash, ...(affectedSetHash ? { affectedSetHash } : {}),
          ...(request.baseVersion ? { baseVersion: Object.freeze({ ...request.baseVersion }) } : {}),
          catalog: Object.freeze({ ...request.catalog }), risk: request.risk,
          ...(request.policyVersion ? { policyVersion: request.policyVersion } : {}), createdAt,
          ...(reservation ? { reservation, r4Authority } : {})
        });
        return { changed: true, value: Object.freeze({ kind: 'admitted' as const, prepared }) };
      }
    });
    return result.value;
  }

  async terminalizeKnownFailure(prepared: PreparedExecutionReceipt, error: unknown): Promise<ExecutionReceipt> {
    return this.terminalizeControl(prepared, 'failed', serializeAgentError(error), true);
  }

  async terminalizeIndeterminate(prepared: PreparedExecutionReceipt, evidence: ReceiptRecoveryEvidence): Promise<ExecutionReceipt> {
    this.assertRecoveryEvidence(evidence);
    return this.terminalizeControl(prepared, 'indeterminate', serializeAgentError(new AgentError('PERSISTENCE_INDETERMINATE')), false);
  }

  async reconcileInterruptedPrecommit(evidence: ReceiptRecoveryEvidence): Promise<number> {
    this.assertRecoveryEvidence(evidence);
    const now = this.currentTimestamp();
    const result = await this.executeControlWrite({ requestId: 'agent-receipt-reconcile', execute: (database, scope) => {
      assertDatabaseMutationScope(scope, database);
      const rows = all(database, "SELECT * FROM agent_idempotency WHERE status = 'admitted' ORDER BY created_at, receipt_id");
      for (const row of rows) {
        const error = serializeAgentError(new AgentError('RECOVERY_FENCE'));
        const outcomeJson = canonicalizeJson(error);
        database.run(`UPDATE agent_idempotency SET status = 'interrupted_precommit', terminal_outcome_json = ?,
          terminal_outcome_hash = ?, updated_at = ?, terminal_at = ?, retain_until = ? WHERE receipt_id = ? AND status = 'admitted'`, [
          outcomeJson, hashCanonicalJson(error), now, now, plusDays(now, row.risk === 'R4' ? 365 : 30), String(row.receipt_id)
        ]);
        let released = false;
        if (typeof row.reservation_id === 'string') released = this.workflows.releaseR4ReservationInTransaction(database, scope, row.reservation_id);
        this.requiredAudit(() => this.audit.appendReconciliationInTransaction(database, scope, {
          clientId: String(row.client_id), requestId: String(row.request_id), operation: row.operation as OperationName,
          risk: row.risk as RiskLevel, receiptId: String(row.receipt_id), receiptClientId: String(row.client_id), receiptRequestId: String(row.request_id),
          summary: Object.freeze({ action: 'interrupted_precommit', reservationReleased: released })
        }));
        if (released) this.requiredAudit(() => this.audit.appendGrantReleasedInTransaction(database, scope, {
          clientId: String(row.client_id), requestId: String(row.request_id), operation: row.operation as OperationName,
          risk: 'R4', receiptId: String(row.receipt_id), receiptClientId: String(row.client_id), receiptRequestId: String(row.request_id),
          summary: Object.freeze({ action: 'r4_grant_released_after_reconciliation', reservationId: String(row.reservation_id) })
        }));
      }
      return { changed: rows.length > 0, value: rows.length };
    } });
    return result.value;
  }

  async get(clientId: string, requestId: string): Promise<{ readonly receipt: ExecutionReceipt; readonly outcome?: CommandResult | SerializedAgentError } | undefined> {
    const result = await this.executeControlWrite({ requestId: `agent-receipt-get-${requestId}`, execute: (database) => {
      const row = one(database, 'SELECT * FROM agent_idempotency WHERE client_id = ? AND request_id = ?', [clientId, requestId]);
      return { changed: false, value: row ? Object.freeze({ receipt: receiptFromRow(row), ...(row.status !== 'admitted' ? { outcome: terminalValue(row) } : {}) }) : undefined };
    } });
    return result.value;
  }

  async pruneExpiredTerminalReceipts(before: string): Promise<number> {
    timestamp(before, 'before');
    const trustedNow = this.currentTimestamp();
    if (before > trustedNow) throw new AgentError('VALIDATION_ERROR', { field: 'before' });
    const result = await this.executeControlWrite({ requestId: 'agent-receipt-retention', execute: (database, scope) => {
      assertDatabaseMutationScope(scope, database);
      database.run("DELETE FROM agent_idempotency WHERE status <> 'admitted' AND risk <> 'R4' AND retain_until <= ?", [before]);
      const count = database.getRowsModified();
      return { changed: count > 0, value: count };
    } });
    return result.value;
  }

  private async terminalizeControl(
    prepared: PreparedExecutionReceipt,
    status: 'failed' | 'indeterminate',
    error: SerializedAgentError,
    releaseReservation: boolean
  ): Promise<ExecutionReceipt> {
    const now = this.currentTimestamp();
    const outcomeJson = canonicalizeJson(error);
    const result = await this.executeControlWrite({ requestId: `agent-receipt-${status}-${prepared.requestId}`, execute: (database, scope) => {
      assertDatabaseMutationScope(scope, database);
      const row = one(database, 'SELECT * FROM agent_idempotency WHERE receipt_id = ?', [prepared.receiptId]);
      if (!row) throw new AgentError('RECOVERY_FENCE');
      assertSameBindings(row, { ...prepared, r4Authority: prepared.r4Authority });
      if (row.status !== 'admitted') return { changed: false, value: receiptFromRow(row) };
      database.run(`UPDATE agent_idempotency SET status = ?, terminal_outcome_json = ?, terminal_outcome_hash = ?,
        updated_at = ?, terminal_at = ?, retain_until = ? WHERE receipt_id = ? AND status = 'admitted'`, [
        status, outcomeJson, hashCanonicalJson(error), now, now, plusDays(now, prepared.risk === 'R4' ? 365 : 30), prepared.receiptId
      ]);
      let released = false;
      if (releaseReservation && prepared.reservation) {
        released = this.workflows.releaseR4ReservationInTransaction(database, scope, prepared.reservation.reservationId);
      }
      this.requiredAudit(() => status === 'failed'
        ? this.audit.appendTerminalFailureInTransaction(database, scope, {
            clientId: prepared.clientId, requestId: prepared.requestId, operation: prepared.operation, risk: prepared.risk,
            policyVersion: prepared.policyVersion, receiptId: prepared.receiptId, receiptClientId: prepared.clientId,
            receiptRequestId: prepared.requestId, summary: Object.freeze({ action: 'command_failed', errorCode: error.code })
          })
        : this.audit.appendIndeterminateInTransaction(database, scope, {
            clientId: prepared.clientId, requestId: prepared.requestId, operation: prepared.operation, risk: prepared.risk,
            policyVersion: prepared.policyVersion, receiptId: prepared.receiptId, receiptClientId: prepared.clientId,
            receiptRequestId: prepared.requestId, summary: Object.freeze({ action: 'publication_indeterminate', errorCode: error.code })
          }));
      if (released && prepared.reservation) this.requiredAudit(() => this.audit.appendGrantReleasedInTransaction(database, scope, {
        clientId: prepared.clientId, requestId: prepared.requestId, operation: prepared.operation, risk: 'R4',
        receiptId: prepared.receiptId, receiptClientId: prepared.clientId, receiptRequestId: prepared.requestId,
        summary: Object.freeze({ action: 'r4_grant_released_after_failure', reservationId: prepared.reservation!.reservationId })
      }));
      return { changed: true, value: receiptFromRow(one(database, 'SELECT * FROM agent_idempotency WHERE receipt_id = ?', [prepared.receiptId])!) };
    } });
    return result.value;
  }

  private requiredAudit<T>(append: () => T): T {
    try { return append(); } catch (error) {
      if (error instanceof AgentError && error.code === 'AUDIT_INTEGRITY_FAILURE') throw error;
      throw new AgentError('AUDIT_UNAVAILABLE');
    }
  }

  private assertRecoveryEvidence(evidence: ReceiptRecoveryEvidence): void {
    if (!evidence || evidence.selectedCandidate !== true || evidence.ledgerVerified !== true || Object.keys(evidence).length !== 2) {
      throw new AgentError('RECOVERY_FENCE');
    }
  }

  private currentTimestamp(): string {
    return timestamp(this.now(), 'now');
  }
}

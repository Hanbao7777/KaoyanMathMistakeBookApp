import { timingSafeEqual } from 'node:crypto';
import type { Database } from 'sql.js';
import { AgentError } from '../../shared/agent/errors';
import type { CommandResult } from '../../shared/agent/v1/contracts';
import { canonicalizeJson, hashCanonicalJson } from '../../shared/agent/v1/gatewaySchemas';
import {
  assertDatabaseMutationScope,
  type DatabaseMutationScope,
  type DatabaseTerminalHook,
  type DatabaseTerminalHookContext
} from '../persistence/databaseCoordinator';
import { RevisionStore } from '../persistence/revisionStore';
import { AuditLedger } from './auditLedger';
import type { PreparedExecutionReceipt } from './idempotencyStore';
import { one } from './sqlRows';
import { WorkflowStore, type ChangeSetApplyBinding, type WorkflowBinding } from './workflows';

export interface ExecutionReceiptsDependencies {
  readonly audit: AuditLedger;
  readonly workflows: WorkflowStore;
  readonly now?: () => string;
}

export interface ReceiptWorkflowAuthorities {
  readonly approval?: { readonly approvalId: string; readonly binding: WorkflowBinding };
  readonly changeSet?: ChangeSetApplyBinding;
}

const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const hashPattern = /^sha256-v1:[0-9a-f]{64}$/;

function equalHash(left: string, right: string): boolean {
  return hashPattern.test(left) && hashPattern.test(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function plusDays(value: string, days: number): string {
  return new Date(Date.parse(value) + days * 24 * 60 * 60 * 1000).toISOString();
}

function assertTerminalResult(result: CommandResult, context: DatabaseTerminalHookContext<CommandResult>): void {
  if (!Object.isFrozen(result) || !Object.isFrozen(result.events) || !Object.isFrozen(result.dataVersion)) {
    throw new AgentError('AUDIT_UNAVAILABLE');
  }
  if (
    result.changed !== context.semanticChanged ||
    result.dataVersion.dataEpoch !== context.versionAfter.dataEpoch ||
    result.dataVersion.dataRevision !== context.versionAfter.dataRevision
  ) throw new AgentError('INVALID_RECEIPT_TRANSITION');
  for (const event of result.events) {
    if (
      event.versionBefore.dataEpoch !== context.versionBefore.dataEpoch ||
      event.versionBefore.dataRevision !== context.versionBefore.dataRevision ||
      event.versionAfter.dataEpoch !== context.versionAfter.dataEpoch ||
      event.versionAfter.dataRevision !== context.versionAfter.dataRevision
    ) throw new AgentError('INVALID_RECEIPT_TRANSITION');
  }
  canonicalizeJson(result);
}

function assertPreparedReceipt(row: Record<string, unknown> | undefined, prepared: PreparedExecutionReceipt): void {
  if (!row || row.status !== 'admitted') throw new AgentError('INVALID_RECEIPT_TRANSITION');
  if (
    row.client_id !== prepared.clientId || row.request_id !== prepared.requestId || row.operation !== prepared.operation ||
    !equalHash(String(row.payload_hash), prepared.payloadHash) ||
    (row.affected_set_hash ?? undefined) !== prepared.affectedSetHash ||
    (row.base_data_epoch ?? undefined) !== prepared.baseVersion?.dataEpoch ||
    (row.base_data_revision ?? undefined) !== prepared.baseVersion?.dataRevision ||
    row.catalog_version !== prepared.catalog.version || !equalHash(String(row.catalog_hash), prepared.catalog.hash) ||
    (row.reservation_id ?? undefined) !== prepared.reservation?.reservationId ||
    (row.grant_id ?? undefined) !== prepared.r4Authority?.grantId ||
    (prepared.r4Authority ? !equalHash(String(row.r4_target_hash), prepared.r4Authority.targetHash) : row.r4_target_hash !== null) ||
    (row.r4_recovery ?? undefined) !== prepared.r4Authority?.recovery ||
    (row.r4_max_affected_entities ?? undefined) !== prepared.r4Authority?.maxAffectedEntities ||
    (row.r4_reservation_expires_at ?? undefined) !== prepared.r4Authority?.reservationExpiresAt
  ) throw new AgentError('IDEMPOTENCY_CONFLICT');
}

export class ExecutionReceipts {
  private readonly audit: AuditLedger;
  private readonly workflows: WorkflowStore;
  private readonly now: () => string;

  constructor(dependencies: ExecutionReceiptsDependencies) {
    this.audit = dependencies.audit;
    this.workflows = dependencies.workflows;
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  createTerminalHook(
    prepared: PreparedExecutionReceipt,
    authorities: ReceiptWorkflowAuthorities = {}
  ): DatabaseTerminalHook<CommandResult> {
    return Object.freeze({
      execute: (database: Database, scope: DatabaseMutationScope, context: DatabaseTerminalHookContext<CommandResult>) => {
        assertDatabaseMutationScope(scope, database);
        assertTerminalResult(context.value, context);
        const row = one(database, 'SELECT * FROM agent_idempotency WHERE receipt_id = ?', [prepared.receiptId]);
        assertPreparedReceipt(row, prepared);
        if (authorities.approval) {
          this.workflows.consumeApprovalInTransaction(database, scope, authorities.approval.approvalId, authorities.approval.binding);
        }
        if (authorities.changeSet) this.workflows.applyChangeSetInTransaction(database, scope, authorities.changeSet);
        if (prepared.reservation) this.workflows.consumeR4ReservationInTransaction(database, scope, prepared.reservation);
        this.finalizeSuccessInTransaction(database, scope, prepared, context.value);
        return { changed: true, value: undefined };
      }
    });
  }

  finalizeControlSuccessInTransaction<T>(
    database: Database,
    scope: DatabaseMutationScope,
    prepared: PreparedExecutionReceipt,
    mutation: { readonly changed: boolean; readonly value: T }
  ): CommandResult<T> {
    assertDatabaseMutationScope(scope, database);
    assertPreparedReceipt(one(database, 'SELECT * FROM agent_idempotency WHERE receipt_id = ?', [prepared.receiptId]), prepared);
    if (prepared.reservation) this.workflows.consumeR4ReservationInTransaction(database, scope, prepared.reservation);
    const version = new RevisionStore(database).readCurrentVersion();
    const result = Object.freeze({
      changed: mutation.changed,
      value: mutation.value,
      events: Object.freeze([]),
      dataVersion: Object.freeze({ ...version })
    });
    this.finalizeSuccessInTransaction(database, scope, prepared, result);
    return result;
  }

  private finalizeSuccessInTransaction(
    database: Database,
    scope: DatabaseMutationScope,
    prepared: PreparedExecutionReceipt,
    result: CommandResult
  ): void {
    const now = this.currentTimestamp();
    const outcomeJson = canonicalizeJson(result);
    const outcomeHash = hashCanonicalJson(result);
    database.run(`UPDATE agent_idempotency SET status = 'completed', terminal_outcome_json = ?, terminal_outcome_hash = ?,
      terminal_data_epoch = ?, terminal_data_revision = ?, updated_at = ?, terminal_at = ?, retain_until = ?
      WHERE receipt_id = ? AND status = 'admitted'`, [
      outcomeJson, outcomeHash, result.dataVersion.dataEpoch, result.dataVersion.dataRevision,
      now, now, plusDays(now, prepared.risk === 'R4' ? 365 : 30), prepared.receiptId
    ]);
    if (database.getRowsModified() !== 1) throw new AgentError('INVALID_RECEIPT_TRANSITION');
    if (prepared.reservation) this.requiredAudit(() => this.audit.appendGrantConsumedInTransaction(database, scope, {
      clientId: prepared.clientId, requestId: prepared.requestId, operation: prepared.operation, risk: 'R4',
      policyVersion: prepared.policyVersion, receiptId: prepared.receiptId, receiptClientId: prepared.clientId,
      receiptRequestId: prepared.requestId,
      summary: Object.freeze({ action: 'r4_grant_consumed', grantId: prepared.reservation!.grantId, reservationId: prepared.reservation!.reservationId })
    }));
    this.requiredAudit(() => this.audit.appendTerminalSuccessInTransaction(database, scope, {
      clientId: prepared.clientId, requestId: prepared.requestId, operation: prepared.operation, risk: prepared.risk,
      policyVersion: prepared.policyVersion, receiptId: prepared.receiptId, receiptClientId: prepared.clientId,
      receiptRequestId: prepared.requestId,
      summary: Object.freeze({
        action: 'command_completed', outcomeHash, changed: result.changed,
        dataEpoch: result.dataVersion.dataEpoch, dataRevision: result.dataVersion.dataRevision
      })
    }));
  }

  private requiredAudit<T>(append: () => T): T {
    try { return append(); } catch (error) {
      if (error instanceof AgentError && error.code === 'AUDIT_INTEGRITY_FAILURE') throw error;
      throw new AgentError('AUDIT_UNAVAILABLE');
    }
  }

  private currentTimestamp(): string {
    const value = this.now();
    if (!timestampPattern.test(value) || new Date(value).toISOString() !== value) throw new AgentError('AUDIT_UNAVAILABLE');
    return value;
  }
}

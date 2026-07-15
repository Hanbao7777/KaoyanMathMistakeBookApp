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
import { AuditLedger } from './auditLedger';
import type { PreparedExecutionReceipt } from './idempotencyStore';
import { WorkflowStore } from './workflows';

type SqlParameter = string | number | null | Uint8Array;

export interface ExecutionReceiptsDependencies {
  readonly audit: AuditLedger;
  readonly workflows: WorkflowStore;
  readonly now?: () => string;
}

const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const hashPattern = /^sha256-v1:[0-9a-f]{64}$/;

function one(database: Database, sql: string, parameters: readonly SqlParameter[] = []): Record<string, unknown> | undefined {
  const statement = database.prepare(sql);
  try {
    statement.bind([...parameters]);
    return statement.step() ? statement.getAsObject() : undefined;
  } finally {
    statement.free();
  }
}

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

export class ExecutionReceipts {
  private readonly audit: AuditLedger;
  private readonly workflows: WorkflowStore;
  private readonly now: () => string;

  constructor(dependencies: ExecutionReceiptsDependencies) {
    this.audit = dependencies.audit;
    this.workflows = dependencies.workflows;
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  createTerminalHook(prepared: PreparedExecutionReceipt): DatabaseTerminalHook<CommandResult> {
    return Object.freeze({
      execute: (database: Database, scope: DatabaseMutationScope, context: DatabaseTerminalHookContext<CommandResult>) => {
        assertDatabaseMutationScope(scope, database);
        assertTerminalResult(context.value, context);
        const row = one(database, 'SELECT * FROM agent_idempotency WHERE receipt_id = ?', [prepared.receiptId]);
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
        if (prepared.reservation) this.workflows.consumeR4ReservationInTransaction(database, scope, prepared.reservation);
        const now = this.currentTimestamp();
        const outcomeJson = canonicalizeJson(context.value);
        const outcomeHash = hashCanonicalJson(context.value);
        database.run(`UPDATE agent_idempotency SET status = 'completed', terminal_outcome_json = ?, terminal_outcome_hash = ?,
          terminal_data_epoch = ?, terminal_data_revision = ?, updated_at = ?, terminal_at = ?, retain_until = ?
          WHERE receipt_id = ? AND status = 'admitted'`, [
          outcomeJson, outcomeHash, context.value.dataVersion.dataEpoch, context.value.dataVersion.dataRevision,
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
            action: 'command_completed', outcomeHash, changed: context.value.changed,
            dataEpoch: context.value.dataVersion.dataEpoch, dataRevision: context.value.dataVersion.dataRevision
          })
        }));
        return { changed: true, value: undefined };
      }
    });
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

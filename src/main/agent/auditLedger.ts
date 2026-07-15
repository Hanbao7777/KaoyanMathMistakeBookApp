import { randomUUID } from 'node:crypto';
import type { Database } from 'sql.js';
import { AgentError } from '../../shared/agent/errors';
import { agentApiVersion } from '../../shared/agent/versions';
import type { EntityRef } from '../../shared/agent/v1/contracts';
import {
  auditKinds,
  riskLevels,
  type AuditKind,
  type AuditRecord,
  type CatalogIdentity,
  type JsonObject,
  type JsonValue,
  type OperationName,
  type RiskLevel
} from '../../shared/agent/v1/gatewayContracts';
import {
  canonicalizeJson,
  gatewayMaxAffectedEntities,
  hashCanonicalJson,
  validateAuditRecord,
  validateCatalogIdentity,
  validateJsonObject
} from '../../shared/agent/v1/gatewaySchemas';
import { assertDatabaseMutationScope, type DatabaseControlWriteRequest, type DatabaseMutationScope, type DatabaseWriteResult } from '../persistence/databaseCoordinator';

type SqlParameter = string | number | null | Uint8Array;

export type AgentControlWriteExecutor = <T>(
  request: DatabaseControlWriteRequest<T>
) => Promise<DatabaseWriteResult<T>>;

export interface AuditEventInput {
  readonly clientId: string;
  readonly requestId?: string;
  readonly operation?: OperationName;
  readonly risk?: RiskLevel;
  readonly policyVersion?: string;
  readonly receiptId?: string;
  readonly receiptClientId?: string;
  readonly receiptRequestId?: string;
  readonly summary: JsonObject;
  readonly affectedEntities?: readonly EntityRef[];
  readonly occurredAt?: string;
}

export interface AuditSearchRequest {
  readonly afterSequence?: number;
  readonly pageSize: number;
  readonly clientId?: string;
  readonly kinds?: readonly AuditKind[];
}

export interface AuditSearchResult {
  readonly records: readonly AuditRecord[];
  readonly nextSequence?: number;
}

export interface AuditVerificationResult {
  readonly valid: true;
  readonly segments: number;
  readonly events: number;
  readonly headHash?: string;
}

export interface AuditExportResult extends AuditVerificationResult {
  readonly records: readonly AuditRecord[];
}

export interface AuditLedgerDependencies {
  readonly executeControlWrite: AgentControlWriteExecutor;
  readonly catalog: CatalogIdentity;
  readonly now?: () => string;
  readonly randomUUID?: () => string;
}

interface AuditSegmentRow {
  readonly segment_id: string;
  readonly segment_number: number;
  readonly previous_segment_id: string | null;
  readonly previous_closing_hash: string | null;
  readonly opened_sequence: number;
  readonly last_sequence: number | null;
  readonly last_hash: string | null;
  readonly closed_sequence: number | null;
  readonly closing_hash: string | null;
  readonly opened_at: string;
  readonly closed_at: string | null;
  readonly pruned_at: string | null;
}

const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const safeIdentifier = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const sensitiveKey = /(?:credential|secret|token|authorization|password|api[_-]?key|private[_-]?key|session[_-]?(?:id|fingerprint)|file[_-]?path|absolute[_-]?path|data[_-]?root)/i;
const absolutePath = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;
const protectedKinds = new Set<AuditKind>([
  'authentication', 'pairing', 'client_revoked', 'policy_changed', 'catalog_changed'
]);

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

function timestamp(value: string, field: string): string {
  if (!timestampPattern.test(value) || new Date(value).toISOString() !== value) {
    throw new AgentError('VALIDATION_ERROR', { field });
  }
  return value;
}

function plusDays(value: string, days: number): string {
  return new Date(Date.parse(value) + days * 24 * 60 * 60 * 1000).toISOString();
}

function redact(value: JsonValue, key?: string): JsonValue | undefined {
  if (key && sensitiveKey.test(key)) return undefined;
  if (typeof value === 'string' && absolutePath.test(value)) return '[redacted-path]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => redact(entry)).filter((entry): entry is JsonValue => entry !== undefined));
  }
  const result: Record<string, JsonValue> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    const redacted = redact(entryValue, entryKey);
    if (redacted !== undefined) result[entryKey] = redacted;
  }
  return Object.freeze(result);
}

function redactedSummary(summary: JsonObject): JsonObject {
  validateJsonObject(summary, 'summary');
  const result = redact(summary);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new AgentError('AUDIT_UNAVAILABLE');
  return result as JsonObject;
}

function normalizedEntities(entities: readonly EntityRef[] = []): readonly EntityRef[] {
  if (!Array.isArray(entities) || entities.length > gatewayMaxAffectedEntities) {
    throw new AgentError('AUDIT_UNAVAILABLE');
  }
  const normalized = entities.map((entity) => {
    if (!entity || !safeIdentifier.test(entity.entityType) || typeof entity.entityId !== 'string' || entity.entityId.length > 200) {
      throw new AgentError('AUDIT_UNAVAILABLE');
    }
    return Object.freeze({ entityType: entity.entityType, entityId: entity.entityId });
  }).sort((left, right) => `${left.entityType}\0${left.entityId}`.localeCompare(`${right.entityType}\0${right.entityId}`));
  if (new Set(normalized.map((entity) => `${entity.entityType}\0${entity.entityId}`)).size !== normalized.length) {
    throw new AgentError('AUDIT_UNAVAILABLE');
  }
  return Object.freeze(normalized);
}

function toSegment(row: Record<string, unknown>): AuditSegmentRow {
  return row as unknown as AuditSegmentRow;
}

function immutableJson<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(immutableJson)) as T;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) result[key] = immutableJson(entry);
  return Object.freeze(result) as T;
}

function parseRecord(row: Record<string, unknown>): AuditRecord {
  let value: unknown;
  try {
    value = JSON.parse(String(row.event_json));
  } catch {
    throw new AgentError('AUDIT_INTEGRITY_FAILURE');
  }
  validateAuditRecord(value);
  return immutableJson(value as AuditRecord);
}

export class AuditLedger {
  private readonly executeControlWrite: AgentControlWriteExecutor;
  private readonly catalog: CatalogIdentity;
  private readonly now: () => string;
  private readonly randomUUID: () => string;

  constructor(dependencies: AuditLedgerDependencies) {
    validateCatalogIdentity(dependencies.catalog);
    this.executeControlWrite = dependencies.executeControlWrite;
    this.catalog = Object.freeze({ ...dependencies.catalog });
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.randomUUID = dependencies.randomUUID ?? randomUUID;
  }

  async recordDenial(input: AuditEventInput): Promise<AuditRecord> {
    return this.recordControl('denial', input);
  }

  async recordQuery(input: AuditEventInput): Promise<AuditRecord> {
    return this.recordControl('query', input);
  }

  async recordAuthentication(input: AuditEventInput): Promise<AuditRecord> {
    return this.recordControl('authentication', input);
  }

  async recordControlChange(input: AuditEventInput): Promise<AuditRecord> {
    return this.recordControl('control_changed', input);
  }

  async recordIndeterminate(input: AuditEventInput): Promise<AuditRecord> {
    return this.recordControl('indeterminate', input);
  }

  appendAdmissionInTransaction(database: Database, scope: DatabaseMutationScope, input: AuditEventInput): AuditRecord {
    return this.appendInTransaction(database, scope, 'admission', input);
  }

  appendTerminalSuccessInTransaction(database: Database, scope: DatabaseMutationScope, input: AuditEventInput): AuditRecord {
    return this.appendInTransaction(database, scope, 'success', input);
  }

  appendTerminalFailureInTransaction(database: Database, scope: DatabaseMutationScope, input: AuditEventInput): AuditRecord {
    return this.appendInTransaction(database, scope, 'failure', input);
  }

  appendGrantReservedInTransaction(database: Database, scope: DatabaseMutationScope, input: AuditEventInput): AuditRecord {
    return this.appendInTransaction(database, scope, 'grant_reserved', input);
  }

  appendGrantConsumedInTransaction(database: Database, scope: DatabaseMutationScope, input: AuditEventInput): AuditRecord {
    return this.appendInTransaction(database, scope, 'grant_consumed', input);
  }

  appendGrantReleasedInTransaction(database: Database, scope: DatabaseMutationScope, input: AuditEventInput): AuditRecord {
    return this.appendInTransaction(database, scope, 'grant_released', input);
  }

  appendReconciliationInTransaction(database: Database, scope: DatabaseMutationScope, input: AuditEventInput): AuditRecord {
    return this.appendInTransaction(database, scope, 'reconciliation', input);
  }

  appendIndeterminateInTransaction(database: Database, scope: DatabaseMutationScope, input: AuditEventInput): AuditRecord {
    return this.appendInTransaction(database, scope, 'indeterminate', input);
  }

  appendWorkflowControlInTransaction(database: Database, scope: DatabaseMutationScope, input: AuditEventInput): AuditRecord {
    return this.appendInTransaction(database, scope, 'control_changed', input);
  }

  async verify(): Promise<AuditVerificationResult> {
    const result = await this.executeControlWrite({
      requestId: 'agent-audit-verify',
      execute: (database) => ({ changed: false, value: this.verifyDatabase(database) })
    });
    return result.value;
  }

  async search(request: AuditSearchRequest): Promise<AuditSearchResult> {
    if (!Number.isSafeInteger(request.pageSize) || request.pageSize < 1 || request.pageSize > 200) {
      throw new AgentError('VALIDATION_ERROR', { field: 'pageSize' });
    }
    if (request.afterSequence !== undefined && (!Number.isSafeInteger(request.afterSequence) || request.afterSequence < 0)) {
      throw new AgentError('VALIDATION_ERROR', { field: 'afterSequence' });
    }
    if (request.kinds?.some((kind) => !auditKinds.includes(kind))) throw new AgentError('VALIDATION_ERROR', { field: 'kinds' });
    const result = await this.executeControlWrite({
      requestId: 'agent-audit-search',
      execute: (database) => {
        this.verifyDatabase(database);
        const clauses = ['sequence > ?'];
        const parameters: SqlParameter[] = [request.afterSequence ?? -1];
        if (request.clientId) { clauses.push('client_id = ?'); parameters.push(request.clientId); }
        if (request.kinds?.length) {
          clauses.push(`kind IN (${request.kinds.map(() => '?').join(',')})`);
          parameters.push(...request.kinds);
        }
        parameters.push(request.pageSize + 1);
        const rows = all(database, `SELECT event_json FROM agent_audit_events WHERE ${clauses.join(' AND ')} ORDER BY sequence LIMIT ?`, parameters);
        const records = rows.slice(0, request.pageSize).map(parseRecord);
        return { changed: false, value: Object.freeze({
          records: Object.freeze(records),
          ...(rows.length > request.pageSize ? { nextSequence: records[records.length - 1].sequence } : {})
        }) };
      }
    });
    return result.value;
  }

  async exportVerified(): Promise<AuditExportResult> {
    const result = await this.executeControlWrite({
      requestId: 'agent-audit-export',
      execute: (database) => {
        const verification = this.verifyDatabase(database);
        const records = all(database, 'SELECT event_json FROM agent_audit_events ORDER BY sequence').map(parseRecord);
        return { changed: false, value: Object.freeze({ ...verification, records: Object.freeze(records) }) };
      }
    });
    return result.value;
  }

  async rotateAndApplyRetention(input: AuditEventInput & { readonly before: string }): Promise<void> {
    if (input.operation !== 'agent.audit.cleanup' || input.risk !== 'R4') throw new AgentError('POLICY_DENIED');
    const before = timestamp(input.before, 'before');
    const trustedNow = this.currentTimestamp();
    if (before > trustedNow) throw new AgentError('VALIDATION_ERROR', { field: 'before' });
    const cleanupInput = Object.freeze({ ...input, occurredAt: trustedNow });
    try {
      await this.executeControlWrite({
        requestId: `agent-audit-retention-${input.requestId ?? this.randomUUID()}`,
        execute: (database, scope) => {
          this.rotateInTransaction(database, scope, cleanupInput);
          const candidates = all(database, `SELECT segment_id FROM agent_audit_segments
            WHERE closed_at IS NOT NULL AND pruned_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM agent_audit_events e WHERE e.segment_id = agent_audit_segments.segment_id AND e.retain_until > ?)`, [before]);
          for (const candidate of candidates) {
            const segmentId = String(candidate.segment_id);
            database.run('DELETE FROM agent_audit_events WHERE segment_id = ?', [segmentId]);
            database.run('UPDATE agent_audit_segments SET pruned_at = ? WHERE segment_id = ?', [trustedNow, segmentId]);
          }
          return { changed: true, value: undefined };
        }
      });
    } catch (error) {
      if (error instanceof AgentError && ['PERSISTENCE_INDETERMINATE', 'RECOVERY_FENCE', 'AUDIT_INTEGRITY_FAILURE'].includes(error.code)) throw error;
      throw new AgentError('AUDIT_UNAVAILABLE');
    }
  }

  private async recordControl(kind: AuditKind, input: AuditEventInput): Promise<AuditRecord> {
    try {
      const result = await this.executeControlWrite({
        requestId: `agent-audit-${kind}-${input.requestId ?? this.randomUUID()}`,
        execute: (database, scope) => ({ changed: true, value: this.appendInTransaction(database, scope, kind, input) })
      });
      return result.value;
    } catch (error) {
      if (error instanceof AgentError && ['PERSISTENCE_INDETERMINATE', 'RECOVERY_FENCE', 'AUDIT_INTEGRITY_FAILURE'].includes(error.code)) throw error;
      throw new AgentError('AUDIT_UNAVAILABLE');
    }
  }

  private appendInTransaction(
    database: Database,
    scope: DatabaseMutationScope,
    kind: AuditKind,
    input: AuditEventInput
  ): AuditRecord {
    assertDatabaseMutationScope(scope, database);
    const occurredAt = timestamp(input.occurredAt ?? this.currentTimestamp(), 'occurredAt');
    if (!auditKinds.includes(kind) || !safeIdentifier.test(input.clientId)) throw new AgentError('AUDIT_UNAVAILABLE');
    if (input.risk && !riskLevels.includes(input.risk)) throw new AgentError('AUDIT_UNAVAILABLE');
    if ((input.receiptClientId === undefined) !== (input.receiptRequestId === undefined)) throw new AgentError('AUDIT_UNAVAILABLE');
    const summary = redactedSummary(input.summary);
    const affectedEntities = normalizedEntities(input.affectedEntities);
    let segment = one(database, 'SELECT * FROM agent_audit_segments WHERE closed_at IS NULL');
    const sequence = Number(one(database, 'SELECT COALESCE(MAX(sequence), -1) + 1 AS value FROM agent_audit_events')?.value);
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new AgentError('AUDIT_UNAVAILABLE');
    if (!segment) {
      const segmentId = this.randomUUID().toLowerCase();
      const segmentNumber = Number(one(database, 'SELECT COALESCE(MAX(segment_number), -1) + 1 AS value FROM agent_audit_segments')?.value);
      database.run(`INSERT INTO agent_audit_segments (
        segment_id, segment_number, opened_sequence, opened_at
      ) VALUES (?, ?, ?, ?)`, [segmentId, segmentNumber, sequence, occurredAt]);
      segment = one(database, 'SELECT * FROM agent_audit_segments WHERE segment_id = ?', [segmentId]);
    } else {
      this.verifyAppendHead(database, toSegment(segment));
    }
    if (!segment) throw new AgentError('AUDIT_UNAVAILABLE');
    const currentSegment = toSegment(segment);
    const previousHash = currentSegment.last_hash ?? currentSegment.previous_closing_hash ?? undefined;
    const auditId = this.randomUUID().toLowerCase();
    const material = {
      apiVersion: agentApiVersion,
      auditId,
      segmentId: currentSegment.segment_id,
      sequence,
      kind,
      occurredAt,
      clientId: input.clientId,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.operation ? { operation: input.operation } : {}),
      ...(input.risk ? { risk: input.risk } : {}),
      catalog: this.catalog,
      ...(input.receiptId ? { receiptId: input.receiptId } : {}),
      summary,
      affectedEntities,
      ...(previousHash ? { previousHash } : {})
    };
    const recordHash = hashCanonicalJson({
      ...material,
      ...(input.policyVersion ? { policyVersion: input.policyVersion } : {}),
      ...(input.receiptClientId ? { receiptClientId: input.receiptClientId, receiptRequestId: input.receiptRequestId } : {})
    });
    const record = Object.freeze({ ...material, recordHash }) as AuditRecord;
    validateAuditRecord(record);
    const protectedRetention = input.risk === 'R3' || input.risk === 'R4' || protectedKinds.has(kind);
    const retentionClass = protectedRetention ? 'protected_1y' : 'ordinary_180d';
    const retainUntil = plusDays(occurredAt, protectedRetention ? 365 : 180);
    database.run(`INSERT INTO agent_audit_events (
      sequence, audit_id, segment_id, kind, occurred_at, client_id, request_id, operation, risk,
      catalog_version, catalog_hash, policy_version, receipt_id, receipt_client_id, receipt_request_id,
      summary_json, affected_entities_json, event_json, previous_hash, record_hash, retention_class, retain_until
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      sequence, auditId, currentSegment.segment_id, kind, occurredAt, input.clientId, input.requestId ?? null,
      input.operation ?? null, input.risk ?? null, this.catalog.version, this.catalog.hash, input.policyVersion ?? null,
      input.receiptId ?? null, input.receiptClientId ?? null, input.receiptRequestId ?? null,
      canonicalizeJson(summary), canonicalizeJson(affectedEntities), canonicalizeJson(record), previousHash ?? null,
      recordHash, retentionClass, retainUntil
    ]);
    database.run('UPDATE agent_audit_segments SET last_sequence = ?, last_hash = ? WHERE segment_id = ?', [
      sequence, recordHash, currentSegment.segment_id
    ]);
    return record;
  }

  private rotateInTransaction(database: Database, scope: DatabaseMutationScope, input: AuditEventInput): void {
    const closed = this.appendInTransaction(database, scope, 'segment_closed', {
      ...input,
      summary: Object.freeze({ action: 'retention_segment_close' })
    });
    database.run(`UPDATE agent_audit_segments SET closed_sequence = ?, closing_hash = ?, closed_at = ?
      WHERE segment_id = ? AND closed_at IS NULL`, [closed.sequence, closed.recordHash, closed.occurredAt, closed.segmentId]);
    if (database.getRowsModified() !== 1) throw new AgentError('AUDIT_UNAVAILABLE');
    const successorId = this.randomUUID().toLowerCase();
    const nextSequence = closed.sequence + 1;
    const nextNumber = Number(one(database, 'SELECT COALESCE(MAX(segment_number), -1) + 1 AS value FROM agent_audit_segments')?.value);
    database.run(`INSERT INTO agent_audit_segments (
      segment_id, segment_number, previous_segment_id, previous_closing_hash, opened_sequence, opened_at
    ) VALUES (?, ?, ?, ?, ?, ?)`, [successorId, nextNumber, closed.segmentId, closed.recordHash, nextSequence, closed.occurredAt]);
    this.appendInTransaction(database, scope, 'segment_opened', {
      ...input,
      summary: Object.freeze({ action: 'retention_segment_open', previousSegmentId: closed.segmentId, previousClosingHash: closed.recordHash })
    });
  }

  private verifyAppendHead(database: Database, segment: AuditSegmentRow): void {
    const head = one(database, 'SELECT * FROM agent_audit_events WHERE segment_id = ? ORDER BY sequence DESC LIMIT 1', [segment.segment_id]);
    if (segment.last_sequence === null || segment.last_hash === null) {
      if (head) throw new AgentError('AUDIT_INTEGRITY_FAILURE');
      return;
    }
    if (!head || head.sequence !== segment.last_sequence || head.record_hash !== segment.last_hash || head.segment_id !== segment.segment_id) {
      throw new AgentError('AUDIT_INTEGRITY_FAILURE');
    }
    const previous = one(database, `SELECT record_hash FROM agent_audit_events
      WHERE segment_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT 1`, [segment.segment_id, segment.last_sequence]);
    const expectedPrevious = typeof previous?.record_hash === 'string' ? previous.record_hash : segment.previous_closing_hash ?? undefined;
    const record = parseRecord(head);
    if (
      record.segmentId !== segment.segment_id || record.sequence !== segment.last_sequence || record.recordHash !== segment.last_hash ||
      (record.previousHash ?? undefined) !== expectedPrevious || head.previous_hash !== (expectedPrevious ?? null) ||
      record.auditId !== head.audit_id || record.kind !== head.kind || record.occurredAt !== head.occurred_at ||
      record.clientId !== head.client_id || (record.requestId ?? null) !== head.request_id ||
      (record.operation ?? null) !== head.operation || (record.risk ?? null) !== head.risk ||
      record.catalog.version !== head.catalog_version || record.catalog.hash !== head.catalog_hash ||
      (record.receiptId ?? null) !== head.receipt_id || canonicalizeJson(record.summary) !== head.summary_json ||
      canonicalizeJson(record.affectedEntities) !== head.affected_entities_json || canonicalizeJson(record) !== head.event_json
    ) throw new AgentError('AUDIT_INTEGRITY_FAILURE');
    const material = JSON.parse(String(head.event_json)) as Record<string, unknown>;
    delete material.recordHash;
    const committed = {
      ...material,
      ...(head.policy_version ? { policyVersion: head.policy_version } : {}),
      ...(head.receipt_client_id ? { receiptClientId: head.receipt_client_id, receiptRequestId: head.receipt_request_id } : {})
    };
    const protectedRetention = record.risk === 'R3' || record.risk === 'R4' || protectedKinds.has(record.kind);
    if (
      hashCanonicalJson(committed) !== record.recordHash || record.recordHash !== head.record_hash ||
      head.retention_class !== (protectedRetention ? 'protected_1y' : 'ordinary_180d') ||
      head.retain_until !== plusDays(record.occurredAt, protectedRetention ? 365 : 180)
    ) throw new AgentError('AUDIT_INTEGRITY_FAILURE');
  }

  private verifyDatabase(database: Database): AuditVerificationResult {
    const segments = all(database, 'SELECT * FROM agent_audit_segments ORDER BY segment_number').map(toSegment);
    const events = all(database, 'SELECT * FROM agent_audit_events ORDER BY sequence');
    let eventIndex = 0;
    let previousSegment: AuditSegmentRow | undefined;
    let headHash: string | undefined;
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      const segment = segments[segmentIndex];
      if (segment.segment_number !== segmentIndex) throw new AgentError('AUDIT_INTEGRITY_FAILURE');
      if (!previousSegment) {
        if (segment.previous_segment_id !== null || segment.previous_closing_hash !== null) throw new AgentError('AUDIT_INTEGRITY_FAILURE');
      } else if (
        segment.previous_segment_id !== previousSegment.segment_id ||
        segment.previous_closing_hash !== previousSegment.closing_hash
      ) throw new AgentError('AUDIT_INTEGRITY_FAILURE');
      const segmentEvents: Record<string, unknown>[] = [];
      while (eventIndex < events.length && events[eventIndex].segment_id === segment.segment_id) {
        segmentEvents.push(events[eventIndex++]);
      }
      if (segment.pruned_at !== null) {
        if (segmentEvents.length !== 0 || segment.closed_at === null || segment.closing_hash === null) throw new AgentError('AUDIT_INTEGRITY_FAILURE');
        headHash = segment.closing_hash;
        previousSegment = segment;
        continue;
      }
      let expectedPrevious = segment.previous_closing_hash ?? undefined;
      for (let index = 0; index < segmentEvents.length; index += 1) {
        const row = segmentEvents[index];
        const record = parseRecord(row);
        if (
          record.segmentId !== segment.segment_id || record.sequence !== row.sequence || record.auditId !== row.audit_id ||
          record.kind !== row.kind || record.occurredAt !== row.occurred_at || record.clientId !== row.client_id ||
          (record.requestId ?? null) !== row.request_id || (record.operation ?? null) !== row.operation ||
          (record.risk ?? null) !== row.risk || record.catalog.version !== row.catalog_version || record.catalog.hash !== row.catalog_hash ||
          (record.receiptId ?? null) !== row.receipt_id || canonicalizeJson(record.summary) !== row.summary_json ||
          canonicalizeJson(record.affectedEntities) !== row.affected_entities_json
        ) throw new AgentError('AUDIT_INTEGRITY_FAILURE');
        if ((record.previousHash ?? undefined) !== expectedPrevious || row.previous_hash !== (expectedPrevious ?? null)) {
          throw new AgentError('AUDIT_INTEGRITY_FAILURE');
        }
        const material = JSON.parse(String(row.event_json)) as Record<string, unknown>;
        delete material.recordHash;
        const committed = {
          ...material,
          ...(row.policy_version ? { policyVersion: row.policy_version } : {}),
          ...(row.receipt_client_id ? { receiptClientId: row.receipt_client_id, receiptRequestId: row.receipt_request_id } : {})
        };
        const protectedRetention = record.risk === 'R3' || record.risk === 'R4' || protectedKinds.has(record.kind);
        if (
          canonicalizeJson(record) !== row.event_json || hashCanonicalJson(committed) !== record.recordHash || record.recordHash !== row.record_hash ||
          row.retention_class !== (protectedRetention ? 'protected_1y' : 'ordinary_180d') ||
          row.retain_until !== plusDays(record.occurredAt, protectedRetention ? 365 : 180)
        ) {
          throw new AgentError('AUDIT_INTEGRITY_FAILURE');
        }
        expectedPrevious = record.recordHash;
      }
      const last = segmentEvents.at(-1);
      if ((last ? Number(last.sequence) : null) !== segment.last_sequence || (last ? String(last.record_hash) : null) !== segment.last_hash) {
        throw new AgentError('AUDIT_INTEGRITY_FAILURE');
      }
      if (segment.closed_at !== null && (segment.closed_sequence !== segment.last_sequence || segment.closing_hash !== segment.last_hash)) {
        throw new AgentError('AUDIT_INTEGRITY_FAILURE');
      }
      headHash = segment.last_hash ?? segment.previous_closing_hash ?? undefined;
      previousSegment = segment;
    }
    if (eventIndex !== events.length) throw new AgentError('AUDIT_INTEGRITY_FAILURE');
    return Object.freeze({ valid: true as const, segments: segments.length, events: events.length, ...(headHash ? { headHash } : {}) });
  }

  private currentTimestamp(): string {
    return timestamp(this.now(), 'now');
  }
}

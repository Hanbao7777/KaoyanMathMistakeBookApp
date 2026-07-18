import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'sql.js';
import { AgentError, agentErrorCodes, serializeAgentError, type SerializedAgentError } from '../../shared/agent/errors';
import { agentApiVersion } from '../../shared/agent/versions';
import {
  isTerminalJobStatus,
  jobMaxResultBytes,
  jobRetentionClasses,
  jobStatuses,
  validateJobCreateInput,
  type AgentJob,
  type JobCreateInput,
  type JobListInput,
  type JobListResult,
  type JobResultRecord,
  type JobStatus
} from '../../shared/agent/v1/jobs';
import { agentScopes, trustProfiles, type AgentPrincipal, type AgentPrincipalClaims, type AgentQueryOutcome, type AgentExecuteOutcome, type AgentScope, type JsonObject, type OperationName, type TrustProfile } from '../../shared/agent/v1/gatewayContracts';
import { canonicalizeJson, hashCanonicalJson } from '../../shared/agent/v1/gatewaySchemas';
import { operationCatalogIdentity, resolveOperationDescriptor } from '../../shared/agent/v1/operationCatalog';
import { assertDatabaseMutationScope, type DatabaseControlWriteRequest, type DatabaseMutationResult, type DatabaseMutationScope, type DatabaseWriteResult } from '../persistence/databaseCoordinator';
import { flushDirectory, defaultDirectoryDurabilityDependencies } from '../persistence/fileDurability';
import { all, one, type SqlParameter } from './sqlRows';

export type JobControlWriteExecutor = <T>(request: DatabaseControlWriteRequest<T>) => Promise<DatabaseWriteResult<T>>;

export interface JobStoreDependencies {
  readonly executeControlWrite: JobControlWriteExecutor;
  readonly resultRoot: string;
  readonly now?: () => string;
  readonly randomUUID?: () => string;
  readonly maxResultBytes?: number;
  readonly hook?: (stage: JobStoreDurableStage, jobId: string) => void | Promise<void>;
}

export const jobStoreDurableStages = Object.freeze([
  'after_result_binding', 'before_result_temp', 'after_result_write', 'after_result_flush', 'after_result_rename', 'after_result_directory_flush', 'before_terminal_write', 'before_result_unlink'
] as const);
export type JobStoreDurableStage = (typeof jobStoreDurableStages)[number];

export interface JobLease {
  readonly job: AgentJob;
  readonly leaseToken: string;
  readonly target: JobCreateInput['target'];
  readonly principalClaims: AgentPrincipalClaims;
}

export interface JobRecoveryCandidate {
  readonly job: AgentJob;
  readonly target: JobCreateInput['target'];
  readonly resultRef?: string;
  readonly resultHash?: string;
  readonly resultSize?: number;
}

export interface WaitingWorkflowJob {
  readonly jobId: string;
  readonly ownerClientId: string;
}

interface PreparedJobResult {
  readonly bytes: Buffer;
  readonly ref: string;
  readonly hash: string;
  readonly size: number;
}

const HASH = /^sha256-v1:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const terminalStatuses = new Set<JobStatus>(['completed', 'failed', 'cancelled', 'interrupted']);

function addDays(timestamp: string, days: number): string {
  return new Date(Date.parse(timestamp) + days * 24 * 60 * 60 * 1000).toISOString();
}

function safeTimestamp(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || new Date(value).toISOString() !== value) {
    throw new AgentError('VALIDATION_ERROR', { field: 'timestamp' });
  }
  return value;
}

function rowError(row: Record<string, unknown>): SerializedAgentError | undefined {
  if (row.error_code === null && row.error_message === null) return undefined;
  if (typeof row.error_code !== 'string' || typeof row.error_message !== 'string' || row.error_message.length > 500) throw new AgentError('RECOVERY_FENCE');
  if (!(agentErrorCodes as readonly string[]).includes(row.error_code)) throw new AgentError('RECOVERY_FENCE');
  return Object.freeze({ code: row.error_code as SerializedAgentError['code'], message: row.error_message, retryable: false });
}

function persistedTimestamp(value: unknown): string {
  try { return safeTimestamp(String(value)); } catch { throw new AgentError('RECOVERY_FENCE'); }
}

function jobFromRow(row: Record<string, unknown>): AgentJob {
  let descriptor;
  try { descriptor = resolveOperationDescriptor(row.operation as OperationName); } catch { throw new AgentError('RECOVERY_FENCE'); }
  const operationKind = row.operation_kind;
  const status = row.status;
  const retentionClass = row.retention_class;
  if (descriptor.kind !== operationKind || !(jobStatuses as readonly unknown[]).includes(status) || !(jobRetentionClasses as readonly unknown[]).includes(retentionClass)) {
    throw new AgentError('RECOVERY_FENCE');
  }
  if (row.catalog_version !== operationCatalogIdentity.version || row.catalog_hash !== operationCatalogIdentity.hash) throw new AgentError('RECOVERY_FENCE');
  const job = Object.freeze({
    apiVersion: agentApiVersion,
    jobId: String(row.job_id), ownerClientId: String(row.owner_client_id), creatingSessionId: String(row.creating_session_id),
    operation: descriptor.name, operationKind: operationKind as 'command' | 'query',
    catalog: Object.freeze({ version: String(row.catalog_version), hash: String(row.catalog_hash) }), inputHash: String(row.input_hash),
    gatewayRequestId: String(row.gateway_request_id),
    ...(typeof row.receipt_id === 'string' ? { receiptId: row.receipt_id } : {}),
    ...(typeof row.operation_journal_id === 'string' ? { operationJournalId: row.operation_journal_id } : {}),
    status: status as JobStatus, progress: Number(row.progress),
    ...(rowError(row) ? { error: rowError(row) } : {}),
    ...(typeof row.cancellation_requested_at === 'string' ? { cancellationRequestedAt: row.cancellation_requested_at } : {}),
    attempt: Number(row.attempt), createdAt: persistedTimestamp(row.created_at), updatedAt: persistedTimestamp(row.updated_at),
    ...(typeof row.started_at === 'string' ? { startedAt: persistedTimestamp(row.started_at) } : {}),
    ...(typeof row.terminal_at === 'string' ? { terminalAt: persistedTimestamp(row.terminal_at) } : {}),
    retentionClass: retentionClass as AgentJob['retentionClass'], retainUntil: persistedTimestamp(row.retain_until)
  });
  if (job.cancellationRequestedAt) persistedTimestamp(job.cancellationRequestedAt);
  const hasLease = typeof row.lease_token === 'string' || typeof row.lease_expires_at === 'string';
  if ((typeof row.lease_token === 'string') !== (typeof row.lease_expires_at === 'string') ||
      (hasLease && (!UUID.test(String(row.lease_token)) || !persistedTimestamp(row.lease_expires_at))) ||
      (job.status === 'running') !== hasLease) throw new AgentError('RECOVERY_FENCE');
  const hasResultRef = typeof row.result_ref === 'string';
  if (hasResultRef !== (typeof row.result_hash === 'string') || hasResultRef !== (typeof row.result_size === 'number') ||
      (hasResultRef && (safeResultName(job.jobId) !== row.result_ref || !HASH.test(String(row.result_hash)) ||
        !Number.isSafeInteger(row.result_size) || Number(row.result_size) < 0 || Number(row.result_size) > jobMaxResultBytes)) ||
      (job.status === 'completed' && !hasResultRef)) throw new AgentError('RECOVERY_FENCE');
  if (!UUID.test(job.jobId) || !UUID.test(job.creatingSessionId) || !UUID.test(job.gatewayRequestId) || !HASH.test(job.inputHash) ||
      !Number.isInteger(job.progress) || job.progress < 0 || job.progress > 100 || !Number.isInteger(job.attempt) || job.attempt < 0 || job.attempt > 100 ||
      Date.parse(job.updatedAt) < Date.parse(job.createdAt) || Date.parse(job.retainUntil) <= Date.parse(job.createdAt) ||
      (isTerminalJobStatus(job.status) !== !!job.terminalAt)) {
    throw new AgentError('RECOVERY_FENCE');
  }
  return job;
}

function targetFromRow(row: Record<string, unknown>): JobCreateInput['target'] {
  let payload: unknown;
  try { payload = JSON.parse(String(row.input_json)); } catch { throw new AgentError('RECOVERY_FENCE'); }
  if (canonicalizeJson(payload) !== row.input_json || hashCanonicalJson(payload) !== row.input_hash) throw new AgentError('RECOVERY_FENCE');
  const target = Object.freeze({
    operation: row.operation as OperationName,
    kind: row.operation_kind as 'command' | 'query',
    payload: payload as JsonObject,
    ...(typeof row.expected_data_epoch === 'string' ? { expectedVersion: Object.freeze({ dataEpoch: row.expected_data_epoch, dataRevision: Number(row.expected_data_revision) }) } : {}),
    ...(typeof row.workflow_kind === 'string' ? { workflow: Object.freeze({ kind: row.workflow_kind as 'approval' | 'changeset' | 'r4-grant', id: String(row.workflow_id) }) } : {})
  });
  try {
    validateJobCreateInput({ target });
    const descriptor = resolveOperationDescriptor(target.operation);
    if (descriptor.kind !== target.kind || descriptor.domain === 'management' || target.operation.startsWith('jobs.') ||
        (target.kind === 'command') !== !!target.expectedVersion) throw new AgentError('RECOVERY_FENCE');
  } catch { throw new AgentError('RECOVERY_FENCE'); }
  return target;
}

function assertAccess(job: AgentJob, principal: AgentPrincipal, admin: boolean, creatingSessionRequired = false): void {
  if (principal.renderer || admin) return;
  if (job.ownerClientId !== principal.clientId || (creatingSessionRequired && job.creatingSessionId !== principal.sessionId)) throw new AgentError('SCOPE_DENIED');
}

function safeResultName(jobId: string): string {
  if (!UUID.test(jobId)) throw new AgentError('VALIDATION_ERROR', { field: 'jobId' });
  return `${jobId}.result.json`;
}

export class JobStore {
  private readonly executeControlWrite: JobControlWriteExecutor;
  private readonly resultRoot: string;
  private readonly now: () => string;
  private readonly uuid: () => string;
  private readonly maxResultBytes: number;
  private readonly hook?: JobStoreDependencies['hook'];

  constructor(dependencies: JobStoreDependencies) {
    if (!path.isAbsolute(dependencies.resultRoot) || path.normalize(dependencies.resultRoot) !== dependencies.resultRoot) throw new Error('Job result root must be normalized and absolute');
    this.executeControlWrite = dependencies.executeControlWrite;
    this.resultRoot = dependencies.resultRoot;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.uuid = dependencies.randomUUID ?? randomUUID;
    this.maxResultBytes = dependencies.maxResultBytes ?? jobMaxResultBytes;
    if (!Number.isSafeInteger(this.maxResultBytes) || this.maxResultBytes < 1 || this.maxResultBytes > jobMaxResultBytes) throw new Error('Job result limit is invalid');
    this.hook = dependencies.hook;
  }

  createInTransaction(database: Database, scope: DatabaseMutationScope, input: JobCreateInput, principal: AgentPrincipal): DatabaseMutationResult<AgentJob> {
    assertDatabaseMutationScope(scope, database);
    if (!principal.sessionId || principal.renderer) throw new AgentError('SCOPE_DENIED');
    const descriptor = resolveOperationDescriptor(input.target.operation);
    if (descriptor.domain === 'management' || descriptor.kind !== input.target.kind || input.target.operation.startsWith('jobs.')) throw new AgentError('VALIDATION_ERROR', { field: 'target.operation' });
    if (input.target.kind === 'command' && !input.target.expectedVersion) throw new AgentError('VALIDATION_ERROR', { field: 'target.expectedVersion' });
    if (input.target.kind === 'query' && input.target.expectedVersion) throw new AgentError('VALIDATION_ERROR', { field: 'target.expectedVersion' });
    const createdAt = safeTimestamp(this.now());
    const jobId = this.uuid().toLowerCase();
    const gatewayRequestId = this.uuid().toLowerCase();
    const inputJson = canonicalizeJson(input.target.payload);
    const retentionClass = input.retentionClass ?? 'ordinary_7d';
    const defaultRetainUntil = addDays(createdAt, retentionClass === 'protected_30d' ? 30 : 7);
    const requestedRetainUntil = input.ttlMs ? new Date(Date.parse(createdAt) + input.ttlMs).toISOString() : defaultRetainUntil;
    const retainUntil = retentionClass === 'protected_30d' && requestedRetainUntil < defaultRetainUntil ? defaultRetainUntil : requestedRetainUntil;
    database.run(`INSERT INTO agent_jobs (
      job_id, owner_client_id, creating_session_id, operation, operation_kind, catalog_version, catalog_hash,
      input_json, input_hash, expected_data_epoch, expected_data_revision, workflow_kind, workflow_id,
      gateway_request_id, status, progress, attempt, created_at, updated_at, retention_class, retain_until
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 0, ?, ?, ?, ?)`, [
      jobId, principal.clientId, principal.sessionId, input.target.operation, input.target.kind,
      operationCatalogIdentity.version, operationCatalogIdentity.hash, inputJson, hashCanonicalJson(input.target.payload),
      input.target.expectedVersion?.dataEpoch ?? null, input.target.expectedVersion?.dataRevision ?? null,
      input.target.workflow?.kind ?? null, input.target.workflow?.id ?? null, gatewayRequestId,
      createdAt, createdAt, retentionClass, retainUntil
    ]);
    return { changed: true, value: jobFromRow(one(database, 'SELECT * FROM agent_jobs WHERE job_id = ?', [jobId])!) };
  }

  async get(jobId: string, principal: AgentPrincipal): Promise<AgentJob> {
    const result = await this.read(`agent-job-get-${jobId}`, (database) => one(database, 'SELECT * FROM agent_jobs WHERE job_id = ?', [jobId]));
    if (!result) throw new AgentError('HANDLER_NOT_FOUND');
    const job = jobFromRow(result); assertAccess(job, principal, principal.scopes.includes('jobs.admin')); return job;
  }

  async list(input: JobListInput, principal: AgentPrincipal): Promise<JobListResult> {
    const admin = principal.renderer || principal.scopes.includes('jobs.admin');
    const clauses: string[] = [];
    const parameters: SqlParameter[] = [];
    if (!admin) {
      clauses.push('owner_client_id = ?'); parameters.push(principal.clientId);
      if (input.sessionId) {
        if (input.sessionId !== principal.sessionId) throw new AgentError('SCOPE_DENIED');
        clauses.push('creating_session_id = ?'); parameters.push(input.sessionId);
      }
    } else {
      if (input.clientId) { clauses.push('owner_client_id = ?'); parameters.push(input.clientId); }
      if (input.sessionId) { clauses.push('creating_session_id = ?'); parameters.push(input.sessionId); }
    }
    if (input.status) { clauses.push('status = ?'); parameters.push(input.status); }
    if (input.cursor) { clauses.push('job_id > ?'); parameters.push(input.cursor); }
    parameters.push(input.pageSize + 1);
    const rows = await this.read('agent-jobs-list', (database) => all(database, `SELECT * FROM agent_jobs ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY job_id LIMIT ?`, parameters));
    const hasMore = rows.length > input.pageSize;
    const items = Object.freeze(rows.slice(0, input.pageSize).map(jobFromRow));
    return Object.freeze({ items, pageSize: input.pageSize, hasMore, ...(hasMore ? { nextCursor: items.at(-1)!.jobId } : {}) });
  }

  cancelInTransaction(database: Database, scope: DatabaseMutationScope, jobId: string, principal: AgentPrincipal): DatabaseMutationResult<AgentJob> {
    assertDatabaseMutationScope(scope, database);
    const row = one(database, 'SELECT * FROM agent_jobs WHERE job_id = ?', [jobId]);
    if (!row) throw new AgentError('HANDLER_NOT_FOUND');
    const job = jobFromRow(row); assertAccess(job, principal, principal.scopes.includes('jobs.admin'), true);
    if (isTerminalJobStatus(job.status)) throw new AgentError('VALIDATION_ERROR', { field: 'jobId' });
    const timestamp = safeTimestamp(this.now());
    if (job.status === 'queued' || job.status === 'waiting_approval' || (job.status === 'running' && job.progress < 25)) {
      database.run(`UPDATE agent_jobs SET status = 'cancelled', progress = 100, cancellation_requested_at = ?, lease_token = NULL,
        lease_expires_at = NULL, updated_at = ?, terminal_at = ? WHERE job_id = ?`, [timestamp, timestamp, timestamp, jobId]);
    } else {
      database.run('UPDATE agent_jobs SET cancellation_requested_at = COALESCE(cancellation_requested_at, ?), updated_at = ? WHERE job_id = ?', [timestamp, timestamp, jobId]);
    }
    return { changed: true, value: jobFromRow(one(database, 'SELECT * FROM agent_jobs WHERE job_id = ?', [jobId])!) };
  }

  async result(jobId: string, principal: AgentPrincipal): Promise<JobResultRecord> {
    const row = await this.read(`agent-job-result-${jobId}`, (database) => one(database, 'SELECT * FROM agent_jobs WHERE job_id = ?', [jobId]));
    if (!row) throw new AgentError('HANDLER_NOT_FOUND');
    const job = jobFromRow(row); assertAccess(job, principal, principal.scopes.includes('jobs.admin'));
    if (job.status === 'failed' && row.result_ref === null) {
      const result = Object.freeze({ kind: 'rejected' as const, error: job.error ?? serializeAgentError(new Error('Job execution failed')) }) as unknown as JsonObject;
      const bytes = Buffer.from(canonicalizeJson(result), 'utf8');
      return Object.freeze({ job, result, resultHash: `sha256-v1:${createHash('sha256').update(bytes).digest('hex')}`, resultSize: bytes.byteLength });
    }
    if (!isTerminalJobStatus(job.status) || typeof row.result_ref !== 'string' || typeof row.result_hash !== 'string' || typeof row.result_size !== 'number') throw new AgentError('HANDLER_NOT_FOUND');
    const result = await this.readVerifiedResult(row.result_ref, row.result_hash, row.result_size);
    return Object.freeze({ job, result, resultHash: row.result_hash, resultSize: row.result_size });
  }

  async leaseNext(): Promise<JobLease | null> {
    const leaseToken = this.uuid().toLowerCase();
    const timestamp = safeTimestamp(this.now());
    const expiresAt = new Date(Date.parse(timestamp) + 15 * 60_000).toISOString();
    const result = await this.executeControlWrite<JobLease | null>({ requestId: `agent-job-lease-${leaseToken}`, execute: (database, scope) => {
      assertDatabaseMutationScope(scope, database);
      let changed = false;
      while (true) {
        const row = one(database, `SELECT j.*, c.subject_id, c.display_name, c.trust, c.revoked_at, c.credential_fingerprint AS client_credential_fingerprint,
          s.client_id AS session_client_id, s.credential_fingerprint, s.expires_at AS session_expires_at, s.terminated_at
          FROM agent_jobs j LEFT JOIN agent_sessions s ON s.session_id = j.creating_session_id
          LEFT JOIN agent_clients c ON c.client_id = j.owner_client_id
          WHERE j.status = 'queued' ORDER BY j.created_at, j.job_id LIMIT 1`);
        if (!row) return { changed, value: null };
        const queuedJob = jobFromRow(row);
        const invalidOwner = typeof row.subject_id !== 'string' || typeof row.display_name !== 'string' ||
          !HASH.test(String(row.client_credential_fingerprint)) || row.revoked_at !== null;
        const invalidSession = row.session_client_id !== queuedJob.ownerClientId ||
          !HASH.test(String(row.credential_fingerprint)) || row.credential_fingerprint !== row.client_credential_fingerprint;
        if (invalidOwner || invalidSession) {
          const denied = serializeAgentError(new AgentError('CLIENT_REVOKED'));
          database.run(`UPDATE agent_jobs SET status = 'failed', progress = 100, error_code = ?, error_message = ?, updated_at = ?, terminal_at = ?
            WHERE job_id = ? AND status = 'queued'`, [denied.code, denied.message, timestamp, timestamp, queuedJob.jobId]);
          changed = database.getRowsModified() === 1 || changed;
          continue;
        }
        const scopes = all(database, 'SELECT scope FROM agent_client_scopes WHERE client_id = ? ORDER BY scope', [queuedJob.ownerClientId]).map((entry) => entry.scope as AgentScope);
        if (scopes.some((scope) => !(agentScopes as readonly string[]).includes(scope)) || !(trustProfiles as readonly unknown[]).includes(row.trust)) throw new AgentError('RECOVERY_FENCE');
        database.run(`UPDATE agent_jobs SET status = 'running', progress = 5, lease_token = ?, lease_expires_at = ?, attempt = attempt + 1,
          started_at = COALESCE(started_at, ?), updated_at = ? WHERE job_id = ? AND status = 'queued'`, [leaseToken, expiresAt, timestamp, timestamp, queuedJob.jobId]);
        if (database.getRowsModified() !== 1) continue;
        const leasedRow = one(database, 'SELECT * FROM agent_jobs WHERE job_id = ?', [queuedJob.jobId])!;
        return { changed: true, value: Object.freeze({ job: jobFromRow(leasedRow), leaseToken, target: targetFromRow(leasedRow),
          principalClaims: Object.freeze({ apiVersion: agentApiVersion, kind: 'agent-principal' as const, clientId: queuedJob.ownerClientId,
            subjectId: String(row.subject_id), displayName: String(row.display_name), scopes: Object.freeze(scopes), trust: row.trust as TrustProfile,
            credentialBinding: String(row.credential_fingerprint), sessionId: queuedJob.creatingSessionId, authenticatedAt: timestamp, renderer: false }) }) };
      }
    }});
    return result.value;
  }

  async hasQueued(): Promise<boolean> {
    return this.read('agent-job-queued-check', (database) => one(database, "SELECT job_id FROM agent_jobs WHERE status = 'queued' LIMIT 1") !== undefined);
  }

  async findWaitingWorkflow(kind: 'approval' | 'changeset', workflowId: string): Promise<WaitingWorkflowJob | undefined> {
    return this.read(`agent-job-waiting-workflow-${kind}-${workflowId}`, (database) => {
      const rows = all(database, `SELECT job_id, owner_client_id FROM agent_jobs
        WHERE status = 'waiting_approval' AND workflow_kind = ? AND workflow_id = ?
        ORDER BY job_id LIMIT 2`, [kind, workflowId]);
      if (rows.length > 1) throw new AgentError('RECOVERY_FENCE');
      return rows[0]
        ? Object.freeze({ jobId: String(rows[0].job_id), ownerClientId: String(rows[0].owner_client_id) })
        : undefined;
    });
  }

  resolveWaitingWorkflowInTransaction(
    database: Database,
    scope: DatabaseMutationScope,
    kind: 'approval' | 'changeset',
    workflowId: string,
    decision: 'approved' | 'rejected'
  ): DatabaseMutationResult<AgentJob | undefined> {
    assertDatabaseMutationScope(scope, database);
    const rows = all(database, `SELECT * FROM agent_jobs WHERE status = 'waiting_approval'
      AND workflow_kind = ? AND workflow_id = ? ORDER BY job_id LIMIT 2`, [kind, workflowId]);
    if (rows.length > 1) throw new AgentError('RECOVERY_FENCE');
    const row = rows[0];
    if (!row) return { changed: false, value: undefined };
    const job = jobFromRow(row);
    const workflowRow = this.assertWaitingWorkflowBinding(database, row, kind, workflowId);
    if (workflowRow.status !== decision) throw new AgentError('RECOVERY_FENCE');
    const timestamp = safeTimestamp(this.now());
    if (decision === 'approved') {
      database.run(`UPDATE agent_jobs SET status = 'queued', progress = 0, updated_at = ?
        WHERE job_id = ? AND status = 'waiting_approval'`, [timestamp, job.jobId]);
    } else {
      const denied = serializeAgentError(new AgentError('APPROVAL_INVALID'));
      database.run(`UPDATE agent_jobs SET status = 'failed', progress = 100, error_code = ?, error_message = ?,
        updated_at = ?, terminal_at = ? WHERE job_id = ? AND status = 'waiting_approval'`,
      [denied.code, denied.message, timestamp, timestamp, job.jobId]);
    }
    if (database.getRowsModified() !== 1) throw new AgentError('RECOVERY_FENCE');
    return { changed: true, value: jobFromRow(one(database, 'SELECT * FROM agent_jobs WHERE job_id = ?', [job.jobId])!) };
  }

  async beginDispatch(jobId: string, leaseToken: string): Promise<boolean> {
    const timestamp = safeTimestamp(this.now());
    const result = await this.executeControlWrite<boolean>({ requestId: `agent-job-dispatch-${jobId}`, execute: (database) => {
      const row = one(database, 'SELECT * FROM agent_jobs WHERE job_id = ? AND status = \'running\' AND lease_token = ?', [jobId, leaseToken]);
      if (!row) return { changed: false, value: false };
      if (row.cancellation_requested_at !== null) {
        database.run(`UPDATE agent_jobs SET status = 'cancelled', progress = 100, lease_token = NULL, lease_expires_at = NULL,
          updated_at = ?, terminal_at = ? WHERE job_id = ?`, [timestamp, timestamp, jobId]);
        return { changed: true, value: false };
      }
      database.run('UPDATE agent_jobs SET progress = 25, updated_at = ? WHERE job_id = ?', [timestamp, jobId]);
      return { changed: true, value: true };
    }});
    return result.value;
  }

  async requeueAtSafeCheckpoint(jobId: string, leaseToken: string): Promise<void> {
    await this.executeControlWrite({ requestId: `agent-job-requeue-${jobId}`, execute: (database) => {
      database.run(`UPDATE agent_jobs SET status = 'queued', progress = 0, lease_token = NULL, lease_expires_at = NULL,
        updated_at = ? WHERE job_id = ? AND status = 'running' AND lease_token = ?`, [safeTimestamp(this.now()), jobId, leaseToken]);
      if (database.getRowsModified() !== 1) throw new AgentError('RECOVERY_FENCE');
      return { changed: true, value: undefined };
    }});
  }

  async bindEvidence(jobId: string, leaseToken: string, receiptId?: string, operationJournalId?: string): Promise<void> {
    if (!receiptId && !operationJournalId) return;
    await this.executeControlWrite({ requestId: `agent-job-evidence-${jobId}`, execute: (database) => {
      const row = one(database, 'SELECT receipt_id, operation_journal_id FROM agent_jobs WHERE job_id = ? AND status = \'running\' AND lease_token = ?', [jobId, leaseToken]);
      if (!row) return { changed: false, value: undefined };
      if ((row.receipt_id && row.receipt_id !== receiptId) || (row.operation_journal_id && row.operation_journal_id !== operationJournalId)) throw new AgentError('RECOVERY_FENCE');
      database.run('UPDATE agent_jobs SET receipt_id = COALESCE(receipt_id, ?), operation_journal_id = COALESCE(operation_journal_id, ?), updated_at = ? WHERE job_id = ?', [receiptId ?? null, operationJournalId ?? null, safeTimestamp(this.now()), jobId]);
      return { changed: true, value: undefined };
    }});
  }

  async terminalize(jobId: string, leaseToken: string, status: 'completed' | 'failed' | 'interrupted', outcome?: AgentExecuteOutcome | AgentQueryOutcome | JsonObject, error?: unknown): Promise<AgentJob> {
    const prepared = outcome ? this.prepareResult(jobId, outcome as unknown as JsonObject) : undefined;
    if (prepared) await this.bindResult(jobId, prepared, leaseToken);
    const published = prepared ? await this.publishResult(jobId, prepared) : undefined;
    await this.hook?.('before_terminal_write', jobId);
    const timestamp = safeTimestamp(this.now());
    const serialized = error ? serializeAgentError(error) : undefined;
    const result = await this.executeControlWrite<AgentJob>({ requestId: `agent-job-terminal-${jobId}`, execute: (database) => {
      const row = one(database, 'SELECT * FROM agent_jobs WHERE job_id = ? AND status = \'running\' AND lease_token = ?', [jobId, leaseToken]);
      if (!row) {
        const current = one(database, 'SELECT * FROM agent_jobs WHERE job_id = ?', [jobId]);
        if (current && terminalStatuses.has(current.status as JobStatus)) return { changed: false, value: jobFromRow(current) };
        throw new AgentError('RECOVERY_FENCE');
      }
      database.run(`UPDATE agent_jobs SET status = ?, progress = 100, result_ref = ?, result_hash = ?, result_size = ?, error_code = ?, error_message = ?,
        lease_token = NULL, lease_expires_at = NULL, updated_at = ?, terminal_at = ? WHERE job_id = ?`, [status,
        published?.ref ?? null, published?.hash ?? null, published?.size ?? null, serialized?.code ?? null, serialized?.message ?? null,
        timestamp, timestamp, jobId]);
      return { changed: true, value: jobFromRow(one(database, 'SELECT * FROM agent_jobs WHERE job_id = ?', [jobId])!) };
    }});
    return result.value;
  }

  async waitForApproval(jobId: string, leaseToken: string, outcome: Extract<AgentExecuteOutcome, { kind: 'pending_approval' | 'pending_changeset' }>): Promise<AgentJob> {
    const timestamp = safeTimestamp(this.now());
    const result = await this.executeControlWrite<AgentJob>({ requestId: `agent-job-wait-${jobId}`, execute: (database) => {
      database.run(`UPDATE agent_jobs SET status = 'waiting_approval', progress = 50, workflow_kind = ?, workflow_id = ?, lease_token = NULL,
        lease_expires_at = NULL, updated_at = ? WHERE job_id = ? AND status = 'running' AND lease_token = ?`, [outcome.workflow.kind, outcome.workflow.id, timestamp, jobId, leaseToken]);
      if (database.getRowsModified() !== 1) throw new AgentError('RECOVERY_FENCE');
      return { changed: true, value: jobFromRow(one(database, 'SELECT * FROM agent_jobs WHERE job_id = ?', [jobId])!) };
    }});
    return result.value;
  }

  async recoveryCandidates(): Promise<readonly JobRecoveryCandidate[]> {
    return this.read('agent-job-recovery-scan', (database) => Object.freeze(all(database, `SELECT * FROM agent_jobs WHERE status = 'running' ORDER BY created_at, job_id`).map((row) => Object.freeze({
      job: jobFromRow(row), target: targetFromRow(row),
      ...(typeof row.result_ref === 'string' ? { resultRef: row.result_ref, resultHash: String(row.result_hash), resultSize: Number(row.result_size) } : {})
    }))));
  }

  async reconcileOrphanResults(): Promise<number> {
    await this.assertSafeResultRoot(true);
    const references = new Set(await this.read('agent-job-result-reference-scan', (database) =>
      all(database, 'SELECT result_ref FROM agent_jobs WHERE result_ref IS NOT NULL').map((row) => String(row.result_ref))));
    let removed = 0;
    for (const entry of await fs.promises.readdir(this.resultRoot, { withFileTypes: true })) {
      const isResult = /^([0-9a-f-]{36})\.result\.json$/i.test(entry.name);
      const isTemporary = /^\.([0-9a-f-]{36})\.[0-9a-f]{32}\.tmp$/i.test(entry.name);
      if (!isResult && !isTemporary) continue;
      if (entry.isSymbolicLink() || !entry.isFile()) throw new AgentError('RECOVERY_FENCE');
      if (isTemporary || !references.has(entry.name)) {
        if (isResult) {
          await this.unlinkSafeFile(entry.name);
        } else {
          const target = path.join(this.resultRoot, entry.name);
          const realTarget = await fs.promises.realpath(target);
          if (path.dirname(realTarget).toLowerCase() !== this.resultRoot.toLowerCase()) throw new AgentError('RECOVERY_FENCE');
          await fs.promises.unlink(target);
        }
        removed += 1;
      }
    }
    return removed;
  }

  async reconcileWaitingWorkflows(): Promise<number> {
    const timestamp = safeTimestamp(this.now());
    const result = await this.executeControlWrite<number>({ requestId: 'agent-job-waiting-workflow-reconcile', execute: (database, scope) => {
      const rows = all(database, `SELECT * FROM agent_jobs WHERE status = 'waiting_approval' ORDER BY created_at, job_id`);
      let changed = 0;
      for (const row of rows) {
        const job = jobFromRow(row);
        const kind = String(row.workflow_kind);
        if (kind !== 'approval' && kind !== 'changeset') throw new AgentError('RECOVERY_FENCE');
        const workflow = this.assertWaitingWorkflowBinding(database, row, kind, String(row.workflow_id));
        const status = workflow.status;
        const expiresAt = workflow.expires_at;
        if (typeof status !== 'string' || typeof expiresAt !== 'string') throw new AgentError('RECOVERY_FENCE');
        const expired = persistedTimestamp(expiresAt) <= timestamp;
        if (status === 'approved') {
          this.resolveWaitingWorkflowInTransaction(database, scope, kind, String(row.workflow_id), 'approved');
          changed += 1;
        } else if (status === 'rejected' || status === 'expired' || expired) {
          const denied = serializeAgentError(new AgentError('APPROVAL_INVALID'));
          database.run(`UPDATE agent_jobs SET status = 'failed', progress = 100, error_code = ?, error_message = ?,
            updated_at = ?, terminal_at = ? WHERE job_id = ? AND status = 'waiting_approval'`,
          [denied.code, denied.message, timestamp, timestamp, job.jobId]);
          if (database.getRowsModified() !== 1) throw new AgentError('RECOVERY_FENCE');
          changed += 1;
        } else if (!((kind === 'approval' && status === 'pending') || (kind === 'changeset' && ['draft', 'waiting_approval'].includes(status)))) {
          throw new AgentError('RECOVERY_FENCE');
        }
      }
      return { changed: changed > 0, value: changed };
    }});
    return result.value;
  }

  async recoverTerminal(candidate: JobRecoveryCandidate, status: 'completed' | 'failed' | 'interrupted', outcome?: JsonObject, error?: unknown, receiptId?: string, operationJournalId?: string): Promise<AgentJob> {
    const prepared = outcome && !candidate.resultRef ? this.prepareResult(candidate.job.jobId, outcome) : undefined;
    if (prepared) await this.bindResult(candidate.job.jobId, prepared);
    const published = prepared ? await this.publishResult(candidate.job.jobId, prepared) : undefined;
    if (candidate.resultRef && status !== 'interrupted') await this.readVerifiedResult(candidate.resultRef, candidate.resultHash!, candidate.resultSize!);
    const timestamp = safeTimestamp(this.now());
    const serialized = error ? serializeAgentError(error) : undefined;
    const result = await this.executeControlWrite<AgentJob>({ requestId: `agent-job-recover-${candidate.job.jobId}`, execute: (database) => {
      database.run(`UPDATE agent_jobs SET status = ?, progress = 100, receipt_id = COALESCE(receipt_id, ?), operation_journal_id = COALESCE(operation_journal_id, ?),
        result_ref = ?, result_hash = ?, result_size = ?, error_code = ?, error_message = ?,
        lease_token = NULL, lease_expires_at = NULL, updated_at = ?, terminal_at = ? WHERE job_id = ? AND status = 'running'`, [status,
        receiptId ?? null, operationJournalId ?? null,
        status === 'interrupted' ? null : candidate.resultRef ?? published?.ref ?? null,
        status === 'interrupted' ? null : candidate.resultHash ?? published?.hash ?? null,
        status === 'interrupted' ? null : candidate.resultSize ?? published?.size ?? null,
        serialized?.code ?? null, serialized?.message ?? null, timestamp, timestamp, candidate.job.jobId]);
      if (database.getRowsModified() !== 1) throw new AgentError('RECOVERY_FENCE');
      return { changed: true, value: jobFromRow(one(database, 'SELECT * FROM agent_jobs WHERE job_id = ?', [candidate.job.jobId])!) };
    }});
    return result.value;
  }

  async verifyBoundResult(candidate: JobRecoveryCandidate): Promise<boolean> {
    if (!candidate.resultRef || !candidate.resultHash || candidate.resultSize === undefined) return false;
    try {
      await this.readVerifiedResult(candidate.resultRef, candidate.resultHash, candidate.resultSize);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async purgeExpired(): Promise<number> {
    const timestamp = safeTimestamp(this.now());
    const result = await this.executeControlWrite<{ readonly count: number; readonly rows: readonly Record<string, unknown>[] }>({ requestId: 'agent-job-retention-delete', execute: (database) => {
      const rows = all(database, `SELECT job_id, result_ref FROM agent_jobs
        WHERE status IN ('completed', 'failed', 'cancelled', 'interrupted') AND retain_until <= ? ORDER BY retain_until, job_id LIMIT 100`, [timestamp]);
      if (rows.length === 0) return { changed: false, value: Object.freeze({ count: 0, rows: Object.freeze([]) }) };
      const jobIds = rows.map((row) => String(row.job_id));
      database.run(`DELETE FROM agent_jobs WHERE job_id IN (${jobIds.map(() => '?').join(', ')})`, jobIds);
      return { changed: true, value: Object.freeze({ count: database.getRowsModified(), rows: Object.freeze(rows) }) };
    }});
    for (const row of result.value.rows) {
      if (typeof row.result_ref !== 'string') continue;
      await this.hook?.('before_result_unlink', String(row.job_id));
      await this.unlinkSafeFile(row.result_ref);
    }
    return result.value.count;
  }

  private async read<T>(requestId: string, execute: (database: Database) => T): Promise<T> {
    return (await this.executeControlWrite({ requestId, execute: (database) => ({ changed: false, value: execute(database) }) })).value;
  }

  private assertWaitingWorkflowBinding(
    database: Database,
    jobRow: Record<string, unknown>,
    kind: 'approval' | 'changeset',
    workflowId: string
  ): Record<string, unknown> {
    const workflow = kind === 'approval'
      ? one(database, 'SELECT * FROM agent_approvals WHERE approval_id = ?', [workflowId])
      : one(database, 'SELECT * FROM agent_changesets WHERE change_set_id = ?', [workflowId]);
    if (!workflow || workflow.client_id !== jobRow.owner_client_id || workflow.catalog_version !== operationCatalogIdentity.version ||
        workflow.catalog_hash !== operationCatalogIdentity.hash || workflow.base_data_epoch !== jobRow.expected_data_epoch ||
        workflow.base_data_revision !== jobRow.expected_data_revision) throw new AgentError('RECOVERY_FENCE');
    if (kind === 'approval') {
      if (workflow.operation !== jobRow.operation || workflow.payload_hash !== jobRow.input_hash) throw new AgentError('RECOVERY_FENCE');
    } else {
      const operations = all(database, `SELECT operation, payload_hash FROM agent_changeset_operations
        WHERE change_set_id = ? ORDER BY operation_index`, [workflowId]);
      if (operations.length !== 1 || operations[0].operation !== jobRow.operation || operations[0].payload_hash !== jobRow.input_hash) {
        throw new AgentError('RECOVERY_FENCE');
      }
    }
    return workflow;
  }

  private resultPath(reference: string): string {
    if (path.basename(reference) !== reference || !/^([0-9a-f-]{36})\.result\.json$/i.test(reference)) throw new AgentError('RECOVERY_FENCE');
    const target = path.join(this.resultRoot, reference);
    if (path.dirname(target) !== this.resultRoot) throw new AgentError('RECOVERY_FENCE');
    return target;
  }

  private async assertSafeResultRoot(create: boolean): Promise<void> {
    const parsed = path.parse(this.resultRoot);
    const relativeParts = this.resultRoot.slice(parsed.root.length).split(path.sep).filter(Boolean);
    let current = parsed.root;
    for (const part of relativeParts) {
      current = path.join(current, part);
      try {
        const stat = await fs.promises.lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AgentError('RECOVERY_FENCE');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (!create) throw error;
        break;
      }
    }
    if (create) await fs.promises.mkdir(this.resultRoot, { recursive: true });
    const rootStat = await fs.promises.lstat(this.resultRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new AgentError('RECOVERY_FENCE');
    const realRoot = await fs.promises.realpath(this.resultRoot);
    if (path.resolve(realRoot).toLowerCase() !== path.resolve(this.resultRoot).toLowerCase()) throw new AgentError('RECOVERY_FENCE');
  }

  private async readSafeFile(reference: string): Promise<Buffer> {
    await this.assertSafeResultRoot(false);
    const target = this.resultPath(reference);
    const pathStat = await fs.promises.lstat(target);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) throw new AgentError('RECOVERY_FENCE');
    const realTarget = await fs.promises.realpath(target);
    if (path.dirname(realTarget).toLowerCase() !== this.resultRoot.toLowerCase()) throw new AgentError('RECOVERY_FENCE');
    const handle = await fs.promises.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const openStat = await handle.stat();
      if (!openStat.isFile() || openStat.dev !== pathStat.dev || openStat.ino !== pathStat.ino) throw new AgentError('RECOVERY_FENCE');
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  private async unlinkSafeFile(reference: string): Promise<void> {
    await this.assertSafeResultRoot(false);
    const target = this.resultPath(reference);
    try {
      const stat = await fs.promises.lstat(target);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new AgentError('RECOVERY_FENCE');
      const realTarget = await fs.promises.realpath(target);
      if (path.dirname(realTarget).toLowerCase() !== this.resultRoot.toLowerCase()) throw new AgentError('RECOVERY_FENCE');
      await fs.promises.unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private prepareResult(jobId: string, value: JsonObject): PreparedJobResult {
    const bytes = Buffer.from(canonicalizeJson(value), 'utf8');
    if (bytes.byteLength > this.maxResultBytes) throw new AgentError('VALIDATION_ERROR', { field: 'result' });
    const ref = safeResultName(jobId);
    return Object.freeze({ bytes, ref, hash: `sha256-v1:${createHash('sha256').update(bytes).digest('hex')}`, size: bytes.byteLength });
  }

  private async bindResult(jobId: string, prepared: PreparedJobResult, leaseToken?: string): Promise<void> {
    await this.executeControlWrite({ requestId: `agent-job-result-bind-${jobId}`, execute: (database) => {
      const row = one(database, `SELECT result_ref, result_hash, result_size FROM agent_jobs WHERE job_id = ? AND status = 'running'${leaseToken ? ' AND lease_token = ?' : ''}`,
        leaseToken ? [jobId, leaseToken] : [jobId]);
      if (!row) throw new AgentError('RECOVERY_FENCE');
      if ((row.result_ref !== null && row.result_ref !== prepared.ref) || (row.result_hash !== null && row.result_hash !== prepared.hash) ||
          (row.result_size !== null && row.result_size !== prepared.size)) throw new AgentError('RECOVERY_FENCE');
      database.run('UPDATE agent_jobs SET result_ref = ?, result_hash = ?, result_size = ?, updated_at = ? WHERE job_id = ?',
        [prepared.ref, prepared.hash, prepared.size, safeTimestamp(this.now()), jobId]);
      return { changed: database.getRowsModified() === 1, value: undefined };
    }});
    await this.hook?.('after_result_binding', jobId);
  }

  private async publishResult(jobId: string, prepared: PreparedJobResult): Promise<{ readonly ref: string; readonly hash: string; readonly size: number }> {
    const { bytes, ref, hash, size } = prepared;
    const target = this.resultPath(ref);
    await this.assertSafeResultRoot(true);
    try {
      const existing = await this.readSafeFile(ref);
      if (existing.equals(bytes)) return Object.freeze({ ref, hash, size });
      throw new AgentError('RECOVERY_FENCE');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const temporary = path.join(this.resultRoot, `.${jobId}.${this.uuid().replaceAll('-', '')}.tmp`);
    await this.hook?.('before_result_temp', jobId);
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(temporary, 'wx');
      await handle.writeFile(bytes); await this.hook?.('after_result_write', jobId);
      await handle.sync(); await this.hook?.('after_result_flush', jobId);
      await handle.close(); handle = undefined;
      await this.assertSafeResultRoot(false);
      const temporaryStat = await fs.promises.lstat(temporary);
      if (temporaryStat.isSymbolicLink() || !temporaryStat.isFile()) throw new AgentError('RECOVERY_FENCE');
      try {
        const targetStat = await fs.promises.lstat(target);
        if (targetStat.isSymbolicLink()) throw new AgentError('RECOVERY_FENCE');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await fs.promises.rename(temporary, target); await this.hook?.('after_result_rename', jobId);
      await this.assertSafeResultRoot(false);
      const flushed = await flushDirectory(this.resultRoot, defaultDirectoryDurabilityDependencies);
      if (flushed.status === 'failed') throw flushed.error;
      await this.hook?.('after_result_directory_flush', jobId);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.promises.unlink(temporary).catch(() => undefined);
      throw error;
    }
    return Object.freeze({ ref, hash, size });
  }

  private async readVerifiedResult(reference: string, expectedHash: string, expectedSize: number): Promise<JsonObject> {
    if (!HASH.test(expectedHash) || !Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > this.maxResultBytes) throw new AgentError('RECOVERY_FENCE');
    const bytes = await this.readSafeFile(reference);
    const hash = `sha256-v1:${createHash('sha256').update(bytes).digest('hex')}`;
    if (bytes.byteLength !== expectedSize || hash !== expectedHash) throw new AgentError('RECOVERY_FENCE');
    let value: unknown;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new AgentError('RECOVERY_FENCE'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || canonicalizeJson(value) !== bytes.toString('utf8')) throw new AgentError('RECOVERY_FENCE');
    return value as JsonObject;
  }
}

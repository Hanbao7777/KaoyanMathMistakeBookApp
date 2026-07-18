import { AgentError, type SerializedAgentError } from '../errors';
import type { AgentApiVersion } from '../versions';
import type { DataVersion } from './contracts';
import type { CatalogIdentity, JsonObject, OperationName, WorkflowReference } from './gatewayContracts';

export const jobStatuses = Object.freeze(['queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'interrupted'] as const);
export type JobStatus = (typeof jobStatuses)[number];
export const terminalJobStatuses = Object.freeze(['completed', 'failed', 'cancelled', 'interrupted'] as const);
export type TerminalJobStatus = (typeof terminalJobStatuses)[number];
export const jobRetentionClasses = Object.freeze(['ordinary_7d', 'protected_30d'] as const);
export type JobRetentionClass = (typeof jobRetentionClasses)[number];
export const jobMaxPageSize = 100;
export const jobMaxResultBytes = 1024 * 1024;
export const jobMaxTtlMs = 30 * 24 * 60 * 60 * 1000;
export const jobPollIntervalMs = 1_000;

export interface JobTarget {
  readonly operation: OperationName;
  readonly kind: 'command' | 'query';
  readonly payload: JsonObject;
  readonly expectedVersion?: DataVersion;
  readonly workflow?: WorkflowReference;
}

export interface JobCreateInput {
  readonly target: JobTarget;
  readonly retentionClass?: JobRetentionClass;
  readonly ttlMs?: number;
}

export interface JobGetInput { readonly jobId: string }
export interface JobCancelInput { readonly jobId: string }
export interface JobResultInput { readonly jobId: string }
export interface JobListInput {
  readonly clientId?: string;
  readonly sessionId?: string;
  readonly status?: JobStatus;
  readonly cursor?: string;
  readonly pageSize: number;
}

export interface AgentJob {
  readonly apiVersion: AgentApiVersion;
  readonly jobId: string;
  readonly ownerClientId: string;
  readonly creatingSessionId: string;
  readonly operation: OperationName;
  readonly operationKind: 'command' | 'query';
  readonly catalog: CatalogIdentity;
  readonly inputHash: string;
  readonly gatewayRequestId: string;
  readonly receiptId?: string;
  readonly operationJournalId?: string;
  readonly status: JobStatus;
  readonly progress: number;
  readonly error?: SerializedAgentError;
  readonly cancellationRequestedAt?: string;
  readonly attempt: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly terminalAt?: string;
  readonly retentionClass: JobRetentionClass;
  readonly retainUntil: string;
}

export interface JobListResult {
  readonly items: readonly AgentJob[];
  readonly nextCursor?: string;
  readonly pageSize: number;
  readonly hasMore: boolean;
}

export interface JobResultRecord {
  readonly job: AgentJob;
  readonly result: JsonObject;
  readonly resultHash: string;
  readonly resultSize: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE = /^[A-Za-z0-9._:-]{1,200}$/;

function fail(field: string): never { throw new AgentError('VALIDATION_ERROR', { field }); }
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field);
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: readonly string[], required: readonly string[], field: string): Record<string, unknown> {
  const result = object(value, field);
  for (const key of Object.keys(result)) if (!keys.includes(key)) fail(`${field}.${key}`);
  for (const key of required) if (!Object.hasOwn(result, key)) fail(`${field}.${key}`);
  return result;
}
function uuid(value: unknown, field: string): asserts value is string { if (typeof value !== 'string' || !UUID.test(value)) fail(field); }
function safe(value: unknown, field: string): asserts value is string { if (typeof value !== 'string' || !SAFE.test(value)) fail(field); }

export function validateJobCreateInput(value: unknown, field = 'payload'): asserts value is JobCreateInput {
  const input = exact(value, ['target', 'retentionClass', 'ttlMs'], ['target'], field);
  const target = exact(input.target, ['operation', 'kind', 'payload', 'expectedVersion', 'workflow'], ['operation', 'kind', 'payload'], `${field}.target`);
  safe(target.operation, `${field}.target.operation`);
  if (target.kind !== 'command' && target.kind !== 'query') fail(`${field}.target.kind`);
  object(target.payload, `${field}.target.payload`);
  if (target.expectedVersion !== undefined) {
    const version = exact(target.expectedVersion, ['dataEpoch', 'dataRevision'], ['dataEpoch', 'dataRevision'], `${field}.target.expectedVersion`);
    safe(version.dataEpoch, `${field}.target.expectedVersion.dataEpoch`);
    if (!Number.isSafeInteger(version.dataRevision) || (version.dataRevision as number) < 0) fail(`${field}.target.expectedVersion.dataRevision`);
  }
  if (target.workflow !== undefined) {
    const workflow = exact(target.workflow, ['kind', 'id'], ['kind', 'id'], `${field}.target.workflow`);
    if (!['approval', 'changeset', 'r4-grant'].includes(String(workflow.kind))) fail(`${field}.target.workflow.kind`);
    uuid(workflow.id, `${field}.target.workflow.id`);
  }
  if (input.retentionClass !== undefined && !(jobRetentionClasses as readonly unknown[]).includes(input.retentionClass)) fail(`${field}.retentionClass`);
  if (input.ttlMs !== undefined && (!Number.isSafeInteger(input.ttlMs) || (input.ttlMs as number) < 1_000 || (input.ttlMs as number) > jobMaxTtlMs)) fail(`${field}.ttlMs`);
}

export function validateJobGetInput(value: unknown, field = 'payload'): asserts value is JobGetInput {
  const input = exact(value, ['jobId'], ['jobId'], field); uuid(input.jobId, `${field}.jobId`);
}
export function validateJobCancelInput(value: unknown, field = 'payload'): asserts value is JobCancelInput {
  validateJobGetInput(value, field);
}

export function validateJobResultInput(value: unknown, field = 'payload'): asserts value is JobResultInput {
  validateJobGetInput(value, field);
}

export function validateJobListInput(value: unknown, field = 'payload'): asserts value is JobListInput {
  const input = exact(value, ['clientId', 'sessionId', 'status', 'cursor', 'pageSize'], ['pageSize'], field);
  if (input.clientId !== undefined) safe(input.clientId, `${field}.clientId`);
  if (input.sessionId !== undefined) uuid(input.sessionId, `${field}.sessionId`);
  if (input.status !== undefined && !(jobStatuses as readonly unknown[]).includes(input.status)) fail(`${field}.status`);
  if (input.cursor !== undefined) uuid(input.cursor, `${field}.cursor`);
  if (!Number.isSafeInteger(input.pageSize) || (input.pageSize as number) < 1 || (input.pageSize as number) > jobMaxPageSize) fail(`${field}.pageSize`);
}

export function isTerminalJobStatus(status: JobStatus): status is TerminalJobStatus {
  return (terminalJobStatuses as readonly string[]).includes(status);
}

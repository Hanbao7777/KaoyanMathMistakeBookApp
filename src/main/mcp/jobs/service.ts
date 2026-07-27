import { randomUUID } from 'node:crypto';
import { AgentError } from '../../../shared/agent/errors';
import type { AgentGateway, AgentPrincipal, JsonObject, OperationName } from '../../../shared/agent/v1/gatewayContracts';
import type { AgentJob, JobListResult, JobResultRecord } from '../../../shared/agent/v1/jobs';
import { jobMaxTtlMs } from '../../../shared/agent/v1/jobs';
import { operationCatalogIdentity } from '../../../shared/agent/v1/operationCatalog';
import type { McpRegistryDescriptor } from '../../../shared/mcp/v1/contracts';
import { mapMcpGatewayResult } from '../resultMapping';
import { projectJobTask } from './projection';

export interface McpJobServiceOptions {
  readonly gateway: AgentGateway;
  readonly randomUUID?: () => string;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

function value(outcome: Awaited<ReturnType<AgentGateway['query']>>): unknown {
  if (outcome.kind !== 'completed') throw new AgentError('HANDLER_NOT_FOUND');
  return outcome.result.value;
}

function commandValue(outcome: Awaited<ReturnType<AgentGateway['execute']>>): unknown {
  if (outcome.kind !== 'completed' && outcome.kind !== 'replayed') throw new AgentError('HANDLER_NOT_FOUND');
  return outcome.result.value;
}

function assertTaskOwner(job: AgentJob, principal: AgentPrincipal): void {
  if (principal.renderer || principal.scopes.includes('jobs.admin')) return;
  if (!principal.sessionId || job.ownerClientId !== principal.clientId || job.creatingSessionId !== principal.sessionId) throw new AgentError('SCOPE_DENIED');
}

export class McpJobService {
  private readonly uuid: () => string;
  private readonly wait: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: McpJobServiceOptions) {
    this.uuid = options.randomUUID ?? randomUUID;
    this.wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async createTask(descriptor: McpRegistryDescriptor, argumentsValue: Record<string, unknown>, ttl: unknown, principal: AgentPrincipal): Promise<object> {
    if (descriptor.handler.kind !== 'gateway' || descriptor.exposure !== 'business' || !principal.sessionId || !principal.scopes.includes('jobs.execute')) throw new AgentError('SCOPE_DENIED');
    if (ttl !== undefined && (!Number.isSafeInteger(ttl) || (ttl as number) < 1_000 || (ttl as number) > Math.min(jobMaxTtlMs, 7 * 24 * 60 * 60 * 1000))) {
      throw new AgentError('VALIDATION_ERROR', { field: 'params.task.ttl' });
    }
    const requestId = String(argumentsValue.requestId);
    const target = Object.freeze({
      operation: descriptor.operation as OperationName,
      kind: descriptor.handler.gatewayMethod === 'execute' ? 'command' as const : 'query' as const,
      payload: argumentsValue.payload as JsonObject,
      ...(descriptor.handler.gatewayMethod === 'execute' ? { expectedVersion: argumentsValue.expectedVersion as { readonly dataEpoch: string; readonly dataRevision: number } } : {})
    });
    const outcome = await this.options.gateway.execute(Object.freeze({
      apiVersion: 1 as const, kind: 'agent-command' as const, operation: 'jobs.create' as const,
      payload: Object.freeze({ target, ...(ttl === undefined ? {} : { ttlMs: ttl as number }) }), requestId, catalog: operationCatalogIdentity
    }), principal);
    const job = commandValue(outcome) as AgentJob;
    assertTaskOwner(job, principal);
    return Object.freeze({ task: projectJobTask(job) });
  }

  async get(taskId: string, principal: AgentPrincipal): Promise<object> {
    return projectJobTask(await this.getJob(taskId, principal));
  }

  async list(cursor: string | undefined, principal: AgentPrincipal): Promise<object> {
    if (!principal.renderer && !principal.scopes.includes('jobs.admin') && !principal.sessionId) throw new AgentError('SCOPE_DENIED');
    const outcome = await this.options.gateway.query(Object.freeze({ apiVersion: 1 as const, kind: 'agent-query' as const,
      operation: 'jobs.list' as const, payload: Object.freeze({ pageSize: 100, ...(!principal.renderer && !principal.scopes.includes('jobs.admin') ? { sessionId: principal.sessionId } : {}), ...(cursor ? { cursor } : {}) }), requestId: this.uuid(), catalog: operationCatalogIdentity }), principal);
    const page = value(outcome) as JobListResult;
    return Object.freeze({ tasks: Object.freeze(page.items.map(projectJobTask)), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) });
  }

  async cancel(taskId: string, principal: AgentPrincipal): Promise<object> {
    const current = await this.getJob(taskId, principal);
    assertTaskOwner(current, principal);
    const outcome = await this.options.gateway.execute(Object.freeze({ apiVersion: 1 as const, kind: 'agent-command' as const,
      operation: 'jobs.cancel' as const, payload: Object.freeze({ jobId: taskId }), requestId: this.uuid(), catalog: operationCatalogIdentity }), principal);
    const job = commandValue(outcome) as AgentJob;
    assertTaskOwner(job, principal);
    return projectJobTask(job);
  }

  async result(taskId: string, principal: AgentPrincipal): Promise<object> {
    let job = await this.getJob(taskId, principal);
    assertTaskOwner(job, principal);
    while (!['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) {
      await this.wait(250);
      job = await this.getJob(taskId, principal);
    }
    if (job.status === 'cancelled' || job.status === 'interrupted') {
      const outcome = Object.freeze({ schemaVersion: 'kaoyan-mcp-schema-v1@1', ok: false as const, kind: 'tool-error' as const,
        code: job.status === 'cancelled' ? 'JOB_CANCELLED' : 'JOB_INTERRUPTED', message: job.status === 'cancelled' ? 'The job was cancelled.' : 'The job was interrupted.', retryable: false });
      return Object.freeze({ content: Object.freeze([{ type: 'text', text: JSON.stringify(outcome) }]), structuredContent: outcome, isError: true,
        _meta: Object.freeze({ 'io.modelcontextprotocol/related-task': Object.freeze({ taskId }) }) });
    }
    if (job.status === 'failed') {
      const outcome = Object.freeze({ schemaVersion: 'kaoyan-mcp-schema-v1@1', ok: false as const, kind: 'tool-error' as const,
        code: job.error?.code ?? 'INTERNAL_ERROR', message: job.error?.message ?? 'The job failed.', retryable: job.error?.retryable ?? false });
      return Object.freeze({ content: Object.freeze([{ type: 'text', text: JSON.stringify(outcome) }]), structuredContent: outcome, isError: true,
        _meta: Object.freeze({ 'io.modelcontextprotocol/related-task': Object.freeze({ taskId }) }) });
    }
    const resultOutcome = await this.options.gateway.query(Object.freeze({ apiVersion: 1 as const, kind: 'agent-query' as const,
      operation: 'jobs.result' as const, payload: Object.freeze({ jobId: taskId }), requestId: this.uuid(), catalog: operationCatalogIdentity }), principal);
    const record = value(resultOutcome) as JobResultRecord;
    const mapped = mapMcpGatewayResult({ operation: record.job.operation, requestId: record.job.gatewayRequestId, outcome: record.result as never });
    return Object.freeze({ content: Object.freeze([{ type: 'text', text: JSON.stringify(mapped) }]), structuredContent: mapped, isError: !mapped.ok,
      _meta: Object.freeze({ 'io.modelcontextprotocol/related-task': Object.freeze({ taskId }) }) });
  }

  private async getJob(taskId: string, principal: AgentPrincipal): Promise<AgentJob> {
    const outcome = await this.options.gateway.query(Object.freeze({ apiVersion: 1 as const, kind: 'agent-query' as const,
      operation: 'jobs.get' as const, payload: Object.freeze({ jobId: taskId }), requestId: this.uuid(), catalog: operationCatalogIdentity }), principal);
    const job = value(outcome) as AgentJob;
    assertTaskOwner(job, principal);
    return job;
  }
}

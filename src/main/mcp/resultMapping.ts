import { serializeAgentError, type SerializedAgentError } from '../../shared/agent/errors';
import type { AgentExecuteOutcome, AgentQueryOutcome, OperationName } from '../../shared/agent/v1/gatewayContracts';
import type { EntityRef } from '../../shared/agent/v1/contracts';
import type { McpGatewayResultInput, McpStructuredOutcome } from '../../shared/mcp/v1/contracts';
import { mcpExternalBusinessOperations } from '../../shared/mcp/v1/exposureManifest';
import { mapGatewayValueToMcpOutcome, mapSerializedAgentErrorToMcpOutcome } from '../../shared/mcp/v1/launcherContracts';
import { mcpSchemaVersion } from '../../shared/mcp/v1/versions';

const mcpAdditionalMapperOperations = Object.freeze([
  'questions.get',
  'tasks.get',
  'questions.review_buckets',
  'tasks.list',
  'jobs.create',
  'jobs.get',
  'jobs.list',
  'jobs.cancel',
  'jobs.result'
] as const);

function toolError(error: SerializedAgentError, field?: string): McpStructuredOutcome {
  const mapped = mapSerializedAgentErrorToMcpOutcome(error);
  return field && mapped.ok === false && mapped.kind === 'tool-error' ? Object.freeze({ ...mapped, field }) : mapped;
}

export function mapMcpError(error: unknown): McpStructuredOutcome {
  const serialized = serializeAgentError(error);
  return mapSerializedAgentErrorToMcpOutcome(serialized);
}

function affectedEntities(result: { readonly value: unknown; readonly events?: readonly unknown[] }): readonly EntityRef[] | undefined {
  const references: EntityRef[] = [];
  const add = (entityType: string, entityId: unknown) => {
    if ((typeof entityId === 'string' && entityId.length > 0) || (typeof entityId === 'number' && Number.isSafeInteger(entityId))) {
      references.push({ entityType, entityId: String(entityId) });
    }
  };
  const candidates: readonly [string, string][] = [
    ['questionId', 'question'], ['imageId', 'question_image'], ['reviewLogId', 'review_log'],
    ['taskId', 'task'], ['studySessionId', 'study_session'], ['sessionId', 'focus_session'], ['id', 'entity']
  ];
  for (const event of result.events ?? []) {
    if (!event || typeof event !== 'object') continue;
    const payload = (event as { readonly payload?: unknown }).payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    for (const [field, entityType] of candidates) add(entityType, (payload as Record<string, unknown>)[field]);
  }
  if (references.length === 0 && result.value && typeof result.value === 'object' && !Array.isArray(result.value)) {
    for (const [field, entityType] of candidates) add(entityType, (result.value as Record<string, unknown>)[field]);
  }
  const unique = new Map(references.map((entry) => [`${entry.entityType}\0${entry.entityId}`, entry]));
  return unique.size > 0 ? Object.freeze([...unique.values()]) : undefined;
}

function mapSuccess(
  operation: OperationName,
  requestId: string,
  result: { readonly changed?: boolean; readonly value: unknown; readonly events?: readonly unknown[]; readonly dataVersion?: { readonly dataEpoch: string; readonly dataRevision: number } },
  options: { readonly receiptId?: string; readonly page?: import('../../shared/agent/v1/gatewayContracts').PageInfo } = {}
): McpStructuredOutcome {
  return mapGatewayValueToMcpOutcome(operation, requestId, result.value, result.dataVersion, {
    ...(options.receiptId ? { receiptId: options.receiptId } : {}),
    ...(affectedEntities(result) ? { affectedEntities: affectedEntities(result) } : {}),
    recovery: 'none',
    ...(options.page ? { page: options.page } : {})
  });
}

export function mapMcpGatewayResult(input: McpGatewayResultInput): McpStructuredOutcome {
  const outcome = input.outcome as AgentExecuteOutcome | AgentQueryOutcome;
  if (outcome.kind === 'completed') return mapSuccess(input.operation, input.requestId, outcome.result, 'page' in outcome && outcome.page ? { page: outcome.page } : {});
  if (outcome.kind === 'replayed') return mapSuccess(input.operation, input.requestId, outcome.result, { receiptId: outcome.receiptId });
  if (outcome.kind === 'pending_approval') {
    return Object.freeze({ schemaVersion: mcpSchemaVersion, ok: false as const, kind: 'tool-error' as const,
      code: 'APPROVAL_REQUIRED', message: 'The operation requires approval.', retryable: false,
      recovery: 'approval' as const, workflow: outcome.workflow });
  }
  if (outcome.kind === 'pending_changeset') {
    return Object.freeze({ schemaVersion: mcpSchemaVersion, ok: false as const, kind: 'tool-error' as const,
      code: 'APPROVAL_REQUIRED', message: 'The operation requires a change set.', retryable: false,
      recovery: 'changeset' as const, workflow: outcome.workflow });
  }
  return mapSerializedAgentErrorToMcpOutcome(outcome.error);
}

export type McpResultMapper = (input: McpGatewayResultInput) => McpStructuredOutcome;

const mapper = (input: McpGatewayResultInput): McpStructuredOutcome => mapMcpGatewayResult(input);
export const mcpV1ResultMappers: Readonly<Record<string, McpResultMapper>> = Object.freeze(
  Object.fromEntries([...mcpExternalBusinessOperations, ...mcpAdditionalMapperOperations].map((operation) => [`mcp.result.${operation}.v1`, mapper]))
);

export function resolveMcpResultMapper(operation: OperationName): McpResultMapper {
  const result = mcpV1ResultMappers[`mcp.result.${operation}.v1`];
  if (!result) throw new Error(`No MCP result mapper is registered for ${operation}`);
  return result;
}

import { serializeAgentError, type SerializedAgentError } from '../../shared/agent/errors';
import type { AgentExecuteOutcome, AgentQueryOutcome, OperationName } from '../../shared/agent/v1/gatewayContracts';
import type { McpGatewayResultInput, McpStructuredOutcome } from '../../shared/mcp/v1/contracts';
import { mcpExternalBusinessOperations } from '../../shared/mcp/v1/exposureManifest';
import { mapGatewayValueToMcpOutcome, mapSerializedAgentErrorToMcpOutcome } from '../../shared/mcp/v1/launcherContracts';

const mcpAdditionalMapperOperations = Object.freeze([
  'questions.get',
  'tasks.get',
  'questions.review_buckets',
  'tasks.list'
] as const);

function toolError(error: SerializedAgentError, field?: string): McpStructuredOutcome {
  const mapped = mapSerializedAgentErrorToMcpOutcome(error);
  return field && mapped.ok === false && mapped.kind === 'tool-error' ? Object.freeze({ ...mapped, field }) : mapped;
}

export function mapMcpError(error: unknown): McpStructuredOutcome {
  const serialized = serializeAgentError(error);
  return mapSerializedAgentErrorToMcpOutcome(serialized);
}

function mapSuccess(operation: OperationName, requestId: string, result: { readonly changed?: boolean; readonly value: unknown; readonly events?: readonly unknown[]; readonly dataVersion?: { readonly dataEpoch: string; readonly dataRevision: number } }): McpStructuredOutcome {
  return mapGatewayValueToMcpOutcome(operation, requestId, result.value, result.dataVersion);
}

export function mapMcpGatewayResult(input: McpGatewayResultInput): McpStructuredOutcome {
  const outcome = input.outcome as AgentExecuteOutcome | AgentQueryOutcome;
  if (outcome.kind === 'completed') return mapSuccess(input.operation, input.requestId, outcome.result);
  if (outcome.kind === 'replayed') return mapSuccess(input.operation, input.requestId, outcome.result);
  if (outcome.kind === 'pending_approval') return toolError({ code: 'APPROVAL_REQUIRED', message: 'The operation requires approval.', retryable: false });
  if (outcome.kind === 'pending_changeset') return toolError({ code: 'APPROVAL_REQUIRED', message: 'The operation requires a change set.', retryable: false });
  return mapMcpError(outcome.error);
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

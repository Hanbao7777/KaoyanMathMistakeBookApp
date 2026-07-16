import { serializeAgentError, type AgentErrorCode, type SerializedAgentError } from '../../shared/agent/errors';
import type { AgentExecuteOutcome, AgentQueryOutcome, OperationName } from '../../shared/agent/v1/gatewayContracts';
import type { McpGatewayResultInput, McpJsonValue, McpStructuredOutcome } from '../../shared/mcp/v1/contracts';
import { mcpSchemaVersion } from '../../shared/mcp/v1/versions';
import { mcpExternalBusinessOperations } from '../../shared/mcp/v1/exposureManifest';

const mcpAdditionalMapperOperations = Object.freeze([
  'questions.get',
  'tasks.get',
  'questions.review_buckets',
  'tasks.list'
] as const);

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /(?:access|bearer|refresh)?(?:token|secret|credential)|privatekey|signature|password|apikey/i;
const ABSOLUTE_PATH = /(?:^|[\s"'(=])(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/]|\/(?:[^/\s]+\/)+[^/\s]+)/;
const TOOL_ERROR_CODES = new Set<AgentErrorCode>([
  'VALIDATION_ERROR', 'DATA_EPOCH_MISMATCH', 'DATA_REVISION_CONFLICT', 'REQUEST_CONFLICT', 'IDEMPOTENCY_CONFLICT',
  'CURSOR_INVALID', 'POLICY_DENIED', 'APPROVAL_REQUIRED', 'APPROVAL_INVALID', 'R4_GRANT_REQUIRED', 'R4_GRANT_INVALID'
]);
const AUTHENTICATION_CODES = new Set<AgentErrorCode>(['CLIENT_REVOKED', 'SCOPE_DENIED']);
const LIFECYCLE_CODES = new Set<AgentErrorCode>(['EXTERNAL_CONTROL_DISABLED', 'MAINTENANCE_FENCE', 'RECOVERY_FENCE', 'PERSISTENCE_INDETERMINATE', 'AUDIT_UNAVAILABLE']);

function redact(value: unknown, depth = 0): McpJsonValue {
  if (depth > 16) return REDACTED;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : REDACTED;
  if (typeof value === 'string') return ABSOLUTE_PATH.test(value) ? REDACTED : value.length > 100_000 ? REDACTED : value;
  if (Array.isArray(value)) return value.slice(0, 2_000).map((entry) => redact(entry, depth + 1));
  if (typeof value !== 'object') return REDACTED;
  const result: Record<string, McpJsonValue> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 2_000)) {
    if (key.length > 200 || SENSITIVE_KEY.test(key.replace(/[_-]/g, ''))) continue;
    result[key] = redact(entry, depth + 1);
  }
  return result;
}

function toolError(error: SerializedAgentError, field?: string): McpStructuredOutcome {
  return Object.freeze({
    schemaVersion: mcpSchemaVersion,
    ok: false as const,
    kind: 'tool-error' as const,
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(field ? { field } : error.details?.field ? { field: error.details.field } : {})
  });
}

function transportError(error: SerializedAgentError): McpStructuredOutcome {
  const category = AUTHENTICATION_CODES.has(error.code)
    ? 'authentication' as const
    : LIFECYCLE_CODES.has(error.code)
      ? 'lifecycle' as const
      : 'protocol' as const;
  return Object.freeze({
    schemaVersion: mcpSchemaVersion,
    ok: false as const,
    kind: 'transport-error' as const,
    category,
    code: error.code,
    message: error.message,
    retryable: error.retryable
  });
}

export function mapMcpError(error: unknown): McpStructuredOutcome {
  const serialized = serializeAgentError(error);
  return TOOL_ERROR_CODES.has(serialized.code) ? toolError(serialized) : transportError(serialized);
}

function mapSuccess(operation: OperationName, requestId: string, result: { readonly value: unknown; readonly dataVersion?: { readonly dataEpoch: string; readonly dataRevision: number } }, receiptId?: string): McpStructuredOutcome {
  return Object.freeze({
    schemaVersion: mcpSchemaVersion,
    ok: true as const,
    operation,
    requestId,
    data: redact(result.value),
    ...(receiptId ? { receiptId } : {}),
    ...(result.dataVersion ? { dataVersion: result.dataVersion } : {})
  });
}

export function mapMcpGatewayResult(input: McpGatewayResultInput): McpStructuredOutcome {
  const outcome = input.outcome as AgentExecuteOutcome | AgentQueryOutcome;
  if (outcome.kind === 'completed') return mapSuccess(input.operation, input.requestId, outcome.result);
  if (outcome.kind === 'replayed') return mapSuccess(input.operation, input.requestId, outcome.result, outcome.receiptId);
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

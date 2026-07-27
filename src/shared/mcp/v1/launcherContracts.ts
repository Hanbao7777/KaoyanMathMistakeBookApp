import { operationCatalogIdentity, resolveOperationDescriptor } from '../../agent/v1/operationCatalog';
import type { SerializedAgentError } from '../../agent/errors';
import type { AgentCommandEnvelope, AgentQueryEnvelope, OperationName, SafeReceiptStatusResult, SafeReceiptTerminal } from '../../agent/v1/gatewayContracts';
import { assertCatalogIdentity, canonicalizeJson, hashCanonicalJson, validateAgentCommandEnvelope, validateAgentQueryEnvelope, validateSafeReceiptStatusResult } from '../../agent/v1/gatewaySchemas';
import { mcpExternalExposureManifest, mcpExternalExposureManifestVersion } from './exposureManifest';
import type { McpJsonValue, McpStructuredOutcome } from './contracts';
import { validateMcpStructuredOutcome } from './schemas';
import { mcpSchemaVersion } from './versions';

/** Narrow, transport-neutral projection consumed by the standalone stdio launcher. */
export const launcherContractVersion = 'kaoyan-mcp-launcher-contract-v1@1' as const;

export const launcherOperationManifest = Object.freeze({
  version: launcherContractVersion,
  exposureVersion: mcpExternalExposureManifestVersion,
  catalog: operationCatalogIdentity,
  operations: Object.freeze(mcpExternalExposureManifest.businessOperations.map((name) => {
    const descriptor = resolveOperationDescriptor(name);
    return Object.freeze({ name, kind: descriptor.kind, idempotency: descriptor.idempotency });
  }))
});

export type LauncherOperation = (typeof launcherOperationManifest.operations)[number];

export const launcherCatalogIdentity = operationCatalogIdentity;

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /(?:access|bearer|refresh)?(?:token|secret|credential)|privatekey|signature|password|apikey/i;
const ABSOLUTE_PATH = /(?:^|[\s"'(=])(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/]|\/(?:[^/\s]+\/)+[^/\s]+)/;
const TOOL_ERROR_CODES = new Set([
  'VALIDATION_ERROR', 'DATA_EPOCH_MISMATCH', 'DATA_REVISION_CONFLICT', 'REQUEST_CONFLICT', 'IDEMPOTENCY_CONFLICT',
  'CURSOR_INVALID', 'POLICY_DENIED', 'APPROVAL_REQUIRED', 'APPROVAL_INVALID', 'R4_GRANT_REQUIRED', 'R4_GRANT_INVALID'
]);
const AUTHENTICATION_CODES = new Set(['CLIENT_REVOKED', 'SCOPE_DENIED']);
const LIFECYCLE_CODES = new Set(['EXTERNAL_CONTROL_DISABLED', 'MAINTENANCE_FENCE', 'RECOVERY_FENCE', 'PERSISTENCE_INDETERMINATE', 'AUDIT_UNAVAILABLE']);

function redact(value: unknown, depth = 0): McpJsonValue {
  if (depth > 16) return REDACTED;
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : REDACTED;
  if (typeof value === 'string') return ABSOLUTE_PATH.test(value) || value.length > 100_000 ? REDACTED : value;
  if (Array.isArray(value)) return value.slice(0, 2_000).map((entry) => redact(entry, depth + 1));
  if (typeof value !== 'object') return REDACTED;
  const result: Record<string, McpJsonValue> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 2_000)) {
    if (key.length > 200 || SENSITIVE_KEY.test(key.replace(/[_-]/g, ''))) continue;
    result[key] = redact(entry, depth + 1);
  }
  return result;
}

export function mapSerializedAgentErrorToMcpOutcome(error: SerializedAgentError): McpStructuredOutcome {
  if (TOOL_ERROR_CODES.has(error.code)) {
    return Object.freeze({
      schemaVersion: mcpSchemaVersion, ok: false as const, kind: 'tool-error' as const,
      code: error.code, message: error.message, retryable: error.retryable,
      ...(error.details?.field ? { field: error.details.field } : {})
    });
  }
  const category = AUTHENTICATION_CODES.has(error.code)
    ? 'authentication' as const
    : LIFECYCLE_CODES.has(error.code)
      ? 'lifecycle' as const
      : 'protocol' as const;
  return Object.freeze({
    schemaVersion: mcpSchemaVersion, ok: false as const, kind: 'transport-error' as const,
    category, code: error.code, message: error.message, retryable: error.retryable
  });
}

export function mapGatewayValueToMcpOutcome(
  operation: OperationName,
  requestId: string,
  value: unknown,
  dataVersion?: { readonly dataEpoch: string; readonly dataRevision: number },
  options: {
    readonly receiptId?: string;
    readonly affectedEntities?: readonly { readonly entityType: string; readonly entityId: string }[];
    readonly recovery?: 'none' | 'retry' | 'receipt-status' | 'approval' | 'changeset';
    readonly page?: { readonly nextCursor?: string; readonly pageSize: number; readonly hasMore: boolean };
  } = {}
): McpStructuredOutcome {
  const result = Object.freeze({
    schemaVersion: mcpSchemaVersion, ok: true as const, operation, requestId,
    data: redact(value), ...(options.receiptId ? { receiptId: options.receiptId } : {}),
    ...(dataVersion ? { dataVersion } : {}), ...(options.affectedEntities ? { affectedEntities: options.affectedEntities } : {}),
    ...(options.recovery ? { recovery: options.recovery } : {}), ...(options.page ? { page: options.page } : {})
  });
  validateMcpStructuredOutcome(result);
  return result;
}

function terminalAffectedEntities(result: { readonly value: unknown; readonly events?: readonly unknown[] }): readonly { readonly entityType: string; readonly entityId: string }[] | undefined {
  const references: { entityType: string; entityId: string }[] = [];
  const fields: readonly [string, string][] = [
    ['questionId', 'question'], ['imageId', 'question_image'], ['reviewLogId', 'review_log'],
    ['taskId', 'task'], ['sessionId', 'focus_session'], ['id', 'entity']
  ];
  const add = (entityType: string, value: unknown) => {
    if ((typeof value === 'string' && value.length > 0) || (typeof value === 'number' && Number.isSafeInteger(value))) {
      references.push({ entityType, entityId: String(value) });
    }
  };
  for (const event of result.events ?? []) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
    const payload = (event as { readonly payload?: unknown }).payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    for (const [field, entityType] of fields) add(entityType, (payload as Record<string, unknown>)[field]);
  }
  if (references.length === 0 && result.value && typeof result.value === 'object' && !Array.isArray(result.value)) {
    for (const [field, entityType] of fields) add(entityType, (result.value as Record<string, unknown>)[field]);
  }
  const unique = new Map(references.map((entry) => [`${entry.entityType}\0${entry.entityId}`, entry]));
  return unique.size > 0 ? [...unique.values()] : undefined;
}

export function mapGatewayTerminalToMcpOutcome(operation: OperationName, requestId: string, terminal: SafeReceiptTerminal): McpStructuredOutcome {
  const result = terminal.kind === 'command-result'
    ? mapGatewayValueToMcpOutcome(operation, requestId, terminal.result.value, terminal.result.dataVersion, {
      ...(terminalAffectedEntities(terminal.result) ? { affectedEntities: terminalAffectedEntities(terminal.result) } : {}),
      recovery: 'none'
    })
    : mapSerializedAgentErrorToMcpOutcome(terminal.error);
  validateMcpStructuredOutcome(result);
  return result;
}

export function resolveLauncherOperation(name: unknown): LauncherOperation | null {
  return typeof name === 'string' ? launcherOperationManifest.operations.find((entry) => entry.name === name) ?? null : null;
}

export function validateLauncherReceiptStatus(value: unknown): asserts value is SafeReceiptStatusResult {
  validateSafeReceiptStatusResult(value);
}

export function extractLauncherTerminalEvidence(value: unknown): { terminal: SafeReceiptTerminal; hashSubject: unknown } | null {
  validateLauncherReceiptStatus(value);
  const receipt = value as SafeReceiptStatusResult;
  if (receipt.status !== 'completed' && receipt.status !== 'failed') return null;
  if (!receipt.terminal) return null;
  return Object.freeze({
    terminal: receipt.terminal,
    hashSubject: receipt.terminal.kind === 'command-result' ? receipt.terminal.result : receipt.terminal.error
  });
}

export function validateLauncherCommandEnvelope(value: unknown): asserts value is AgentCommandEnvelope {
  validateAgentCommandEnvelope(value);
  assertCatalogIdentity(value.catalog, launcherCatalogIdentity);
  const operation = resolveLauncherOperation(value.operation);
  if (!operation || operation.kind !== 'command') throw new Error('Launcher operation is not an exposed command');
}

export function validateLauncherQueryEnvelope(value: unknown): asserts value is AgentQueryEnvelope {
  validateAgentQueryEnvelope(value);
  assertCatalogIdentity(value.catalog, launcherCatalogIdentity);
  const operation = resolveLauncherOperation(value.operation);
  if (!operation || operation.kind !== 'query') throw new Error('Launcher operation is not an exposed query');
}

export function validateLauncherMcpOutcome(value: unknown): void {
  validateMcpStructuredOutcome(value);
}

export function canonicalizeLauncherJson(value: unknown): string {
  return canonicalizeJson(value);
}

export function hashLauncherJson(value: unknown): string {
  return hashCanonicalJson(value);
}

export function extractLauncherTerminal(value: unknown): SafeReceiptTerminal | null {
  return extractLauncherTerminalEvidence(value)?.terminal ?? null;
}

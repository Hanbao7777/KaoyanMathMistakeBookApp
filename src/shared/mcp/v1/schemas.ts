import { mcpSchemaVersion, mcpProtocolVersions, mcpCurrentProtocolVersion } from './versions';
import {
  mcpPaginationKinds,
  mcpExposureKinds,
  mcpPrimitiveTypes,
  mcpVisibilityKinds,
  type McpCapabilitySummary,
  type McpJsonValue,
  type McpPageInfo,
  type McpPageRequest,
  type McpRegistryDescriptor,
  type McpRuntimeValidator,
  type McpServerInstructions,
  type McpStructuredOutcome,
  type McpSupportPrimitiveDescriptor
} from './contracts';

export const mcpMaxPageSize = 200;
export const mcpMaxCursorLength = 16_384;
export const mcpMaxNameLength = 200;
export const mcpMaxDescriptionLength = 1_000;
export const mcpMaxInstructionsLength = 512;
export const mcpMaxJsonDepth = 16;
export const mcpMaxJsonNodes = 2_000;
export const mcpMaxJsonStringLength = 100_000;
const SAFE_NAME = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const CURSOR = /^[A-Za-z0-9_-]{1,16384}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;
const EMBEDDED_ABSOLUTE_PATH = /(?:^|[\s"'(=])(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/]|\/(?:[^/\s]+\/)+[^/\s]+)/;
const CATALOG_VERSION = /^agent-catalog-v1@[1-9][0-9]{0,8}$/;
const FORBIDDEN_KEYS = new Set(['accessToken', 'bearerToken', 'credential', 'credentials', 'privateKey', 'refreshToken', 'secret']);

export class McpValidationError extends Error {
  readonly path: string;
  constructor(path: string) {
    super('The MCP request is invalid.');
    this.name = 'McpValidationError';
    this.path = path;
  }
}

function fail(path: string): never { throw new McpValidationError(path); }
function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path);
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  const result = object(value, path);
  for (const key of Object.keys(result)) if (!keys.includes(key)) fail(`${path}.${key}`);
  return result;
}
function required(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${path}.${key}`);
}
function string(value: unknown, path: string, max: number): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value !== value.normalize('NFC')) fail(path);
}
function safeName(value: unknown, path: string): asserts value is string {
  string(value, path, mcpMaxNameLength);
  if (!SAFE_NAME.test(value)) fail(path);
}
function uuid(value: unknown, path: string): asserts value is string { if (typeof value !== 'string' || !UUID.test(value)) fail(path); }
function positive(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > mcpMaxPageSize) fail(path);
}
function boolean(value: unknown, path: string): asserts value is boolean { if (typeof value !== 'boolean') fail(path); }
function oneOf<T extends readonly string[]>(value: unknown, values: T, path: string): asserts value is T[number] {
  if (typeof value !== 'string' || !values.includes(value)) fail(path);
}
function json(value: unknown, path: string, seen = new Set<object>(), depth = 0, state = { nodes: 0 }): asserts value is McpJsonValue {
  if (++state.nodes > mcpMaxJsonNodes || depth > mcpMaxJsonDepth) fail(path);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') { if (value.length > mcpMaxJsonStringLength || value !== value.normalize('NFC') || ABSOLUTE_PATH.test(value) || EMBEDDED_ABSOLUTE_PATH.test(value)) fail(path); return; }
  if (typeof value === 'number') { if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) fail(path); return; }
  if (typeof value !== 'object' || seen.has(value)) fail(path);
  seen.add(value);
  if (Array.isArray(value)) value.forEach((entry, index) => json(entry, `${path}[${index}]`, seen, depth + 1, state));
  else {
    const result = object(value, path);
    for (const key of Object.keys(result)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase()) || /(?:access|bearer|refresh)?(?:token|secret|credential)|privatekey|signature|password|apikey/i.test(key.replace(/[_-]/g, ''))) fail(`${path}.${key}`);
      json(result[key], `${path}.${key}`, seen, depth + 1, state);
    }
  }
  seen.delete(value);
}

export function validateMcpPageRequest(value: unknown, path = 'page'): asserts value is McpPageRequest {
  const result = exact(value, ['cursor', 'pageSize'], path);
  required(result, ['pageSize'], path);
  if (result.cursor !== undefined && (typeof result.cursor !== 'string' || !CURSOR.test(result.cursor))) fail(`${path}.cursor`);
  positive(result.pageSize, `${path}.pageSize`);
}

export function validateMcpPageInfo(value: unknown, path = 'page'): asserts value is McpPageInfo {
  const result = exact(value, ['nextCursor', 'pageSize', 'hasMore'], path);
  required(result, ['pageSize', 'hasMore'], path);
  if (result.nextCursor !== undefined && (typeof result.nextCursor !== 'string' || !CURSOR.test(result.nextCursor))) fail(`${path}.nextCursor`);
  positive(result.pageSize, `${path}.pageSize`);
  boolean(result.hasMore, `${path}.hasMore`);
  if (result.hasMore !== (result.nextCursor !== undefined)) fail(path);
}

export function validateMcpJson(value: unknown, path = 'value'): asserts value is McpJsonValue { json(value, path); }

function validateDataVersion(value: unknown, path: string): void {
  const result = exact(value, ['dataEpoch', 'dataRevision'], path);
  required(result, ['dataEpoch', 'dataRevision'], path);
  string(result.dataEpoch, `${path}.dataEpoch`, 200);
  if (!Number.isSafeInteger(result.dataRevision) || (result.dataRevision as number) < 0) fail(`${path}.dataRevision`);
}

function validateEntityRefs(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.length > 500) fail(path);
  for (let index = 0; index < value.length; index += 1) {
    const result = exact(value[index], ['entityType', 'entityId'], `${path}[${index}]`);
    required(result, ['entityType', 'entityId'], `${path}[${index}]`);
    safeName(result.entityType, `${path}[${index}].entityType`); string(result.entityId, `${path}[${index}].entityId`, 200);
  }
}

function validateSchema(value: unknown, path: string): void {
  const result = exact(value, ['id', 'version', 'direction', 'bounded'], path);
  required(result, ['id', 'version', 'direction', 'bounded'], path);
  safeName(result.id, `${path}.id`);
  if (result.version !== mcpSchemaVersion) fail(`${path}.version`);
  oneOf(result.direction, ['input', 'output'] as const, `${path}.direction`);
  if (result.bounded !== true) fail(`${path}.bounded`);
}

function validatePagination(value: unknown, path: string): void {
  const result = exact(value, ['kind', 'defaultPageSize', 'maxPageSize'], path);
  required(result, ['kind', 'defaultPageSize', 'maxPageSize'], path);
  oneOf(result.kind, mcpPaginationKinds, `${path}.kind`);
  positive(result.defaultPageSize, `${path}.defaultPageSize`);
  positive(result.maxPageSize, `${path}.maxPageSize`);
  if ((result.defaultPageSize as number) > (result.maxPageSize as number)) fail(path);
  if (result.kind === 'none' && result.defaultPageSize !== 1) fail(path);
}

export function validateMcpRegistryDescriptor(value: unknown, path = 'descriptor'): asserts value is McpRegistryDescriptor {
  const result = exact(value, ['name', 'operation', 'catalog', 'exposure', 'primitive', 'description', 'inputSchema', 'outputSchema', 'requiredScopes', 'visibility', 'pagination', 'resultMapperId', 'inputValidator', 'outputValidator', 'handler', 'uri', 'uriTemplate', 'promptArguments'], path);
  required(result, ['name', 'operation', 'catalog', 'exposure', 'primitive', 'description', 'inputSchema', 'outputSchema', 'requiredScopes', 'visibility', 'pagination', 'resultMapperId', 'inputValidator', 'outputValidator', 'handler'], path);
  safeName(result.name, `${path}.name`); safeName(result.operation, `${path}.operation`);
  const catalog = exact(result.catalog, ['version', 'hash'], `${path}.catalog`);
  required(catalog, ['version', 'hash'], `${path}.catalog`);
  string(catalog.version, `${path}.catalog.version`, 100); if (!CATALOG_VERSION.test(catalog.version as string)) fail(`${path}.catalog.version`); string(catalog.hash, `${path}.catalog.hash`, 100); if (!/^sha256-v1:[0-9a-f]{64}$/.test(catalog.hash as string)) fail(`${path}.catalog.hash`);
  oneOf(result.exposure, mcpExposureKinds, `${path}.exposure`);
  oneOf(result.primitive, mcpPrimitiveTypes, `${path}.primitive`); string(result.description, `${path}.description`, mcpMaxDescriptionLength);
  validateSchema(result.inputSchema, `${path}.inputSchema`); validateSchema(result.outputSchema, `${path}.outputSchema`);
  if ((result.requiredScopes as unknown) === null || !Array.isArray(result.requiredScopes)) fail(`${path}.requiredScopes`);
  const scopes = result.requiredScopes as unknown[];
  if (new Set(scopes).size !== scopes.length || scopes.some((scope) => typeof scope !== 'string' || !SAFE_NAME.test(scope))) fail(`${path}.requiredScopes`);
  oneOf(result.visibility, mcpVisibilityKinds, `${path}.visibility`); validatePagination(result.pagination, `${path}.pagination`);
  safeName(result.resultMapperId, `${path}.resultMapperId`);
  if (typeof result.inputValidator !== 'function' || typeof result.outputValidator !== 'function') fail(`${path}.validator`);
  const handler = object(result.handler, `${path}.handler`);
  if (handler.kind === 'gateway') {
    const gateway = exact(handler, ['kind', 'gatewayMethod', 'operation'], `${path}.handler`);
    required(gateway, ['kind', 'gatewayMethod', 'operation'], `${path}.handler`);
    oneOf(gateway.gatewayMethod, ['execute', 'query'] as const, `${path}.handler.gatewayMethod`);
    if (gateway.operation !== result.operation || result.operation === 'mcp.capabilities.summary') fail(`${path}.handler.operation`);
    if ((scopes as unknown[]).length === 0) fail(`${path}.requiredScopes`);
  } else if (handler.kind === 'local-summary') {
    const local = exact(handler, ['kind', 'operation'], `${path}.handler`);
    required(local, ['kind', 'operation'], `${path}.handler`);
    if (local.operation !== 'mcp.capabilities.summary' || result.operation !== local.operation || result.exposure !== 'support' || result.visibility !== 'public' || scopes.length !== 0) fail(`${path}.handler`);
  } else fail(`${path}.handler.kind`);
  if (result.uri !== undefined) string(result.uri, `${path}.uri`, 500);
  if (result.uriTemplate !== undefined) string(result.uriTemplate, `${path}.uriTemplate`, 500);
  if (result.promptArguments !== undefined && (!Array.isArray(result.promptArguments) || result.promptArguments.length > 32 || result.promptArguments.some((entry) => typeof entry !== 'string' || !SAFE_NAME.test(entry)))) fail(`${path}.promptArguments`);
  if (result.primitive === 'resource' && result.uri === undefined) fail(`${path}.uri`);
  if (result.primitive === 'resource-template' && result.uriTemplate === undefined) fail(`${path}.uriTemplate`);
  if (result.primitive === 'prompt' && result.promptArguments === undefined) fail(`${path}.promptArguments`);
}

export function validateMcpToolArgumentEnvelope(
  value: unknown,
  operation: string,
  payloadValidator: McpRuntimeValidator,
  command: boolean,
  path = 'arguments'
): void {
  const result = exact(value, ['apiVersion', 'kind', 'operation', 'requestId', 'idempotencyKey', 'expectedVersion', 'payload'], path);
  required(result, command
    ? ['apiVersion', 'kind', 'operation', 'requestId', 'idempotencyKey', 'expectedVersion', 'payload']
    : ['apiVersion', 'kind', 'operation', 'requestId', 'payload'], path);
  if (result.apiVersion !== 1 || result.kind !== 'mcp-tool-arguments' || result.operation !== operation) fail(path);
  uuid(result.requestId, `${path}.requestId`);
  if (command) {
    uuid(result.idempotencyKey, `${path}.idempotencyKey`);
    if (result.idempotencyKey !== result.requestId) fail(`${path}.idempotencyKey`);
    validateDataVersion(result.expectedVersion, `${path}.expectedVersion`);
  } else if (result.idempotencyKey !== undefined || result.expectedVersion !== undefined) fail(path);
  payloadValidator(result.payload);
}

export function validateMcpSupportPrimitive(value: unknown, path = 'primitive'): asserts value is McpSupportPrimitiveDescriptor {
  const result = exact(value, ['support', 'name', 'operation', 'catalog', 'exposure', 'primitive', 'description', 'requiredScopes', 'visibility', 'resultMapperId', 'inputSchema', 'outputSchema', 'pagination', 'handler', 'uri', 'uriTemplate', 'promptArguments'], path);
  if (result.support !== true) fail(`${path}.support`);
  if (result.exposure !== 'support') fail(`${path}.exposure`);
  if (result.name === undefined || result.operation === undefined || result.primitive === undefined || result.description === undefined) fail(path);
  if (result.inputSchema !== undefined) validateSchema(result.inputSchema, `${path}.inputSchema`);
  if (result.outputSchema !== undefined) validateSchema(result.outputSchema, `${path}.outputSchema`);
  if (result.pagination !== undefined) validatePagination(result.pagination, `${path}.pagination`);
  safeName(result.name, `${path}.name`); safeName(result.operation, `${path}.operation`);
  oneOf(result.primitive, mcpPrimitiveTypes, `${path}.primitive`); string(result.description, `${path}.description`, mcpMaxDescriptionLength);
  if (result.uri !== undefined) string(result.uri, `${path}.uri`, 500);
  if (result.uriTemplate !== undefined) string(result.uriTemplate, `${path}.uriTemplate`, 500);
  if (!Array.isArray(result.requiredScopes) || result.requiredScopes.some((entry) => typeof entry !== 'string' || !SAFE_NAME.test(entry))) fail(`${path}.requiredScopes`);
  oneOf(result.visibility, mcpVisibilityKinds, `${path}.visibility`); safeName(result.resultMapperId, `${path}.resultMapperId`);
  if (result.promptArguments !== undefined && (!Array.isArray(result.promptArguments) || result.promptArguments.length > 32 || result.promptArguments.some((entry) => typeof entry !== 'string' || !SAFE_NAME.test(entry)))) fail(`${path}.promptArguments`);
  if (result.primitive === 'resource' && result.uri === undefined) fail(`${path}.uri`);
  if (result.primitive === 'resource-template' && result.uriTemplate === undefined) fail(`${path}.uriTemplate`);
  if (result.primitive === 'prompt' && result.promptArguments === undefined) fail(`${path}.promptArguments`);
}

export function validateMcpServerInstructions(value: unknown, path = 'instructions'): asserts value is McpServerInstructions {
  const result = exact(value, ['version', 'text', 'length'], path);
  required(result, ['version', 'text', 'length'], path);
  if (result.version !== mcpSchemaVersion) fail(`${path}.version`);
  string(result.text, `${path}.text`, mcpMaxInstructionsLength);
  if (result.length !== result.text.length || result.length > mcpMaxInstructionsLength) fail(`${path}.length`);
}

export function validateMcpStructuredOutcome(value: unknown, path = 'outcome'): asserts value is McpStructuredOutcome {
  const result = object(value, path);
  if (result.schemaVersion !== mcpSchemaVersion) fail(`${path}.schemaVersion`);
  boolean(result.ok, `${path}.ok`);
  if (result.ok === true) {
    const success = exact(result, ['schemaVersion', 'ok', 'operation', 'requestId', 'data', 'receiptId', 'dataVersion', 'affectedEntities', 'recovery'], path);
    required(success, ['schemaVersion', 'ok', 'operation', 'requestId', 'data'], path);
    safeName(success.operation, `${path}.operation`); uuid(success.requestId, `${path}.requestId`); json(success.data, `${path}.data`);
    if (success.receiptId !== undefined) uuid(success.receiptId, `${path}.receiptId`);
    if (success.dataVersion !== undefined) validateDataVersion(success.dataVersion, `${path}.dataVersion`);
    if (success.affectedEntities !== undefined) validateEntityRefs(success.affectedEntities, `${path}.affectedEntities`);
    if (success.recovery !== undefined) oneOf(success.recovery, ['none', 'retry', 'receipt-status', 'approval', 'changeset'] as const, `${path}.recovery`);
    return;
  }
  if (result.kind === 'tool-error') {
    const error = exact(result, ['schemaVersion', 'ok', 'kind', 'code', 'message', 'retryable', 'field'], path);
    required(error, ['schemaVersion', 'ok', 'kind', 'code', 'message', 'retryable'], path);
    string(error.code, `${path}.code`, 100); string(error.message, `${path}.message`, 500); boolean(error.retryable, `${path}.retryable`);
    if (error.field !== undefined) safeName(error.field, `${path}.field`); return;
  }
  if (result.kind === 'transport-error') {
    const error = exact(result, ['schemaVersion', 'ok', 'kind', 'category', 'code', 'message', 'retryable'], path);
    required(error, ['schemaVersion', 'ok', 'kind', 'category', 'code', 'message', 'retryable'], path);
    oneOf(error.category, ['authentication', 'lifecycle', 'protocol'] as const, `${path}.category`);
    string(error.code, `${path}.code`, 100); string(error.message, `${path}.message`, 500); boolean(error.retryable, `${path}.retryable`); return;
  }
  fail(`${path}.kind`);
}

export function validateMcpCapabilitySummary(value: unknown, path = 'summary'): asserts value is McpCapabilitySummary {
  const result = exact(value, ['schemaVersion', 'protocolVersions', 'currentProtocolVersion', 'tasks', 'tools', 'resources', 'resourceTemplates', 'prompts'], path);
  required(result, ['schemaVersion', 'protocolVersions', 'currentProtocolVersion', 'tasks', 'tools', 'resources', 'resourceTemplates', 'prompts'], path);
  if (result.schemaVersion !== mcpSchemaVersion) fail(`${path}.schemaVersion`);
  if (!Array.isArray(result.protocolVersions) || result.protocolVersions.length !== mcpProtocolVersions.length || new Set(result.protocolVersions).size !== mcpProtocolVersions.length || result.protocolVersions.some((entry) => !mcpProtocolVersions.includes(entry as never)) || result.protocolVersions.some((entry, index) => entry !== mcpProtocolVersions[index])) fail(`${path}.protocolVersions`);
  oneOf(result.currentProtocolVersion, mcpProtocolVersions, `${path}.currentProtocolVersion`);
  if (result.currentProtocolVersion !== mcpCurrentProtocolVersion || result.tasks !== false) fail(path);
  for (const key of ['tools', 'resources', 'resourceTemplates', 'prompts']) if (!Number.isSafeInteger(result[key]) || (result[key] as number) < 0) fail(`${path}.${key}`);
}

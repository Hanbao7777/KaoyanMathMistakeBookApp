import { AgentError, agentErrorCodes } from '../errors';
import { agentApiVersion } from '../versions';
import {
  agentScopes,
  approvalRequirements,
  approvalSources,
  approvalStatuses,
  auditKinds,
  changeSetStatuses,
  detailLevels,
  gatewayBusinessCommandTypes,
  gatewayBusinessQueryTypes,
  gatewayWorkflowCommandTypes,
  gatewayWorkflowQueryTypes,
  idempotencyRequirements,
  operationDomains,
  operationKinds,
  operationNames,
  policyDispositions,
  r4GrantStatuses,
  receiptStatuses,
  recoveryRequirements,
  riskLevels,
  riskResolvers,
  sideEffectKinds,
  terminalReceiptStatuses,
  trustProfiles,
  workflowReferenceKinds,
  type AgentCommandEnvelope,
  type AgentExecuteOutcome,
  type AgentPrincipalClaims,
  type AgentQueryEnvelope,
  type AgentQueryOutcome,
  type ApprovalRecord,
  type AuditCursor,
  type AuditRecord,
  type CatalogIdentity,
  type ChangeSet,
  type DescriptorPolicyBounds,
  type ExecutionReceipt,
  type GatewayWorkflowCommand,
  type GatewayWorkflowQuery,
  type JsonObject,
  type OperationCatalog,
  type OperationDescriptor,
  type OperationPolicyOverride,
  type PageInfo,
  type PageRequest,
  type PlannedOperation,
  type PolicyDecision,
  type R4Grant,
  type R4GrantBinding,
  type R4Reservation,
  type ReceiptStatus,
  type RedactionProfile
} from './gatewayContracts';
import type { DataVersion, EntityRef } from './contracts';

type MutableJsonObject = Record<string, unknown>;
type Assertion = (value: unknown, path: string) => void;

export const gatewayMaxPageSize = 200;
export const gatewayMaxFieldSelection = 64;
export const gatewayMaxAffectedEntities = 500;
export const gatewayMaxChangeSetOperations = 500;
/** R4 grants are single-use and must expire within this control-center window. */
export const gatewayMaxR4GrantLifetimeMs = 15 * 60 * 1000;
export const gatewayMaxJsonDepth = 32;
export const gatewayMaxJsonNodes = 10_000;
export const gatewayMaxJsonEntries = 20_000;
export const gatewayMaxJsonStringLength = 100_000;
export const gatewayMaxJsonKeyLength = 200;
export const canonicalHashAlgorithm = 'sha256-v1' as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^sha256-v1:[0-9a-f]{64}$/;
const CURSOR = /^cursor-v1\.[A-Za-z0-9_-]{16,384}\.[0-9a-f]{64}$/;
const SAFE_NAME = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SAFE_FIELD = /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/;
const CATALOG_VERSION = /^agent-catalog-v1@[1-9][0-9]{0,8}$/;
const FORBIDDEN_CREDENTIAL_KEYS = new Set([
  'principal', 'credentials', 'credential', 'bearerToken', 'accessToken', 'refreshToken', 'privateKey', 'signature'
]);

function fail(path: string): never {
  throw new AgentError('VALIDATION_ERROR', { field: path });
}

function object(value: unknown, path: string): MutableJsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path);
  return value as MutableJsonObject;
}

function exact(value: unknown, keys: readonly string[], path: string): MutableJsonObject {
  const result = object(value, path);
  for (const key of Object.keys(result)) if (!keys.includes(key)) fail(`${path}.${key}`);
  return result;
}

function required(value: MutableJsonObject, keys: readonly string[], path: string): void {
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${path}.${key}`);
}

function string(value: unknown, path: string, max = 500): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value !== value.normalize('NFC')) fail(path);
}

function safeName(value: unknown, path: string): asserts value is string {
  string(value, path, 200);
  if (!SAFE_NAME.test(value)) fail(path);
}

function uuid(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(path);
}

function timestamp(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail(path);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail(path);
}

function hash(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !HASH.test(value)) fail(path);
}

function cursor(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !CURSOR.test(value)) throw new AgentError('CURSOR_INVALID', { field: path });
}

function boolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== 'boolean') fail(path);
}

function safeNonNegative(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(path);
}

function boundedPositive(value: unknown, path: string, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) fail(path);
}

function oneOf<T extends readonly string[]>(value: unknown, values: T, path: string): asserts value is T[number] {
  if (typeof value !== 'string' || !values.includes(value)) fail(path);
}

function array(value: unknown, path: string, assertion: Assertion, max: number, min = 0): asserts value is readonly unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(path);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) fail(`${path}[${index}]`);
    assertion(value[index], `${path}[${index}]`);
  }
}

function uniqueStringArray(value: unknown, values: readonly string[], path: string, max = values.length): void {
  array(value, path, (entry, entryPath) => oneOf(entry, values, entryPath), max);
  if (new Set(value as readonly string[]).size !== (value as readonly string[]).length) fail(path);
}

function sortedUniqueFields(value: unknown, path: string): void {
  array(value, path, (entry, entryPath) => {
    if (typeof entry !== 'string' || !SAFE_FIELD.test(entry)) fail(entryPath);
  }, gatewayMaxFieldSelection);
  const fields = value as readonly string[];
  if (new Set(fields).size !== fields.length) fail(path);
  if (fields.some((field, index) => index > 0 && fields[index - 1] >= field)) fail(path);
}

interface JsonValidationState {
  nodes: number;
  entries: number;
}

function validateJson(value: unknown, path: string, seen: Set<object>, state: JsonValidationState, depth: number): void {
  if (depth > gatewayMaxJsonDepth || ++state.nodes > gatewayMaxJsonNodes) fail(path);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && (value.length > gatewayMaxJsonStringLength || value !== value.normalize('NFC'))) fail(path);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) fail(path);
    return;
  }
  if (typeof value !== 'object') fail(path);
  if (seen.has(value)) fail(path);
  seen.add(value);
  if (Array.isArray(value)) {
    if ((state.entries += value.length) > gatewayMaxJsonEntries) fail(path);
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) fail(`${path}[${index}]`);
      validateJson(value[index], `${path}[${index}]`, seen, state, depth + 1);
    }
  } else {
    object(value, path);
    const normalizedKeys = new Set<string>();
    const keys = Object.keys(value);
    if ((state.entries += keys.length) > gatewayMaxJsonEntries) fail(path);
    for (const key of keys) {
      if (key.length > gatewayMaxJsonKeyLength) fail(`${path}.${key}`);
      const normalized = key.normalize('NFC');
      if (normalized !== key || normalizedKeys.has(normalized)) fail(`${path}.${key}`);
      normalizedKeys.add(normalized);
      validateJson((value as MutableJsonObject)[key], `${path}.${key}`, seen, state, depth + 1);
    }
  }
  seen.delete(value);
}

export function validateJsonObject(value: unknown, path = 'value'): asserts value is JsonObject {
  object(value, path);
  validateJson(value, path, new Set(), { nodes: 0, entries: 0 }, 0);
}

function canonicalJsonValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJsonValue).join(',')}]`;
  const entries = Object.keys(value as MutableJsonObject)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJsonValue((value as MutableJsonObject)[key])}`);
  return `{${entries.join(',')}}`;
}

export function canonicalizeJson(value: unknown): string {
  validateJson(value, 'value', new Set(), { nodes: 0, entries: 0 }, 0);
  return canonicalJsonValue(value);
}

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

export function sha256Utf8(value: string): string {
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  const state = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const bytes = Array.from(new TextEncoder().encode(value));
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((high >>> shift) & 0xff);
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((low >>> shift) & 0xff);

  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array<number>(64);
    for (let index = 0; index < 16; index += 1) {
      const start = offset + index * 4;
      words[index] = ((bytes[start] << 24) | (bytes[start + 1] << 16) | (bytes[start + 2] << 8) | bytes[start + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15];
      const previous2 = words[index - 2];
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const first = (h + sum1 + choice + constants[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + first) >>> 0; d = c; c = b; b = a; a = (first + second) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0; state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0; state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0; state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0; state[7] = (state[7] + h) >>> 0;
  }
  return state.map((word) => word.toString(16).padStart(8, '0')).join('');
}

export function hashCanonicalJson(value: unknown): string {
  return `${canonicalHashAlgorithm}:${sha256Utf8(canonicalizeJson(value))}`;
}

function validateApiVersion(value: unknown, path: string): void {
  if (value !== agentApiVersion) throw new AgentError('UNSUPPORTED_API_VERSION', { field: path });
}

export function validateGatewayDataVersion(value: unknown, path = 'dataVersion'): asserts value is DataVersion {
  const result = exact(value, ['dataEpoch', 'dataRevision'], path);
  required(result, ['dataEpoch', 'dataRevision'], path);
  string(result.dataEpoch, `${path}.dataEpoch`, 200);
  safeNonNegative(result.dataRevision, `${path}.dataRevision`);
}

export function validateCatalogIdentity(value: unknown, path = 'catalog'): asserts value is CatalogIdentity {
  const result = exact(value, ['version', 'hash'], path);
  required(result, ['version', 'hash'], path);
  if (typeof result.version !== 'string' || !CATALOG_VERSION.test(result.version)) fail(`${path}.version`);
  hash(result.hash, `${path}.hash`);
}

export function assertCatalogIdentity(actual: CatalogIdentity, expected: CatalogIdentity): void {
  validateCatalogIdentity(actual);
  validateCatalogIdentity(expected, 'expectedCatalog');
  if (actual.version !== expected.version || actual.hash !== expected.hash) throw new AgentError('CATALOG_VERSION_MISMATCH');
}

export function validateAgentPrincipalClaims(value: unknown, path = 'principal'): asserts value is AgentPrincipalClaims {
  const result = exact(value, [
    'apiVersion', 'kind', 'clientId', 'subjectId', 'displayName', 'scopes', 'trust', 'credentialBinding', 'authenticatedAt', 'renderer'
  ], path);
  required(result, ['apiVersion', 'kind', 'clientId', 'subjectId', 'displayName', 'scopes', 'trust', 'credentialBinding', 'authenticatedAt', 'renderer'], path);
  validateApiVersion(result.apiVersion, `${path}.apiVersion`);
  if (result.kind !== 'agent-principal') fail(`${path}.kind`);
  safeName(result.clientId, `${path}.clientId`);
  safeName(result.subjectId, `${path}.subjectId`);
  string(result.displayName, `${path}.displayName`, 200);
  uniqueStringArray(result.scopes, agentScopes, `${path}.scopes`);
  oneOf(result.trust, trustProfiles, `${path}.trust`);
  string(result.credentialBinding, `${path}.credentialBinding`, 500);
  timestamp(result.authenticatedAt, `${path}.authenticatedAt`);
  boolean(result.renderer, `${path}.renderer`);
}

function rejectCredentialMaterial(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectCredentialMaterial(entry, `${path}[${index}]`));
    return;
  }
  const result = value as MutableJsonObject;
  if (result.kind === 'agent-principal') fail(path);
  for (const key of Object.keys(result)) {
    if (FORBIDDEN_CREDENTIAL_KEYS.has(key)) fail(`${path}.${key}`);
    rejectCredentialMaterial(result[key], `${path}.${key}`);
  }
}

function validateOperationName(value: unknown, path: string): void {
  oneOf(value, operationNames, path);
}

function validateWorkflowReference(value: unknown, path: string): void {
  const result = exact(value, ['kind', 'id'], path);
  required(result, ['kind', 'id'], path);
  oneOf(result.kind, workflowReferenceKinds, `${path}.kind`);
  uuid(result.id, `${path}.id`);
}

export function validatePageRequest(value: unknown, path = 'page'): asserts value is PageRequest {
  const result = exact(value, ['cursor', 'pageSize', 'detail', 'fields'], path);
  required(result, ['pageSize', 'detail'], path);
  if (result.cursor !== undefined) cursor(result.cursor, `${path}.cursor`);
  boundedPositive(result.pageSize, `${path}.pageSize`, gatewayMaxPageSize);
  oneOf(result.detail, detailLevels, `${path}.detail`);
  if (result.fields !== undefined) sortedUniqueFields(result.fields, `${path}.fields`);
}

export function validateAgentCommandEnvelope(value: unknown): asserts value is AgentCommandEnvelope {
  const envelope = exact(value, ['apiVersion', 'kind', 'operation', 'payload', 'requestId', 'expectedVersion', 'workflow', 'catalog'], 'envelope');
  required(envelope, ['apiVersion', 'kind', 'operation', 'payload', 'requestId', 'catalog'], 'envelope');
  validateApiVersion(envelope.apiVersion, 'envelope.apiVersion');
  if (envelope.kind !== 'agent-command') fail('envelope.kind');
  oneOf(envelope.operation, [...gatewayWorkflowCommandTypes, ...gatewayBusinessCommandTypes], 'envelope.operation');
  validateJsonObject(envelope.payload, 'envelope.payload');
  rejectCredentialMaterial(envelope.payload, 'envelope.payload');
  uuid(envelope.requestId, 'envelope.requestId');
  validateCatalogIdentity(envelope.catalog, 'envelope.catalog');
  if (envelope.expectedVersion !== undefined) validateGatewayDataVersion(envelope.expectedVersion, 'envelope.expectedVersion');
  if ((gatewayBusinessCommandTypes as readonly string[]).includes(envelope.operation as string) && envelope.expectedVersion === undefined) {
    fail('envelope.expectedVersion');
  }
  if (envelope.workflow !== undefined) validateWorkflowReference(envelope.workflow, 'envelope.workflow');
}

export function validateAgentQueryEnvelope(value: unknown): asserts value is AgentQueryEnvelope {
  const envelope = exact(value, ['apiVersion', 'kind', 'operation', 'payload', 'requestId', 'page', 'catalog'], 'envelope');
  required(envelope, ['apiVersion', 'kind', 'operation', 'payload', 'requestId', 'catalog'], 'envelope');
  validateApiVersion(envelope.apiVersion, 'envelope.apiVersion');
  if (envelope.kind !== 'agent-query') fail('envelope.kind');
  oneOf(envelope.operation, [...gatewayWorkflowQueryTypes, ...gatewayBusinessQueryTypes], 'envelope.operation');
  validateJsonObject(envelope.payload, 'envelope.payload');
  rejectCredentialMaterial(envelope.payload, 'envelope.payload');
  uuid(envelope.requestId, 'envelope.requestId');
  validateCatalogIdentity(envelope.catalog, 'envelope.catalog');
  if (envelope.page !== undefined) validatePageRequest(envelope.page, 'envelope.page');
}

function validateSerializedError(value: unknown, path: string): void {
  const result = exact(value, ['code', 'message', 'retryable', 'details'], path);
  required(result, ['code', 'message', 'retryable'], path);
  oneOf(result.code, agentErrorCodes, `${path}.code`);
  string(result.message, `${path}.message`, 500);
  boolean(result.retryable, `${path}.retryable`);
  if (result.details !== undefined) validateJsonObject(result.details, `${path}.details`);
}

function validatePageInfo(value: unknown, path: string): asserts value is PageInfo {
  const result = exact(value, ['nextCursor', 'pageSize', 'hasMore'], path);
  required(result, ['pageSize', 'hasMore'], path);
  if (result.nextCursor !== undefined) cursor(result.nextCursor, `${path}.nextCursor`);
  boundedPositive(result.pageSize, `${path}.pageSize`, gatewayMaxPageSize);
  boolean(result.hasMore, `${path}.hasMore`);
  if (result.hasMore && result.nextCursor === undefined) fail(`${path}.nextCursor`);
  if (!result.hasMore && result.nextCursor !== undefined) fail(`${path}.nextCursor`);
}

export function validateAgentExecuteOutcome(value: unknown, path = 'outcome'): asserts value is AgentExecuteOutcome {
  const result = object(value, path);
  switch (result.kind) {
    case 'completed': exact(result, ['kind', 'result'], path); required(result, ['kind', 'result'], path); validateJsonObject(result.result, `${path}.result`); return;
    case 'replayed': exact(result, ['kind', 'result', 'receiptId'], path); required(result, ['kind', 'result', 'receiptId'], path); validateJsonObject(result.result, `${path}.result`); uuid(result.receiptId, `${path}.receiptId`); return;
    case 'pending_approval':
    case 'pending_changeset': {
      exact(result, ['kind', 'workflow'], path); required(result, ['kind', 'workflow'], path);
      const workflow = exact(result.workflow, ['kind', 'id', 'expiresAt'], `${path}.workflow`);
      required(workflow, ['kind', 'id', 'expiresAt'], `${path}.workflow`);
      if (workflow.kind !== (result.kind === 'pending_approval' ? 'approval' : 'changeset')) fail(`${path}.workflow.kind`);
      uuid(workflow.id, `${path}.workflow.id`); timestamp(workflow.expiresAt, `${path}.workflow.expiresAt`); return;
    }
    case 'rejected': exact(result, ['kind', 'error'], path); required(result, ['kind', 'error'], path); validateSerializedError(result.error, `${path}.error`); return;
    default: fail(`${path}.kind`);
  }
}

export function validateAgentQueryOutcome(value: unknown, path = 'outcome'): asserts value is AgentQueryOutcome {
  const result = object(value, path);
  if (result.kind === 'completed') {
    exact(result, ['kind', 'result', 'page'], path); required(result, ['kind', 'result'], path); validateJsonObject(result.result, `${path}.result`);
    if (result.page !== undefined) validatePageInfo(result.page, `${path}.page`);
    return;
  }
  if (result.kind === 'rejected') {
    exact(result, ['kind', 'error'], path); required(result, ['kind', 'error'], path); validateSerializedError(result.error, `${path}.error`); return;
  }
  fail(`${path}.kind`);
}

export function isReceiptTransitionAllowed(from: ReceiptStatus | null, to: ReceiptStatus): boolean {
  if (from === null) return to === 'admitted';
  return from === 'admitted' && (terminalReceiptStatuses as readonly string[]).includes(to);
}

export function assertReceiptTransition(from: ReceiptStatus | null, to: ReceiptStatus): void {
  if (!isReceiptTransitionAllowed(from, to)) throw new AgentError('INVALID_RECEIPT_TRANSITION');
}

export function validateExecutionReceipt(value: unknown, path = 'receipt'): asserts value is ExecutionReceipt {
  const result = exact(value, [
    'apiVersion', 'receiptId', 'clientId', 'requestId', 'operation', 'payloadHash', 'affectedSetHash', 'catalog', 'baseVersion',
    'status', 'dataVersion', 'outcomeHash', 'error', 'createdAt', 'updatedAt'
  ], path);
  required(result, ['apiVersion', 'receiptId', 'clientId', 'requestId', 'operation', 'payloadHash', 'catalog', 'status', 'createdAt', 'updatedAt'], path);
  validateApiVersion(result.apiVersion, `${path}.apiVersion`); uuid(result.receiptId, `${path}.receiptId`); safeName(result.clientId, `${path}.clientId`);
  uuid(result.requestId, `${path}.requestId`); validateOperationName(result.operation, `${path}.operation`); hash(result.payloadHash, `${path}.payloadHash`);
  if (result.affectedSetHash !== undefined) hash(result.affectedSetHash, `${path}.affectedSetHash`);
  validateCatalogIdentity(result.catalog, `${path}.catalog`); if (result.baseVersion !== undefined) validateGatewayDataVersion(result.baseVersion, `${path}.baseVersion`);
  oneOf(result.status, receiptStatuses, `${path}.status`); if (result.dataVersion !== undefined) validateGatewayDataVersion(result.dataVersion, `${path}.dataVersion`);
  if (result.outcomeHash !== undefined) hash(result.outcomeHash, `${path}.outcomeHash`); if (result.error !== undefined) validateSerializedError(result.error, `${path}.error`);
  timestamp(result.createdAt, `${path}.createdAt`); timestamp(result.updatedAt, `${path}.updatedAt`);
  if (result.updatedAt < result.createdAt) fail(`${path}.updatedAt`);
  if (result.status === 'admitted' && (result.dataVersion !== undefined || result.outcomeHash !== undefined || result.error !== undefined)) fail(path);
  if (result.status === 'completed' && (result.outcomeHash === undefined || result.error !== undefined)) fail(path);
  if (result.status !== 'admitted' && result.status !== 'completed' && result.error === undefined) fail(`${path}.error`);
}

export function validateAuditCursor(value: unknown, path = 'cursor'): asserts value is AuditCursor {
  const result = exact(value, ['apiVersion', 'kind', 'value'], path);
  required(result, ['apiVersion', 'kind', 'value'], path); validateApiVersion(result.apiVersion, `${path}.apiVersion`);
  if (result.kind !== 'audit-cursor') fail(`${path}.kind`); cursor(result.value, `${path}.value`);
}

export function validateRedactionProfile(value: unknown, path = 'redaction'): asserts value is RedactionProfile {
  const result = exact(value, ['apiVersion', 'kind', 'detail', 'includeUserContent', 'includeAffectedEntities', 'fields'], path);
  required(result, ['apiVersion', 'kind', 'detail', 'includeUserContent', 'includeAffectedEntities', 'fields'], path);
  validateApiVersion(result.apiVersion, `${path}.apiVersion`); if (result.kind !== 'redaction-profile') fail(`${path}.kind`);
  oneOf(result.detail, detailLevels, `${path}.detail`); boolean(result.includeUserContent, `${path}.includeUserContent`);
  boolean(result.includeAffectedEntities, `${path}.includeAffectedEntities`); sortedUniqueFields(result.fields, `${path}.fields`);
}

function validateEntityRef(value: unknown, path: string): asserts value is EntityRef {
  const result = exact(value, ['entityType', 'entityId'], path); required(result, ['entityType', 'entityId'], path);
  safeName(result.entityType, `${path}.entityType`); string(result.entityId, `${path}.entityId`, 200);
}

export function validateAuditRecord(value: unknown, path = 'audit'): asserts value is AuditRecord {
  const result = exact(value, [
    'apiVersion', 'auditId', 'segmentId', 'sequence', 'kind', 'occurredAt', 'clientId', 'requestId', 'operation', 'risk',
    'catalog', 'receiptId', 'summary', 'affectedEntities', 'previousHash', 'recordHash'
  ], path);
  required(result, ['apiVersion', 'auditId', 'segmentId', 'sequence', 'kind', 'occurredAt', 'clientId', 'catalog', 'summary', 'affectedEntities', 'recordHash'], path);
  validateApiVersion(result.apiVersion, `${path}.apiVersion`); uuid(result.auditId, `${path}.auditId`); uuid(result.segmentId, `${path}.segmentId`);
  safeNonNegative(result.sequence, `${path}.sequence`); oneOf(result.kind, auditKinds, `${path}.kind`); timestamp(result.occurredAt, `${path}.occurredAt`);
  safeName(result.clientId, `${path}.clientId`); if (result.requestId !== undefined) uuid(result.requestId, `${path}.requestId`);
  if (result.operation !== undefined) validateOperationName(result.operation, `${path}.operation`); if (result.risk !== undefined) oneOf(result.risk, riskLevels, `${path}.risk`);
  validateCatalogIdentity(result.catalog, `${path}.catalog`); if (result.receiptId !== undefined) uuid(result.receiptId, `${path}.receiptId`);
  validateJsonObject(result.summary, `${path}.summary`); array(result.affectedEntities, `${path}.affectedEntities`, validateEntityRef, gatewayMaxAffectedEntities);
  if (result.previousHash !== undefined) hash(result.previousHash, `${path}.previousHash`); hash(result.recordHash, `${path}.recordHash`);
  if (result.sequence === 0 && result.previousHash !== undefined) fail(`${path}.previousHash`);
  if ((result.sequence as number) > 0 && result.previousHash === undefined) fail(`${path}.previousHash`);
}

export function validateR4Grant(value: unknown, path = 'grant'): asserts value is R4Grant {
  const result = exact(value, [
    'apiVersion', 'grantId', 'clientId', 'operation', 'payloadHash', 'targetHash', 'catalog', 'recovery', 'maxAffectedEntities', 'maxUses',
    'status', 'issuedAt', 'expiresAt', 'consumedAt', 'revokedAt'
  ], path);
  required(result, ['apiVersion', 'grantId', 'clientId', 'operation', 'payloadHash', 'targetHash', 'catalog', 'recovery', 'maxAffectedEntities', 'maxUses', 'status', 'issuedAt', 'expiresAt'], path);
  validateApiVersion(result.apiVersion, `${path}.apiVersion`); uuid(result.grantId, `${path}.grantId`); safeName(result.clientId, `${path}.clientId`);
  validateOperationName(result.operation, `${path}.operation`); hash(result.payloadHash, `${path}.payloadHash`); hash(result.targetHash, `${path}.targetHash`); validateCatalogIdentity(result.catalog, `${path}.catalog`);
  oneOf(result.recovery, recoveryRequirements, `${path}.recovery`); if (result.recovery === 'none') fail(`${path}.recovery`);
  boundedPositive(result.maxAffectedEntities, `${path}.maxAffectedEntities`, gatewayMaxAffectedEntities); if (result.maxUses !== 1) fail(`${path}.maxUses`);
  oneOf(result.status, r4GrantStatuses, `${path}.status`); timestamp(result.issuedAt, `${path}.issuedAt`); timestamp(result.expiresAt, `${path}.expiresAt`);
  if (result.expiresAt <= result.issuedAt || Date.parse(result.expiresAt) - Date.parse(result.issuedAt) > gatewayMaxR4GrantLifetimeMs) fail(`${path}.expiresAt`);
  if (result.consumedAt !== undefined) timestamp(result.consumedAt, `${path}.consumedAt`); if (result.revokedAt !== undefined) timestamp(result.revokedAt, `${path}.revokedAt`);
  if ((result.status === 'consumed') !== (result.consumedAt !== undefined)) fail(`${path}.consumedAt`);
  if ((result.status === 'revoked') !== (result.revokedAt !== undefined)) fail(`${path}.revokedAt`);
}

export function assertR4GrantBinding(
  grant: R4Grant,
  descriptor: OperationDescriptor,
  binding: R4GrantBinding
): void {
  validateR4Grant(grant);
  validateOperationDescriptor(descriptor, 'descriptor');
  validateCatalogIdentity(binding.catalog, 'binding.catalog');
  hash(binding.payloadHash, 'binding.payloadHash');
  hash(binding.targetHash, 'binding.targetHash');
  if (binding.resolvedRisk !== 'R4') throw new AgentError('R4_GRANT_INVALID');
  oneOf(binding.recovery, recoveryRequirements, 'binding.recovery');
  boundedPositive(binding.maxAffectedEntities, 'binding.maxAffectedEntities', gatewayMaxAffectedEntities);
  assertCatalogIdentity(grant.catalog, binding.catalog);
  if (
    descriptor.name !== binding.operation ||
    descriptor.catalogVersion !== binding.catalog.version ||
    descriptor.policyBounds.maximumRisk !== 'R4' ||
    !descriptor.policyBounds.requiresR4GrantWhenRiskR4 ||
    grant.operation !== binding.operation ||
    grant.payloadHash !== binding.payloadHash ||
    grant.targetHash !== binding.targetHash ||
    grant.recovery !== binding.recovery ||
    grant.recovery !== descriptor.recovery ||
    grant.maxAffectedEntities !== binding.maxAffectedEntities ||
    grant.maxAffectedEntities > descriptor.policyBounds.maxAffectedEntities
  ) {
    throw new AgentError('R4_GRANT_INVALID');
  }
}

export function validateR4Reservation(value: unknown, path = 'reservation'): asserts value is R4Reservation {
  const result = exact(value, ['apiVersion', 'reservationId', 'grantId', 'clientId', 'requestId', 'operation', 'payloadHash', 'affectedSetHash', 'baseVersion', 'catalog', 'reservedAt', 'expiresAt'], path);
  required(result, ['apiVersion', 'reservationId', 'grantId', 'clientId', 'requestId', 'operation', 'payloadHash', 'affectedSetHash', 'baseVersion', 'catalog', 'reservedAt', 'expiresAt'], path);
  validateApiVersion(result.apiVersion, `${path}.apiVersion`); uuid(result.reservationId, `${path}.reservationId`); uuid(result.grantId, `${path}.grantId`);
  safeName(result.clientId, `${path}.clientId`); uuid(result.requestId, `${path}.requestId`); validateOperationName(result.operation, `${path}.operation`);
  hash(result.payloadHash, `${path}.payloadHash`); hash(result.affectedSetHash, `${path}.affectedSetHash`); validateGatewayDataVersion(result.baseVersion, `${path}.baseVersion`);
  validateCatalogIdentity(result.catalog, `${path}.catalog`); timestamp(result.reservedAt, `${path}.reservedAt`); timestamp(result.expiresAt, `${path}.expiresAt`);
  if (result.expiresAt <= result.reservedAt) fail(`${path}.expiresAt`);
}

export function validateApprovalRecord(value: unknown, path = 'approval'): asserts value is ApprovalRecord {
  const result = exact(value, [
    'apiVersion', 'approvalId', 'nonce', 'clientId', 'credentialBinding', 'operation', 'payloadHash', 'affectedSetHash', 'baseVersion',
    'catalog', 'policyVersion', 'risk', 'requiredScopes', 'recovery', 'source', 'status', 'createdAt', 'expiresAt', 'consumedAt', 'revokedAt'
  ], path);
  required(result, ['apiVersion', 'approvalId', 'nonce', 'clientId', 'credentialBinding', 'operation', 'payloadHash', 'affectedSetHash', 'baseVersion', 'catalog', 'policyVersion', 'risk', 'requiredScopes', 'recovery', 'status', 'createdAt', 'expiresAt'], path);
  validateApiVersion(result.apiVersion, `${path}.apiVersion`); uuid(result.approvalId, `${path}.approvalId`); string(result.nonce, `${path}.nonce`, 500);
  safeName(result.clientId, `${path}.clientId`); string(result.credentialBinding, `${path}.credentialBinding`, 500); validateOperationName(result.operation, `${path}.operation`);
  hash(result.payloadHash, `${path}.payloadHash`); hash(result.affectedSetHash, `${path}.affectedSetHash`); validateGatewayDataVersion(result.baseVersion, `${path}.baseVersion`);
  validateCatalogIdentity(result.catalog, `${path}.catalog`); safeName(result.policyVersion, `${path}.policyVersion`); oneOf(result.risk, riskLevels, `${path}.risk`);
  uniqueStringArray(result.requiredScopes, agentScopes, `${path}.requiredScopes`); oneOf(result.recovery, recoveryRequirements, `${path}.recovery`);
  if (result.source !== undefined) oneOf(result.source, approvalSources, `${path}.source`); oneOf(result.status, approvalStatuses, `${path}.status`);
  timestamp(result.createdAt, `${path}.createdAt`); timestamp(result.expiresAt, `${path}.expiresAt`); if (result.expiresAt <= result.createdAt) fail(`${path}.expiresAt`);
  if (result.consumedAt !== undefined) timestamp(result.consumedAt, `${path}.consumedAt`); if (result.revokedAt !== undefined) timestamp(result.revokedAt, `${path}.revokedAt`);
}

function validatePlannedOperation(value: unknown, path: string): asserts value is PlannedOperation {
  const result = exact(value, ['operation', 'payload', 'payloadHash', 'affectedEntities'], path);
  required(result, ['operation', 'payload', 'payloadHash', 'affectedEntities'], path); validateOperationName(result.operation, `${path}.operation`);
  validateJsonObject(result.payload, `${path}.payload`); rejectCredentialMaterial(result.payload, `${path}.payload`); hash(result.payloadHash, `${path}.payloadHash`);
  array(result.affectedEntities, `${path}.affectedEntities`, validateEntityRef, gatewayMaxAffectedEntities);
}

export function validateChangeSet(value: unknown, path = 'changeSet'): asserts value is ChangeSet {
  const result = exact(value, [
    'apiVersion', 'changeSetId', 'clientId', 'status', 'catalog', 'baseVersion', 'risk', 'summary', 'operations', 'affectedSetHash',
    'recovery', 'recoveryAssetId', 'createdAt', 'expiresAt', 'appliedAt'
  ], path);
  required(result, ['apiVersion', 'changeSetId', 'clientId', 'status', 'catalog', 'baseVersion', 'risk', 'summary', 'operations', 'affectedSetHash', 'recovery', 'createdAt', 'expiresAt'], path);
  validateApiVersion(result.apiVersion, `${path}.apiVersion`); uuid(result.changeSetId, `${path}.changeSetId`); safeName(result.clientId, `${path}.clientId`);
  oneOf(result.status, changeSetStatuses, `${path}.status`); validateCatalogIdentity(result.catalog, `${path}.catalog`); validateGatewayDataVersion(result.baseVersion, `${path}.baseVersion`);
  oneOf(result.risk, ['R2', 'R3', 'R4'] as const, `${path}.risk`); string(result.summary, `${path}.summary`, 2000);
  array(result.operations, `${path}.operations`, validatePlannedOperation, gatewayMaxChangeSetOperations, 1); hash(result.affectedSetHash, `${path}.affectedSetHash`);
  oneOf(result.recovery, recoveryRequirements, `${path}.recovery`); if (result.risk === 'R4' && result.recovery === 'none') fail(`${path}.recovery`);
  if (result.recoveryAssetId !== undefined) uuid(result.recoveryAssetId, `${path}.recoveryAssetId`);
  timestamp(result.createdAt, `${path}.createdAt`); timestamp(result.expiresAt, `${path}.expiresAt`); if (result.expiresAt <= result.createdAt) fail(`${path}.expiresAt`);
  if (result.appliedAt !== undefined) timestamp(result.appliedAt, `${path}.appliedAt`); if ((result.status === 'applied') !== (result.appliedAt !== undefined)) fail(`${path}.appliedAt`);
}

export function validatePolicyDecision(value: unknown, path = 'decision'): asserts value is PolicyDecision {
  const result = exact(value, ['apiVersion', 'disposition', 'risk', 'reasonCode', 'requiredScopes', 'catalog', 'policyVersion'], path);
  required(result, ['apiVersion', 'disposition', 'risk', 'reasonCode', 'requiredScopes', 'catalog', 'policyVersion'], path);
  validateApiVersion(result.apiVersion, `${path}.apiVersion`); oneOf(result.disposition, policyDispositions, `${path}.disposition`);
  oneOf(result.risk, riskLevels, `${path}.risk`); safeName(result.reasonCode, `${path}.reasonCode`); uniqueStringArray(result.requiredScopes, agentScopes, `${path}.requiredScopes`);
  validateCatalogIdentity(result.catalog, `${path}.catalog`); safeName(result.policyVersion, `${path}.policyVersion`);
}

function validatePolicyBounds(value: unknown, path: string): asserts value is DescriptorPolicyBounds {
  const result = exact(value, ['minimumRisk', 'maximumRisk', 'maxAffectedEntities', 'maxPageSize', 'approval', 'requiresChangeSet', 'requiresR4GrantWhenRiskR4'], path);
  required(result, ['minimumRisk', 'maximumRisk', 'maxAffectedEntities', 'maxPageSize', 'approval', 'requiresChangeSet', 'requiresR4GrantWhenRiskR4'], path);
  oneOf(result.minimumRisk, riskLevels, `${path}.minimumRisk`); oneOf(result.maximumRisk, riskLevels, `${path}.maximumRisk`);
  if (riskLevels.indexOf(result.minimumRisk as typeof riskLevels[number]) > riskLevels.indexOf(result.maximumRisk as typeof riskLevels[number])) fail(path);
  boundedPositive(result.maxAffectedEntities, `${path}.maxAffectedEntities`, gatewayMaxAffectedEntities);
  boundedPositive(result.maxPageSize, `${path}.maxPageSize`, gatewayMaxPageSize); oneOf(result.approval, approvalRequirements, `${path}.approval`);
  boolean(result.requiresChangeSet, `${path}.requiresChangeSet`);
  boolean(result.requiresR4GrantWhenRiskR4, `${path}.requiresR4GrantWhenRiskR4`);
  if (result.maximumRisk === 'R4' && !result.requiresR4GrantWhenRiskR4) fail(`${path}.requiresR4GrantWhenRiskR4`);
  if (result.maximumRisk !== 'R4' && result.requiresR4GrantWhenRiskR4) fail(`${path}.requiresR4GrantWhenRiskR4`);
  if (result.minimumRisk === 'R4' && result.approval !== 'r4_grant') fail(`${path}.approval`);
}

export function validateOperationDescriptor(value: unknown, path = 'descriptor'): asserts value is OperationDescriptor {
  const result = exact(value, [
    'apiVersion', 'name', 'kind', 'domain', 'catalogVersion', 'inputSchema', 'outputSchema', 'requiredScopes', 'sideEffects',
    'idempotency', 'recovery', 'riskResolver', 'policyBounds', 'rendererManagement', 'allowedWhenExternalControlDisabled'
  ], path);
  required(result, ['apiVersion', 'name', 'kind', 'domain', 'catalogVersion', 'inputSchema', 'outputSchema', 'requiredScopes', 'sideEffects', 'idempotency', 'recovery', 'riskResolver', 'policyBounds', 'rendererManagement', 'allowedWhenExternalControlDisabled'], path);
  validateApiVersion(result.apiVersion, `${path}.apiVersion`); validateOperationName(result.name, `${path}.name`); oneOf(result.kind, operationKinds, `${path}.kind`);
  oneOf(result.domain, operationDomains, `${path}.domain`); if (typeof result.catalogVersion !== 'string' || !CATALOG_VERSION.test(result.catalogVersion)) fail(`${path}.catalogVersion`);
  safeName(result.inputSchema, `${path}.inputSchema`); safeName(result.outputSchema, `${path}.outputSchema`);
  uniqueStringArray(result.requiredScopes, agentScopes, `${path}.requiredScopes`);
  if ((result.requiredScopes as readonly unknown[]).length === 0) fail(`${path}.requiredScopes`);
  uniqueStringArray(result.sideEffects, sideEffectKinds, `${path}.sideEffects`);
  oneOf(result.idempotency, idempotencyRequirements, `${path}.idempotency`); oneOf(result.recovery, recoveryRequirements, `${path}.recovery`);
  oneOf(result.riskResolver, riskResolvers, `${path}.riskResolver`); validatePolicyBounds(result.policyBounds, `${path}.policyBounds`);
  boolean(result.rendererManagement, `${path}.rendererManagement`); boolean(result.allowedWhenExternalControlDisabled, `${path}.allowedWhenExternalControlDisabled`);
  const isCommand = (gatewayWorkflowCommandTypes as readonly string[]).includes(result.name as string) || (gatewayBusinessCommandTypes as readonly string[]).includes(result.name as string);
  if ((result.kind === 'command') !== isCommand) fail(`${path}.kind`);
  if (result.kind === 'command' && result.idempotency !== 'required') fail(`${path}.idempotency`);
  if (result.kind === 'query' && result.sideEffects !== undefined && (result.sideEffects as readonly unknown[]).length > 0) fail(`${path}.sideEffects`);
  if (result.rendererManagement && result.domain !== 'management') fail(`${path}.rendererManagement`);
  if (result.allowedWhenExternalControlDisabled !== result.rendererManagement) fail(`${path}.allowedWhenExternalControlDisabled`);
  if (result.policyBounds.minimumRisk === 'R4' && result.recovery === 'none') fail(`${path}.recovery`);
}

export function catalogHashInput(catalog: Pick<OperationCatalog, 'apiVersion' | 'version' | 'hashAlgorithm' | 'operations'>): JsonObject {
  return {
    apiVersion: catalog.apiVersion,
    version: catalog.version,
    hashAlgorithm: catalog.hashAlgorithm,
    operations: catalog.operations as unknown as JsonObject['operations']
  };
}

export function validateOperationCatalog(value: unknown, path = 'catalog'): asserts value is OperationCatalog {
  const result = exact(value, ['apiVersion', 'version', 'hashAlgorithm', 'hash', 'operations'], path);
  required(result, ['apiVersion', 'version', 'hashAlgorithm', 'hash', 'operations'], path); validateApiVersion(result.apiVersion, `${path}.apiVersion`);
  if (typeof result.version !== 'string' || !CATALOG_VERSION.test(result.version)) fail(`${path}.version`);
  if (result.hashAlgorithm !== canonicalHashAlgorithm) fail(`${path}.hashAlgorithm`); hash(result.hash, `${path}.hash`);
  array(result.operations, `${path}.operations`, validateOperationDescriptor, operationNames.length, operationNames.length);
  const operations = result.operations as readonly OperationDescriptor[];
  const names = operations.map(({ name }) => name);
  if (new Set(names).size !== names.length || names.some((name, index) => index > 0 && names[index - 1] >= name)) fail(`${path}.operations`);
  if (names.length !== operationNames.length || operationNames.some((name) => !names.includes(name))) fail(`${path}.operations`);
  if (operations.some((descriptor) => descriptor.catalogVersion !== result.version)) fail(`${path}.operations`);
  const expectedHash = hashCanonicalJson(catalogHashInput(result as unknown as OperationCatalog));
  if (result.hash !== expectedHash) throw new AgentError('CATALOG_VERSION_MISMATCH');
}

export function validateOperationPolicyOverride(
  value: unknown,
  descriptor: OperationDescriptor,
  catalog: CatalogIdentity,
  path = 'override'
): asserts value is OperationPolicyOverride {
  validateOperationDescriptor(descriptor, 'descriptor'); validateCatalogIdentity(catalog, 'catalog');
  const result = exact(value, ['apiVersion', 'operation', 'catalog', 'enabled', 'minimumRisk', 'maxAffectedEntities', 'maxPageSize', 'requireApproval', 'requireChangeSet'], path);
  required(result, ['apiVersion', 'operation', 'catalog'], path); validateApiVersion(result.apiVersion, `${path}.apiVersion`);
  if (result.operation !== descriptor.name) fail(`${path}.operation`); validateCatalogIdentity(result.catalog, `${path}.catalog`);
  assertCatalogIdentity(result.catalog as unknown as CatalogIdentity, catalog);
  if (result.enabled !== undefined) boolean(result.enabled, `${path}.enabled`);
  if (result.minimumRisk !== undefined) {
    oneOf(result.minimumRisk, riskLevels, `${path}.minimumRisk`);
    if (riskLevels.indexOf(result.minimumRisk as typeof riskLevels[number]) < riskLevels.indexOf(descriptor.policyBounds.minimumRisk)) throw new AgentError('POLICY_INVARIANT_VIOLATION');
  }
  if (result.maxAffectedEntities !== undefined) {
    boundedPositive(result.maxAffectedEntities, `${path}.maxAffectedEntities`, descriptor.policyBounds.maxAffectedEntities);
  }
  if (result.maxPageSize !== undefined) boundedPositive(result.maxPageSize, `${path}.maxPageSize`, descriptor.policyBounds.maxPageSize);
  if (result.requireApproval !== undefined) {
    boolean(result.requireApproval, `${path}.requireApproval`);
    if (!result.requireApproval && descriptor.policyBounds.approval !== 'never') throw new AgentError('POLICY_INVARIANT_VIOLATION');
  }
  if (result.requireChangeSet !== undefined) {
    boolean(result.requireChangeSet, `${path}.requireChangeSet`);
    if (!result.requireChangeSet && descriptor.policyBounds.requiresChangeSet) throw new AgentError('POLICY_INVARIANT_VIOLATION');
  }
}

function validatePagedPayload(result: MutableJsonObject, path: string): void {
  if (result.cursor !== undefined) cursor(result.cursor, `${path}.cursor`);
  boundedPositive(result.pageSize, `${path}.pageSize`, gatewayMaxPageSize);
}

export function validateGatewayWorkflowCommand(value: unknown, path = 'command'): asserts value is GatewayWorkflowCommand {
  const command = exact(value, ['type', 'payload'], path); required(command, ['type', 'payload'], path);
  oneOf(command.type, gatewayWorkflowCommandTypes, `${path}.type`);
  const payloadPath = `${path}.payload`;
  switch (command.type) {
    case 'agent.control.set_enabled': { const payload = exact(command.payload, ['enabled'], payloadPath); required(payload, ['enabled'], payloadPath); boolean(payload.enabled, `${payloadPath}.enabled`); return; }
    case 'agent.clients.revoke': { const payload = exact(command.payload, ['clientId'], payloadPath); required(payload, ['clientId'], payloadPath); safeName(payload.clientId, `${payloadPath}.clientId`); return; }
    case 'agent.sessions.terminate': { const payload = exact(command.payload, ['sessionId'], payloadPath); required(payload, ['sessionId'], payloadPath); uuid(payload.sessionId, `${payloadPath}.sessionId`); return; }
    case 'agent.r4_grants.create': { const payload = exact(command.payload, ['grant'], payloadPath); required(payload, ['grant'], payloadPath); validateR4Grant(payload.grant, `${payloadPath}.grant`); return; }
    case 'agent.r4_grants.revoke': { const payload = exact(command.payload, ['grantId'], payloadPath); required(payload, ['grantId'], payloadPath); uuid(payload.grantId, `${payloadPath}.grantId`); return; }
    case 'agent.approvals.approve': { const payload = exact(command.payload, ['approvalId'], payloadPath); required(payload, ['approvalId'], payloadPath); uuid(payload.approvalId, `${payloadPath}.approvalId`); return; }
    case 'agent.approvals.reject': { const payload = exact(command.payload, ['approvalId', 'reasonCode'], payloadPath); required(payload, ['approvalId', 'reasonCode'], payloadPath); uuid(payload.approvalId, `${payloadPath}.approvalId`); safeName(payload.reasonCode, `${payloadPath}.reasonCode`); return; }
    case 'agent.changesets.apply':
    case 'agent.changesets.rollback': { const payload = exact(command.payload, ['changeSetId'], payloadPath); required(payload, ['changeSetId'], payloadPath); uuid(payload.changeSetId, `${payloadPath}.changeSetId`); return; }
    case 'agent.changesets.reject': { const payload = exact(command.payload, ['changeSetId', 'reasonCode'], payloadPath); required(payload, ['changeSetId', 'reasonCode'], payloadPath); uuid(payload.changeSetId, `${payloadPath}.changeSetId`); safeName(payload.reasonCode, `${payloadPath}.reasonCode`); return; }
    case 'agent.policy.update': { const payload = exact(command.payload, ['policyVersion', 'overrides'], payloadPath); required(payload, ['policyVersion', 'overrides'], payloadPath); safeName(payload.policyVersion, `${payloadPath}.policyVersion`); array(payload.overrides, `${payloadPath}.overrides`, (entry, entryPath) => validateJsonObject(entry, entryPath), operationNames.length); return; }
    case 'agent.audit.export': { const payload = exact(command.payload, ['cursor', 'redaction', 'pageSize'], payloadPath); required(payload, ['redaction', 'pageSize'], payloadPath); if (payload.cursor !== undefined) validateAuditCursor(payload.cursor, `${payloadPath}.cursor`); validateRedactionProfile(payload.redaction, `${payloadPath}.redaction`); boundedPositive(payload.pageSize, `${payloadPath}.pageSize`, gatewayMaxPageSize); return; }
    case 'agent.audit.cleanup': { const payload = exact(command.payload, ['before', 'grantId'], payloadPath); required(payload, ['before', 'grantId'], payloadPath); timestamp(payload.before, `${payloadPath}.before`); uuid(payload.grantId, `${payloadPath}.grantId`); return; }
    default: fail(`${path}.type`);
  }
}

export function validateGatewayWorkflowQuery(value: unknown, path = 'query'): asserts value is GatewayWorkflowQuery {
  const query = exact(value, ['type', 'payload'], path); required(query, ['type', 'payload'], path); oneOf(query.type, gatewayWorkflowQueryTypes, `${path}.type`);
  const payloadPath = `${path}.payload`;
  switch (query.type) {
    case 'agent.status.get': case 'agent.policy.get': case 'agent.catalog.get': case 'agent.privacy.get': exact(query.payload, [], payloadPath); return;
    case 'agent.clients.list': { const payload = exact(query.payload, ['cursor', 'pageSize'], payloadPath); required(payload, ['pageSize'], payloadPath); validatePagedPayload(payload, payloadPath); return; }
    case 'agent.sessions.list': { const payload = exact(query.payload, ['clientId', 'cursor', 'pageSize'], payloadPath); required(payload, ['pageSize'], payloadPath); if (payload.clientId !== undefined) safeName(payload.clientId, `${payloadPath}.clientId`); validatePagedPayload(payload, payloadPath); return; }
    case 'agent.r4_grants.list': { const payload = exact(query.payload, ['clientId', 'status', 'cursor', 'pageSize'], payloadPath); required(payload, ['pageSize'], payloadPath); if (payload.clientId !== undefined) safeName(payload.clientId, `${payloadPath}.clientId`); if (payload.status !== undefined) oneOf(payload.status, r4GrantStatuses, `${payloadPath}.status`); validatePagedPayload(payload, payloadPath); return; }
    case 'agent.approvals.list': { const payload = exact(query.payload, ['status', 'cursor', 'pageSize'], payloadPath); required(payload, ['pageSize'], payloadPath); if (payload.status !== undefined) oneOf(payload.status, approvalStatuses, `${payloadPath}.status`); validatePagedPayload(payload, payloadPath); return; }
    case 'agent.changesets.list': { const payload = exact(query.payload, ['status', 'cursor', 'pageSize'], payloadPath); required(payload, ['pageSize'], payloadPath); if (payload.status !== undefined) oneOf(payload.status, changeSetStatuses, `${payloadPath}.status`); validatePagedPayload(payload, payloadPath); return; }
    case 'agent.changesets.get': { const payload = exact(query.payload, ['changeSetId'], payloadPath); required(payload, ['changeSetId'], payloadPath); uuid(payload.changeSetId, `${payloadPath}.changeSetId`); return; }
    case 'agent.audit.search': { const payload = exact(query.payload, ['cursor', 'kinds', 'clientId', 'pageSize', 'redaction'], payloadPath); required(payload, ['pageSize', 'redaction'], payloadPath); if (payload.cursor !== undefined) validateAuditCursor(payload.cursor, `${payloadPath}.cursor`); if (payload.kinds !== undefined) uniqueStringArray(payload.kinds, auditKinds, `${payloadPath}.kinds`); if (payload.clientId !== undefined) safeName(payload.clientId, `${payloadPath}.clientId`); boundedPositive(payload.pageSize, `${payloadPath}.pageSize`, gatewayMaxPageSize); validateRedactionProfile(payload.redaction, `${payloadPath}.redaction`); return; }
    case 'agent.audit.verify': { const payload = exact(query.payload, ['segmentId'], payloadPath); if (payload.segmentId !== undefined) uuid(payload.segmentId, `${payloadPath}.segmentId`); return; }
    default: fail(`${path}.type`);
  }
}

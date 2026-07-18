import type { AgentPrincipal, AgentScope, AgentExecuteOutcome, AgentQueryOutcome, CatalogIdentity, JsonObject, OperationName } from '../../agent/v1/gatewayContracts';
import type { DataVersion, EntityRef } from '../../agent/v1/contracts';
import type { SerializedAgentError } from '../../agent/errors';
import type { McpProtocolVersion } from './versions';

export type McpJsonPrimitive = boolean | number | string | null;
export type McpJsonValue = McpJsonPrimitive | McpJsonValue[] | { [key: string]: McpJsonValue };

export const mcpPrimitiveTypes = Object.freeze(['tool', 'resource', 'resource-template', 'prompt'] as const);
export type McpPrimitiveType = (typeof mcpPrimitiveTypes)[number];
export const mcpVisibilityKinds = Object.freeze(['authorized-principal', 'owner-or-admin', 'public'] as const);
export type McpVisibility = (typeof mcpVisibilityKinds)[number];
export const mcpExposureKinds = Object.freeze(['business', 'support'] as const);
export type McpExposure = (typeof mcpExposureKinds)[number];
export const mcpPaginationKinds = Object.freeze(['none', 'cursor'] as const);
export type McpPaginationKind = (typeof mcpPaginationKinds)[number];
export type McpOperationName = OperationName | 'mcp.capabilities.summary';

export interface McpPaginationPolicy {
  readonly kind: McpPaginationKind;
  readonly defaultPageSize: number;
  readonly maxPageSize: number;
}

export interface McpSchemaDescriptor {
  readonly id: string;
  readonly version: typeof import('./versions').mcpSchemaVersion;
  readonly direction: 'input' | 'output';
  readonly bounded: true;
}

export interface McpToolCall {
  readonly name: string;
  readonly arguments: JsonObject;
  readonly requestId: string;
}

export interface McpToolArgumentEnvelope {
  readonly apiVersion: 1;
  readonly kind: 'mcp-tool-arguments';
  readonly operation: OperationName;
  readonly requestId: string;
  readonly idempotencyKey?: string;
  readonly expectedVersion?: DataVersion;
  readonly payload: JsonObject;
}

export interface McpResourceRead {
  readonly uri: string;
  readonly requestId: string;
}

export interface McpPromptRequest {
  readonly name: string;
  readonly arguments?: Readonly<Record<string, string>>;
  readonly requestId: string;
}

export interface McpPageRequest {
  readonly cursor?: string;
  readonly pageSize: number;
}

export interface McpPageInfo {
  readonly nextCursor?: string;
  readonly pageSize: number;
  readonly hasMore: boolean;
}

export interface McpRegistryDescriptor {
  readonly name: string;
  readonly operation: McpOperationName;
  readonly catalog: CatalogIdentity;
  readonly exposure: McpExposure;
  readonly primitive: McpPrimitiveType;
  readonly description: string;
  readonly inputSchema: McpSchemaDescriptor;
  readonly outputSchema: McpSchemaDescriptor;
  readonly requiredScopes: readonly AgentScope[];
  readonly visibility: McpVisibility;
  readonly pagination: McpPaginationPolicy;
  readonly resultMapperId: string;
  readonly inputValidator: McpRuntimeValidator;
  readonly outputValidator: McpRuntimeValidator;
  readonly handler:
    | { readonly kind: 'gateway'; readonly gatewayMethod: 'execute' | 'query'; readonly operation: OperationName }
    | { readonly kind: 'local-summary'; readonly operation: 'mcp.capabilities.summary' };
  readonly uri?: string;
  readonly uriTemplate?: string;
  readonly promptArguments?: readonly string[];
}

export type McpRuntimeValidator = (value: unknown) => void;

export interface McpSupportPrimitiveDescriptor extends Omit<McpRegistryDescriptor, 'catalog' | 'inputSchema' | 'outputSchema' | 'pagination' | 'inputValidator' | 'outputValidator' | 'handler'> {
  readonly support: true;
  readonly exposure: 'support';
  readonly catalog?: CatalogIdentity;
  readonly uri?: string;
  readonly uriTemplate?: string;
  readonly promptArguments?: readonly string[];
  readonly inputSchema?: McpSchemaDescriptor;
  readonly outputSchema?: McpSchemaDescriptor;
  readonly pagination?: McpPaginationPolicy;
  readonly inputValidator?: McpRuntimeValidator;
  readonly outputValidator?: McpRuntimeValidator;
  readonly handler?: McpRegistryDescriptor['handler'];
}

export interface McpServerInstructions {
  readonly version: typeof import('./versions').mcpSchemaVersion;
  readonly text: string;
  readonly length: number;
}

export interface McpStructuredSuccess {
  readonly schemaVersion: typeof import('./versions').mcpSchemaVersion;
  readonly ok: true;
  readonly operation: McpOperationName;
  readonly requestId: string;
  readonly data: McpJsonValue;
  readonly receiptId?: string;
  readonly dataVersion?: DataVersion;
  readonly affectedEntities?: readonly EntityRef[];
  readonly recovery?: 'none' | 'retry' | 'receipt-status' | 'approval' | 'changeset';
  readonly page?: McpPageInfo;
}

export interface McpStructuredToolError {
  readonly schemaVersion: typeof import('./versions').mcpSchemaVersion;
  readonly ok: false;
  readonly kind: 'tool-error';
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly field?: string;
  readonly recovery?: 'receipt-status' | 'approval' | 'changeset';
  readonly workflow?: { readonly kind: 'approval' | 'changeset'; readonly id: string; readonly expiresAt: string };
}

export interface McpTransportError {
  readonly schemaVersion: typeof import('./versions').mcpSchemaVersion;
  readonly ok: false;
  readonly kind: 'transport-error';
  readonly category: 'authentication' | 'lifecycle' | 'protocol';
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type McpStructuredOutcome = McpStructuredSuccess | McpStructuredToolError | McpTransportError;

export interface McpCapabilitySummary {
  readonly schemaVersion: typeof import('./versions').mcpSchemaVersion;
  readonly protocolVersions: readonly McpProtocolVersion[];
  readonly currentProtocolVersion: McpProtocolVersion;
  readonly tasks: boolean;
  readonly tools: number;
  readonly resources: number;
  readonly resourceTemplates: number;
  readonly prompts: number;
}

export interface McpGatewayResultInput {
  readonly operation: OperationName;
  readonly requestId: string;
  readonly outcome: AgentExecuteOutcome | AgentQueryOutcome;
}

export interface McpAuthenticatedPrincipalContext {
  readonly principal: AgentPrincipal;
}

export type McpCapabilitySummaryHandler = (context: McpAuthenticatedPrincipalContext) => McpCapabilitySummary;

export type McpGatewayValue = JsonObject;
export type McpSerializedGatewayError = SerializedAgentError;

import { randomUUID } from 'node:crypto';
import type { AgentGateway, AgentPrincipal, JsonObject, SafeReceiptStatusResult } from '../../shared/agent/v1/gatewayContracts';
import { operationCatalogIdentity } from '../../shared/agent/v1/operationCatalog';
import { validateSafeReceiptStatusResult } from '../../shared/agent/v1/gatewaySchemas';
import { AgentError, serializeAgentError } from '../../shared/agent/errors';
import { McpValidationError, validateMcpCapabilitySummary, validateMcpStructuredOutcome } from '../../shared/mcp/v1/schemas';
import { mcpSchemaVersion, mcpServerVersion } from '../../shared/mcp/v1/versions';
import type { McpJsonValue, McpRegistryDescriptor, McpStructuredOutcome } from '../../shared/mcp/v1/contracts';
import { mcpServerInstructionsValue } from '../../shared/mcp/v1/prompts';
import { mapGatewayTerminalToMcpOutcome } from '../../shared/mcp/v1/launcherContracts';
import { mcpV1BusinessRegistry, mcpV1RegistryByName, createMcpCapabilitySummary } from './registry';
import { visibleResources, visibleResourceTemplates } from './resources';
import { getPromptMessages, visiblePrompts } from './prompts';
import { applyMcpListPolicy, applyPrincipalDataPolicy, toolInputSchema, visibleToPrincipal } from './tools';
import { mapMcpError, mapMcpGatewayResult } from './resultMapping';

interface JsonRpcRequest {
  readonly id?: string | number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface McpProtocolOptions {
  readonly gateway: AgentGateway;
  readonly now?: () => Date;
  readonly randomUUID?: () => string;
}

export const mcpInitializeResult = Object.freeze({
  capabilities: Object.freeze({
    tools: Object.freeze({ listChanged: false }),
    resources: Object.freeze({ subscribe: false, listChanged: false }),
    prompts: Object.freeze({ listChanged: false })
  }),
  serverInfo: Object.freeze({ name: 'kaoyan-mcp', version: mcpServerVersion }),
  instructions: mcpServerInstructionsValue.text
});

function rpcError(id: unknown, code: number, message: string, data?: unknown): object {
  return { jsonrpc: '2.0', id: typeof id === 'string' || typeof id === 'number' ? id : null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function rpcResult(id: unknown, result: unknown): object {
  return { jsonrpc: '2.0', id: typeof id === 'string' || typeof id === 'number' ? id : null, result };
}

function params(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentError('VALIDATION_ERROR', { field: 'params' });
  return value as Record<string, unknown>;
}

function name(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) throw new AgentError('VALIDATION_ERROR', { field });
  return value;
}

function toolDescriptor(toolName: unknown, principal: AgentPrincipal): McpRegistryDescriptor {
  const descriptor = mcpV1RegistryByName[name(toolName, 'params.name')];
  if (!descriptor || descriptor.primitive !== 'tool' || descriptor.exposure !== 'business' || !visibleToPrincipal(descriptor, principal.scopes)) {
    throw new AgentError('SCOPE_DENIED');
  }
  return descriptor;
}

function queryPage(descriptor: McpRegistryDescriptor, payload: JsonObject): { readonly pageSize: number; readonly detail: 'summary' | 'standard' | 'full' } | undefined {
  if (descriptor.pagination.kind !== 'cursor') return undefined;
  const candidate = typeof payload.limit === 'number' ? payload.limit : descriptor.pagination.defaultPageSize;
  const pageSize = Math.max(1, Math.min(descriptor.pagination.maxPageSize, Number.isSafeInteger(candidate) ? candidate : descriptor.pagination.defaultPageSize));
  const detail = descriptor.operation.endsWith('.get') ? 'full' : 'summary';
  return Object.freeze({ pageSize, detail });
}

function outcomeText(outcome: McpStructuredOutcome): string {
  return JSON.stringify(outcome);
}

function toolResult(outcome: McpStructuredOutcome): object {
  validateMcpStructuredOutcome(outcome);
  return Object.freeze({ content: Object.freeze([{ type: 'text', text: outcomeText(outcome) }]), structuredContent: outcome, isError: !outcome.ok });
}

function resourceContent(uri: string, outcome: McpStructuredOutcome): object {
  validateMcpStructuredOutcome(outcome);
  return Object.freeze({ contents: Object.freeze([{ uri, mimeType: 'application/json', text: outcomeText(outcome) }]) });
}

function localSummary(principal: AgentPrincipal, requestId: string): McpStructuredOutcome {
  const data = createMcpCapabilitySummary(principal);
  validateMcpCapabilitySummary(data);
  return Object.freeze({ schemaVersion: mcpSchemaVersion, ok: true as const, operation: 'mcp.capabilities.summary' as const, requestId, data: data as unknown as McpJsonValue, recovery: 'none' as const });
}

function readResourceUri(uri: string): { readonly descriptor: McpRegistryDescriptor; readonly payload: JsonObject } {
  if (uri === 'kaoyan://capabilities/summary') return { descriptor: mcpV1RegistryByName['capabilities.summary'], payload: {} };
  if (uri === 'kaoyan://reviews/today') return { descriptor: mcpV1RegistryByName['reviews.today'], payload: {} };
  if (uri === 'kaoyan://tasks/today') return { descriptor: mcpV1RegistryByName['tasks.today'], payload: { filters: {} } };
  const question = uri.match(/^kaoyan:\/\/questions\/([1-9][0-9]*)$/);
  if (question) return { descriptor: mcpV1RegistryByName['questions.view'], payload: { questionId: Number(question[1]) } };
  const task = uri.match(/^kaoyan:\/\/tasks\/([^/]+)$/);
  if (task && task[1] !== 'today') return { descriptor: mcpV1RegistryByName['tasks.view'], payload: { taskId: decodeURIComponent(task[1]) } };
  throw new AgentError('HANDLER_NOT_FOUND');
}

function safeResourceDescriptor(descriptor: McpRegistryDescriptor, principal: AgentPrincipal): McpRegistryDescriptor {
  if (!visibleToPrincipal(descriptor, principal.scopes)) throw new AgentError('SCOPE_DENIED');
  return descriptor;
}

async function callTool(options: McpProtocolOptions, request: JsonRpcRequest, principal: AgentPrincipal): Promise<object> {
  try {
    const requestParams = params(request.params);
    const descriptor = toolDescriptor(requestParams.name, principal);
    if (!requestParams.arguments || typeof requestParams.arguments !== 'object' || Array.isArray(requestParams.arguments)) throw new AgentError('VALIDATION_ERROR', { field: 'params.arguments' });
    const argumentsValue = requestParams.arguments as Record<string, unknown>;
    descriptor.inputValidator(argumentsValue);
    const requestId = argumentsValue.requestId as string;
    const payload = argumentsValue.payload as JsonObject;
    const handler = descriptor.handler;
    if (handler.kind !== 'gateway') throw new AgentError('HANDLER_NOT_FOUND');
    const outcome = handler.gatewayMethod === 'execute'
      ? await options.gateway.execute(Object.freeze({ apiVersion: 1 as const, kind: 'agent-command' as const, operation: handler.operation, payload, requestId,
          expectedVersion: argumentsValue.expectedVersion as { readonly dataEpoch: string; readonly dataRevision: number }, catalog: operationCatalogIdentity }), principal)
      : await options.gateway.query(Object.freeze({ apiVersion: 1 as const, kind: 'agent-query' as const, operation: handler.operation, payload, requestId,
          ...(queryPage(descriptor, payload) ? { page: queryPage(descriptor, payload) } : {}), catalog: operationCatalogIdentity }), principal);
    const mappedBase = mapMcpGatewayResult({ operation: handler.operation, requestId, outcome });
    const mapped = descriptor.pagination.kind === 'cursor'
      ? applyMcpListPolicy(mappedBase, principal, descriptor.pagination.maxPageSize)
      : applyPrincipalDataPolicy(mappedBase, principal);
    return rpcResult(request.id, toolResult(mapped));
  } catch (error) {
    const mapped = mapMcpError(error instanceof McpValidationError ? new AgentError('VALIDATION_ERROR', { field: error.path }) : error);
    return rpcResult(request.id, toolResult(mapped));
  }
}

async function readResource(options: McpProtocolOptions, request: JsonRpcRequest, principal: AgentPrincipal): Promise<object> {
  try {
    const requestParams = params(request.params);
    const uri = name(requestParams.uri, 'params.uri');
    const target = readResourceUri(uri);
    const descriptor = safeResourceDescriptor(target.descriptor, principal);
    if (descriptor.handler.kind === 'local-summary') return rpcResult(request.id, resourceContent(uri, localSummary(principal, (options.randomUUID ?? randomUUID)())));
    const operation = descriptor.handler.operation;
    const requestId = (options.randomUUID ?? randomUUID)();
    const envelope = Object.freeze({ apiVersion: 1 as const, kind: 'agent-query' as const, operation, payload: target.payload,
      ...(queryPage(descriptor, target.payload) ? { page: queryPage(descriptor, target.payload) } : {}), requestId, catalog: operationCatalogIdentity });
    const outcome = await options.gateway.query(envelope, principal);
    const mappedBase = mapMcpGatewayResult({ operation, requestId, outcome });
    const mapped = descriptor.pagination.kind === 'cursor'
      ? applyMcpListPolicy(mappedBase, principal, descriptor.pagination.maxPageSize)
      : applyPrincipalDataPolicy(mappedBase, principal);
    return mapped.ok ? rpcResult(request.id, resourceContent(uri, mapped)) : rpcError(request.id, -32000, 'Resource read failed', mapped);
  } catch (error) {
    return rpcError(request.id, -32602, 'Resource read failed', serializeAgentError(error));
  }
}

async function receiptStatus(
  options: McpProtocolOptions,
  request: JsonRpcRequest,
  principal: AgentPrincipal,
  projectPublicOutcome: boolean
): Promise<object> {
  try {
    const requestParams = params(request.params);
    const clientId = name(requestParams.clientId, 'params.clientId');
    const receiptRequestId = name(requestParams.requestId, 'params.requestId');
    const outcome = await options.gateway.query(Object.freeze({ apiVersion: 1 as const, kind: 'agent-query' as const,
      operation: 'agent.receipts.get_status' as const, payload: { clientId, requestId: receiptRequestId }, requestId: receiptRequestId, catalog: operationCatalogIdentity }), principal);
    if (outcome.kind === 'completed') {
      validateSafeReceiptStatusResult(outcome.result.value);
      const receipt = outcome.result.value as SafeReceiptStatusResult;
      if (!projectPublicOutcome) return rpcResult(request.id, receipt);
      const publicOutcome = receipt.terminal
        ? applyPrincipalDataPolicy(mapGatewayTerminalToMcpOutcome(receipt.receipt.operation, receiptRequestId, receipt.terminal), principal)
        : undefined;
      return rpcResult(request.id, Object.freeze({
        kind: 'mcp-receipt-projection' as const,
        receipt,
        ...(publicOutcome ? { publicOutcome } : {})
      }));
    }
    return rpcError(request.id, -32004, 'Receipt outcome is unavailable', mapMcpGatewayResult({ operation: 'agent.receipts.get_status', requestId: receiptRequestId, outcome }));
  } catch (error) {
    return rpcError(request.id, -32004, 'Receipt outcome is unavailable', serializeAgentError(error));
  }
}

export function createMcpProtocolHandler(options: McpProtocolOptions): (input: {
  readonly principal: AgentPrincipal;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly request: Readonly<Record<string, unknown>>;
}) => Promise<{ readonly status: number; readonly body: unknown }> {
  return async ({ principal, headers, request: rawRequest }) => {
    const request = rawRequest as unknown as JsonRpcRequest;
    try {
      if (request.method === 'tools/list') {
        const tools = mcpV1BusinessRegistry.filter((descriptor) => visibleToPrincipal(descriptor, principal.scopes)).map((descriptor) => ({
          name: descriptor.name, description: descriptor.description, inputSchema: toolInputSchema(descriptor)
        }));
        return { status: 200, body: rpcResult(request.id, { tools }) };
      }
      if (request.method === 'tools/call') return { status: 200, body: await callTool(options, request, principal) };
      if (request.method === 'resources/list') {
        const resources = visibleResources(principal).map(({ descriptor }) => ({ uri: descriptor.uri!, name: descriptor.name, description: descriptor.description, mimeType: 'application/json' }));
        return { status: 200, body: rpcResult(request.id, { resources }) };
      }
      if (request.method === 'resources/templates/list') {
        const resourceTemplates = visibleResourceTemplates(principal).map(({ descriptor }) => ({ uriTemplate: descriptor.uriTemplate!, name: descriptor.name, description: descriptor.description, mimeType: 'application/json' }));
        return { status: 200, body: rpcResult(request.id, { resourceTemplates }) };
      }
      if (request.method === 'resources/read') return { status: 200, body: await readResource(options, request, principal) };
      if (request.method === 'prompts/list') {
        return { status: 200, body: rpcResult(request.id, { prompts: visiblePrompts(principal).map(({ name, description, arguments: promptArguments }) => ({ name, description, arguments: promptArguments })) }) };
      }
      if (request.method === 'prompts/get') {
        const requestParams = params(request.params);
        const promptName = name(requestParams.name, 'params.name');
        const descriptor = mcpV1RegistryByName[promptName];
        if (!descriptor || descriptor.primitive !== 'prompt' || !visibleToPrincipal(descriptor, principal.scopes)) throw new AgentError('SCOPE_DENIED');
        const values = requestParams.arguments && typeof requestParams.arguments === 'object' && !Array.isArray(requestParams.arguments) ? requestParams.arguments as Record<string, string> : undefined;
        if (values) {
          for (const [key, value] of Object.entries(values)) {
            if (!(descriptor.promptArguments ?? []).includes(key) || typeof value !== 'string' || value.length > 200 || value !== value.normalize('NFC')) throw new AgentError('VALIDATION_ERROR', { field: `params.arguments.${key}` });
          }
        }
        return { status: 200, body: rpcResult(request.id, getPromptMessages(promptName, values)) };
      }
      if (request.method === 'agent.receipts.get_status') return {
        status: 200,
        body: await receiptStatus(options, request, principal, headers?.['x-kaoyan-receipt-projection'] === 'mcp-v1')
      };
      return { status: 200, body: rpcError(request.id, -32601, 'MCP method is not available') };
    } catch (error) {
      return { status: 200, body: rpcError(request.id, -32602, 'MCP request parameters are invalid', serializeAgentError(error)) };
    }
  };
}

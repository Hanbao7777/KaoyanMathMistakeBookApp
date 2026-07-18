import type { AgentPrincipal, AgentScope, OperationName } from '../../shared/agent/v1/gatewayContracts';
import { validateQuestionCommand, validateQuestionQuery } from '../../shared/agent/v1/schemas';
import { operationCatalog, operationCatalogIdentity, resolveOperationDescriptor } from '../../shared/agent/v1/operationCatalog';
import { validateTickTickCommand, validateTickTickQuery } from '../application/ticktick/contracts';
import { validateKnowledgeCommand, validateKnowledgeQuery } from '../application/knowledge/contracts';
import { assertMcpExternalExposureManifest, mcpExternalExposureManifest, mcpExternalBusinessOperations } from '../../shared/mcp/v1/exposureManifest';
import { mcpCapabilityVersion, mcpCurrentProtocolVersion, mcpProtocolVersions, mcpSchemaVersion, mcpServerVersion } from '../../shared/mcp/v1/versions';
import type { McpCapabilitySummary, McpRegistryDescriptor, McpRuntimeValidator } from '../../shared/mcp/v1/contracts';
import { mcpServerInstructionsValue, mcpV1Prompts } from '../../shared/mcp/v1/prompts';
import { validateMcpRegistryDescriptor, validateMcpServerInstructions, validateMcpStructuredOutcome, validateMcpToolArgumentEnvelope } from '../../shared/mcp/v1/schemas';
import { resolveMcpResultMapper } from './resultMapping';
import { validateJobCancelInput, validateJobCreateInput, validateJobGetInput, validateJobListInput, validateJobResultInput } from '../../shared/agent/v1/jobs';

const descriptions: Readonly<Record<string, string>> = Object.freeze({
  'questions.create': 'Create one bounded mathematics question.', 'questions.update': 'Update one mathematics question with revision checks.',
  'questions.delete': 'Archive one mathematics question.', 'questions.remove_image': 'Remove one question image binding.',
  'questions.mark_mastery': 'Record a mastery level for one question.', 'questions.submit_review': 'Submit one bounded review result.',
  'questions.list': 'List summarized questions with bounded pagination.', 'questions.get': 'Read one authorized question.',
  'questions.review_logs': 'List review logs for one question.', 'questions.review_buckets': 'Read bounded review buckets.',
  'tasks.create': 'Create one bounded study task.', 'tasks.update': 'Update one study task with revision checks.',
  'tasks.complete': 'Complete one study task.', 'tasks.uncomplete': 'Reopen one study task.', 'tasks.delete': 'Delete one study task subject to policy.',
  'tasks.list': 'List summarized study tasks with bounded pagination.', 'tasks.get': 'Read one authorized study task.',
  'focus.sessions.create': 'Create one bounded focus session.', 'focus.sessions.list': 'List authorized focus sessions with bounded pagination.',
  'capabilities.summary': 'Read the safe capability summary without stored content.', 'questions.view': 'Read one addressable question resource.',
  'tasks.view': 'Read one addressable task resource.', 'review.daily.zh_en': 'Use the bilingual daily review workflow.',
  'review.weekly.zh_en': 'Use the bilingual weekly review workflow.',
  'jobs.create': 'Create one durable bounded Gateway job.', 'jobs.get': 'Read one owner-bound durable job.',
  'jobs.list': 'List owner-bound durable jobs with bounded pagination.', 'jobs.cancel': 'Request cancellation at a declared safe checkpoint.',
  'jobs.result': 'Read one hash-verified durable job result.', 'jobs.view': 'Read one owner-bound durable job resource.',
   'jobs.result.view': 'Read one verified durable job result resource.',
  'knowledge.list_nodes': 'List bounded knowledge nodes.', 'knowledge.get_node': 'Read one knowledge node.',
  'knowledge.list_links': 'List bounded knowledge-question links.', 'textbooks.list': 'List bounded textbook metadata.',
  'textbooks.get': 'Read one textbook metadata record.', 'analytics.get_weak_areas': 'List bounded weak knowledge areas.',
  'knowledge.link_question': 'Link one question to one knowledge node.', 'knowledge.unlink_question': 'Unlink one question from one knowledge node.',
  'knowledge.bind_textbook': 'Bind one knowledge node to one existing textbook.', 'knowledge.view': 'Read one addressable knowledge node resource.', 'textbooks.view': 'Read one addressable textbook metadata resource.'
});

function schema(id: string, direction: 'input' | 'output') {
  return Object.freeze({ id, version: mcpSchemaVersion, direction, bounded: true as const });
}

function payloadValidator(operation: OperationName): McpRuntimeValidator {
  return (payload: unknown): void => {
    if (operation === 'jobs.create') { validateJobCreateInput(payload); return; }
    if (operation === 'jobs.cancel') { validateJobCancelInput(payload); return; }
    if (operation === 'jobs.get') { validateJobGetInput(payload); return; }
    if (operation === 'jobs.list') { validateJobListInput(payload); return; }
    if (operation === 'jobs.result') { validateJobResultInput(payload); return; }
    const request = { type: operation, payload };
    if (operation.startsWith('questions.')) {
      if (resolveOperationDescriptor(operation).kind === 'command') validateQuestionCommand(request);
      else validateQuestionQuery(request);
      return;
    }
    if (operation.startsWith('knowledge.') || operation.startsWith('textbooks.') || operation.startsWith('analytics.')) {
      if (resolveOperationDescriptor(operation).kind === 'command') validateKnowledgeCommand(request);
      else validateKnowledgeQuery(request);
      return;
    }
    if (resolveOperationDescriptor(operation).kind === 'command') validateTickTickCommand(request);
    else validateTickTickQuery(request);
  };
}

function inputValidator(operation: OperationName): McpRuntimeValidator {
  const descriptor = resolveOperationDescriptor(operation);
  return (value: unknown): void => validateMcpToolArgumentEnvelope(value, operation, payloadValidator(operation), descriptor.kind === 'command');
}

function supportInputValidator(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 0) {
    throw new Error('MCP support input is invalid');
  }
}

function pagination(operation: OperationName) {
  const descriptor = resolveOperationDescriptor(operation);
  const paged = descriptor.kind === 'query' && (descriptor.name.endsWith('.list') || descriptor.name.endsWith('.logs') || descriptor.name.endsWith('.buckets'));
  return Object.freeze({ kind: paged ? 'cursor' as const : 'none' as const, defaultPageSize: paged ? Math.min(50, descriptor.policyBounds.maxPageSize) : 1, maxPageSize: descriptor.policyBounds.maxPageSize });
}

function gatewayEntry(name: string, operation: OperationName, primitive: McpRegistryDescriptor['primitive']): McpRegistryDescriptor {
  const descriptor = resolveOperationDescriptor(operation);
  return Object.freeze({
    name, operation, catalog: operationCatalogIdentity, exposure: 'business' as const, primitive,
    description: descriptions[name] ?? `Execute the bounded ${operation} operation.`, inputSchema: schema(descriptor.inputSchema, 'input'), outputSchema: schema(descriptor.outputSchema, 'output'),
    requiredScopes: Object.freeze([...descriptor.requiredScopes]) as readonly AgentScope[], visibility: descriptor.visibility, pagination: pagination(operation),
    resultMapperId: `mcp.result.${operation}.v1`, inputValidator: inputValidator(operation), outputValidator: validateMcpStructuredOutcome,
    handler: Object.freeze({ kind: 'gateway' as const, gatewayMethod: descriptor.kind === 'command' ? 'execute' as const : 'query' as const, operation })
  });
}

export const mcpV1BusinessRegistry: readonly McpRegistryDescriptor[] = Object.freeze(mcpExternalBusinessOperations.map((operation) => gatewayEntry(operation, operation, 'tool')));

export const mcpV1JobRegistry: readonly McpRegistryDescriptor[] = Object.freeze(([
  'jobs.create', 'jobs.get', 'jobs.list', 'jobs.cancel', 'jobs.result'
] as const).map((operation) => Object.freeze({ ...gatewayEntry(operation, operation, 'tool'), exposure: 'support' as const })));

export const mcpV1SupportRegistry: readonly McpRegistryDescriptor[] = Object.freeze([
  Object.freeze({
    name: 'capabilities.summary', operation: 'mcp.capabilities.summary' as const, catalog: operationCatalogIdentity, exposure: 'support' as const, primitive: 'resource' as const,
    description: descriptions['capabilities.summary'], inputSchema: schema('mcp.capabilities.summary.input.v1', 'input'), outputSchema: schema('mcp.capabilities.summary.output.v1', 'output'),
    requiredScopes: Object.freeze([]), visibility: 'public' as const, pagination: Object.freeze({ kind: 'none' as const, defaultPageSize: 1, maxPageSize: 1 }),
    resultMapperId: 'mcp.result.mcp.capabilities.summary.v1', inputValidator: supportInputValidator, outputValidator: validateMcpStructuredOutcome,
    handler: Object.freeze({ kind: 'local-summary' as const, operation: 'mcp.capabilities.summary' as const }), uri: 'kaoyan://capabilities/summary'
  }),
  Object.freeze({ ...gatewayEntry('questions.view', 'questions.get', 'resource-template'), exposure: 'support' as const, name: 'questions.view', uriTemplate: 'kaoyan://questions/{questionId}' }),
  Object.freeze({ ...gatewayEntry('tasks.view', 'tasks.get', 'resource-template'), exposure: 'support' as const, name: 'tasks.view', uriTemplate: 'kaoyan://tasks/{taskId}' }),
  Object.freeze({ ...gatewayEntry('reviews.today', 'questions.review_buckets', 'resource'), exposure: 'support' as const, name: 'reviews.today', uri: 'kaoyan://reviews/today' }),
  Object.freeze({ ...gatewayEntry('tasks.today', 'tasks.list', 'resource'), exposure: 'support' as const, name: 'tasks.today', uri: 'kaoyan://tasks/today' }),
  Object.freeze({ ...gatewayEntry('review.daily.zh_en', 'questions.review_buckets', 'prompt'), exposure: 'support' as const, name: 'review.daily.zh_en', promptArguments: Object.freeze(['focus']) }),
  Object.freeze({ ...gatewayEntry('review.weekly.zh_en', 'tasks.list', 'prompt'), exposure: 'support' as const, name: 'review.weekly.zh_en', promptArguments: Object.freeze(['week']) }),
  Object.freeze({ ...gatewayEntry('jobs.view', 'jobs.get', 'resource-template'), exposure: 'support' as const, name: 'jobs.view', uriTemplate: 'kaoyan://jobs/{jobId}' }),
  Object.freeze({ ...gatewayEntry('jobs.result.view', 'jobs.result', 'resource-template'), exposure: 'support' as const, name: 'jobs.result.view', uriTemplate: 'kaoyan://jobs/{jobId}/result' }),
  Object.freeze({ ...gatewayEntry('knowledge.view', 'knowledge.get_node', 'resource-template'), exposure: 'support' as const, name: 'knowledge.view', uriTemplate: 'kaoyan://knowledge/{nodeId}' }),
  Object.freeze({ ...gatewayEntry('textbooks.view', 'textbooks.get', 'resource-template'), exposure: 'support' as const, name: 'textbooks.view', uriTemplate: 'kaoyan://textbooks/{textbookId}' })
]);

export const mcpV1Registry: readonly McpRegistryDescriptor[] = Object.freeze([...mcpV1BusinessRegistry, ...mcpV1JobRegistry, ...mcpV1SupportRegistry]);
export const mcpV1RegistryByName: Readonly<Record<string, McpRegistryDescriptor>> = Object.freeze(Object.fromEntries(mcpV1Registry.map((descriptor) => [descriptor.name, descriptor])));

export function createMcpCapabilitySummary(principal: AgentPrincipal): McpCapabilitySummary {
  const visible = mcpV1Registry.filter((descriptor) => descriptor.visibility === 'public' || descriptor.requiredScopes.every((scope) => principal.scopes.includes(scope)));
  return Object.freeze({ schemaVersion: mcpSchemaVersion, protocolVersions: Object.freeze([...mcpProtocolVersions]), currentProtocolVersion: mcpCurrentProtocolVersion, tasks: true, tools: visible.filter(({ primitive }) => primitive === 'tool').length, resources: visible.filter(({ primitive }) => primitive === 'resource').length, resourceTemplates: visible.filter(({ primitive }) => primitive === 'resource-template').length, prompts: visible.filter(({ primitive }) => primitive === 'prompt').length });
}

export const mcpV1CapabilitySummary: McpCapabilitySummary = Object.freeze({ schemaVersion: mcpSchemaVersion, protocolVersions: Object.freeze([...mcpProtocolVersions]), currentProtocolVersion: mcpCurrentProtocolVersion, tasks: true, tools: mcpV1BusinessRegistry.length + mcpV1JobRegistry.length, resources: 3, resourceTemplates: 4, prompts: 2 });
export const mcpV1ServerMetadata = Object.freeze({ serverVersion: mcpServerVersion, capabilityVersion: mcpCapabilityVersion, schemaVersion: mcpSchemaVersion, protocolVersions: Object.freeze([...mcpProtocolVersions]), currentProtocolVersion: mcpCurrentProtocolVersion, tasks: true, instructions: mcpServerInstructionsValue, exposureManifestVersion: mcpExternalExposureManifest.version });

function assertRegistry(): void {
  assertMcpExternalExposureManifest(mcpExternalExposureManifest); validateMcpServerInstructions(mcpServerInstructionsValue);
  if (mcpV1BusinessRegistry.length !== 28) throw new Error('MCP business registry must contain exactly 28 operations');
  if (JSON.stringify([...mcpExternalExposureManifest.businessOperations].sort()) !== JSON.stringify(mcpV1BusinessRegistry.map(({ operation }) => operation).sort())) throw new Error('MCP registry and exposure manifest differ');
  if (new Set(mcpV1Registry.map(({ name }) => name)).size !== mcpV1Registry.length) throw new Error('MCP public names must be unique');
  for (const descriptor of mcpV1Registry) {
    validateMcpRegistryDescriptor(descriptor);
    if (descriptor.handler.kind === 'gateway') {
      if (!operationCatalog.operations.some((candidate) => candidate.name === descriptor.operation) || descriptor.catalog.version !== operationCatalogIdentity.version || descriptor.catalog.hash !== operationCatalogIdentity.hash) throw new Error(`MCP catalog identity mismatch for ${descriptor.name}`);
      resolveMcpResultMapper(descriptor.operation as OperationName);
    }
  }
  for (const prompt of mcpV1Prompts) if (!mcpV1Registry.some((descriptor) => descriptor.name === prompt.name)) throw new Error(`MCP prompt is not explicitly registered: ${prompt.name}`);
}

assertRegistry();

import type { AgentPrincipal, AgentScope, OperationName } from '../../shared/agent/v1/gatewayContracts';
import { validateQuestionCommand, validateQuestionQuery } from '../../shared/agent/v1/schemas';
import { operationCatalog, operationCatalogIdentity, resolveOperationDescriptor } from '../../shared/agent/v1/operationCatalog';
import { validateTickTickCommand, validateTickTickQuery } from '../application/ticktick/contracts';
import { validateKnowledgeCommand, validateKnowledgeQuery } from '../application/knowledge/contracts';
import { validateStudyCommand, validateStudyQuery } from '../application/study/contracts';
import { validateImportsCommand, validateImportsQuery } from '../application/imports/contracts';
import { validateGlobalCommand, validateGlobalQuery } from '../application/global/contracts';
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
    'knowledge.bind_textbook': 'Bind one knowledge node to one existing textbook.', 'knowledge.view': 'Read one addressable knowledge node resource.', 'textbooks.view': 'Read one addressable textbook metadata resource.',
   'imports.create_draft': 'Create one bounded structured import draft.', 'imports.add_draft_image': 'Bind one App-managed user-selected image to a draft item.', 'imports.validate_draft': 'Validate and deduplicate one bounded import draft.', 'imports.preview_draft': 'Read the deterministic change preview for one draft.', 'imports.apply_draft': 'Apply one validated import draft through a durable job and journal.', 'imports.get': 'Read one owner-bound import draft.', 'imports.cancel': 'Cancel one owner-bound draft and quarantine staged assets.', 'imports.view': 'Read one owner-bound import draft resource.',
   'study.get_today': 'Read one bounded daily study supervision summary.', 'study.get_week_summary': 'Read one bounded week-to-date study summary.', 'study.create_plan_draft': 'Create at most twenty bounded draft study tasks.', 'study.apply_plan_adjustment': 'Adjust one existing study task.', 'study.record_manual_progress': 'Record one bounded manual study session.', 'study.today.view': 'Read one addressable daily study summary.', 'study.week.view': 'Read one addressable weekly study summary.', 'study.daily_review.zh_en': 'Use the bilingual bounded daily study review workflow.', 'study.weekly_review.zh_en': 'Use the bilingual bounded weekly study review workflow.',
   'ticktick.lists.list': 'List bounded TickTick-style lists.', 'ticktick.lists.create': 'Create one bounded TickTick-style list.', 'ticktick.lists.update': 'Update one bounded TickTick-style list.', 'ticktick.habits.list': 'List bounded habits.', 'ticktick.habits.create': 'Create one bounded habit.', 'ticktick.habits.update': 'Update one bounded habit.', 'ticktick.calendar.list_events': 'List bounded calendar events for one month.', 'ticktick.bridges.get': 'Read bounded bridges for one task.', 'ticktick.bridges.update': 'Upsert one bounded local bridge.',
    'ticktick.lists.view': 'Read the bounded TickTick list collection resource.', 'ticktick.habits.view': 'Read the bounded habit collection resource.', 'ticktick.calendar.view': 'Read one bounded calendar month resource.', 'ticktick.bridges.view': 'Read bridges for one bounded task resource.',
    'backups.list': 'List bounded managed backup metadata.', 'backups.create': 'Create one App-managed database backup through a durable job.',
    'backups.delete': 'Request deletion of one resolved managed backup.', 'database.restore': 'Request restoration from one resolved managed backup.',
    'database.replace_from_import': 'Request replacement from one resolved managed import asset.', 'database.clear_all': 'Request a bounded full-data clear.',
    'imports.delete_batch': 'Request deletion of one resolved import batch.', 'data_root.migrate': 'Request migration using one local-user-selected root token.',
    'exports.create': 'Create one bounded App-managed export through a durable job.', 'exports.get': 'Read owner-bound export metadata only.', 'exports.view': 'Read one owner-bound export metadata resource.'
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
    if (operation.startsWith('study.')) { if (resolveOperationDescriptor(operation).kind === 'command') validateStudyCommand(request); else validateStudyQuery(request); return; }
    if (operation.startsWith('backups.') || operation.startsWith('exports.') || operation.startsWith('database.') || operation === 'data_root.migrate' || operation === 'imports.delete_batch') {
      if (resolveOperationDescriptor(operation).kind === 'command') validateGlobalCommand(request); else validateGlobalQuery(request);
      return;
    }
    if (operation.startsWith('imports.')) { if (resolveOperationDescriptor(operation).kind === 'command') validateImportsCommand(request); else validateImportsQuery(request); return; }
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
  Object.freeze({ ...gatewayEntry('textbooks.view', 'textbooks.get', 'resource-template'), exposure: 'support' as const, name: 'textbooks.view', uriTemplate: 'kaoyan://textbooks/{textbookId}' }),
  Object.freeze({ ...gatewayEntry('imports.view', 'imports.get', 'resource-template'), exposure: 'support' as const, name: 'imports.view', uriTemplate: 'kaoyan://imports/{draftId}' }),
  Object.freeze({ ...gatewayEntry('backups.view', 'backups.list', 'resource'), exposure: 'support' as const, name: 'backups.view', uri: 'kaoyan://backups' }),
  Object.freeze({ ...gatewayEntry('study.today.view', 'study.get_today', 'resource'), exposure: 'support' as const, name: 'study.today.view', uri: 'kaoyan://study/today' }),
   Object.freeze({ ...gatewayEntry('study.week.view', 'study.get_week_summary', 'resource'), exposure: 'support' as const, name: 'study.week.view', uri: 'kaoyan://study/week' }),
   Object.freeze({ ...gatewayEntry('ticktick.lists.view', 'ticktick.lists.list', 'resource'), exposure: 'support' as const, name: 'ticktick.lists.view', uri: 'kaoyan://ticktick/lists' }),
   Object.freeze({ ...gatewayEntry('ticktick.habits.view', 'ticktick.habits.list', 'resource'), exposure: 'support' as const, name: 'ticktick.habits.view', uri: 'kaoyan://ticktick/habits' }),
   Object.freeze({ ...gatewayEntry('study.daily_review.zh_en', 'study.get_today', 'prompt'), exposure: 'support' as const, name: 'study.daily_review.zh_en', promptArguments: Object.freeze(['date']) }),
   Object.freeze({ ...gatewayEntry('study.weekly_review.zh_en', 'study.get_week_summary', 'prompt'), exposure: 'support' as const, name: 'study.weekly_review.zh_en', promptArguments: Object.freeze(['date']) }),
    Object.freeze({ ...gatewayEntry('ticktick.calendar.view', 'ticktick.calendar.list_events', 'resource-template'), exposure: 'support' as const, name: 'ticktick.calendar.view', uriTemplate: 'kaoyan://ticktick/calendar/{year}/{month}' }),
    Object.freeze({ ...gatewayEntry('ticktick.bridges.view', 'ticktick.bridges.get', 'resource-template'), exposure: 'support' as const, name: 'ticktick.bridges.view', uriTemplate: 'kaoyan://ticktick/bridges/{taskId}' }),
    Object.freeze({ ...gatewayEntry('exports.view', 'exports.get', 'resource-template'), exposure: 'support' as const, name: 'exports.view', uriTemplate: 'kaoyan://exports/{exportId}' })
]);

export const mcpV1Registry: readonly McpRegistryDescriptor[] = Object.freeze([...mcpV1BusinessRegistry, ...mcpV1JobRegistry, ...mcpV1SupportRegistry]);
export const mcpV1RegistryByName: Readonly<Record<string, McpRegistryDescriptor>> = Object.freeze(Object.fromEntries(mcpV1Registry.map((descriptor) => [descriptor.name, descriptor])));

export function createMcpCapabilitySummary(principal: AgentPrincipal): McpCapabilitySummary {
  const visible = mcpV1Registry.filter((descriptor) => descriptor.visibility === 'public' || descriptor.requiredScopes.every((scope) => principal.scopes.includes(scope)));
  return Object.freeze({ schemaVersion: mcpSchemaVersion, protocolVersions: Object.freeze([...mcpProtocolVersions]), currentProtocolVersion: mcpCurrentProtocolVersion, tasks: true, tools: visible.filter(({ primitive }) => primitive === 'tool').length, resources: visible.filter(({ primitive }) => primitive === 'resource').length, resourceTemplates: visible.filter(({ primitive }) => primitive === 'resource-template').length, prompts: visible.filter(({ primitive }) => primitive === 'prompt').length });
}

export const mcpV1CapabilitySummary: McpCapabilitySummary = Object.freeze({ schemaVersion: mcpSchemaVersion, protocolVersions: Object.freeze([...mcpProtocolVersions]), currentProtocolVersion: mcpCurrentProtocolVersion, tasks: true, tools: mcpV1BusinessRegistry.length + mcpV1JobRegistry.length, resources: 8, resourceTemplates: 11, prompts: 4 });
export const mcpV1ServerMetadata = Object.freeze({ serverVersion: mcpServerVersion, capabilityVersion: mcpCapabilityVersion, schemaVersion: mcpSchemaVersion, protocolVersions: Object.freeze([...mcpProtocolVersions]), currentProtocolVersion: mcpCurrentProtocolVersion, tasks: true, instructions: mcpServerInstructionsValue, exposureManifestVersion: mcpExternalExposureManifest.version });

function assertRegistry(): void {
  assertMcpExternalExposureManifest(mcpExternalExposureManifest); validateMcpServerInstructions(mcpServerInstructionsValue);
  if (mcpV1BusinessRegistry.length !== 59) throw new Error('MCP business registry must contain exactly 59 operations');
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

import type { AgentPrincipal, OperationName } from '../../../shared/agent/v1/gatewayContracts';
import type { McpRegistryDescriptor } from '../../../shared/mcp/v1/contracts';
import { mcpV1Registry } from '../registry';
import { visibleToPrincipal } from '../tools';

export interface McpResourceDefinition {
  readonly descriptor: McpRegistryDescriptor;
  readonly operation?: OperationName;
  readonly kind: 'summary' | 'question' | 'task' | 'job' | 'job-result' | 'capabilities';
}

export const mcpV1Resources: readonly McpResourceDefinition[] = Object.freeze([
  Object.freeze({ descriptor: mcpV1Registry.find((entry) => entry.name === 'capabilities.summary')!, kind: 'capabilities' as const }),
  Object.freeze({ descriptor: mcpV1Registry.find((entry) => entry.name === 'reviews.today')!, operation: 'questions.review_buckets' as const, kind: 'summary' as const }),
  Object.freeze({ descriptor: mcpV1Registry.find((entry) => entry.name === 'tasks.today')!, operation: 'tasks.list' as const, kind: 'summary' as const })
]);

export const mcpV1ResourceTemplates: readonly McpResourceDefinition[] = Object.freeze([
  Object.freeze({ descriptor: mcpV1Registry.find((entry) => entry.name === 'questions.view')!, operation: 'questions.get' as const, kind: 'question' as const }),
  Object.freeze({ descriptor: mcpV1Registry.find((entry) => entry.name === 'tasks.view')!, operation: 'tasks.get' as const, kind: 'task' as const }),
  Object.freeze({ descriptor: mcpV1Registry.find((entry) => entry.name === 'jobs.view')!, operation: 'jobs.get' as const, kind: 'job' as const }),
  Object.freeze({ descriptor: mcpV1Registry.find((entry) => entry.name === 'jobs.result.view')!, operation: 'jobs.result' as const, kind: 'job-result' as const })
]);

export function visibleResources(principal: AgentPrincipal): readonly McpResourceDefinition[] {
  return mcpV1Resources.filter(({ descriptor }) => visibleToPrincipal(descriptor, principal.scopes));
}

export function visibleResourceTemplates(principal: AgentPrincipal): readonly McpResourceDefinition[] {
  return mcpV1ResourceTemplates.filter(({ descriptor }) => visibleToPrincipal(descriptor, principal.scopes));
}

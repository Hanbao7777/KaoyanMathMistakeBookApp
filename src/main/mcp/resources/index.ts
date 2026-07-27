import type { AgentPrincipal, OperationName } from '../../../shared/agent/v1/gatewayContracts';
import type { McpRegistryDescriptor } from '../../../shared/mcp/v1/contracts';
import { mcpV1Registry } from '../registry';
import { visibleToPrincipal } from '../tools';

export interface McpResourceDefinition {
  readonly descriptor: McpRegistryDescriptor;
  readonly operation?: OperationName;
  readonly kind: 'summary' | 'question' | 'task' | 'knowledge' | 'textbook' | 'job' | 'job-result' | 'study' | 'import' | 'backup' | 'export' | 'ticktick-list' | 'ticktick-habit' | 'ticktick-calendar' | 'ticktick-bridge' | 'capabilities';
}

export const mcpV1Resources: readonly McpResourceDefinition[] = Object.freeze([
  Object.freeze({ descriptor: mcpV1Registry.find((entry) => entry.name === 'capabilities.summary')!, kind: 'capabilities' as const }),
  Object.freeze({ descriptor: mcpV1Registry.find((entry) => entry.name === 'reviews.today')!, operation: 'questions.review_buckets' as const, kind: 'summary' as const }),
  Object.freeze({ descriptor: mcpV1Registry.find((entry) => entry.name === 'tasks.today')!, operation: 'tasks.list' as const, kind: 'summary' as const }),
  Object.freeze({ descriptor: mcpV1Registry.find((entry) => entry.name === 'study.today.view')!, operation: 'study.get_today' as const, kind: 'study' as const }),
  Object.freeze({ descriptor: mcpV1Registry.find((entry) => entry.name === 'study.week.view')!, operation: 'study.get_week_summary' as const, kind: 'study' as const }),
  Object.freeze({ descriptor: mcpV1Registry.find((entry) => entry.name === 'ticktick.lists.view')!, operation: 'ticktick.lists.list' as const, kind: 'ticktick-list' as const }),
  Object.freeze({ descriptor: mcpV1Registry.find((entry) => entry.name === 'ticktick.habits.view')!, operation: 'ticktick.habits.list' as const, kind: 'ticktick-habit' as const })
  , Object.freeze({ descriptor: mcpV1Registry.find((entry) => entry.name === 'backups.view')!, operation: 'backups.list' as const, kind: 'backup' as const })
]);

export const mcpV1ResourceTemplates: readonly McpResourceDefinition[] = Object.freeze([
  Object.freeze({ descriptor: mcpV1Registry.find((entry) => entry.name === 'questions.view')!, operation: 'questions.get' as const, kind: 'question' as const }),
  Object.freeze({ descriptor: mcpV1Registry.find((entry) => entry.name === 'tasks.view')!, operation: 'tasks.get' as const, kind: 'task' as const }),
  Object.freeze({ descriptor: mcpV1Registry.find((entry) => entry.name === 'jobs.view')!, operation: 'jobs.get' as const, kind: 'job' as const }),
  Object.freeze({ descriptor: mcpV1Registry.find((entry) => entry.name === 'jobs.result.view')!, operation: 'jobs.result' as const, kind: 'job-result' as const }),
  Object.freeze({ descriptor: mcpV1Registry.find((entry) => entry.name === 'knowledge.view')!, operation: 'knowledge.get_node' as const, kind: 'knowledge' as const }),
  Object.freeze({ descriptor: mcpV1Registry.find((entry) => entry.name === 'textbooks.view')!, operation: 'textbooks.get' as const, kind: 'textbook' as const })
  , Object.freeze({ descriptor: mcpV1Registry.find((entry) => entry.name === 'imports.view')!, operation: 'imports.get' as const, kind: 'import' as const }),
  Object.freeze({ descriptor: mcpV1Registry.find((entry) => entry.name === 'ticktick.calendar.view')!, operation: 'ticktick.calendar.list_events' as const, kind: 'ticktick-calendar' as const }),
  Object.freeze({ descriptor: mcpV1Registry.find((entry) => entry.name === 'ticktick.bridges.view')!, operation: 'ticktick.bridges.get' as const, kind: 'ticktick-bridge' as const })
  , Object.freeze({ descriptor: mcpV1Registry.find((entry) => entry.name === 'exports.view')!, operation: 'exports.get' as const, kind: 'export' as const })
]);

export function visibleResources(principal: AgentPrincipal): readonly McpResourceDefinition[] {
  return mcpV1Resources.filter(({ descriptor }) => visibleToPrincipal(descriptor, principal.scopes));
}

export function visibleResourceTemplates(principal: AgentPrincipal): readonly McpResourceDefinition[] {
  return mcpV1ResourceTemplates.filter(({ descriptor }) => visibleToPrincipal(descriptor, principal.scopes));
}

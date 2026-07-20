import type { OperationName } from '../../agent/v1/gatewayContracts';

export const mcpExternalExposureManifestVersion = 'mcp-external-exposure-v1@3' as const;
export const mcpExternalExposureManifest = Object.freeze({
  apiVersion: 1 as const,
  kind: 'mcp-external-exposure-manifest' as const,
  version: mcpExternalExposureManifestVersion,
  businessOperations: Object.freeze([
    'questions.create',
    'questions.update',
    'questions.delete',
    'questions.remove_image',
    'questions.mark_mastery',
    'questions.submit_review',
    'questions.list',
    'questions.get',
    'questions.review_logs',
    'questions.review_buckets',
    'tasks.create',
    'tasks.update',
    'tasks.complete',
    'tasks.uncomplete',
    'tasks.delete',
    'tasks.list',
    'tasks.get',
    'focus.sessions.create',
    'focus.sessions.list',
    'knowledge.list_nodes',
    'knowledge.get_node',
    'knowledge.list_links',
    'textbooks.list',
    'textbooks.get',
    'analytics.get_weak_areas',
    'knowledge.link_question',
    'knowledge.unlink_question',
    'knowledge.bind_textbook',
    'study.get_today',
    'study.get_week_summary',
    'study.create_plan_draft',
    'study.apply_plan_adjustment',
    'study.record_manual_progress'
  ] as const)
});

export type McpExternalBusinessOperation = (typeof mcpExternalExposureManifest.businessOperations)[number];

const operationSet = new Set<string>(mcpExternalExposureManifest.businessOperations);

export function isMcpExternalBusinessOperation(name: OperationName | string): name is McpExternalBusinessOperation {
  return operationSet.has(name);
}

export function assertMcpExternalExposureManifest(value: unknown): asserts value is typeof mcpExternalExposureManifest {
  if (value !== mcpExternalExposureManifest || typeof value !== 'object' || value === null || !Object.isFrozen(value)) {
    throw new Error('MCP external exposure manifest is not the code-owned immutable manifest');
  }
  const manifest = value as typeof mcpExternalExposureManifest;
  if (!Object.isFrozen(manifest.businessOperations) || manifest.businessOperations.length !== 33 || new Set(manifest.businessOperations).size !== 33) throw new Error('MCP external exposure manifest is not exact');
}

export const mcpExternalBusinessOperations: readonly OperationName[] = mcpExternalExposureManifest.businessOperations;

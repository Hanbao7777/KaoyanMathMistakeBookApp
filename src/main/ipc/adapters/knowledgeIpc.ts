import { randomUUID } from 'node:crypto';
import { AgentError } from '../../../shared/agent/errors';
import { agentApiVersion } from '../../../shared/agent/versions';
import type { KnowledgeCommand, KnowledgeQuery } from '../../../shared/agent/v1/contracts';
import type { AgentGateway, AgentPrincipal, JsonObject } from '../../../shared/agent/v1/gatewayContracts';
import { operationCatalogIdentity } from '../../../shared/agent/v1/operationCatalog';

export interface KnowledgeRendererAdapterDependencies {
  readonly gateway: AgentGateway;
  readonly principal: () => AgentPrincipal;
  readonly currentVersion: () => { readonly dataEpoch: string; readonly dataRevision: number };
}

function rejected(error: { code: ConstructorParameters<typeof AgentError>[0]; details?: ConstructorParameters<typeof AgentError>[1] }): never {
  throw new AgentError(error.code, error.details);
}

/** Fixed DTO adapter: callers cannot select a principal, catalog, or execution source. */
export function createKnowledgeRendererAdapter(dependencies: KnowledgeRendererAdapterDependencies) {
  const query = async <T>(operation: KnowledgeQuery['type'], payload: JsonObject): Promise<T> => {
    const outcome = await dependencies.gateway.query({ apiVersion: agentApiVersion, kind: 'agent-query', operation, payload, requestId: randomUUID(), catalog: operationCatalogIdentity }, dependencies.principal());
    if (outcome.kind === 'rejected') rejected(outcome.error);
    return outcome.result.value as T;
  };
  const write = async <T>(command: KnowledgeCommand): Promise<T> => {
    const outcome = await dependencies.gateway.execute({ apiVersion: agentApiVersion, kind: 'agent-command', operation: command.type, payload: command.payload as unknown as JsonObject, requestId: randomUUID(), expectedVersion: dependencies.currentVersion(), catalog: operationCatalogIdentity }, dependencies.principal());
    if (outcome.kind === 'completed' || outcome.kind === 'replayed') return outcome.result.value as T;
    if (outcome.kind === 'rejected') rejected(outcome.error);
    throw new AgentError('APPROVAL_REQUIRED');
  };
  return Object.freeze({
    listNodes: (parentNodeId?: string, subject?: string) => query('knowledge.list_nodes', { ...(parentNodeId ? { parentNodeId } : {}), ...(subject ? { subject } : {}), limit: 200 }),
    getNode: (nodeId: string) => query('knowledge.get_node', { nodeId }),
    listLinks: (input: { nodeId?: string; questionId?: number }) => query('knowledge.list_links', { ...input, limit: 200 }),
    listTextbooks: (subject?: string) => query('textbooks.list', { ...(subject ? { subject } : {}), limit: 200 }),
    getTextbook: (textbookId: number) => query('textbooks.get', { textbookId }),
    getWeakAreas: (subject?: string) => query('analytics.get_weak_areas', { ...(subject ? { subject } : {}), limit: 200 }),
    linkQuestion: (questionId: number, nodeId: string, matchType: 'gpt' | 'auto' | 'manual') => write({ type: 'knowledge.link_question', payload: { questionId, nodeId, matchType } }),
    unlinkQuestion: (questionId: number, nodeId: string) => write({ type: 'knowledge.unlink_question', payload: { questionId, nodeId } }),
    bindTextbook: (nodeId: string, textbookId: number) => write({ type: 'knowledge.bind_textbook', payload: { nodeId, textbookId } })
  });
}

import { validateKnowledgeCommand, validateKnowledgeQuery } from '../../../shared/agent/v1/schemas';
import type {
  KnowledgeCommand,
  KnowledgeCommandValues,
  KnowledgeQuery,
  KnowledgeQueryValues
} from '../../../shared/agent/v1/contracts';

export type { KnowledgeCommand, KnowledgeCommandValues, KnowledgeQuery, KnowledgeQueryValues };
export const knowledgeCommandTypes = Object.freeze(['knowledge.link_question', 'knowledge.unlink_question', 'knowledge.bind_textbook'] as const);
export const knowledgeQueryTypes = Object.freeze(['knowledge.list_nodes', 'knowledge.get_node', 'knowledge.list_links', 'textbooks.list', 'textbooks.get', 'analytics.get_weak_areas'] as const);
export { validateKnowledgeCommand, validateKnowledgeQuery };

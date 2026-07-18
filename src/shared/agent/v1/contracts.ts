import type {
  MasteryLevel,
  Question,
  QuestionFilters,
  QuestionInput,
  ReviewBuckets,
  ReviewLog,
  ReviewSubmitInput,
  ReviewSubmitResult,
  KnowledgePoint,
  KnowledgePointReviewStats,
  SafeKnowledgeNode,
  SafeTextbook
} from '../../types';
import type { AgentApiVersion } from '../versions';

export interface DataVersion {
  readonly dataEpoch: string;
  readonly dataRevision: number;
}

export type ExecutionSource = 'renderer' | 'internal' | 'mcp';
export type ConcurrencyPolicy = 'strict' | 'epoch-only' | 'none';

export interface ActorIdentity {
  actorId: string;
  actorType: 'user' | 'agent' | 'system';
}

export interface ClientIdentity {
  clientId: string;
  clientName?: string;
}

interface ExecutionContextBase {
  requestId: string;
  traceId: string;
  source: ExecutionSource;
  actor: ActorIdentity;
  client: ClientIdentity;
  timestamp: string;
}

export interface CallerExecutionContext extends ExecutionContextBase {
  trust: 'caller';
  source: 'mcp';
  expectedVersion?: DataVersion;
}

export interface TrustedExecutionContext extends ExecutionContextBase {
  trust: 'trusted';
  concurrency: ConcurrencyPolicy;
  expectedVersion?: DataVersion;
}

export type ExecutionContext = CallerExecutionContext | TrustedExecutionContext;

export interface EntityRef {
  entityType: string;
  entityId: string;
}

export interface QuestionCreateCommand {
  type: 'questions.create';
  payload: { input: QuestionInput; externalRef?: string };
}

export interface QuestionUpdateCommand {
  type: 'questions.update';
  payload: { questionId: number; input: QuestionInput };
}

export interface QuestionDeleteCommand {
  type: 'questions.delete';
  payload: { questionId: number; deleteImages: boolean };
}

export interface QuestionRemoveImageCommand {
  type: 'questions.remove_image';
  payload: { imageId: number; deleteFile: boolean };
}

export interface QuestionMarkMasteryCommand {
  type: 'questions.mark_mastery';
  payload: { questionId: number; mastery: MasteryLevel };
}

export interface QuestionSubmitReviewCommand {
  type: 'questions.submit_review';
  payload: ReviewSubmitInput;
}

export interface QuestionUndoReviewCommand {
  type: 'questions.undo_review';
  payload: { questionId: number; reviewLogId: number };
}

export interface QuestionUndoReviewResult {
  question: Question;
  reviewLog: ReviewLog;
}

export interface QuestionLinkKnowledgeCommand {
  type: 'questions.link_knowledge';
  payload: { questionId: number; knowledgeNodeIds: string[]; matchType: 'gpt' | 'auto' | 'manual' };
}

export interface QuestionCategoryMigrationCommand {
  type: 'questions.migrate_categories';
  payload: { limit: number };
}

export interface QuestionRematchCommand {
  type: 'questions.rematch_knowledge';
  payload: { limit: number; questionIds?: number[] };
}

export interface QuestionBulkUpsertCommand {
  type: 'questions.bulk_upsert';
  payload: { items: Array<{ input: QuestionInput; externalRef?: string }> };
}

export interface QuestionImportCommand {
  type: 'questions.import';
  payload: { batchId: string; items: Array<{ input: QuestionInput; knowledgeNodeIds: string[] }> };
}

export interface QuestionReplaceAllCommand {
  type: 'questions.replace_all';
  payload: { questions: QuestionInput[] };
}

export interface QuestionClearAllCommand {
  type: 'questions.clear_all';
  payload: { deleteImages: boolean; maxQuestions: number };
}

export type QuestionCommand =
  | QuestionCreateCommand
  | QuestionUpdateCommand
  | QuestionDeleteCommand
  | QuestionRemoveImageCommand
  | QuestionMarkMasteryCommand
  | QuestionSubmitReviewCommand
  | QuestionUndoReviewCommand
  | QuestionLinkKnowledgeCommand
  | QuestionCategoryMigrationCommand
  | QuestionRematchCommand
  | QuestionBulkUpsertCommand
  | QuestionImportCommand
  | QuestionReplaceAllCommand
  | QuestionClearAllCommand;

export const questionCommandTypes = [
  'questions.create',
  'questions.update',
  'questions.delete',
  'questions.remove_image',
  'questions.mark_mastery',
  'questions.submit_review',
  'questions.undo_review',
  'questions.link_knowledge',
  'questions.migrate_categories',
  'questions.rematch_knowledge',
  'questions.bulk_upsert',
  'questions.import',
  'questions.replace_all',
  'questions.clear_all'
] as const satisfies ReadonlyArray<QuestionCommand['type']>;

export interface QuestionListQuery {
  type: 'questions.list';
  payload: { filters: QuestionFilters; limit: number };
}

export interface QuestionGetQuery {
  type: 'questions.get';
  payload: { questionId: number };
}

export interface QuestionReviewLogsQuery {
  type: 'questions.review_logs';
  payload: { questionId: number; limit: number };
}

export interface QuestionReviewBucketsQuery {
  type: 'questions.review_buckets';
  payload: Record<string, never>;
}

export type QuestionQuery = QuestionListQuery | QuestionGetQuery | QuestionReviewLogsQuery | QuestionReviewBucketsQuery;
export const questionQueryTypes = [
  'questions.list',
  'questions.get',
  'questions.review_logs',
  'questions.review_buckets'
] as const satisfies ReadonlyArray<QuestionQuery['type']>;
export interface KnowledgeLinkQuestionCommand {
  type: 'knowledge.link_question';
  payload: { questionId: number; nodeId: string; matchType: 'gpt' | 'auto' | 'manual' };
}

export interface KnowledgeUnlinkQuestionCommand {
  type: 'knowledge.unlink_question';
  payload: { questionId: number; nodeId: string };
}

export interface KnowledgeBindTextbookCommand {
  type: 'knowledge.bind_textbook';
  payload: { nodeId: string; textbookId: number };
}

export type KnowledgeCommand = KnowledgeLinkQuestionCommand | KnowledgeUnlinkQuestionCommand | KnowledgeBindTextbookCommand;

export interface KnowledgeListNodesQuery { type: 'knowledge.list_nodes'; payload: { parentNodeId?: string; subject?: string; limit: number }; }
export interface KnowledgeGetNodeQuery { type: 'knowledge.get_node'; payload: { nodeId: string }; }
export interface KnowledgeListLinksQuery { type: 'knowledge.list_links'; payload: { nodeId?: string; questionId?: number; limit: number }; }
export interface TextbooksListQuery { type: 'textbooks.list'; payload: { subject?: string; limit: number }; }
export interface TextbooksGetQuery { type: 'textbooks.get'; payload: { textbookId: number }; }
export interface AnalyticsWeakAreasQuery { type: 'analytics.get_weak_areas'; payload: { subject?: string; limit: number }; }
export type KnowledgeQuery = KnowledgeListNodesQuery | KnowledgeGetNodeQuery | KnowledgeListLinksQuery | TextbooksListQuery | TextbooksGetQuery | AnalyticsWeakAreasQuery;

export type AppCommand = QuestionCommand | KnowledgeCommand;
export type AppQuery = QuestionQuery | KnowledgeQuery;

export interface CommandEnvelope<C extends AppCommand = AppCommand> {
  apiVersion: AgentApiVersion;
  kind: 'command';
  context: ExecutionContext;
  command: C;
}

export interface QueryEnvelope<Q extends AppQuery = AppQuery> {
  apiVersion: AgentApiVersion;
  kind: 'query';
  context: ExecutionContext;
  query: Q;
}

export interface DomainEvent<T = unknown> {
  readonly apiVersion: AgentApiVersion;
  readonly eventId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly requestId: string;
  readonly traceId: string;
  readonly source: ExecutionSource;
  readonly versionBefore: DataVersion;
  readonly versionAfter: DataVersion;
  readonly payload: Readonly<T>;
}

export interface CommandResult<T = unknown> {
  changed: boolean;
  value: T;
  events: ReadonlyArray<DomainEvent>;
  dataVersion: DataVersion;
}

export interface QueryResult<T = unknown> {
  value: T;
  dataVersion: DataVersion;
}

export interface QuestionCommandValues {
  'questions.create': Question;
  'questions.update': Question;
  'questions.delete': boolean;
  'questions.remove_image': boolean;
  'questions.mark_mastery': Question;
  'questions.submit_review': ReviewSubmitResult;
  'questions.undo_review': QuestionUndoReviewResult;
  'questions.link_knowledge': number;
  'questions.migrate_categories': { migrated: number };
  'questions.rematch_knowledge': { scannedQuestions: number; insertedCount: number };
  'questions.bulk_upsert': { processed: number; questionIds: number[] };
  'questions.import': { processed: number; questionIds: number[] };
  'questions.replace_all': { replaced: number };
  'questions.clear_all': { deleted: number };
}

export interface QuestionQueryValues {
  'questions.list': Question[];
  'questions.get': Question | null;
  'questions.review_logs': ReviewLog[];
  'questions.review_buckets': ReviewBuckets;
}

export interface KnowledgeCommandValues {
  'knowledge.link_question': { linked: boolean; questionId: number; nodeId: string };
  'knowledge.unlink_question': { unlinked: boolean; questionId: number; nodeId: string };
  'knowledge.bind_textbook': { bound: boolean; nodeId: string; textbookId: number };
}

export interface KnowledgeLinkView { readonly question_id: number; readonly knowledge_node_id: string; readonly match_type: string; readonly created_at: string; }
export interface KnowledgeQueryValues {
  'knowledge.list_nodes': KnowledgePoint[];
  'knowledge.get_node': SafeKnowledgeNode | null;
  'knowledge.list_links': KnowledgeLinkView[];
  'textbooks.list': SafeTextbook[];
  'textbooks.get': SafeTextbook | null;
  'analytics.get_weak_areas': KnowledgePointReviewStats[];
}

export type AppCommandValues = QuestionCommandValues & KnowledgeCommandValues;
export type AppQueryValues = QuestionQueryValues & KnowledgeQueryValues;

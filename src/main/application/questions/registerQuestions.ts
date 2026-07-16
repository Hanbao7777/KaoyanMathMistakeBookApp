import { agentApiVersion } from '../../../shared/agent/versions';
import type {
  AppCommand,
  AppQuery,
  CommandResult,
  EntityRef,
  QueryResult,
  QuestionCommandValues,
  QuestionQueryValues,
  TrustedExecutionContext
} from '../../../shared/agent/v1/contracts';
import type { AgentCommandEnvelope, AgentQueryEnvelope, JsonObject, OperationDescriptor } from '../../../shared/agent/v1/gatewayContracts';
import { hashCanonicalJson } from '../../../shared/agent/v1/gatewaySchemas';
import type { GatewayResolvedState } from '../../agent/agentGateway';
import type { DatabaseCoordinator } from '../../persistence/databaseCoordinator';
import { CommandBus, type CommandHandler } from '../commandBus';
import { DomainEventBus, type DomainEventBusOptions } from '../domainEvents';
import { QueryBus, type ReadOnlyDatabaseFacade } from '../queryBus';
import { createQuestionCommandHandlers, finalizeQuestionFileOperation, type QuestionCommandDependencies } from './commands';
import { getQuestionQuery, listQuestionsQuery, reviewBucketsQuery, reviewLogsQuery } from './queries';

type CommandValue<C extends AppCommand> = QuestionCommandValues[C['type']];
type QueryValue<Q extends AppQuery> = QuestionQueryValues[Q['type']];

function questionEventDraft(command: AppCommand, value: unknown) {
  switch (command.type) {
    case 'questions.create':
      return { type: 'questions.question_created', payload: { questionId: (value as { id: number }).id, externalRef: command.payload.externalRef ?? null } };
    case 'questions.update': return { type: 'questions.question_updated', payload: { questionId: command.payload.questionId } };
    case 'questions.delete': return { type: 'questions.question_deleted', payload: { questionId: command.payload.questionId, deleteImages: command.payload.deleteImages } };
    case 'questions.remove_image': return { type: 'questions.image_removed', payload: { imageId: command.payload.imageId, deleteFile: command.payload.deleteFile } };
    case 'questions.mark_mastery': return { type: 'questions.mastery_changed', payload: { questionId: command.payload.questionId, mastery: command.payload.mastery } };
    case 'questions.submit_review': return { type: 'questions.review_submitted', payload: { questionId: command.payload.questionId, reviewLogId: (value as { log: { id: number } }).log.id, result: command.payload.result } };
    case 'questions.undo_review': return { type: 'questions.review_undone', payload: { questionId: command.payload.questionId, reviewLogId: command.payload.reviewLogId } };
    case 'questions.link_knowledge': return { type: 'questions.knowledge_linked', payload: { questionId: command.payload.questionId, insertedCount: value as number } };
    case 'questions.migrate_categories': return { type: 'questions.categories_migrated', payload: { migrated: (value as { migrated: number }).migrated } };
    case 'questions.rematch_knowledge': return { type: 'questions.knowledge_rematched', payload: { ...(value as Record<string, unknown>) } };
    case 'questions.bulk_upsert': return { type: 'questions.bulk_upserted', payload: { ...(value as Record<string, unknown>) } };
    case 'questions.import': return { type: 'questions.imported', payload: { batchId: command.payload.batchId, ...(value as Record<string, unknown>) } };
    case 'questions.replace_all': return { type: 'questions.state_replaced', payload: { ...(value as Record<string, unknown>) } };
    case 'questions.clear_all': return { type: 'questions.state_cleared', payload: { ...(value as Record<string, unknown>) } };
  }
}

type CommandOfType<T extends AppCommand['type']> = Extract<AppCommand, { type: T }>;

function withQuestionEvent<T extends AppCommand['type']>(
  handler: CommandHandler<CommandOfType<T>>
): CommandHandler<CommandOfType<T>> {
  return async (command, context, database, scope) => {
    const result = await handler(command, context, database, scope);
    return {
      ...result,
      events: result.changed ? [questionEventDraft(command, result.value)] : []
    };
  };
}

export interface RegisterQuestionsOptions {
  readonly coordinator: DatabaseCoordinator;
  readonly readOnlyDatabase: ReadOnlyDatabaseFacade;
  readonly eventBus?: DomainEventBus;
  readonly eventBusOptions?: DomainEventBusOptions;
  readonly commandDependencies?: QuestionCommandDependencies;
}

export interface QuestionsApplication {
  readonly eventBus: DomainEventBus;
  readonly gateway: QuestionsGatewayApplication;
  execute<C extends AppCommand>(command: C, context: TrustedExecutionContext): Promise<CommandResult<CommandValue<C>>>;
  query<Q extends AppQuery>(query: Q, context: TrustedExecutionContext): QueryResult<QueryValue<Q>>;
}

export interface QuestionsGatewayApplication {
  readonly commandBus: CommandBus;
  readonly queryBus: QueryBus;
  execute(
    command: AppCommand,
    context: TrustedExecutionContext,
    dispatch: () => Promise<CommandResult>
  ): Promise<CommandResult>;
  resolveState(
    envelope: AgentCommandEnvelope | AgentQueryEnvelope,
    descriptor: OperationDescriptor
  ): GatewayResolvedState;
}

function uniqueEntities(entities: readonly EntityRef[]): readonly EntityRef[] {
  return Object.freeze([...new Map(entities.map((entity) => [
    `${entity.entityType}\0${entity.entityId}`,
    Object.freeze({ entityType: entity.entityType, entityId: entity.entityId })
  ])).values()].sort((left, right) =>
    `${left.entityType}\0${left.entityId}`.localeCompare(`${right.entityType}\0${right.entityId}`)
  ));
}

function questionGatewayState(
  envelope: AgentCommandEnvelope | AgentQueryEnvelope,
  descriptor: OperationDescriptor,
  database: ReadOnlyDatabaseFacade,
  coordinator: DatabaseCoordinator
): GatewayResolvedState {
  if (descriptor.domain !== 'questions' || descriptor.name !== envelope.operation) throw new Error('Question Gateway descriptor mismatch');
  const payload = envelope.payload;
  const entities: EntityRef[] = [];
  let affectedEntityCount = 1;
  let managedFileCount = 0;
  const question = (questionId: unknown) => {
    if (typeof questionId !== 'number') return false;
    const exists = database.select<{ id: number }>('SELECT id FROM questions WHERE id = ?', [questionId])[0];
    return Boolean(exists);
  };

  switch (envelope.operation) {
    case 'questions.create':
      entities.push({ entityType: 'question_create', entityId: typeof payload.externalRef === 'string' ? payload.externalRef : hashCanonicalJson(payload) });
      break;
    case 'questions.update':
    case 'questions.mark_mastery':
    case 'questions.submit_review':
      entities.push({ entityType: 'question', entityId: String(payload.questionId) });
      affectedEntityCount = question(payload.questionId) ? 1 : 0;
      break;
    case 'questions.delete': {
      entities.push({ entityType: 'question', entityId: String(payload.questionId) });
      const exists = question(payload.questionId);
      const images = typeof payload.questionId === 'number'
        ? database.select<{ id: number }>('SELECT id FROM question_images WHERE question_id = ? ORDER BY id ASC', [payload.questionId])
        : [];
      for (const image of images) entities.push({ entityType: 'question_image', entityId: String(image.id) });
      affectedEntityCount = exists ? 1 : 0;
      managedFileCount = payload.deleteImages === true ? images.length : 0;
      break;
    }
    case 'questions.remove_image': {
      entities.push({ entityType: 'question_image', entityId: String(payload.imageId) });
      const image = typeof payload.imageId === 'number'
        ? database.select<{ id: number; question_id: number }>('SELECT id, question_id FROM question_images WHERE id = ?', [payload.imageId])[0]
        : undefined;
      if (image) entities.push({ entityType: 'question', entityId: String(image.question_id) });
      affectedEntityCount = image ? 1 : 0;
      managedFileCount = image && payload.deleteFile === true ? 1 : 0;
      break;
    }
    case 'questions.undo_review': {
      const log = typeof payload.reviewLogId === 'number'
        ? database.select<{ id: number; question_id: number }>('SELECT id, question_id FROM review_logs WHERE id = ?', [payload.reviewLogId])[0]
        : undefined;
      entities.push({ entityType: 'question', entityId: String(payload.questionId) });
      question(payload.questionId);
      entities.push({ entityType: 'review_log', entityId: String(payload.reviewLogId) });
      affectedEntityCount = log && log.question_id === payload.questionId ? 1 : 0;
      break;
    }
    case 'questions.link_knowledge': {
      entities.push({ entityType: 'question', entityId: String(payload.questionId) });
      affectedEntityCount = question(payload.questionId) ? 1 : 0;
      if (Array.isArray(payload.knowledgeNodeIds)) {
        for (const nodeId of payload.knowledgeNodeIds) {
          if (typeof nodeId !== 'string') continue;
          const exists = database.select<{ node_id: string }>('SELECT node_id FROM knowledge_points WHERE node_id = ?', [nodeId])[0];
          if (exists) entities.push({ entityType: 'knowledge_point', entityId: nodeId });
        }
      }
      break;
    }
    case 'questions.migrate_categories': {
      const limit = typeof payload.limit === 'number' ? payload.limit : 0;
      const rows = database.select<{ id: number }>(`SELECT id FROM questions WHERE category IN (?, ?, ?, ?, ?, ?) ORDER BY id ASC LIMIT ?`, [
        '函数、极限与连续', '多元函数微分学', '重积分', '曲线曲面积分', '微分方程', '线性代数', limit
      ]);
      rows.forEach((row) => entities.push({ entityType: 'question', entityId: String(row.id) }));
      affectedEntityCount = rows.length;
      break;
    }
    case 'questions.rematch_knowledge': {
      const limit = typeof payload.limit === 'number' ? payload.limit : 0;
      const questionIds = Array.isArray(payload.questionIds) ? payload.questionIds.filter((id): id is number => typeof id === 'number') : [];
      const rows = questionIds.length
        ? database.select<{ id: number }>(`SELECT id FROM questions WHERE id IN (${questionIds.map(() => '?').join(', ')}) ORDER BY id ASC LIMIT ?`, [...questionIds, limit])
        : database.select<{ id: number }>('SELECT id FROM questions ORDER BY id ASC LIMIT ?', [limit]);
      rows.forEach((row) => entities.push({ entityType: 'question', entityId: String(row.id) }));
      affectedEntityCount = rows.length;
      break;
    }
    case 'questions.bulk_upsert':
    case 'questions.import':
      affectedEntityCount = Array.isArray(payload.items) ? payload.items.length : 0;
      entities.push({ entityType: 'question_batch', entityId: hashCanonicalJson(payload) });
      break;
    case 'questions.replace_all': {
      const existing = Number(database.select<{ count: number }>('SELECT COUNT(*) AS count FROM questions')[0]?.count ?? 0);
      affectedEntityCount = Math.max(existing, Array.isArray(payload.questions) ? payload.questions.length : 0);
      entities.push({ entityType: 'question_state', entityId: 'all' });
      break;
    }
    case 'questions.clear_all': {
      affectedEntityCount = Number(database.select<{ count: number }>('SELECT COUNT(*) AS count FROM questions')[0]?.count ?? 0);
      entities.push({ entityType: 'question_state', entityId: 'all' });
      managedFileCount = payload.deleteImages === true
        ? Number(database.select<{ count: number }>('SELECT COUNT(*) AS count FROM question_images')[0]?.count ?? 0)
        : 0;
      break;
    }
    case 'questions.get':
    case 'questions.review_logs':
      entities.push({ entityType: 'question', entityId: String(payload.questionId) });
      affectedEntityCount = question(payload.questionId) ? 1 : 0;
      break;
    case 'questions.list':
      entities.push({ entityType: 'question_collection', entityId: 'filtered' });
      break;
    case 'questions.review_buckets':
      entities.push({ entityType: 'review_collection', entityId: 'buckets' });
      break;
    default:
      throw new Error(`Question Gateway mapping is missing for ${envelope.operation}`);
  }

  const affectedEntities = uniqueEntities(entities);
  const dataVersion = Object.freeze({ ...coordinator.currentVersion() });
  return Object.freeze({
    affectedEntityCount,
    affectedEntities,
    affectedSetHash: hashCanonicalJson(affectedEntities),
    targetHash: hashCanonicalJson({ operation: envelope.operation, affectedEntities, managedFileCount } as unknown as JsonObject),
    dataVersion,
    managedFileCount
  });
}

export function registerQuestions(options: RegisterQuestionsOptions): QuestionsApplication {
  const eventBus = options.eventBus ?? new DomainEventBus(options.eventBusOptions);
  // CommandBus must prepare and validate event identity before the database is
  // committed. It publishes only to this private bus; the public bus receives
  // the already-finalized events after managed-file finalization succeeds.
  const commandEventBus = new DomainEventBus(options.eventBusOptions);
  const commandBus = new CommandBus(options.coordinator, commandEventBus);
  const queryBus = new QueryBus(options.readOnlyDatabase, options.coordinator);
  const handlers = createQuestionCommandHandlers(options.commandDependencies);
  let executionTail: Promise<void> = Promise.resolve();

  commandBus.register('questions.create', { handler: withQuestionEvent(handlers.create) });
  commandBus.register('questions.update', { handler: withQuestionEvent(handlers.update), conflicts: (command) => [{ entityType: 'question', entityId: String(command.payload.questionId) }] });
  commandBus.register('questions.delete', { handler: withQuestionEvent(handlers.delete), conflicts: (command) => [{ entityType: 'question', entityId: String(command.payload.questionId) }] });
  commandBus.register('questions.remove_image', { handler: withQuestionEvent(handlers.removeImage), conflicts: (command) => [{ entityType: 'question_image', entityId: String(command.payload.imageId) }] });
  commandBus.register('questions.mark_mastery', { handler: withQuestionEvent(handlers.markMastery), conflicts: (command) => [{ entityType: 'question', entityId: String(command.payload.questionId) }] });
  commandBus.register('questions.submit_review', { handler: withQuestionEvent(handlers.submitReview), conflicts: (command) => [{ entityType: 'question', entityId: String(command.payload.questionId) }] });
  commandBus.register('questions.undo_review', { handler: withQuestionEvent(handlers.undoReview), conflicts: (command) => [{ entityType: 'question', entityId: String(command.payload.questionId) }, { entityType: 'review_log', entityId: String(command.payload.reviewLogId) }] });
  commandBus.register('questions.link_knowledge', { handler: withQuestionEvent(handlers.linkKnowledge), conflicts: (command) => [{ entityType: 'question', entityId: String(command.payload.questionId) }] });
  commandBus.register('questions.migrate_categories', { handler: withQuestionEvent(handlers.migrateCategories) });
  commandBus.register('questions.rematch_knowledge', { handler: withQuestionEvent(handlers.rematchKnowledge) });
  commandBus.register('questions.bulk_upsert', { handler: withQuestionEvent(handlers.bulkUpsert) });
  commandBus.register('questions.import', { handler: withQuestionEvent(handlers.importQuestions) });
  commandBus.register('questions.replace_all', { handler: withQuestionEvent(handlers.replaceAll) });
  commandBus.register('questions.clear_all', { handler: withQuestionEvent(handlers.clearAll) });

  queryBus.register('questions.list', listQuestionsQuery);
  queryBus.register('questions.get', getQuestionQuery);
  queryBus.register('questions.review_logs', reviewLogsQuery);
  queryBus.register('questions.review_buckets', reviewBucketsQuery);

  const execute = async (
    command: AppCommand,
    context: TrustedExecutionContext,
    dispatch: () => Promise<CommandResult>
  ): Promise<CommandResult> => {
    try {
      const result = await dispatch();
      await finalizeQuestionFileOperation(options.coordinator, context.requestId, true, options.commandDependencies);
      await eventBus.publish(result.events);
      return result;
    } catch (error) {
      await finalizeQuestionFileOperation(options.coordinator, context.requestId, false, options.commandDependencies);
      throw error;
    }
  };

  return Object.freeze({
    eventBus,
    gateway: Object.freeze({
      commandBus,
      queryBus,
      execute(command: AppCommand, context: TrustedExecutionContext, dispatch: () => Promise<CommandResult>) {
        const run = executionTail.then(() => execute(command, context, dispatch));
        executionTail = run.then(() => undefined, () => undefined);
        return run;
      },
      resolveState(envelope: AgentCommandEnvelope | AgentQueryEnvelope, descriptor: OperationDescriptor) {
        return questionGatewayState(envelope, descriptor, options.readOnlyDatabase, options.coordinator);
      }
    }),
    async execute<C extends AppCommand>(command: C, context: TrustedExecutionContext): Promise<CommandResult<CommandValue<C>>> {
      const run = executionTail.then(() => execute(command, context, () =>
        commandBus.execute({ apiVersion: agentApiVersion, kind: 'command', context, command })
      ));
      executionTail = run.then(() => undefined, () => undefined);
      return run as Promise<CommandResult<CommandValue<C>>>;
    },
    query<Q extends AppQuery>(query: Q, context: TrustedExecutionContext): QueryResult<QueryValue<Q>> {
      return queryBus.execute({ apiVersion: agentApiVersion, kind: 'query', context, query }) as QueryResult<QueryValue<Q>>;
    }
  });
}

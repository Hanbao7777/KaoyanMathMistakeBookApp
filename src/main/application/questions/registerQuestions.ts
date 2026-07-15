import { agentApiVersion } from '../../../shared/agent/versions';
import type {
  AppCommand,
  AppQuery,
  CommandResult,
  QueryResult,
  QuestionCommandValues,
  QuestionQueryValues,
  TrustedExecutionContext
} from '../../../shared/agent/v1/contracts';
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
  execute<C extends AppCommand>(command: C, context: TrustedExecutionContext): Promise<CommandResult<CommandValue<C>>>;
  query<Q extends AppQuery>(query: Q, context: TrustedExecutionContext): QueryResult<QueryValue<Q>>;
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

  const execute = async <C extends AppCommand>(command: C, context: TrustedExecutionContext): Promise<CommandResult<CommandValue<C>>> => {
    try {
      const result = await commandBus.execute({ apiVersion: agentApiVersion, kind: 'command', context, command });
      await finalizeQuestionFileOperation(options.coordinator, context.requestId, true, options.commandDependencies);
      await eventBus.publish(result.events);
      return result as CommandResult<CommandValue<C>>;
    } catch (error) {
      await finalizeQuestionFileOperation(options.coordinator, context.requestId, false, options.commandDependencies);
      throw error;
    }
  };

  return Object.freeze({
    eventBus,
    async execute<C extends AppCommand>(command: C, context: TrustedExecutionContext): Promise<CommandResult<CommandValue<C>>> {
      const run = executionTail.then(() => execute(command, context));
      executionTail = run.then(() => undefined, () => undefined);
      return run;
    },
    query<Q extends AppQuery>(query: Q, context: TrustedExecutionContext): QueryResult<QueryValue<Q>> {
      return queryBus.execute({ apiVersion: agentApiVersion, kind: 'query', context, query }) as QueryResult<QueryValue<Q>>;
    }
  });
}

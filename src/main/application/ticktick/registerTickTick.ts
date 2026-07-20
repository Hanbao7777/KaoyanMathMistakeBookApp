import type { DatabaseTerminalHook } from '../../persistence/databaseCoordinator';
import {
  createDatabaseCoordinatorBusinessCapability,
  type DatabaseCoordinator
} from '../../persistence/databaseCoordinator';
import type { CommandResult, EntityRef, QueryResult, TrustedExecutionContext } from '../../../shared/agent/v1/contracts';
import type { AgentCommandEnvelope, AgentQueryEnvelope, JsonObject, OperationDescriptor } from '../../../shared/agent/v1/gatewayContracts';
import { hashCanonicalJson } from '../../../shared/agent/v1/gatewaySchemas';
import type { GatewayResolvedState } from '../../agent/agentGateway';
import { DomainEventBus, type DomainEventBusOptions } from '../domainEvents';
import type { ReadOnlyDatabaseFacade } from '../queryBus';
import { executeTickTickCommand, type TickTickCommandDependencies } from './commands';
import {
  tickTickCommandTypes,
  tickTickQueryTypes,
  validateTickTickCommand,
  validateTickTickQuery,
  type TickTickCommand,
  type TickTickCommandValues,
  type TickTickQuery,
  type TickTickQueryValues
} from './contracts';
import { executeTickTickQuery } from './queries';

export interface RegisterTickTickOptions {
  readonly coordinator: DatabaseCoordinator;
  readonly readOnlyDatabase: ReadOnlyDatabaseFacade;
  readonly eventBus?: DomainEventBus;
  readonly eventBusOptions?: DomainEventBusOptions;
  readonly commandDependencies?: TickTickCommandDependencies;
  readonly today?: () => string;
}

export interface TickTickApplication {
  readonly eventBus: DomainEventBus;
  validateCommand(value: unknown): asserts value is TickTickCommand;
  validateQuery(value: unknown): asserts value is TickTickQuery;
  execute<C extends TickTickCommand>(
    command: C,
    context: TrustedExecutionContext,
    terminalHook?: DatabaseTerminalHook<CommandResult<TickTickCommandValues[C['type']]>>
  ): Promise<CommandResult<TickTickCommandValues[C['type']]> >;
  query<Q extends TickTickQuery>(query: Q, context: TrustedExecutionContext): QueryResult<TickTickQueryValues[Q['type']]>;
  resolveState(envelope: AgentCommandEnvelope | AgentQueryEnvelope, descriptor: OperationDescriptor): GatewayResolvedState;
}

function uniqueEntities(entities: readonly EntityRef[]): readonly EntityRef[] {
  return Object.freeze([...new Map(entities.map((entity) => [
    `${entity.entityType}\0${entity.entityId}`,
    Object.freeze({ entityType: entity.entityType, entityId: entity.entityId })
  ])).values()].sort((left, right) =>
    `${left.entityType}\0${left.entityId}`.localeCompare(`${right.entityType}\0${right.entityId}`)
  ));
}

function resolveState(
  envelope: AgentCommandEnvelope | AgentQueryEnvelope,
  descriptor: OperationDescriptor,
  database: ReadOnlyDatabaseFacade,
  coordinator: DatabaseCoordinator
): GatewayResolvedState {
  if (!['tasks', 'focus', 'ticktick'].includes(descriptor.domain) || descriptor.name !== envelope.operation) {
    throw new Error('TickTick Gateway descriptor mismatch');
  }
  const entities: EntityRef[] = [];
  let affectedEntityCount = 1;
  let recursiveAffectedEntityCount = 1;
  const payload = envelope.payload;
  switch (envelope.operation) {
    case 'tasks.create':
      entities.push({ entityType: 'task_create', entityId: hashCanonicalJson(payload) });
      break;
    case 'tasks.update':
    case 'tasks.complete':
    case 'tasks.uncomplete':
    case 'tasks.get': {
      const taskId = String(payload.taskId);
      entities.push({ entityType: 'task', entityId: taskId });
      affectedEntityCount = database.select<{ id: string }>('SELECT id FROM ticktick_tasks WHERE id = ?', [taskId]).length;
      recursiveAffectedEntityCount = affectedEntityCount;
      if (envelope.operation === 'tasks.complete' || envelope.operation === 'tasks.uncomplete') {
        const bridges = database.select<{ id: number; linked_type: string; linked_id: string }>(
          'SELECT id, linked_type, linked_id FROM ticktick_bridge WHERE ticktick_task_id = ? AND sync_review = 1 ORDER BY id ASC',
          [taskId]
        );
        for (const bridge of bridges) {
          entities.push({ entityType: 'ticktick_bridge', entityId: String(bridge.id) });
          entities.push({ entityType: bridge.linked_type, entityId: bridge.linked_id });
        }
      }
      break;
    }
    case 'tasks.delete': {
      const rootId = String(payload.taskId);
      const taskIds = [rootId];
      for (let index = 0; index < taskIds.length; index += 1) {
        for (const child of database.select<{ id: string }>('SELECT id FROM ticktick_tasks WHERE parent_id = ? ORDER BY id ASC', [taskIds[index]])) {
          if (!taskIds.includes(child.id)) taskIds.push(child.id);
        }
      }
      const existing = taskIds.filter((taskId) => database.select<{ id: string }>('SELECT id FROM ticktick_tasks WHERE id = ?', [taskId]).length > 0);
      for (const taskId of existing) entities.push({ entityType: 'task', entityId: taskId });
      if (!entities.length) entities.push({ entityType: 'task', entityId: rootId });
      const placeholders = existing.map(() => '?').join(', ');
      if (placeholders) {
        for (const bridge of database.select<{ id: number }>(
          `SELECT id FROM ticktick_bridge WHERE ticktick_task_id IN (${placeholders}) ORDER BY id ASC`, existing
        )) entities.push({ entityType: 'ticktick_bridge', entityId: String(bridge.id) });
      }
      affectedEntityCount = existing.length ? 1 : 0;
      recursiveAffectedEntityCount = existing.length;
      break;
    }
    case 'tasks.list':
      entities.push({ entityType: 'task_collection', entityId: 'filtered' });
      break;
    case 'focus.sessions.create':
      entities.push({ entityType: 'focus_session_create', entityId: hashCanonicalJson(payload) });
      if (payload.input && typeof payload.input === 'object' && !Array.isArray(payload.input)) {
        const taskId = (payload.input as JsonObject).task_id;
        if (typeof taskId === 'string') entities.push({ entityType: 'task', entityId: taskId });
      }
      break;
    case 'focus.sessions.list':
      entities.push({ entityType: 'focus_session_collection', entityId: 'filtered' });
      break;
    case 'ticktick.lists.create':
      entities.push({ entityType: 'ticktick_list_create', entityId: hashCanonicalJson(payload) });
      break;
    case 'ticktick.lists.update': {
      const listId = String(payload.listId); entities.push({ entityType: 'ticktick_list', entityId: listId });
      affectedEntityCount = database.select<{ id: string }>('SELECT id FROM ticktick_lists WHERE id = ?', [listId]).length; recursiveAffectedEntityCount = affectedEntityCount;
      break;
    }
    case 'ticktick.lists.list': entities.push({ entityType: 'ticktick_list_collection', entityId: 'all' }); break;
    case 'ticktick.habits.create': entities.push({ entityType: 'ticktick_habit_create', entityId: hashCanonicalJson(payload) }); break;
    case 'ticktick.habits.update': {
      const habitId = String(payload.habitId); entities.push({ entityType: 'ticktick_habit', entityId: habitId });
      affectedEntityCount = database.select<{ id: string }>('SELECT id FROM ticktick_habits WHERE id = ?', [habitId]).length; recursiveAffectedEntityCount = affectedEntityCount;
      break;
    }
    case 'ticktick.habits.list': entities.push({ entityType: 'ticktick_habit_collection', entityId: 'all' }); break;
    case 'ticktick.calendar.list_events': entities.push({ entityType: 'ticktick_calendar', entityId: `${String(payload.year)}-${String(payload.month)}` }); break;
    case 'ticktick.bridges.get': {
      const taskId = String(payload.taskId); entities.push({ entityType: 'task', entityId: taskId });
      for (const bridge of database.select<{ id: number }>('SELECT id FROM ticktick_bridge WHERE ticktick_task_id = ?', [taskId])) entities.push({ entityType: 'ticktick_bridge', entityId: String(bridge.id) });
      break;
    }
    case 'ticktick.bridges.update': {
      const input = payload.input as JsonObject; const taskId = String(input.ticktick_task_id); const linkedType = String(input.linked_type); const linkedId = String(input.linked_id);
      entities.push({ entityType: 'task', entityId: taskId }, { entityType: linkedType, entityId: linkedId });
      const bridge = database.select<{ id: number }>('SELECT id FROM ticktick_bridge WHERE ticktick_task_id = ? AND linked_type = ? AND linked_id = ?', [taskId, linkedType, linkedId])[0];
      if (bridge) entities.push({ entityType: 'ticktick_bridge', entityId: String(bridge.id) });
      break;
    }
    default:
      throw new Error(`TickTick Gateway mapping is missing for ${envelope.operation}`);
  }
  const affectedEntities = uniqueEntities(entities);
  return Object.freeze({
    affectedEntityCount,
    recursiveAffectedEntityCount,
    affectedEntities,
    affectedSetHash: hashCanonicalJson(affectedEntities),
    targetHash: hashCanonicalJson({ operation: envelope.operation, affectedEntities } as unknown as JsonObject),
    dataVersion: Object.freeze({ ...coordinator.currentVersion() })
  });
}

function commandConflicts(command: TickTickCommand): readonly EntityRef[] | undefined {
  switch (command.type) {
    case 'tasks.update':
    case 'tasks.complete':
    case 'tasks.uncomplete':
    case 'tasks.delete':
      return [{ entityType: 'task', entityId: command.payload.taskId }];
    case 'ticktick.lists.update':
      return [{ entityType: 'ticktick_list', entityId: command.payload.listId }];
    case 'ticktick.habits.update':
      return [{ entityType: 'ticktick_habit', entityId: command.payload.habitId }];
    case 'ticktick.bridges.update':
      return [
        { entityType: 'task', entityId: command.payload.input.ticktick_task_id },
        { entityType: command.payload.input.linked_type, entityId: command.payload.input.linked_id }
      ];
    default:
      return undefined;
  }
}

export function registerTickTick(options: RegisterTickTickOptions): TickTickApplication {
  const eventBus = options.eventBus ?? new DomainEventBus(options.eventBusOptions);
  const capability = createDatabaseCoordinatorBusinessCapability(options.coordinator);
  return Object.freeze({
    eventBus,
    validateCommand: validateTickTickCommand,
    validateQuery: validateTickTickQuery,
    async execute<C extends TickTickCommand>(
      command: C,
      context: TrustedExecutionContext,
      terminalHook?: DatabaseTerminalHook<CommandResult<TickTickCommandValues[C['type']]>>
    ): Promise<CommandResult<TickTickCommandValues[C['type']]>> {
      validateTickTickCommand(command);
      let eventDraft: { readonly type: string; readonly payload: Readonly<Record<string, unknown>> } | undefined;
      const result = await options.coordinator.executeBusinessWrite(capability, {
        requestId: context.requestId,
        concurrency: context.concurrency,
        expectedVersion: context.expectedVersion,
        conflicts: commandConflicts(command),
        terminalHook,
        async execute(database, scope) {
          const mutation = await executeTickTickCommand(command, database, scope, context, options.commandDependencies);
          eventDraft = { type: mutation.eventType, payload: mutation.eventPayload };
          return { changed: mutation.changed, value: mutation.value };
        },
        finalizeValue(terminalContext) {
          const events = terminalContext.semanticChanged && eventDraft
            ? eventBus.finalizeEvents(eventBus.prepareEvents([eventDraft], {
                requestId: context.requestId, traceId: context.traceId, source: context.source
              }), {
                versionBefore: terminalContext.versionBefore,
                versionAfter: terminalContext.versionAfter
              })
            : Object.freeze([]);
          return Object.freeze({
            changed: terminalContext.semanticChanged,
            value: terminalContext.value,
            events,
            dataVersion: Object.freeze({ ...terminalContext.versionAfter })
          });
        }
      });
      await eventBus.publish(result.value.events);
      return result.value;
    },
    query<Q extends TickTickQuery>(query: Q, _context: TrustedExecutionContext): QueryResult<TickTickQueryValues[Q['type']]> {
      validateTickTickQuery(query);
      if (options.coordinator.state === 'needs_recovery') throw new Error('TickTick query unavailable during recovery');
      if (options.coordinator.pendingWrites !== 0) throw new Error('TickTick query unavailable during a write');
      const versionBefore = options.coordinator.currentVersion();
      const value = executeTickTickQuery(query, options.readOnlyDatabase, { today: options.today });
      const versionAfter = options.coordinator.currentVersion();
      if (versionBefore.dataEpoch !== versionAfter.dataEpoch || versionBefore.dataRevision !== versionAfter.dataRevision) {
        throw new Error('TickTick query version changed during execution');
      }
      return { value, dataVersion: Object.freeze({ ...versionAfter }) };
    },
    resolveState(envelope: AgentCommandEnvelope | AgentQueryEnvelope, descriptor: OperationDescriptor) {
      return resolveState(envelope, descriptor, options.readOnlyDatabase, options.coordinator);
    }
  });
}

export function isTickTickCommandOperation(operation: string): boolean {
  return (tickTickCommandTypes as readonly string[]).includes(operation);
}

export function isTickTickQueryOperation(operation: string): boolean {
  return (tickTickQueryTypes as readonly string[]).includes(operation);
}

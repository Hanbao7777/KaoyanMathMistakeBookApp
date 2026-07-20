import { randomUUID } from 'node:crypto';
import type { AgentCommandEnvelope, AgentQueryEnvelope, JsonObject, OperationDescriptor } from '../../../shared/agent/v1/gatewayContracts';
import type { CommandResult, EntityRef, QueryResult, TrustedExecutionContext } from '../../../shared/agent/v1/contracts';
import { hashCanonicalJson } from '../../../shared/agent/v1/gatewaySchemas';
import type { GatewayResolvedState } from '../../agent/agentGateway';
import { createDatabaseCoordinatorBusinessCapability, type DatabaseCoordinator, type DatabaseTerminalHook } from '../../persistence/databaseCoordinator';
import { DomainEventBus } from '../domainEvents';
import type { ReadOnlyDatabaseFacade } from '../queryBus';
import { executeStudyCommand } from './commands';
import { executeStudyQuery } from './queries';
import { type StudyCommand, type StudyCommandValues, type StudyQuery, type StudyQueryValues, validateStudyCommand, validateStudyQuery } from './contracts';

export interface StudyApplication {
  readonly eventBus: DomainEventBus;
  execute<C extends StudyCommand>(command: C, context: TrustedExecutionContext, terminalHook?: DatabaseTerminalHook<CommandResult<StudyCommandValues[C['type']]>>): Promise<CommandResult<StudyCommandValues[C['type']]>>;
  query<Q extends StudyQuery>(query: Q, context: TrustedExecutionContext): QueryResult<StudyQueryValues[Q['type']]>;
  resolveState(envelope: AgentCommandEnvelope | AgentQueryEnvelope, descriptor: OperationDescriptor): GatewayResolvedState;
}

function localCalendarDate(timestamp: string): string {
  const value = new Date(timestamp);
  if (!Number.isFinite(value.getTime())) throw new Error('Invalid study clock');
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

export function registerStudy(options: { coordinator: DatabaseCoordinator; readOnlyDatabase: ReadOnlyDatabaseFacade; now?: () => string; nextId?: (prefix: string) => string; today?: () => string }): StudyApplication {
  const eventBus = new DomainEventBus();
  const capability = createDatabaseCoordinatorBusinessCapability(options.coordinator);
  const now = options.now ?? (() => new Date().toISOString());
  const nextId = options.nextId ?? ((prefix) => `${prefix}-${randomUUID()}`);
  const today = options.today ?? (() => localCalendarDate(now()));
  const resolveState = (envelope: AgentCommandEnvelope | AgentQueryEnvelope, descriptor: OperationDescriptor): GatewayResolvedState => {
    if (descriptor.domain !== 'study' || descriptor.name !== envelope.operation) throw new Error('Study Gateway descriptor mismatch');
    const payload = envelope.payload;
    const entities: EntityRef[] = [];
    let affectedEntityCount = 1;
    switch (envelope.operation) {
      case 'study.create_plan_draft': {
        const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
        for (const [index, task] of tasks.entries()) entities.push({ entityType: 'study_task_create', entityId: hashCanonicalJson({ date: payload.date, index, task } as unknown as JsonObject) });
        affectedEntityCount = tasks.length;
        break;
      }
      case 'study.apply_plan_adjustment':
        if (typeof payload.taskId === 'string') entities.push({ entityType: 'study_task', entityId: payload.taskId });
        break;
      case 'study.record_manual_progress':
        entities.push({ entityType: 'study_session_create', entityId: hashCanonicalJson(payload) });
        if (typeof payload.taskId === 'string') entities.push({ entityType: 'study_task', entityId: payload.taskId });
        if (typeof payload.materialId === 'string') entities.push({ entityType: 'study_material', entityId: payload.materialId });
        affectedEntityCount = entities.length;
        break;
      case 'study.get_today':
      case 'study.get_week_summary':
        entities.push({ entityType: 'study_day', entityId: typeof payload.date === 'string' ? payload.date : 'today' });
        break;
      default:
        throw new Error(`Study Gateway mapping is missing for ${envelope.operation}`);
    }
    return Object.freeze({
      affectedEntityCount,
      affectedEntities: Object.freeze(entities),
      affectedSetHash: hashCanonicalJson(entities),
      targetHash: hashCanonicalJson({ operation: envelope.operation, entities } as unknown as JsonObject),
      dataVersion: Object.freeze({ ...options.coordinator.currentVersion() })
    });
  };
  return Object.freeze({
    eventBus,
    async execute<C extends StudyCommand>(command: C, context: TrustedExecutionContext, terminalHook?: DatabaseTerminalHook<CommandResult<StudyCommandValues[C['type']]>>) {
      validateStudyCommand(command);
      let draft: { type: string; payload: Record<string, unknown> } | undefined;
      const terminal = await options.coordinator.executeBusinessWrite(capability, {
        requestId: context.requestId,
        concurrency: context.concurrency,
        expectedVersion: context.expectedVersion,
        terminalHook,
        execute(database, scope) {
          const result = executeStudyCommand(command, database, scope, now, nextId);
          draft = { type: result.eventType, payload: result.eventPayload };
          return { changed: result.changed, value: result.value };
        },
        finalizeValue(value) {
          const events = value.semanticChanged && draft
            ? eventBus.finalizeEvents(eventBus.prepareEvents([draft], { requestId: context.requestId, traceId: context.traceId, source: context.source }), { versionBefore: value.versionBefore, versionAfter: value.versionAfter })
            : [];
          return Object.freeze({ changed: value.semanticChanged, value: value.value, events, dataVersion: Object.freeze({ ...value.versionAfter }) });
        }
      });
      await eventBus.publish(terminal.value.events);
      return terminal.value as CommandResult<StudyCommandValues[C['type']]>;
    },
    query<Q extends StudyQuery>(query: Q, _context: TrustedExecutionContext) {
      validateStudyQuery(query);
      const before = options.coordinator.currentVersion();
      const value = executeStudyQuery(query, options.readOnlyDatabase, today);
      const after = options.coordinator.currentVersion();
      if (before.dataEpoch !== after.dataEpoch || before.dataRevision !== after.dataRevision) throw new Error('Study query version changed during execution');
      return { value, dataVersion: Object.freeze({ ...after }) } as QueryResult<StudyQueryValues[Q['type']]>;
    },
    resolveState
  });
}

export function isStudyCommandOperation(operation: string): boolean { return ['study.create_plan_draft', 'study.apply_plan_adjustment', 'study.record_manual_progress'].includes(operation); }
export function isStudyQueryOperation(operation: string): boolean { return ['study.get_today', 'study.get_week_summary'].includes(operation); }

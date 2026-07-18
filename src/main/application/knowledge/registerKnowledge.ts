import type { AgentCommandEnvelope, AgentQueryEnvelope, JsonObject, OperationDescriptor } from '../../../shared/agent/v1/gatewayContracts';
import type { CommandResult, EntityRef, QueryResult, TrustedExecutionContext } from '../../../shared/agent/v1/contracts';
import { hashCanonicalJson } from '../../../shared/agent/v1/gatewaySchemas';
import type { GatewayResolvedState } from '../../agent/agentGateway';
import { createDatabaseCoordinatorBusinessCapability, type DatabaseCoordinator, type DatabaseTerminalHook } from '../../persistence/databaseCoordinator';
import { DomainEventBus } from '../domainEvents';
import type { ReadOnlyDatabaseFacade } from '../queryBus';
import { executeKnowledgeCommand } from './commands';
import { knowledgeCommandTypes, knowledgeQueryTypes, type KnowledgeCommand, type KnowledgeCommandValues, type KnowledgeQuery, type KnowledgeQueryValues, validateKnowledgeCommand, validateKnowledgeQuery } from './contracts';
import { executeKnowledgeQuery } from './queries';

export interface KnowledgeApplication {
  readonly eventBus: DomainEventBus;
  execute<C extends KnowledgeCommand>(command: C, context: TrustedExecutionContext, terminalHook?: DatabaseTerminalHook<CommandResult<KnowledgeCommandValues[C['type']]>>): Promise<CommandResult<KnowledgeCommandValues[C['type']]>>;
  query<Q extends KnowledgeQuery>(query: Q, context: TrustedExecutionContext): QueryResult<KnowledgeQueryValues[Q['type']]>;
  resolveState(envelope: AgentCommandEnvelope | AgentQueryEnvelope, descriptor: OperationDescriptor): GatewayResolvedState;
}

export function registerKnowledge(options: { coordinator: DatabaseCoordinator; readOnlyDatabase: ReadOnlyDatabaseFacade }): KnowledgeApplication {
  const eventBus = new DomainEventBus(); const capability = createDatabaseCoordinatorBusinessCapability(options.coordinator);
  const resolveState = (envelope: AgentCommandEnvelope | AgentQueryEnvelope, descriptor: OperationDescriptor): GatewayResolvedState => {
    if (!['knowledge', 'textbooks', 'analytics'].includes(descriptor.domain) || descriptor.name !== envelope.operation) throw new Error('Knowledge Gateway descriptor mismatch');
    const payload = envelope.payload; const entities: EntityRef[] = [];
    if (typeof payload.nodeId === 'string') entities.push({ entityType: 'knowledge_point', entityId: payload.nodeId });
    if (typeof payload.questionId === 'number') entities.push({ entityType: 'question', entityId: String(payload.questionId) });
    if (typeof payload.textbookId === 'number') entities.push({ entityType: 'textbook', entityId: String(payload.textbookId) });
    if (!entities.length) entities.push({ entityType: `${descriptor.domain}_collection`, entityId: 'filtered' });
    const unique = [...new Map(entities.map((entity) => [`${entity.entityType}\0${entity.entityId}`, entity])).values()];
    return Object.freeze({ affectedEntityCount: unique.length, affectedEntities: Object.freeze(unique), affectedSetHash: hashCanonicalJson(unique), targetHash: hashCanonicalJson({ operation: envelope.operation, entities: unique } as unknown as JsonObject), dataVersion: Object.freeze({ ...options.coordinator.currentVersion() }) });
  };
  return Object.freeze({
    eventBus,
    async execute<C extends KnowledgeCommand>(command: C, context: TrustedExecutionContext, terminalHook?: DatabaseTerminalHook<CommandResult<KnowledgeCommandValues[C['type']]>>) {
      validateKnowledgeCommand(command); let draft: { type: string; payload: Record<string, unknown> } | undefined;
      const result = await options.coordinator.executeBusinessWrite(capability, { requestId: context.requestId, concurrency: context.concurrency, expectedVersion: context.expectedVersion, terminalHook,
        execute(database, scope) { const mutation = executeKnowledgeCommand(command, database, scope); draft = { type: mutation.eventType, payload: mutation.eventPayload }; return { changed: mutation.changed, value: mutation.value }; },
        finalizeValue(terminal) { const events = terminal.semanticChanged && draft ? eventBus.finalizeEvents(eventBus.prepareEvents([draft], { requestId: context.requestId, traceId: context.traceId, source: context.source }), { versionBefore: terminal.versionBefore, versionAfter: terminal.versionAfter }) : []; return Object.freeze({ changed: terminal.semanticChanged, value: terminal.value, events, dataVersion: Object.freeze({ ...terminal.versionAfter }) }); }
      }); await eventBus.publish(result.value.events); return result.value as CommandResult<KnowledgeCommandValues[C['type']]>;
    },
    query<Q extends KnowledgeQuery>(query: Q, _context: TrustedExecutionContext) { validateKnowledgeQuery(query); if (options.coordinator.state === 'needs_recovery' || options.coordinator.pendingWrites !== 0) throw new Error('Knowledge query unavailable during write or recovery'); const before = options.coordinator.currentVersion(); const value = executeKnowledgeQuery(query, options.readOnlyDatabase); const after = options.coordinator.currentVersion(); if (before.dataEpoch !== after.dataEpoch || before.dataRevision !== after.dataRevision) throw new Error('Knowledge query version changed during execution'); return { value, dataVersion: Object.freeze({ ...after }) } as QueryResult<KnowledgeQueryValues[Q['type']]>; },
    resolveState
  });
}

export function isKnowledgeCommandOperation(operation: string): boolean { return (knowledgeCommandTypes as readonly string[]).includes(operation); }
export function isKnowledgeQueryOperation(operation: string): boolean { return (knowledgeQueryTypes as readonly string[]).includes(operation); }

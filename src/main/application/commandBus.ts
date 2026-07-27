import { AgentError } from '../../shared/agent/errors';
import type { Database } from 'sql.js';
import type {
  AppCommand,
  CommandEnvelope,
  CommandResult,
  EntityRef,
  AppCommandValues,
  TrustedExecutionContext
} from '../../shared/agent/v1/contracts';
import { validateCommandEnvelope } from '../../shared/agent/v1/schemas';
import type {
  DatabaseCoordinator,
  DatabaseCoordinatorCapability,
  DatabaseMutationScope,
  DatabaseMutationResult,
  DatabaseTerminalHook
} from '../persistence/databaseCoordinator';
import { createDatabaseCoordinatorBusinessCapability } from '../persistence/databaseCoordinator';
import {
  DomainEventBus,
  type DomainEventDraft,
  type PreparedDomainEvent
} from './domainEvents';

type CommandOfType<T extends AppCommand['type']> = Extract<AppCommand, { type: T }>;
type CommandValue<C extends AppCommand> = AppCommandValues[C['type']];

export interface CommandHandlerResult<T> extends DatabaseMutationResult<T> {
  readonly events?: readonly DomainEventDraft[];
}

export type CommandHandler<C extends AppCommand> = (
  command: C,
  context: TrustedExecutionContext,
  database: Database,
  scope: DatabaseMutationScope
) => CommandHandlerResult<CommandValue<C>> | Promise<CommandHandlerResult<CommandValue<C>>>;

export interface CommandRegistration<C extends AppCommand> {
  readonly handler: CommandHandler<C>;
  readonly conflicts?: (command: C) => readonly EntityRef[];
}

interface StoredRegistration {
  readonly handler: CommandHandler<AppCommand>;
  readonly conflicts?: (command: AppCommand) => readonly EntityRef[];
}

export interface CommandBusExecutionReceiptCapability {
  readonly kind: 'command-bus-execution-receipt-capability';
}

const receiptCapabilities = new WeakMap<object, CommandBus>();

export function createCommandBusExecutionReceiptCapability(
  commandBus: CommandBus
): CommandBusExecutionReceiptCapability {
  const capability = Object.freeze({ kind: 'command-bus-execution-receipt-capability' as const });
  receiptCapabilities.set(capability, commandBus);
  return capability;
}

function applicationError(error: unknown): AgentError {
  return error instanceof AgentError ? error : new AgentError('INTERNAL_ERROR');
}

function trustedContext(envelope: CommandEnvelope): TrustedExecutionContext {
  if (envelope.context.trust !== 'trusted') {
    throw new AgentError('VALIDATION_ERROR', { field: 'envelope.context.trust' });
  }
  return envelope.context;
}

export class CommandBus {
  private readonly registrations = new Map<AppCommand['type'], StoredRegistration>();
  private readonly coordinator: DatabaseCoordinator;
  private readonly coordinatorCapability: DatabaseCoordinatorCapability;
  private readonly eventBus: DomainEventBus;

  constructor(coordinator: DatabaseCoordinator, eventBus: DomainEventBus) {
    this.coordinator = coordinator;
    this.coordinatorCapability = createDatabaseCoordinatorBusinessCapability(coordinator);
    this.eventBus = eventBus;
  }

  register<T extends AppCommand['type']>(
    type: T,
    registration: CommandRegistration<CommandOfType<T>>
  ): void {
    if (this.registrations.has(type)) throw new AgentError('HANDLER_ALREADY_REGISTERED');
    this.registrations.set(type, registration as unknown as StoredRegistration);
  }

  execute<C extends AppCommand>(envelope: CommandEnvelope<C>): Promise<CommandResult<CommandValue<C>>>;
  execute(envelope: unknown): Promise<CommandResult>;
  execute(envelope: unknown): Promise<CommandResult> {
    try {
      validateCommandEnvelope(envelope);
      trustedContext(envelope);
      if (!this.registrations.has(envelope.command.type)) throw new AgentError('HANDLER_NOT_FOUND');
    } catch (error) {
      return Promise.reject(applicationError(error));
    }

    return this.executeValidated(envelope);
  }

  executeWithExecutionReceipt<C extends AppCommand>(
    capability: CommandBusExecutionReceiptCapability,
    envelope: CommandEnvelope<C>,
    terminalHook: DatabaseTerminalHook<CommandResult<CommandValue<C>>>
  ): Promise<CommandResult<CommandValue<C>>>;
  executeWithExecutionReceipt(
    capability: CommandBusExecutionReceiptCapability,
    envelope: unknown,
    terminalHook: DatabaseTerminalHook<CommandResult>
  ): Promise<CommandResult>;
  executeWithExecutionReceipt(
    capability: CommandBusExecutionReceiptCapability,
    envelope: unknown,
    terminalHook: DatabaseTerminalHook<CommandResult>
  ): Promise<CommandResult> {
    if (receiptCapabilities.get(capability as object) !== this) {
      return Promise.reject(applicationError(new Error('A valid execution receipt capability is required')));
    }
    if (!terminalHook || typeof terminalHook.execute !== 'function') {
      return Promise.reject(applicationError(new Error('A terminal receipt hook is required')));
    }
    try {
      validateCommandEnvelope(envelope);
      trustedContext(envelope);
      if (!this.registrations.has(envelope.command.type)) throw new AgentError('HANDLER_NOT_FOUND');
    } catch (error) {
      return Promise.reject(applicationError(error));
    }
    return this.executeValidated(envelope, terminalHook);
  }

  private async executeValidated(
    envelope: CommandEnvelope,
    terminalHook?: DatabaseTerminalHook<CommandResult>
  ): Promise<CommandResult> {
    const context = trustedContext(envelope);
    const registration = this.registrations.get(envelope.command.type);
    if (!registration) throw new AgentError('HANDLER_NOT_FOUND');
    let preparedEvents: readonly PreparedDomainEvent[] = Object.freeze([]);

    try {
      const writeResult = await this.coordinator.executeBusinessWrite(this.coordinatorCapability, {
        requestId: context.requestId,
        concurrency: context.concurrency,
        expectedVersion: context.expectedVersion,
        conflicts: registration.conflicts?.(envelope.command),
        terminalHook,
        finalizeValue: (terminalContext) => {
          const events = terminalContext.semanticChanged
            ? this.eventBus.finalizeEvents(preparedEvents, {
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
        },
        execute: async (database, scope) => {
          const handlerResult = await registration.handler(envelope.command, context, database, scope);
          if (!handlerResult || typeof handlerResult.changed !== 'boolean') {
            throw new Error('Command handler returned an invalid result');
          }
          preparedEvents = handlerResult.changed
            ? this.eventBus.prepareEvents(handlerResult.events ?? [], {
                requestId: context.requestId,
                traceId: context.traceId,
                source: context.source
              })
            : Object.freeze([]);
          return { changed: handlerResult.changed, value: handlerResult.value };
        }
      });

      await this.eventBus.publish(writeResult.value.events);
      return writeResult.value;
    } catch (error) {
      throw applicationError(error);
    }
  }
}

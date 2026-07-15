import crypto from 'node:crypto';
import { agentApiVersion } from '../../shared/agent/versions';
import type {
  DataVersion,
  DomainEvent,
  ExecutionSource
} from '../../shared/agent/v1/contracts';
import { validateDomainEvent } from '../../shared/agent/v1/schemas';

export interface DomainEventDraft<T extends object = Record<string, unknown>> {
  readonly type: string;
  readonly payload: T;
}

export interface DomainEventMetadata {
  readonly requestId: string;
  readonly traceId: string;
  readonly source: ExecutionSource;
}

export interface PreparedDomainEvent extends DomainEventMetadata {
  readonly apiVersion: typeof agentApiVersion;
  readonly eventId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly payload: Readonly<object>;
}

export interface DomainEventVersions {
  readonly versionBefore: DataVersion;
  readonly versionAfter: DataVersion;
}

export interface DomainEventDiagnostic {
  readonly event: DomainEvent;
  readonly listenerIndex: number;
  readonly error: unknown;
}

export type DomainEventListener = (event: DomainEvent) => void | Promise<void>;
export type DomainEventDiagnosticSink = (diagnostic: DomainEventDiagnostic) => void | Promise<void>;

export interface DomainEventBusOptions {
  readonly diagnosticSink?: DomainEventDiagnosticSink;
  readonly randomUUID?: () => string;
  readonly now?: () => string;
}

function cloneImmutable<T>(value: T): T {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Domain event numbers must be finite');
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneImmutable(entry))) as T;
  }
  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Domain event payloads must contain only plain data');
    }
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) result[key] = cloneImmutable(entry);
    return Object.freeze(result) as T;
  }
  throw new Error('Domain event payloads must contain only plain data');
}

function immutableVersion(version: DataVersion): DataVersion {
  return Object.freeze({ dataEpoch: version.dataEpoch, dataRevision: version.dataRevision });
}

const preparationVersionBefore = Object.freeze({ dataEpoch: 'event-preparation', dataRevision: 0 });
const preparationVersionAfter = Object.freeze({ dataEpoch: 'event-preparation', dataRevision: 1 });

function prepareDomainEventDrafts(drafts: readonly DomainEventDraft[]): readonly DomainEventDraft[] {
  if (!Array.isArray(drafts)) throw new Error('Command events must be an array');
  return Object.freeze(drafts.map((draft) => {
    if (!draft || typeof draft !== 'object' || typeof draft.type !== 'string' || !draft.type || draft.type.length > 200) {
      throw new Error('Command returned an invalid domain event');
    }
    if (!draft.payload || typeof draft.payload !== 'object' || Array.isArray(draft.payload)) {
      throw new Error('Domain event payloads must be objects');
    }
    return Object.freeze({ type: draft.type, payload: cloneImmutable(draft.payload) });
  }));
}

export class DomainEventBus {
  private readonly listeners: DomainEventListener[] = [];
  private readonly diagnosticSink: DomainEventDiagnosticSink;
  private readonly randomUUID: () => string;
  private readonly now: () => string;

  constructor(options: DomainEventBusOptions = {}) {
    this.diagnosticSink = options.diagnosticSink ?? (() => undefined);
    this.randomUUID = options.randomUUID ?? crypto.randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  subscribe(listener: DomainEventListener): () => void {
    this.listeners.push(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  prepareEvents(drafts: readonly DomainEventDraft[], metadata: DomainEventMetadata): readonly PreparedDomainEvent[] {
    const preparedDrafts = prepareDomainEventDrafts(drafts);
    const events = preparedDrafts.map((draft) => {
      const prepared = Object.freeze({
        apiVersion: agentApiVersion,
        eventId: this.randomUUID().toLowerCase(),
        type: draft.type,
        occurredAt: new Date(this.now()).toISOString(),
        requestId: metadata.requestId,
        traceId: metadata.traceId,
        source: metadata.source,
        payload: draft.payload
      });
      validateDomainEvent({
        ...prepared,
        versionBefore: preparationVersionBefore,
        versionAfter: preparationVersionAfter
      });
      return prepared;
    });
    return Object.freeze(events);
  }

  finalizeEvents(preparedEvents: readonly PreparedDomainEvent[], versions: DomainEventVersions): readonly DomainEvent[] {
    const versionBefore = immutableVersion(versions.versionBefore);
    const versionAfter = immutableVersion(versions.versionAfter);
    return Object.freeze(preparedEvents.map((prepared) => Object.freeze({
      ...prepared,
      versionBefore,
      versionAfter
    })));
  }

  async publish(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      const listeners = [...this.listeners];
      for (let listenerIndex = 0; listenerIndex < listeners.length; listenerIndex += 1) {
        try {
          await listeners[listenerIndex](event);
        } catch (error) {
          try {
            await this.diagnosticSink(Object.freeze({ event, listenerIndex, error }));
          } catch {
            // Diagnostics must never alter durable command outcomes or listener delivery.
          }
        }
      }
    }
  }
}

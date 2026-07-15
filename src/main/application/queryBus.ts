import type { Database, SqlValue } from 'sql.js';
import { AgentError } from '../../shared/agent/errors';
import type {
  AppQuery,
  QueryEnvelope,
  QueryResult,
  QuestionQueryValues,
  TrustedExecutionContext
} from '../../shared/agent/v1/contracts';
import { validateQueryEnvelope } from '../../shared/agent/v1/schemas';
import type { DatabaseRuntimeState } from '../persistence/recoveryState';

type QueryOfType<T extends AppQuery['type']> = Extract<AppQuery, { type: T }>;
type QueryValue<Q extends AppQuery> = QuestionQueryValues[Q['type']];

export interface ReadOnlyDatabaseFacade {
  readonly kind: 'application-read-only-database';
  select<T extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>>(
    sql: string,
    parameters?: readonly SqlValue[]
  ): readonly T[];
}

export interface QueryRuntimeState {
  readonly state: DatabaseRuntimeState;
  readonly pendingWrites: number;
  currentVersion(): { readonly dataEpoch: string; readonly dataRevision: number };
}

export type QueryHandler<Q extends AppQuery> = (
  query: Q,
  context: TrustedExecutionContext,
  database: ReadOnlyDatabaseFacade
) => QueryValue<Q>;

function applicationError(error: unknown): AgentError {
  return error instanceof AgentError ? error : new AgentError('INTERNAL_ERROR');
}

function trustedContext(envelope: QueryEnvelope): TrustedExecutionContext {
  if (envelope.context.trust !== 'trusted') {
    throw new AgentError('VALIDATION_ERROR', { field: 'envelope.context.trust' });
  }
  return envelope.context;
}

function assertReadStatement(sql: string): void {
  const normalized = sql.trim();
  if (!/^SELECT\b/i.test(normalized) || normalized.includes(';') || /--|\/\*/.test(normalized)) {
    throw new AgentError('VALIDATION_ERROR', { field: 'query.sql' });
  }
}

export function createReadOnlyDatabaseFacade(database: () => Database): ReadOnlyDatabaseFacade {
  return Object.freeze({
    kind: 'application-read-only-database' as const,
    select<T extends Readonly<Record<string, unknown>>>(sql: string, parameters: readonly SqlValue[] = []): readonly T[] {
      assertReadStatement(sql);
      const statement = database().prepare(sql);
      try {
        statement.bind([...parameters]);
        const rows: T[] = [];
        while (statement.step()) rows.push(Object.freeze(statement.getAsObject()) as T);
        return Object.freeze(rows);
      } finally {
        statement.free();
      }
    }
  });
}

export class QueryBus {
  private readonly registrations = new Map<AppQuery['type'], QueryHandler<AppQuery>>();
  private readonly database: ReadOnlyDatabaseFacade;
  private readonly runtime: QueryRuntimeState;

  constructor(database: ReadOnlyDatabaseFacade, runtime: QueryRuntimeState) {
    this.database = database;
    this.runtime = runtime;
  }

  register<T extends AppQuery['type']>(type: T, handler: QueryHandler<QueryOfType<T>>): void {
    if (this.registrations.has(type)) throw new AgentError('HANDLER_ALREADY_REGISTERED');
    this.registrations.set(type, handler as unknown as QueryHandler<AppQuery>);
  }

  execute<Q extends AppQuery>(envelope: QueryEnvelope<Q>): QueryResult<QueryValue<Q>>;
  execute(envelope: unknown): QueryResult;
  execute(envelope: unknown): QueryResult {
    try {
      validateQueryEnvelope(envelope);
      const context = trustedContext(envelope);
      const handler = this.registrations.get(envelope.query.type);
      if (!handler) throw new AgentError('HANDLER_NOT_FOUND');
      this.assertQueryAdmission();
      const versionBefore = this.runtime.currentVersion();
      const value = handler(envelope.query, context, this.database);
      if (value && typeof (value as unknown as Promise<unknown>).then === 'function') {
        throw new Error('Query handlers must be synchronous');
      }
      const versionAfter = this.runtime.currentVersion();
      if (
        versionBefore.dataEpoch !== versionAfter.dataEpoch ||
        versionBefore.dataRevision !== versionAfter.dataRevision
      ) {
        throw new AgentError('MAINTENANCE_FENCE');
      }
      return { value, dataVersion: Object.freeze({ ...versionAfter }) };
    } catch (error) {
      throw applicationError(error);
    }
  }

  private assertQueryAdmission(): void {
    if (this.runtime.state === 'needs_recovery') throw new AgentError('RECOVERY_FENCE');
    if (this.runtime.state !== 'writable' && this.runtime.state !== 'read_only') {
      throw new AgentError('MAINTENANCE_FENCE');
    }
    if (this.runtime.pendingWrites !== 0) throw new AgentError('MAINTENANCE_FENCE');
  }
}

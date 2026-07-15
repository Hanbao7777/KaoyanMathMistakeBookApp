import crypto from 'node:crypto';
import { AgentError } from '../../shared/agent/errors';
import type {
  ConcurrencyPolicy,
  DataVersion,
  TrustedExecutionContext
} from '../../shared/agent/v1/contracts';
import { validateExecutionContext } from '../../shared/agent/v1/schemas';

export interface ExecutionContextFactoryDependencies {
  readonly randomUUID?: () => string;
  readonly now?: () => string;
}

export interface RendererExecutionContextOptions {
  readonly requestId?: string;
  readonly traceId?: string;
  readonly expectedVersion?: DataVersion;
}

export interface InternalExecutionContextOptions extends RendererExecutionContextOptions {
  readonly concurrency: ConcurrencyPolicy;
}

const rendererOptionKeys = new Set(['requestId', 'traceId', 'expectedVersion']);
const internalOptionKeys = new Set([...rendererOptionKeys, 'concurrency']);

function validationError(field: string): AgentError {
  return new AgentError('VALIDATION_ERROR', { field });
}

function assertExactOptions(value: unknown, allowedKeys: ReadonlySet<string>, path: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw validationError(path);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw validationError(`${path}.${key}`);
  }
}

function normalizedUuid(value: string | undefined, randomUUID: () => string): string {
  return (value ?? randomUUID()).toLowerCase();
}

function normalizedTimestamp(now: () => string): string {
  const value = now();
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw validationError('context.timestamp');
  return timestamp.toISOString();
}

function immutableVersion(version: DataVersion | undefined): DataVersion | undefined {
  return version
    ? Object.freeze({ dataEpoch: version.dataEpoch, dataRevision: version.dataRevision })
    : undefined;
}

function dependencies(overrides: ExecutionContextFactoryDependencies): Required<ExecutionContextFactoryDependencies> {
  return {
    randomUUID: overrides.randomUUID ?? crypto.randomUUID,
    now: overrides.now ?? (() => new Date().toISOString())
  };
}

function finalize(context: TrustedExecutionContext): TrustedExecutionContext {
  validateExecutionContext(context);
  Object.freeze(context.actor);
  Object.freeze(context.client);
  return Object.freeze(context);
}

export function createRendererExecutionContext(
  options: RendererExecutionContextOptions = {},
  overrides: ExecutionContextFactoryDependencies = {}
): TrustedExecutionContext {
  assertExactOptions(options, rendererOptionKeys, 'options');
  const resolved = dependencies(overrides);
  return finalize({
    trust: 'trusted',
    requestId: normalizedUuid(options.requestId, resolved.randomUUID),
    traceId: normalizedUuid(options.traceId, resolved.randomUUID),
    source: 'renderer',
    actor: { actorId: 'local-user', actorType: 'user' },
    client: { clientId: 'renderer', clientName: 'Kaoyan Renderer' },
    timestamp: normalizedTimestamp(resolved.now),
    concurrency: 'strict',
    expectedVersion: immutableVersion(options.expectedVersion)
  });
}

export function createInternalExecutionContext(
  options: InternalExecutionContextOptions,
  overrides: ExecutionContextFactoryDependencies = {}
): TrustedExecutionContext {
  assertExactOptions(options, internalOptionKeys, 'options');
  const resolved = dependencies(overrides);
  return finalize({
    trust: 'trusted',
    requestId: normalizedUuid(options.requestId, resolved.randomUUID),
    traceId: normalizedUuid(options.traceId, resolved.randomUUID),
    source: 'internal',
    actor: { actorId: 'application', actorType: 'system' },
    client: { clientId: 'internal', clientName: 'Kaoyan Application' },
    timestamp: normalizedTimestamp(resolved.now),
    concurrency: options.concurrency,
    expectedVersion: immutableVersion(options.expectedVersion)
  });
}

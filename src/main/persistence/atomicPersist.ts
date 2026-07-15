import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DataVersion } from '../../shared/agent';
import {
  databasePreviousPath,
  databaseTempPrefix,
  decideDatabaseCandidate,
  inspectDatabaseCandidates,
  inspectDatabaseFile,
  scanDatabaseCandidates,
  type CandidateDecision,
  type CandidateFileDependencies,
  type CandidateOpener,
  type DatabaseCandidate,
  type ValidDatabaseCandidate,
  type VersionedDatabaseCandidate
} from './databaseCandidate';
import {
  defaultDirectoryDurabilityDependencies,
  flushDirectory,
  flushFile,
  type DirectoryDurabilityDependencies,
  type DurabilityHandle,
  type DurabilityOutcome
} from './fileDurability';

export const atomicPersistStages = [
  'beforeExport',
  'afterExport',
  'afterTempOpen',
  'afterTempWrite',
  'afterTempFlush',
  'afterPreviousPublish',
  'afterLivePublish',
  'afterLiveReopen',
  'afterDirectoryFlush'
] as const;

export type AtomicPersistStage = (typeof atomicPersistStages)[number];

export type AtomicPersistFailureCode =
  | 'hook_failed'
  | 'invalid_options'
  | 'export_handoff_failed'
  | 'temp_open_failed'
  | 'temp_write_failed'
  | 'temp_flush_failed'
  | 'temp_close_failed'
  | 'directory_flush_failed'
  | 'temp_validation_failed'
  | 'candidate_set_unsafe'
  | 'live_candidate_unsafe'
  | 'previous_candidate_unsafe'
  | 'previous_cleanup_failed'
  | 'live_to_previous_failed'
  | 'temp_to_live_failed'
  | 'live_validation_failed'
  | 'rollback_failed';

export type AtomicPersistPhase =
  | 'options_validation'
  | 'export_handoff'
  | 'temp_open'
  | 'temp_write'
  | 'temp_flush'
  | 'temp_close'
  | 'temp_directory_flush'
  | 'temp_validation'
  | 'candidate_preflight'
  | 'previous_cleanup'
  | 'live_to_previous'
  | 'temp_to_live'
  | 'live_validation'
  | 'published_previous_cleanup'
  | 'publication_directory_flush'
  | 'rollback';

export interface AtomicPersistFailure {
  code: AtomicPersistFailureCode;
  phase: AtomicPersistPhase;
  cause: unknown;
}

export interface AtomicPersistHookContext {
  stage: AtomicPersistStage;
  livePath: string;
  previousPath: string;
  tempPath?: string;
  expectedVersion: DataVersion;
}

export type AtomicPersistHook = (context: AtomicPersistHookContext) => void | Promise<void>;

export interface AtomicFileHandle extends DurabilityHandle {
  writeFile(data: Uint8Array): Promise<void>;
}

export interface AtomicFileDependencies extends CandidateFileDependencies {
  openExclusive(filePath: string): Promise<AtomicFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
}

export interface AtomicPersistDependencies {
  files?: AtomicFileDependencies;
  directoryDurability?: DirectoryDurabilityDependencies;
  opener: CandidateOpener;
  platform?: NodeJS.Platform;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  randomId?: () => string;
  hook?: AtomicPersistHook;
}

export interface AtomicPersistOptions {
  livePath: string;
  requestId: string;
  bytes: Uint8Array;
  expectedVersion: DataVersion;
  dependencies: AtomicPersistDependencies;
  retry?: Partial<AtomicRetryPolicy>;
}

export interface AtomicRetryPolicy {
  initialDelayMs: number;
  maximumDelayMs: number;
  deadlineMs: number;
}

interface AtomicPersistBaseOutcome {
  previousPath: string;
  tempPath?: string;
  candidates: DatabaseCandidate[];
  recovery: CandidateDecision;
  directoryFlushes: DurabilityOutcome[];
}

export type AtomicPersistOutcome =
  | (AtomicPersistBaseOutcome & {
      status: 'success';
      live: VersionedDatabaseCandidate;
    })
  | (AtomicPersistBaseOutcome & {
      status: 'failed' | 'indeterminate';
      stage: AtomicPersistStage;
      failure: AtomicPersistFailure;
      /** Compatibility alias for callers that log the underlying error. */
      error: unknown;
    });

const defaultRetryPolicy: AtomicRetryPolicy = {
  initialDelayMs: 10,
  maximumDelayMs: 100,
  deadlineMs: 1_000
};

const retryableWindowsCodes = new Set(['EACCES', 'EBUSY', 'EPERM']);

class PersistFailure extends Error {
  readonly failure: AtomicPersistFailure;

  constructor(code: AtomicPersistFailureCode, phase: AtomicPersistPhase, cause: unknown) {
    super(code);
    this.name = 'PersistFailure';
    this.failure = { code, phase, cause };
  }
}

function asFailure(error: unknown, stage: AtomicPersistStage): AtomicPersistFailure {
  if (error instanceof PersistFailure) return error.failure;
  return { code: 'hook_failed', phase: phaseForStage(stage), cause: error };
}

function validateOptions(options: AtomicPersistOptions, retry: AtomicRetryPolicy): void {
  if (typeof options.livePath !== 'string' || !path.isAbsolute(options.livePath)) {
    throw new PersistFailure('invalid_options', 'options_validation', new Error('livePath must be absolute'));
  }
  try {
    safeRequestId(options.requestId);
    validateRetryPolicy(retry);
  } catch (error) {
    throw new PersistFailure('invalid_options', 'options_validation', error);
  }
  const version = options.expectedVersion;
  if (
    typeof version?.dataEpoch !== 'string' || version.dataEpoch.length === 0 || version.dataEpoch.length > 200 ||
    !Number.isSafeInteger(version.dataRevision) || version.dataRevision < 0
  ) throw new PersistFailure('invalid_options', 'options_validation', new Error('expectedVersion is invalid'));
}

function phaseForStage(stage: AtomicPersistStage): AtomicPersistPhase {
  switch (stage) {
    case 'beforeExport':
    case 'afterExport': return 'export_handoff';
    case 'afterTempOpen': return 'temp_open';
    case 'afterTempWrite': return 'temp_write';
    case 'afterTempFlush': return 'temp_flush';
    case 'afterPreviousPublish': return 'live_to_previous';
    case 'afterLivePublish': return 'temp_to_live';
    case 'afterLiveReopen': return 'live_validation';
    case 'afterDirectoryFlush': return 'publication_directory_flush';
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function safeRequestId(requestId: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(requestId)) throw new Error('requestId is not safe for a database temp name');
  return requestId;
}

function validateRetryPolicy(retry: AtomicRetryPolicy): void {
  for (const value of [retry.initialDelayMs, retry.maximumDelayMs, retry.deadlineMs]) {
    if (!Number.isFinite(value) || value < 0) throw new Error('Atomic retry values must be finite and non-negative');
  }
  if (retry.initialDelayMs === 0 || retry.maximumDelayMs === 0) {
    throw new Error('Atomic retry delays must be greater than zero');
  }
}

async function invokeHook(
  hook: AtomicPersistHook | undefined,
  context: Omit<AtomicPersistHookContext, 'stage'>,
  stage: AtomicPersistStage
): Promise<void> {
  await hook?.({ ...context, stage });
}

async function renameWithRetry(
  files: AtomicFileDependencies,
  from: string,
  to: string,
  retry: AtomicRetryPolicy,
  platform: NodeJS.Platform,
  now: () => number,
  sleep: (milliseconds: number) => Promise<void>
): Promise<void> {
  const startedAt = now();
  let remainingBudget = retry.deadlineMs;
  let delay = retry.initialDelayMs;
  while (true) {
    try {
      await files.rename(from, to);
      return;
    } catch (error) {
      if (platform !== 'win32' || !retryableWindowsCodes.has(errorCode(error) ?? '')) throw error;
      const elapsed = Math.max(0, now() - startedAt);
      const remaining = Math.min(remainingBudget, Math.max(0, retry.deadlineMs - elapsed));
      if (remaining <= 0) throw error;
      const wait = Math.min(delay, remaining);
      await sleep(wait);
      remainingBudget -= wait;
      delay = Math.min(delay * 2, retry.maximumDelayMs);
    }
  }
}

async function createUniqueTemp(
  livePath: string,
  requestId: string,
  files: AtomicFileDependencies,
  randomId: () => string
): Promise<{ path: string; handle: AtomicFileHandle }> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const nonce = randomId().replace(/[^A-Za-z0-9_-]/g, '');
    if (!nonce) continue;
    const tempPath = path.join(path.dirname(livePath), `${databaseTempPrefix(livePath)}${safeRequestId(requestId)}.${nonce}.tmp`);
    try {
      return { path: tempPath, handle: await files.openExclusive(tempPath) };
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
  }
  throw new Error('Unable to allocate a unique database temp file');
}

function isVersioned(candidate: ValidDatabaseCandidate): candidate is VersionedDatabaseCandidate {
  return candidate.metadata === 'present';
}

function canRemovePrevious(previous: ValidDatabaseCandidate, live: ValidDatabaseCandidate): boolean {
  if (!isVersioned(previous) || !isVersioned(live)) return false;
  return previous.version.dataEpoch === live.version.dataEpoch &&
    previous.version.dataRevision <= live.version.dataRevision;
}

async function flushRequiredDirectory(
  directoryPath: string,
  directoryDurability: DirectoryDurabilityDependencies,
  directoryFlushes: DurabilityOutcome[],
  phase: AtomicPersistPhase
): Promise<void> {
  const outcome = await flushDirectory(directoryPath, directoryDurability);
  directoryFlushes.push(outcome);
  if (outcome.status === 'failed') throw new PersistFailure('directory_flush_failed', phase, outcome.error);
}

async function inspectExisting(
  filePath: string,
  kind: 'live' | 'previous',
  opener: CandidateOpener,
  files: AtomicFileDependencies
): Promise<ValidDatabaseCandidate | null> {
  const candidate = await inspectDatabaseFile(filePath, kind, opener, undefined, files);
  if (candidate.status === 'valid') return candidate;
  if (candidate.reason === 'read_error' && isMissing(candidate.error)) return null;
  const code = kind === 'live' ? 'live_candidate_unsafe' : 'previous_candidate_unsafe';
  throw new PersistFailure(code, 'candidate_preflight', candidate);
}

async function inspectAll(
  livePath: string,
  opener: CandidateOpener,
  files: AtomicFileDependencies
): Promise<{ candidates: DatabaseCandidate[]; recovery: CandidateDecision }> {
  const recovery = await inspectDatabaseCandidates({ livePath, opener, files });
  return { candidates: recovery.candidates, recovery };
}

function hasAuthoritativeLive(decision: CandidateDecision): boolean {
  return (decision.status === 'selected' || decision.status === 'legacy_selected') && decision.candidate.kind === 'live';
}

export async function atomicPersist(options: AtomicPersistOptions): Promise<AtomicPersistOutcome> {
  const files = options.dependencies.files ?? defaultAtomicFileDependencies;
  const directoryDurability = options.dependencies.directoryDurability ?? defaultDirectoryDurabilityDependencies;
  const platform = options.dependencies.platform ?? process.platform;
  const now = options.dependencies.now ?? Date.now;
  const sleep = options.dependencies.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const randomId = options.dependencies.randomId ?? crypto.randomUUID;
  const retry = { ...defaultRetryPolicy, ...options.retry };
  const previousPath = databasePreviousPath(options.livePath);
  const directoryPath = path.dirname(options.livePath);
  const directoryFlushes: DurabilityOutcome[] = [];
  const hookContext = { livePath: options.livePath, previousPath, expectedVersion: options.expectedVersion };
  let stage: AtomicPersistStage = 'beforeExport';
  let tempPath: string | undefined;
  let tempHandle: AtomicFileHandle | undefined;
  let liveExisted = false;
  let liveMoveAttempted = false;
  let liveMoved = false;
  let livePublishAttempted = false;

  try {
    validateOptions(options, retry);
    await invokeHook(options.dependencies.hook, hookContext, stage);
    if (!(options.bytes instanceof Uint8Array) || options.bytes.byteLength === 0) {
      throw new PersistFailure('export_handoff_failed', 'export_handoff', new Error('Exported database bytes are empty'));
    }
    stage = 'afterExport';
    await invokeHook(options.dependencies.hook, hookContext, stage);

    try {
      const temp = await createUniqueTemp(options.livePath, options.requestId, files, randomId);
      tempPath = temp.path;
      tempHandle = temp.handle;
    } catch (error) {
      throw new PersistFailure('temp_open_failed', 'temp_open', error);
    }
    stage = 'afterTempOpen';
    await invokeHook(options.dependencies.hook, { ...hookContext, tempPath }, stage);

    try {
      await tempHandle.writeFile(options.bytes);
    } catch (error) {
      throw new PersistFailure('temp_write_failed', 'temp_write', error);
    }
    stage = 'afterTempWrite';
    await invokeHook(options.dependencies.hook, { ...hookContext, tempPath }, stage);

    const tempFlush = await flushFile(tempHandle);
    if (tempFlush.status !== 'flushed') {
      throw new PersistFailure(
        'temp_flush_failed',
        'temp_flush',
        tempFlush.status === 'failed' ? tempFlush.error : new Error('Temp file flush unsupported')
      );
    }
    stage = 'afterTempFlush';
    await invokeHook(options.dependencies.hook, { ...hookContext, tempPath }, stage);
    try {
      await tempHandle.close();
      tempHandle = undefined;
    } catch (error) {
      tempHandle = undefined;
      throw new PersistFailure('temp_close_failed', 'temp_close', error);
    }

    await flushRequiredDirectory(directoryPath, directoryDurability, directoryFlushes, 'temp_directory_flush');

    const tempCandidate = await inspectDatabaseFile(tempPath, 'temp', options.dependencies.opener, options.expectedVersion, files);
    if (tempCandidate.status !== 'valid' || tempCandidate.metadata !== 'present') {
      throw new PersistFailure('temp_validation_failed', 'temp_validation', tempCandidate);
    }

    const candidateScan = await scanDatabaseCandidates({ livePath: options.livePath, opener: options.dependencies.opener, files });
    if (candidateScan.status === 'scan_failed') {
      throw new PersistFailure('candidate_set_unsafe', 'candidate_preflight', candidateScan);
    }
    const existingCandidates = candidateScan.candidates.filter((candidate) => candidate.path !== tempPath);
    if (existingCandidates.some((candidate) => candidate.status === 'invalid')) {
      throw new PersistFailure('candidate_set_unsafe', 'candidate_preflight', existingCandidates);
    }
    const existingDecision = decideDatabaseCandidate(existingCandidates);
    if (
      existingDecision.status !== 'none' &&
      !((existingDecision.status === 'selected' || existingDecision.status === 'legacy_selected') &&
        existingDecision.candidate.kind === 'live')
    ) throw new PersistFailure('candidate_set_unsafe', 'candidate_preflight', existingDecision);

    const live = await inspectExisting(options.livePath, 'live', options.dependencies.opener, files);
    liveExisted = live !== null;
    const previous = await inspectExisting(previousPath, 'previous', options.dependencies.opener, files);
    if (previous) {
      if (!live || !canRemovePrevious(previous, live)) {
        throw new PersistFailure('previous_candidate_unsafe', 'candidate_preflight', previous);
      }
      try {
        await files.unlink(previousPath);
      } catch (error) {
        throw new PersistFailure('previous_cleanup_failed', 'previous_cleanup', error);
      }
    }

    if (live) {
      liveMoveAttempted = true;
      try {
        await renameWithRetry(files, options.livePath, previousPath, retry, platform, now, sleep);
        liveMoved = true;
      } catch (error) {
        throw new PersistFailure('live_to_previous_failed', 'live_to_previous', error);
      }
    }
    stage = 'afterPreviousPublish';
    await invokeHook(options.dependencies.hook, { ...hookContext, tempPath }, stage);

    livePublishAttempted = true;
    try {
      await renameWithRetry(files, tempPath, options.livePath, retry, platform, now, sleep);
    } catch (error) {
      throw new PersistFailure('temp_to_live_failed', 'temp_to_live', error);
    }
    stage = 'afterLivePublish';
    await invokeHook(options.dependencies.hook, { ...hookContext, tempPath }, stage);

    const reopened = await inspectDatabaseFile(options.livePath, 'live', options.dependencies.opener, options.expectedVersion, files);
    if (reopened.status !== 'valid' || reopened.metadata !== 'present') {
      throw new PersistFailure('live_validation_failed', 'live_validation', reopened);
    }
    stage = 'afterLiveReopen';
    await invokeHook(options.dependencies.hook, { ...hookContext, tempPath }, stage);

    if (liveMoved) {
      try {
        await files.unlink(previousPath);
      } catch (error) {
        throw new PersistFailure('previous_cleanup_failed', 'published_previous_cleanup', error);
      }
    }
    await flushRequiredDirectory(directoryPath, directoryDurability, directoryFlushes, 'publication_directory_flush');
    stage = 'afterDirectoryFlush';
    await invokeHook(options.dependencies.hook, { ...hookContext, tempPath }, stage);

    const inspected = await inspectAll(options.livePath, options.dependencies.opener, files);
    if (
      inspected.recovery.status !== 'selected' ||
      inspected.recovery.candidate.kind !== 'live' ||
      inspected.recovery.candidate.version.dataEpoch !== options.expectedVersion.dataEpoch ||
      inspected.recovery.candidate.version.dataRevision !== options.expectedVersion.dataRevision
    ) throw new PersistFailure('live_validation_failed', 'live_validation', inspected.recovery);
    return {
      status: 'success',
      live: reopened,
      previousPath,
      tempPath,
      ...inspected,
      directoryFlushes
    };
  } catch (error) {
    await tempHandle?.close().catch(() => undefined);
    let failure = asFailure(error, stage);
    let rollbackDurable = true;

    if (!livePublishAttempted) {
      // A failed rename may have completed despite reporting an error. Inspect the
      // paths and restore the verified previous generation when live disappeared.
      if (liveExisted && (liveMoved || liveMoveAttempted)) {
        const currentLive = await inspectDatabaseFile(options.livePath, 'live', options.dependencies.opener, undefined, files);
        if (currentLive.status === 'invalid' && currentLive.reason === 'read_error' && isMissing(currentLive.error)) {
          const previous = await inspectDatabaseFile(previousPath, 'previous', options.dependencies.opener, undefined, files);
          if (previous.status === 'valid') {
            try {
              await renameWithRetry(files, previousPath, options.livePath, retry, platform, now, sleep);
              liveMoved = false;
              await flushRequiredDirectory(directoryPath, directoryDurability, directoryFlushes, 'rollback');
            } catch (rollbackError) {
              rollbackDurable = false;
              failure = { code: 'rollback_failed', phase: 'rollback', cause: rollbackError };
            }
          } else {
            rollbackDurable = false;
            failure = { code: 'rollback_failed', phase: 'rollback', cause: previous };
          }
        }
      }
      if (rollbackDurable && tempPath) {
        try {
          await files.unlink(tempPath);
          await flushRequiredDirectory(directoryPath, directoryDurability, directoryFlushes, 'rollback');
        } catch (cleanupError) {
          if (!isMissing(cleanupError)) rollbackDurable = false;
        }
      }
    }

    const inspected = await inspectAll(options.livePath, options.dependencies.opener, files);
    const indeterminate = livePublishAttempted || !rollbackDurable ||
      inspected.recovery.status.startsWith('ambiguous') ||
      inspected.recovery.status === 'scan_failed' ||
      (liveExisted && !hasAuthoritativeLive(inspected.recovery));
    return {
      status: indeterminate ? 'indeterminate' : 'failed',
      stage,
      failure,
      error: failure.cause,
      previousPath,
      ...(tempPath ? { tempPath } : {}),
      ...inspected,
      directoryFlushes
    };
  }
}

export const defaultAtomicFileDependencies: AtomicFileDependencies = {
  async openExclusive(filePath) {
    return fs.promises.open(filePath, 'wx');
  },
  async readFile(filePath) {
    return fs.promises.readFile(filePath);
  },
  async readdir(directoryPath) {
    return fs.promises.readdir(directoryPath);
  },
  async rename(from, to) {
    await fs.promises.rename(from, to);
  },
  async unlink(filePath) {
    await fs.promises.unlink(filePath);
  }
};

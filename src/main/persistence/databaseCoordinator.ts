import { AsyncLocalStorage } from 'node:async_hooks';
import type { Database } from 'sql.js';
import { AgentError } from '../../shared/agent/errors';
import type { ConcurrencyPolicy, DataVersion, EntityRef } from '../../shared/agent/v1/contracts';
import {
  atomicPersist,
  type AtomicPersistDependencies,
  type AtomicPersistOptions,
  type AtomicPersistOutcome
} from './atomicPersist';
import {
  inspectDatabaseBytes,
  type CandidateFileDependencies,
  type CandidateOpener,
  type VersionedDatabaseCandidate
} from './databaseCandidate';
import {
  createRevisionMutationCapability,
  RevisionStore
} from './revisionStore';
import {
  DatabaseRuntimeStateController,
  type DatabaseRuntimeState,
  type MaintenanceLease
} from './recoveryState';

export interface DatabaseMutationScope {
  readonly kind: 'database-mutation-scope';
}

interface MutationScopeState {
  readonly coordinator: DatabaseCoordinator;
  readonly database: Database;
  active: boolean;
}

const mutationScopes = new WeakMap<object, MutationScopeState>();
const activeCoordinator = new AsyncLocalStorage<DatabaseCoordinator>();

export function assertDatabaseMutationScope(scope: DatabaseMutationScope, database: Database): void {
  const state = mutationScopes.get(scope as object);
  if (!state || !state.active || state.database !== database || activeCoordinator.getStore() !== state.coordinator) {
    throw new Error('An active database coordinator mutation scope is required');
  }
}

export interface DatabaseMutationResult<T> {
  readonly changed: boolean;
  readonly value: T;
}

export interface DatabaseWriteRequest<T> {
  readonly requestId: string;
  readonly concurrency: ConcurrencyPolicy;
  readonly expectedVersion?: DataVersion;
  readonly conflicts?: readonly EntityRef[];
  execute(database: Database, scope: DatabaseMutationScope): DatabaseMutationResult<T> | Promise<DatabaseMutationResult<T>>;
}

export interface DatabaseWriteResult<T> extends DatabaseMutationResult<T> {
  readonly versionBefore: DataVersion;
  readonly versionAfter: DataVersion;
}

export type AtomicPublisher = (options: AtomicPersistOptions) => Promise<AtomicPersistOutcome>;

export interface DatabaseCoordinatorOptions {
  database: Database;
  livePath: string;
  opener: CandidateOpener;
  openDatabase(bytes: Uint8Array): Database;
  persistDependencies: AtomicPersistDependencies;
  files?: CandidateFileDependencies;
  publisher?: AtomicPublisher;
  replaceDatabase?(next: Database, previous: Database): void | Promise<void>;
  now?: () => string;
  initialState?: DatabaseRuntimeState;
}

function isVersion(candidate: VersionedDatabaseCandidate, expected: DataVersion): boolean {
  return candidate.version.dataEpoch === expected.dataEpoch && candidate.version.dataRevision === expected.dataRevision;
}

function validationError(field: string): AgentError {
  return new AgentError('VALIDATION_ERROR', { field });
}

function totalChanges(database: Database): number {
  const result = database.exec('SELECT total_changes() AS total_changes');
  const value = result[0]?.values[0]?.[0];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Unable to read database mutation count');
  }
  return value;
}

export class DatabaseCoordinator {
  private database: Database;
  private readonly livePath: string;
  private readonly opener: CandidateOpener;
  private readonly openDatabase: (bytes: Uint8Array) => Database;
  private readonly persistDependencies: AtomicPersistDependencies;
  private readonly files: CandidateFileDependencies;
  private readonly publisher: AtomicPublisher;
  private readonly replaceDatabase?: DatabaseCoordinatorOptions['replaceDatabase'];
  private readonly now: () => string;
  private readonly runtimeState: DatabaseRuntimeStateController;
  private queueTail: Promise<void> = Promise.resolve();
  private admittedWrites = 0;

  constructor(options: DatabaseCoordinatorOptions) {
    this.database = options.database;
    this.livePath = options.livePath;
    this.opener = options.opener;
    this.openDatabase = options.openDatabase;
    this.persistDependencies = options.persistDependencies;
    this.files = options.files ?? options.persistDependencies.files ?? (() => {
      throw new Error('Candidate file dependencies are required');
    })();
    this.publisher = options.publisher ?? atomicPersist;
    this.replaceDatabase = options.replaceDatabase;
    this.now = options.now ?? (() => new Date().toISOString());
    this.runtimeState = new DatabaseRuntimeStateController(options.initialState);
    new RevisionStore(this.database).readCurrentVersion();
  }

  get state(): DatabaseRuntimeState {
    return this.runtimeState.state;
  }

  get pendingWrites(): number {
    return this.admittedWrites;
  }

  currentVersion(): DataVersion {
    return new RevisionStore(this.database).readCurrentVersion();
  }

  async executeWrite<T>(request: DatabaseWriteRequest<T>): Promise<DatabaseWriteResult<T>> {
    if (activeCoordinator.getStore() === this) {
      throw new Error('Nested or reentrant database coordinator writes are forbidden');
    }
    this.runtimeState.assertWriteAdmission();
    this.validateConcurrencyRequest(request);
    this.admittedWrites += 1;
    const run = this.queueTail.then(() => activeCoordinator.run(this, () => this.executeAdmittedWrite(request)));
    this.queueTail = run.then(
      () => { this.admittedWrites -= 1; },
      () => { this.admittedWrites -= 1; }
    ).then(() => undefined);
    return run;
  }

  async beginMaintenance(): Promise<MaintenanceLease> {
    const lease = this.runtimeState.beginMaintenance();
    await this.queueTail;
    return lease;
  }

  finishMaintenance(lease: MaintenanceLease, nextState: 'writable' | 'read_only' | 'needs_recovery' = 'writable'): void {
    this.runtimeState.finishMaintenance(lease, nextState);
  }

  async enterReadOnly(): Promise<void> {
    this.runtimeState.enterReadOnly();
    await this.queueTail;
  }

  resumeWrites(): void {
    this.runtimeState.resumeWrites();
  }

  async shutdown(): Promise<void> {
    this.runtimeState.beginShutdown();
    await this.queueTail;
    this.runtimeState.finishShutdown();
  }

  private validateConcurrencyRequest(request: DatabaseWriteRequest<unknown>): void {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(request.requestId)) throw validationError('requestId');
    if (request.concurrency === 'strict' || request.concurrency === 'epoch-only') {
      if (!request.expectedVersion) throw validationError('expectedVersion');
    } else if (request.concurrency === 'none') {
      if (request.expectedVersion) throw validationError('expectedVersion');
    } else {
      throw validationError('concurrency');
    }
  }

  private assertExpectedVersion(store: RevisionStore, request: DatabaseWriteRequest<unknown>): DataVersion {
    const current = store.readCurrentVersion();
    try {
      if (request.concurrency === 'strict') return store.assertCurrentVersion(request.expectedVersion!);
      if (request.concurrency === 'epoch-only') return store.assertCurrentEpoch(request.expectedVersion!);
      return current;
    } catch (error) {
      if (error instanceof AgentError && request.conflicts?.length) {
        throw new AgentError(error.code, {
          ...error.details,
          conflicts: [...request.conflicts]
        });
      }
      throw error;
    }
  }

  private async executeAdmittedWrite<T>(request: DatabaseWriteRequest<T>): Promise<DatabaseWriteResult<T>> {
    this.runtimeState.assertAdmittedWriteMayStart();
    const database = this.database;
    const store = new RevisionStore(database, this.now);
    const versionBefore = this.assertExpectedVersion(store, request);
    let transactionStarted = false;
    let versionAfter = versionBefore;
    let mutationResult: DatabaseMutationResult<T>;
    const scope = Object.freeze({ kind: 'database-mutation-scope' as const });
    const scopeState: MutationScopeState = { coordinator: this, database, active: true };
    mutationScopes.set(scope, scopeState);

    try {
      database.run('BEGIN');
      transactionStarted = true;
      const changesBefore = totalChanges(database);
      mutationResult = await request.execute(database, scope);
      if (!mutationResult || typeof mutationResult.changed !== 'boolean') throw new Error('Mutation returned an invalid result');
      if (!mutationResult.changed && totalChanges(database) !== changesBefore) {
        throw new Error('A database mutation cannot report changed: false');
      }
      if (mutationResult.changed) {
        versionAfter = store.increment(createRevisionMutationCapability(database), versionBefore);
      }
      database.run('COMMIT');
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        try {
          database.run('ROLLBACK');
        } catch (rollbackError) {
          await this.enterRecoveryAfterReloadFailure(rollbackError);
          throw new AgentError('RECOVERY_FENCE');
        }
      }
      try {
        await this.reloadVerifiedLive(versionBefore);
      } catch (reloadError) {
        await this.enterRecoveryAfterReloadFailure(reloadError);
        throw new AgentError('RECOVERY_FENCE');
      }
      throw error;
    } finally {
      scopeState.active = false;
    }

    if (!mutationResult.changed) {
      return { ...mutationResult, versionBefore, versionAfter };
    }

    let bytes: Uint8Array;
    try {
      bytes = database.export();
    } catch (error) {
      await this.restoreAfterDefiniteFailure(versionBefore, error);
      throw error;
    }

    let publication: AtomicPersistOutcome;
    try {
      publication = await this.publisher({
        livePath: this.livePath,
        requestId: request.requestId,
        bytes,
        expectedVersion: versionAfter,
        dependencies: this.persistDependencies
      });
    } catch (error) {
      await this.restoreAfterDefiniteFailure(versionBefore, error);
      throw error;
    }

    if (publication.status === 'success') {
      try {
        await this.reloadVerifiedLive(versionAfter);
      } catch (error) {
        this.runtimeState.enterRecovery(error);
        throw new AgentError('PERSISTENCE_INDETERMINATE');
      }
      return { ...mutationResult, versionBefore, versionAfter };
    }

    if (publication.status === 'failed') {
      await this.restoreAfterDefiniteFailure(versionBefore, publication.failure);
      throw publication.error;
    }

    try {
      if (publication.recovery.status === 'selected') {
        await this.reloadVerifiedCandidate(publication.recovery.candidate);
      }
    } catch {
      // The recovery fence below remains authoritative even when reload fails.
    }
    this.runtimeState.enterRecovery(publication.failure);
    throw new AgentError('PERSISTENCE_INDETERMINATE');
  }

  private async restoreAfterDefiniteFailure(expectedVersion: DataVersion, reason: unknown): Promise<void> {
    try {
      await this.reloadVerifiedLive(expectedVersion);
    } catch (error) {
      await this.enterRecoveryAfterReloadFailure({ reason, reloadError: error });
      throw new AgentError('RECOVERY_FENCE');
    }
  }

  private async enterRecoveryAfterReloadFailure(reason: unknown): Promise<void> {
    this.runtimeState.enterRecovery(reason);
  }

  private async reloadVerifiedLive(expectedVersion: DataVersion): Promise<void> {
    await this.reloadVerifiedCandidate({
      path: this.livePath,
      kind: 'live',
      status: 'valid',
      metadata: 'present',
      version: expectedVersion
    });
  }

  private async reloadVerifiedCandidate(candidate: VersionedDatabaseCandidate): Promise<void> {
    const expectedVersion = candidate.version;
    const bytes = await this.files.readFile(candidate.path);
    const inspected = inspectDatabaseBytes(
      bytes,
      { path: candidate.path, kind: candidate.kind },
      this.opener,
      expectedVersion
    );
    if (inspected.status !== 'valid' || inspected.metadata !== 'present' || !isVersion(inspected, expectedVersion)) {
      throw new Error('The selected database candidate does not match the required version');
    }
    const next = this.openDatabase(bytes);
    try {
      const actual = new RevisionStore(next).readCurrentVersion();
      if (actual.dataEpoch !== expectedVersion.dataEpoch || actual.dataRevision !== expectedVersion.dataRevision) {
        throw new Error('The reopened database version changed during reload');
      }
      await this.replaceDatabase?.(next, this.database);
    } catch (error) {
      next.close();
      throw error;
    }
    const previous = this.database;
    this.database = next;
    if (previous !== next) previous.close();
  }
}

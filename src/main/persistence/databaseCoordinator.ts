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
  RevisionStore,
  type DatabaseGeneration
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

interface CoordinatorCapabilityState {
  readonly coordinator: DatabaseCoordinator;
  readonly mode: 'business' | 'control';
}

interface MutationTrackerState {
  readonly tableNamesKey: string;
  readonly trackerSchemaKey: string;
  readonly tempSchemaVersion: number;
}

type WriteMode = 'legacy' | CoordinatorCapabilityState['mode'];

const mutationScopes = new WeakMap<object, MutationScopeState>();
const coordinatorCapabilities = new WeakMap<object, CoordinatorCapabilityState>();
const mutationTrackers = new WeakMap<Database, MutationTrackerState>();
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

export interface DatabaseCoordinatorCapability {
  readonly kind: 'database-coordinator-capability';
}

export interface DatabaseTerminalHookContext<T> {
  readonly value: T;
  readonly semanticChanged: boolean;
  readonly versionBefore: DataVersion;
  readonly versionAfter: DataVersion;
  readonly generationBefore: DatabaseGeneration;
  readonly generationAfterDataMutation: DatabaseGeneration;
}

export interface DatabaseTerminalHook<T = unknown> {
  execute(
    database: Database,
    scope: DatabaseMutationScope,
    context: DatabaseTerminalHookContext<T>
  ): DatabaseMutationResult<void> | Promise<DatabaseMutationResult<void>>;
}

export interface DatabaseWriteRequest<T> {
  readonly requestId: string;
  readonly concurrency: ConcurrencyPolicy;
  readonly expectedVersion?: DataVersion;
  readonly conflicts?: readonly EntityRef[];
  execute(database: Database, scope: DatabaseMutationScope): DatabaseMutationResult<T> | Promise<DatabaseMutationResult<T>>;
}

export interface DatabaseBusinessWriteRequest<T, FinalValue = T> extends DatabaseWriteRequest<T> {
  readonly finalizeValue?: (
    context: DatabaseTerminalHookContext<T>
  ) => FinalValue | Promise<FinalValue>;
  readonly terminalHook?: DatabaseTerminalHook<FinalValue>;
}

export interface DatabaseControlWriteRequest<T> {
  readonly requestId: string;
  execute(database: Database, scope: DatabaseMutationScope): DatabaseMutationResult<T> | Promise<DatabaseMutationResult<T>>;
}

export interface DatabaseWriteResult<T> extends DatabaseMutationResult<T> {
  readonly versionBefore: DataVersion;
  readonly versionAfter: DataVersion;
  readonly generationBefore: DatabaseGeneration;
  readonly generationAfter: DatabaseGeneration;
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

function isGeneration(candidate: VersionedDatabaseCandidate, expected: DatabaseGeneration): boolean {
  return candidate.generation.dataEpoch === expected.dataEpoch &&
    candidate.generation.dataRevision === expected.dataRevision &&
    candidate.generation.controlRevision === expected.controlRevision;
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

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function pragmaInteger(database: Database, pragma: string): number {
  const value = database.exec(`PRAGMA ${pragma}`)[0]?.values[0]?.[0];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Unable to read ${pragma}`);
  }
  return value;
}

function tableNames(database: Database): string[] {
  const result = database.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  return (result[0]?.values ?? []).map((row) => row[0]).filter((name): name is string => typeof name === 'string');
}

function mutationTrackerSchemaKey(database: Database): string {
  const table = database.exec('PRAGMA temp.table_info(coordinator_mutation_log)')[0]?.values ?? [];
  const ownedTriggerResult = database.exec(
    "SELECT name, tbl_name, sql FROM sqlite_temp_master WHERE type = 'trigger' AND name LIKE 'coordinator_track_%' ORDER BY name"
  );
  return JSON.stringify({ table, triggers: ownedTriggerResult[0]?.values ?? [] });
}

function rebuildMutationTracker(database: Database, trackedTables: readonly string[]): MutationTrackerState {
  const ownedTriggerResult = database.exec(
    "SELECT name FROM sqlite_temp_master WHERE type = 'trigger' AND name LIKE 'coordinator_track_%' ORDER BY name"
  );
  const ownedTriggers = (ownedTriggerResult[0]?.values ?? [])
    .map((row) => row[0])
    .filter((name): name is string => typeof name === 'string');
  for (const triggerName of ownedTriggers) database.exec(`DROP TRIGGER temp.${quoteIdentifier(triggerName)}`);

  const mutationLogTable = database.exec(
    "SELECT name FROM sqlite_temp_master WHERE type = 'table' AND name = 'coordinator_mutation_log'"
  )[0]?.values ?? [];
  if (mutationLogTable.length > 0) database.exec('DROP TABLE temp.coordinator_mutation_log');
  database.exec(`CREATE TEMP TABLE coordinator_mutation_log (
    table_name TEXT PRIMARY KEY
  )`);

  trackedTables.forEach((tableName, index) => {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      database.exec(`
        CREATE TEMP TRIGGER coordinator_track_${index}_${operation.toLowerCase()}
        AFTER ${operation} ON ${quoteIdentifier(tableName)}
        BEGIN
          INSERT OR IGNORE INTO coordinator_mutation_log (table_name) VALUES (${quoteLiteral(tableName)});
        END;
      `);
    }
  });

  const state = Object.freeze({
    tableNamesKey: JSON.stringify(trackedTables),
    trackerSchemaKey: mutationTrackerSchemaKey(database),
    tempSchemaVersion: pragmaInteger(database, 'temp.schema_version')
  });
  mutationTrackers.set(database, state);
  return state;
}

function prepareMutationTracker(database: Database): void {
  const trackedTables = tableNames(database);
  const tableNamesKey = JSON.stringify(trackedTables);
  let state = mutationTrackers.get(database);
  if (!state || state.tableNamesKey !== tableNamesKey) {
    state = rebuildMutationTracker(database, trackedTables);
  } else {
    const tempSchemaVersion = pragmaInteger(database, 'temp.schema_version');
    if (tempSchemaVersion !== state.tempSchemaVersion) {
      const trackerSchemaKey = mutationTrackerSchemaKey(database);
      state = trackerSchemaKey === state.trackerSchemaKey
        ? Object.freeze({ ...state, tempSchemaVersion })
        : rebuildMutationTracker(database, trackedTables);
      mutationTrackers.set(database, state);
    }
  }
  clearMutationTracker(database);
}

function readMutationTables(database: Database): string[] {
  const result = database.exec('SELECT table_name FROM coordinator_mutation_log ORDER BY table_name');
  return (result[0]?.values ?? []).map((row) => row[0]).filter((name): name is string => typeof name === 'string');
}

function clearMutationTracker(database: Database): void {
  database.run('DELETE FROM coordinator_mutation_log');
}

function isControlTable(tableName: string): boolean {
  return tableName.startsWith('agent_');
}

function assertStableSchema(database: Database, schemaVersion: number, tempSchemaVersion: number): void {
  if (
    pragmaInteger(database, 'schema_version') !== schemaVersion ||
    pragmaInteger(database, 'temp.schema_version') !== tempSchemaVersion
  ) throw new Error('Coordinator writes cannot change database schema');
}

function assertReportedMutation(
  database: Database,
  changed: boolean,
  changesBefore: number,
  tables: readonly string[],
  label: string
): void {
  if (!changed && tables.length > 0) throw new Error(`${label} cannot report changed: false`);
  if (changed && tables.length === 0) throw new Error(`${label} reported changed without mutating an allowed table`);
  if (totalChanges(database) !== changesBefore && tables.length === 0) {
    throw new Error(`${label} mutation tracking was bypassed`);
  }
}

function createCoordinatorCapability(
  coordinator: DatabaseCoordinator,
  mode: CoordinatorCapabilityState['mode']
): DatabaseCoordinatorCapability {
  const capability = Object.freeze({ kind: 'database-coordinator-capability' as const });
  coordinatorCapabilities.set(capability, { coordinator, mode });
  return capability;
}

export function createDatabaseCoordinatorBusinessCapability(
  coordinator: DatabaseCoordinator
): DatabaseCoordinatorCapability {
  return createCoordinatorCapability(coordinator, 'business');
}

export function createDatabaseCoordinatorControlCapability(
  coordinator: DatabaseCoordinator
): DatabaseCoordinatorCapability {
  return createCoordinatorCapability(coordinator, 'control');
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
  private nextAdmissionId = 0;
  private readonly pendingAdmissionIds = new Set<number>();
  private shutdownPendingAdmissionIds: Set<number> | null = null;
  private shutdownDrainFailureRecorded = false;
  private shutdownDrainFailure: unknown;

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

  get writeActivityVersion(): number {
    return this.nextAdmissionId;
  }

  whenWritesIdle(): Promise<void> {
    return this.queueTail;
  }

  currentVersion(): DataVersion {
    return new RevisionStore(this.database).readCurrentVersion();
  }

  currentGeneration(): DatabaseGeneration {
    return new RevisionStore(this.database).readCurrentGeneration();
  }

  async executeWrite<T>(request: DatabaseWriteRequest<T>): Promise<DatabaseWriteResult<T>> {
    return this.admitWrite('legacy', request);
  }

  async executeBusinessWrite<T, FinalValue = T>(
    capability: DatabaseCoordinatorCapability,
    request: DatabaseBusinessWriteRequest<T, FinalValue>
  ): Promise<DatabaseWriteResult<FinalValue>> {
    this.assertCapability(capability, 'business');
    return this.admitWrite<T, FinalValue>('business', request);
  }

  async executeControlWrite<T>(
    capability: DatabaseCoordinatorCapability,
    request: DatabaseControlWriteRequest<T>
  ): Promise<DatabaseWriteResult<T>> {
    this.assertCapability(capability, 'control');
    return this.admitWrite('control', request);
  }

  private assertCapability(capability: DatabaseCoordinatorCapability, mode: CoordinatorCapabilityState['mode']): void {
    const state = coordinatorCapabilities.get(capability as object);
    if (!state || state.coordinator !== this || state.mode !== mode) {
      throw new Error(`A valid ${mode} coordinator capability is required`);
    }
  }

  private async admitWrite<T, FinalValue = T>(
    mode: WriteMode,
    request: DatabaseBusinessWriteRequest<T, FinalValue> | DatabaseControlWriteRequest<T>
  ): Promise<DatabaseWriteResult<FinalValue>> {
    if (activeCoordinator.getStore() === this) {
      throw new Error('Nested or reentrant database coordinator writes are forbidden');
    }
    this.runtimeState.assertWriteAdmission();
    if (mode === 'business' || mode === 'legacy') this.validateConcurrencyRequest(request as DatabaseBusinessWriteRequest<T>);
    else if (!/^[A-Za-z0-9_-]{1,200}$/.test(request.requestId)) throw validationError('requestId');
    this.admittedWrites += 1;
    const admissionId = ++this.nextAdmissionId;
    this.pendingAdmissionIds.add(admissionId);
    const run = this.queueTail.then(() => activeCoordinator.run(
      this,
      () => this.executeAdmittedWrite<T, FinalValue>(mode, request)
    ));
    this.queueTail = run.then(
      () => { this.settleAdmission(admissionId, false); },
      (error) => { this.settleAdmission(admissionId, true, error); }
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
    if (!this.shutdownPendingAdmissionIds) {
      this.shutdownPendingAdmissionIds = new Set(this.pendingAdmissionIds);
    }
    await this.queueTail;
    this.runtimeState.finishShutdown();
    if (this.shutdownDrainFailureRecorded) throw this.shutdownDrainFailure;
  }

  private settleAdmission(admissionId: number, failed: boolean, error?: unknown): void {
    if (failed && !this.shutdownDrainFailureRecorded && this.shutdownPendingAdmissionIds?.has(admissionId)) {
      this.shutdownDrainFailureRecorded = true;
      this.shutdownDrainFailure = error;
    }
    this.pendingAdmissionIds.delete(admissionId);
    this.admittedWrites -= 1;
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

  private async executeAdmittedWrite<T, FinalValue = T>(
    mode: WriteMode,
    request: DatabaseBusinessWriteRequest<T, FinalValue> | DatabaseControlWriteRequest<T>
  ): Promise<DatabaseWriteResult<FinalValue>> {
    this.runtimeState.assertAdmittedWriteMayStart();
    const database = this.database;
    const store = new RevisionStore(database, this.now);
    const generationBefore = store.readCurrentGeneration();
    const versionBefore = mode === 'business' || mode === 'legacy'
      ? this.assertExpectedVersion(store, request as DatabaseBusinessWriteRequest<T>)
      : store.readCurrentVersion();
    let transactionStarted = false;
    let versionAfter = versionBefore;
    let generationAfter = generationBefore;
    let mutationResult: DatabaseMutationResult<T>;
    let finalValue: FinalValue;
    let controlChanged = false;
    const scope = Object.freeze({ kind: 'database-mutation-scope' as const });
    const scopeState: MutationScopeState = { coordinator: this, database, active: true };
    mutationScopes.set(scope, scopeState);

    try {
      if (mode !== 'legacy') prepareMutationTracker(database);
      database.run('BEGIN');
      transactionStarted = true;
      const schemaVersion = mode === 'legacy' ? undefined : pragmaInteger(database, 'schema_version');
      const tempSchemaVersion = mode === 'legacy' ? undefined : pragmaInteger(database, 'temp.schema_version');
      const changesBefore = totalChanges(database);
      mutationResult = await request.execute(database, scope);
      if (!mutationResult || typeof mutationResult.changed !== 'boolean') throw new Error('Mutation returned an invalid result');
      if (mode === 'legacy') {
        if (!mutationResult.changed && totalChanges(database) !== changesBefore) {
          throw new Error('A database mutation cannot report changed: false');
        }
      } else {
        assertStableSchema(database, schemaVersion!, tempSchemaVersion!);
        const mutationTables = readMutationTables(database);
        assertReportedMutation(database, mutationResult.changed, changesBefore, mutationTables, 'A database mutation');

        if (mode === 'control') {
          if (mutationTables.some((table) => !isControlTable(table))) {
            throw new Error('Control writes may mutate only control-plane tables');
          }
          if (mutationResult.changed) {
            clearMutationTracker(database);
            generationAfter = store.incrementControl(createRevisionMutationCapability(database), generationBefore);
            controlChanged = true;
          }
        } else if (mutationTables.some((table) => isControlTable(table) || table === 'control_metadata')) {
          throw new Error('Business handlers may mutate only domain tables');
        }
      }

      if (mode === 'business' || mode === 'legacy') {
        if (mutationResult.changed) {
          versionAfter = store.increment(createRevisionMutationCapability(database), versionBefore);
          generationAfter = store.readCurrentGeneration();
        }

        const businessRequest = mode === 'business'
          ? request as DatabaseBusinessWriteRequest<T, FinalValue>
          : undefined;
        finalValue = businessRequest?.finalizeValue
          ? await businessRequest.finalizeValue({
              value: mutationResult.value,
              semanticChanged: mutationResult.changed,
              versionBefore,
              versionAfter,
              generationBefore,
              generationAfterDataMutation: generationAfter
            })
          : mutationResult.value as unknown as FinalValue;
        const terminalHook = businessRequest?.terminalHook;
        if (terminalHook) {
          clearMutationTracker(database);
          const hookChangesBefore = totalChanges(database);
          const hookResult = await terminalHook.execute(database, scope, {
            value: finalValue,
            semanticChanged: mutationResult.changed,
            versionBefore,
            versionAfter,
            generationBefore,
            generationAfterDataMutation: generationAfter
          });
          if (!hookResult || typeof hookResult.changed !== 'boolean') {
            throw new Error('Terminal receipt hook returned an invalid result');
          }
          assertStableSchema(database, schemaVersion!, tempSchemaVersion!);
          const hookTables = readMutationTables(database);
          assertReportedMutation(database, hookResult.changed, hookChangesBefore, hookTables, 'Terminal receipt hook');
          if (hookTables.some((table) => !isControlTable(table))) {
            throw new Error('Terminal receipt hooks may mutate only control-plane tables');
          }
          if (hookResult.changed) {
            clearMutationTracker(database);
            generationAfter = store.incrementControl(createRevisionMutationCapability(database), generationAfter);
            controlChanged = true;
          }
        }
      }
      if (mode === 'control') finalValue = mutationResult.value as unknown as FinalValue;
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
        await this.reloadVerifiedLive(generationBefore);
      } catch (reloadError) {
        await this.enterRecoveryAfterReloadFailure(reloadError);
        throw new AgentError('RECOVERY_FENCE');
      }
      throw error;
    } finally {
      scopeState.active = false;
    }

    if (!mutationResult.changed && !controlChanged) {
      return { changed: mutationResult.changed, value: finalValue!, versionBefore, versionAfter, generationBefore, generationAfter };
    }

    let bytes: Uint8Array;
    try {
      bytes = database.export();
    } catch (error) {
      await this.restoreAfterDefiniteFailure(generationBefore, error);
      throw error;
    }

    let publication: AtomicPersistOutcome;
    try {
      publication = await this.publisher({
        livePath: this.livePath,
        requestId: request.requestId,
        bytes,
        expectedVersion: versionAfter,
        expectedGeneration: generationAfter,
        dependencies: this.persistDependencies
      });
    } catch (error) {
      await this.restoreAfterDefiniteFailure(generationBefore, error);
      throw error;
    }

    if (publication.status === 'success') {
      try {
        await this.reloadVerifiedLive(generationAfter);
      } catch (error) {
        this.runtimeState.enterRecovery(error);
        throw new AgentError('PERSISTENCE_INDETERMINATE');
      }
      return { changed: mutationResult.changed, value: finalValue!, versionBefore, versionAfter, generationBefore, generationAfter };
    }

    if (publication.status === 'failed') {
      await this.restoreAfterDefiniteFailure(generationBefore, publication.failure);
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

  private async restoreAfterDefiniteFailure(expectedGeneration: DatabaseGeneration, reason: unknown): Promise<void> {
    try {
      await this.reloadVerifiedLive(expectedGeneration);
    } catch (error) {
      await this.enterRecoveryAfterReloadFailure({ reason, reloadError: error });
      throw new AgentError('RECOVERY_FENCE');
    }
  }

  private async enterRecoveryAfterReloadFailure(reason: unknown): Promise<void> {
    this.runtimeState.enterRecovery(reason);
  }

  private async reloadVerifiedLive(expectedGeneration: DatabaseGeneration): Promise<void> {
    await this.reloadVerifiedCandidate({
      path: this.livePath,
      kind: 'live',
      status: 'valid',
      metadata: 'present',
      version: {
        dataEpoch: expectedGeneration.dataEpoch,
        dataRevision: expectedGeneration.dataRevision
      },
      generation: expectedGeneration
    });
  }

  private async reloadVerifiedCandidate(candidate: VersionedDatabaseCandidate): Promise<void> {
    const expectedGeneration = candidate.generation;
    const bytes = await this.files.readFile(candidate.path);
    const inspected = inspectDatabaseBytes(
      bytes,
      { path: candidate.path, kind: candidate.kind },
      this.opener,
      candidate.version,
      expectedGeneration
    );
    if (inspected.status !== 'valid' || inspected.metadata !== 'present' || !isGeneration(inspected, expectedGeneration)) {
      throw new Error('The selected database candidate does not match the required version');
    }
    const next = this.openDatabase(bytes);
    try {
      next.run('PRAGMA foreign_keys = ON;');
      const actual = new RevisionStore(next).readCurrentGeneration();
      if (
        actual.dataEpoch !== expectedGeneration.dataEpoch ||
        actual.dataRevision !== expectedGeneration.dataRevision ||
        actual.controlRevision !== expectedGeneration.controlRevision
      ) {
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

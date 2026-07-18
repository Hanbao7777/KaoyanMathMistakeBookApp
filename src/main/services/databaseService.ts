import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { app } from 'electron';
import initSqlJs, { type Database, type SqlJsStatic, type SqlValue } from 'sql.js';
import { schemaSql } from '../database/schema';
import { createReadOnlyDatabaseFacade, QueryBus, type ReadOnlyDatabaseFacade } from '../application/queryBus';
import { CommandBus, DomainEventBus } from '../application';
import { createInternalExecutionContext } from '../application/executionContext';
import { registerQuestions, type QuestionsApplication } from '../application/questions';
import { registerTickTick, type TickTickApplication } from '../application/ticktick';
import { registerKnowledge, type KnowledgeApplication } from '../application/knowledge';
import type { QuestionCommand } from '../../shared/agent/v1/contracts';
import { bootstrapAgentGateway, type AgentGatewayBootstrapOptions, type AgentGatewayComposition } from '../agent/bootstrap';
import {
  atomicPersist, bootstrapControlMetadata,
  createSqlJsCandidateOpener, DatabaseCoordinator,
  EpochTransitionStore, createEpochTransitionEvidence,
  defaultAtomicFileDependencies, createRevisionMutationCapability,
  inspectDatabaseBytes, scanDatabaseCandidates,
  recoverStartupDatabase, RevisionStore,
  type DatabaseWriteRequest, type DatabaseWriteResult,
  type StartupDatabaseRecoveryResult
} from '../persistence';
import {
  createOperationManifest,
  evidenceForBytes,
  OperationJournal,
  OperationManifestStore,
  recoverOperationStores,
  type OperationFile,
  type OperationJournalDependencies,
  type OperationManifest,
  type RecoveryScanOutcome
} from '../persistence/operationJournal';
import {
  getPaths,
  publishDataRootSwitch,
  restoreDataRootAuthority,
  stageDataRootSwitch,
  type RootSwitchDependencies
} from './pathService';
import type {
  AppPaths,
  ImageType,
  KnowledgePoint,
  MathSubject,
  MasteryLevel,
  Question,
  QuestionFilters,
  QuestionImage,
  QuestionInput,
  ReviewInput,
  ReviewLog,
  ReviewResult,
  ReviewResultV2,
  ReviewSubmitInput,
  ReviewSubmitResult,
  StatsData
} from '../../shared/types';

let db: Database | null = null;
let databaseCoordinator: DatabaseCoordinator | null = null;
let readOnlyDatabase: ReadOnlyDatabaseFacade | null = null;
let questionsApplication: QuestionsApplication | null = null;
let tickTickApplication: TickTickApplication | null = null;
let knowledgeApplication: KnowledgeApplication | null = null;
let agentControlPlane: AgentGatewayComposition | null = null;
const retiredCoordinatorHandles = new WeakSet<Database>();
let initializationPromise: Promise<DatabaseInitializationResult> | null = null;
let initializationResult: DatabaseInitializationResult | null = null;
let shutdownPromise: Promise<void> | null = null;
const defaultAgentInstanceId = `app-${randomUUID()}`;

export const databaseLifecycleStages = [
  'candidate_recovery_started',
  'candidate_recovery_completed',
  'metadata_bootstrap_published',
  'coordinator_created',
  'operation_journal_recovered',
  'audit_ledger_verified',
  'agent_receipts_reconciled',
  'agent_jobs_reconciled',
  'agent_gateway_ready',
  'ready',
  'needs_recovery'
] as const;

export type DatabaseLifecycleStage = (typeof databaseLifecycleStages)[number];

export interface DatabaseInitializationDependencies {
  createEpoch?: () => string;
  now?: () => string;
  randomId?: () => string;
  dataJournalRoot?: string;
  externalJournalRoot?: string;
  recoverOperations?: typeof recoverOperationStores;
  agent?: {
    readonly appInstanceId?: string;
    readonly credentialVerifier?: AgentGatewayBootstrapOptions['credentialVerifier'];
    readonly cursorSecret?: Uint8Array | string;
    readonly commandBus?: CommandBus;
    readonly queryBus?: QueryBus;
    readonly jobResultRoot?: string;
    readonly jobStoreHook?: AgentGatewayBootstrapOptions['jobStoreHook'];
    readonly jobExecutorOnError?: AgentGatewayBootstrapOptions['jobExecutorOnError'];
  };
  onStage?: (stage: DatabaseLifecycleStage) => void;
}

export interface DatabaseInitializationResult {
  readonly state: 'writable' | 'needs_recovery';
  readonly bootstrapChanged: boolean;
  readonly databaseRecovery: StartupDatabaseRecoveryResult | { readonly status: 'empty' };
  readonly journalRecovery: RecoveryScanOutcome;
}

export const maintenanceOperationStages = [
  'maintenance_entered',
  'recovery_package_staged',
  'candidate_validated',
  'database_published',
  'files_committed',
  'runtime_reopened'
] as const;

export type MaintenanceOperationStage = (typeof maintenanceOperationStages)[number];

export interface MaintenanceOperationDependencies {
  createEpoch?: () => string;
  randomId?: () => string;
  now?: () => string;
  atomicHook?: import('../persistence').AtomicPersistHook;
  journal?: OperationJournalDependencies;
  onStage?: (stage: MaintenanceOperationStage) => void | Promise<void>;
}

export class MaintenanceOperationError extends Error {
  readonly code: string;
  readonly phase: string;
  readonly recoverable: boolean;

  constructor(code: string, phase: string, message: string, recoverable = true, cause?: unknown) {
    super(`[${code}:${phase}] ${message}`, cause === undefined ? undefined : { cause });
    this.name = 'MaintenanceOperationError';
    this.code = code;
    this.phase = phase;
    this.recoverable = recoverable;
  }
}

export const legacyDatabaseCompatibilityInventory = Object.freeze({
  mutableHandle: Object.freeze([
    'databaseService.getDatabase/runSql',
    'registerIpc.ai:recordImport and ticktick:whiteNoise',
    'bridgeService',
    'deepseekService',
    'importBatchService',
    'knowledgeMapService',
    'questionBankService',
    'structuredImportService',
    'studySupervisorService',
    'ticktickAiService',
    'ticktickService'
  ]),
  rawPersistence: Object.freeze([
    'bridgeService sync writers',
    'importBatchService deletion writers',
    'knowledgeMapService import/bind/rematch writers',
    'questionBankService import/attempt/add/delete writers',
    'registerIpc.ticktick:whiteNoise:set',
    'structuredImportService.confirmStructuredImport',
    'studySupervisorService bootstrap and domain writers',
    'ticktickService list/task/tag/focus/bridge/settings/habit writers'
  ]),
  localTransactions: Object.freeze([
    'databaseService.migrateCategoryValues/createQuestion/submitReviewResult/importData',
    'knowledgeMapService.importKnowledgeMapZip/seedImportKnowledgeMap/rematchKnowledgePoints',
    'questionBankService.importQuestionBankZip/deleteExternalQuestionBatch',
    'ticktickService.deleteTickTickList/deleteTickTickTask'
  ]),
  startupCompatibility: Object.freeze([
    'main.seedImportKnowledgeMap -> A10f',
    'main.migrateCategoryValues -> A10f',
    'main.rematchKnowledgePoints -> A10f'
  ]),
  migrationTasks: Object.freeze(['A10', 'A12'])
});

const DEFAULT_SUBJECT: MathSubject = '高等数学';
const SUBJECT_VALUES = new Set<MathSubject>(['高等数学', '线性代数', '概率论', '其他']);

const MASTERY_ORDER: MasteryLevel[] = ['未掌握', '较弱', '一般', '较好', '已掌握'];
const OLD_MASTERY_MAP: Record<string, MasteryLevel> = {
  未掌握: '未掌握',
  有点懂: '较弱',
  基本掌握: '较好',
  已掌握: '已掌握',
  反复出错: '未掌握',
  较弱: '较弱',
  一般: '一般',
  较好: '较好'
};

function nowIso() {
  return new Date().toISOString();
}

function dateOnly(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function normalizeSubject(value: unknown, fallback: MathSubject = DEFAULT_SUBJECT): MathSubject {
  const text = value === null || value === undefined ? '' : String(value).trim();
  return SUBJECT_VALUES.has(text as MathSubject) ? (text as MathSubject) : fallback;
}

export function inferSubjectFromCategory(category: unknown): MathSubject {
  const text = category === null || category === undefined ? '' : String(category).trim();
  if (text === '线性代数' || text === '行列式与矩阵' || text === '线性方程组与向量' || text === '特征值与二次型') return '线性代数';
  if (text === '概率论') return '概率论';
  return DEFAULT_SUBJECT;
}

function addDays(dateText: string, days: number) {
  const date = new Date(`${dateText}T00:00:00`);
  date.setDate(date.getDate() + days);
  return dateOnly(date);
}

function addDaysIso(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next.toISOString();
}

export function persistDatabase() {
  if (!db) return;
  if (databaseCoordinator?.pendingWrites) {
    throw new Error('Legacy persistence cannot run while a coordinator write is active');
  }
  const bytes = db.export();
  fs.mkdirSync(path.dirname(getPaths().database), { recursive: true });
  fs.writeFileSync(getPaths().database, Buffer.from(bytes));
}

export async function getDatabase() {
  if (!db) await initializeDatabase();
  if (!db) throw new Error('Database initialization did not install an active handle');
  return db;
}

export async function getDatabaseCoordinator(): Promise<DatabaseCoordinator> {
  if (!databaseCoordinator) await initializeDatabase();
  if (!databaseCoordinator) throw new Error('Database coordinator is unavailable');
  return databaseCoordinator;
}

export async function getReadOnlyDatabase(): Promise<ReadOnlyDatabaseFacade> {
  if (!readOnlyDatabase) await initializeDatabase();
  if (!readOnlyDatabase) throw new Error('Read-only database access is unavailable');
  return readOnlyDatabase;
}

export async function getQuestionsApplication(): Promise<QuestionsApplication> {
  if (!questionsApplication) await initializeDatabase();
  if (!questionsApplication) throw new Error('Questions application is unavailable');
  return questionsApplication;
}

export async function getTickTickApplication(): Promise<TickTickApplication> {
  if (!tickTickApplication) await initializeDatabase();
  if (!tickTickApplication) throw new Error('TickTick application is unavailable');
  return tickTickApplication;
}

export async function getKnowledgeApplication(): Promise<KnowledgeApplication> {
  if (!knowledgeApplication) await initializeDatabase();
  if (!knowledgeApplication) throw new Error('Knowledge application is unavailable');
  return knowledgeApplication;
}

export async function getAgentControlPlane(): Promise<AgentGatewayComposition> {
  if (!agentControlPlane) throw new Error('Agent Gateway is unavailable pending database recovery');
  return agentControlPlane;
}

async function executeLegacyQuestionCommand<C extends QuestionCommand>(command: C) {
  const application = await getQuestionsApplication();
  return application.execute(command, createInternalExecutionContext({ concurrency: 'none' }));
}

function resolveSqlWasmPath() {
  const resolved = require.resolve('sql.js/dist/sql-wasm.wasm');
  if (fs.existsSync(resolved)) return resolved;

  const unpacked = resolved.replace('app.asar', 'app.asar.unpacked');
  if (fs.existsSync(unpacked)) return unpacked;

  const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  const resourcesCandidate = resourcesPath
    ? path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
    : '';
  if (resourcesCandidate && fs.existsSync(resourcesCandidate)) return resourcesCandidate;

  return unpacked;
}

function safeLifecycleId(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]/g, '');
  if (!safe) throw new Error('Database lifecycle identifier is empty');
  return safe;
}

function isSameOrDescendant(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveManagedImagePath(reference: string, phase: string, errorCode: string): string {
  const paths = getPaths();
  const resolved = path.normalize(path.isAbsolute(reference) ? reference : path.resolve(paths.root, reference));
  if (!isSameOrDescendant(resolved, paths.images) || !fs.existsSync(resolved)) {
    throw new MaintenanceOperationError(errorCode, phase, 'Referenced managed image file is unavailable');
  }
  const canonical = fs.realpathSync(resolved);
  if (!isSameOrDescendant(canonical, fs.realpathSync(paths.images))) {
    throw new MaintenanceOperationError(errorCode, phase, 'Referenced managed image file escapes the managed image root');
  }
  return resolved;
}

async function validateApplicableEpochTransitions(
  livePath: string,
  opener: import('../persistence').CandidateOpener,
  transitions: Awaited<ReturnType<EpochTransitionStore['transitionsFor']>>
): Promise<void> {
  const scan = await scanDatabaseCandidates({ livePath, opener });
  if (scan.status !== 'scanned') return;
  const candidates = scan.candidates.filter((candidate): candidate is import('../persistence').VersionedDatabaseCandidate =>
    candidate.status === 'valid' && candidate.metadata === 'present'
  );
  for (const transition of transitions) {
    const targetExists = candidates.some((candidate) => candidate.version.dataEpoch === transition.toVersion.dataEpoch);
    if (!targetExists) continue;
    const targetMatches = candidates.some((candidate) =>
      candidate.version.dataEpoch === transition.toVersion.dataEpoch &&
      candidate.version.dataRevision === transition.toVersion.dataRevision
    );
    const sourceCandidates = candidates.filter((candidate) => candidate.version.dataEpoch === transition.fromVersion.dataEpoch);
    const sourceMatches = sourceCandidates.some((candidate) =>
      candidate.version.dataEpoch === transition.fromVersion.dataEpoch &&
      candidate.version.dataRevision === transition.fromVersion.dataRevision
    );
    if (!targetMatches || (sourceCandidates.length > 0 && !sourceMatches)) {
      throw new Error(`Database transition evidence does not match on-disk candidates: ${transition.operationId}`);
    }
  }
}

function durableWriteNew(filePath: string, bytes: Uint8Array): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const handle = fs.openSync(filePath, 'wx');
  try {
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function fileEvidence(filePath: string) {
  return evidenceForBytes(fs.readFileSync(filePath));
}

function managedFileInventory(paths: AppPaths) {
  const roots = [paths.images, paths.textbooks, path.join(paths.root, 'question-bank-assets')];
  const result: Array<{ path: string; size: number; sha256: string }> = [];
  const visit = (directory: string) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new MaintenanceOperationError('UNSAFE_MANAGED_FILE', 'recovery_package', `Managed file is a symbolic link: ${target}`);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) result.push({ path: path.relative(paths.root, target), ...fileEvidence(target) });
    }
  };
  roots.forEach(visit);
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function journalError(error: unknown, phase: string) {
  return {
    code: error instanceof MaintenanceOperationError ? error.code : 'maintenance_operation_failed',
    phase,
    message: (error instanceof Error ? error.message : String(error)).slice(0, 1_000)
  };
}

interface ReplacementRequest<T> {
  commandType: string;
  inputIdentity: unknown;
  sourceBytes?: Uint8Array;
  mutate?: (candidate: Database) => T | Promise<T>;
  quarantinePaths?: string[] | ((candidate: Database) => string[]);
  dependencies?: MaintenanceOperationDependencies;
}

async function prepareReplacementManifest(
  request: ReplacementRequest<unknown>,
  operationId: string,
  versionBefore: import('../../shared/agent').DataVersion,
  versionAfter: import('../../shared/agent').DataVersion
): Promise<{ journal: OperationJournal; manifest: OperationManifest; recoveryDatabasePath: string; sourceInventoryPath: string }> {
  const paths = getPaths();
  const userRecoveryRoot = path.normalize(path.join(app.getPath('userData'), 'agent-recovery'));
  const manifestRoot = path.normalize(path.join(userRecoveryRoot, 'operation-journal'));
  const packageRoot = path.normalize(path.join(userRecoveryRoot, 'consistency-packages'));
  const sourceRoot = path.normalize(path.join(userRecoveryRoot, 'package-sources'));
  fs.mkdirSync(manifestRoot, { recursive: true });
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(path.join(paths.temp, 'a11-quarantine'), { recursive: true });

  const sourceInventoryPath = path.normalize(path.join(sourceRoot, `${operationId}.managed-files.json`));
  const inventoryBytes = Buffer.from(`${JSON.stringify({
    version: 1,
    root: paths.root,
    database: { path: path.relative(paths.root, paths.database), ...fileEvidence(paths.database) },
    managedFiles: managedFileInventory(paths)
  })}\n`, 'utf8');
  durableWriteNew(sourceInventoryPath, inventoryBytes);

  const recoveryDatabasePath = path.normalize(path.join(packageRoot, `${operationId}.before.db`));
  const recoveryInventoryPath = path.normalize(path.join(packageRoot, `${operationId}.managed-files.json`));
  const files: OperationFile[] = [
    {
      fileId: 'database-snapshot',
      kind: 'create',
      sourcePath: path.normalize(paths.database),
      targetPath: recoveryDatabasePath,
      stagingPath: path.normalize(path.join(packageRoot, `.${operationId}.before.db.staged`)),
      content: fileEvidence(paths.database),
      status: 'pending'
    },
    {
      fileId: 'managed-files-inventory',
      kind: 'create',
      sourcePath: sourceInventoryPath,
      targetPath: recoveryInventoryPath,
      stagingPath: path.normalize(path.join(packageRoot, `.${operationId}.managed-files.staged`)),
      content: evidenceForBytes(inventoryBytes),
      status: 'pending'
    }
  ];
  const quarantinePaths = typeof request.quarantinePaths === 'function'
    ? request.quarantinePaths(db!)
    : request.quarantinePaths ?? [];
  for (const [index, candidate] of quarantinePaths.entries()) {
    const targetPath = resolveManagedImagePath(candidate, 'recovery_package', 'UNSAFE_MANAGED_FILE');
    files.push({
      fileId: `managed-image-${index}`,
      kind: 'quarantine_delete',
      targetPath,
      quarantinePath: path.normalize(path.join(paths.temp, 'a11-quarantine', `${operationId}-${index}.quarantine`)),
      content: fileEvidence(targetPath),
      status: 'pending'
    });
  }
  const now = (request.dependencies?.now ?? (() => new Date().toISOString()))();
  const manifest = createOperationManifest({
    operationId,
    requestId: operationId,
    commandType: request.commandType,
    source: 'internal',
    clientId: 'maintenance-kernel',
    traceId: operationId,
    inputHash: createHash('sha256').update(JSON.stringify(request.inputIdentity)).digest('hex'),
    storage: 'external_recovery',
    versionBefore,
    versionAfter,
    affectedEntities: [{ entityType: 'database', entityId: paths.database }],
    roots: {
      manifestRoot,
      managedRoots: [path.normalize(paths.root), packageRoot],
      sourceRoots: [path.normalize(paths.root), sourceRoot]
    },
    files,
    createdAt: now
  });
  return {
    journal: new OperationJournal(new OperationManifestStore(manifestRoot), request.dependencies?.journal),
    manifest,
    recoveryDatabasePath,
    sourceInventoryPath
  };
}

async function replaceDatabaseIdentity<T>(request: ReplacementRequest<T>): Promise<{
  value: T;
  versionBefore: import('../../shared/agent').DataVersion;
  versionAfter: import('../../shared/agent').DataVersion;
  recoveryDatabasePath: string;
}> {
  const coordinator = await getDatabaseCoordinator();
  const lease = await coordinator.beginMaintenance();
  let versionBefore = coordinator.currentVersion();
  let candidate: Database | null = null;
  let staged: OperationManifest | null = null;
  let journal: OperationJournal | null = null;
  let databasePublished = false;
  try {
    await request.dependencies?.onStage?.('maintenance_entered');
    versionBefore = coordinator.currentVersion();
    const SQL = await initSqlJs({ locateFile: () => resolveSqlWasmPath() });
    const opener = createSqlJsCandidateOpener(SQL);
    candidate = new SQL.Database(request.sourceBytes ?? fs.readFileSync(getPaths().database));
    const operationId = safeLifecycleId((request.dependencies?.randomId ?? randomUUID)());
    candidate.run('PRAGMA foreign_keys = ON;');
    const sourceInspection = inspectDatabaseBytes(candidate.export(), { path: getPaths().database, kind: 'temp' }, opener);
    if (sourceInspection.status !== 'valid' || sourceInspection.metadata !== 'present') {
      throw new MaintenanceOperationError('DATABASE_CANDIDATE_INVALID', 'candidate_validation', 'Replacement database is corrupt or incompatible');
    }
    const value = request.mutate ? await request.mutate(candidate) : undefined as T;
    const epoch = (request.dependencies?.createEpoch ?? randomUUID)();
    const versionAfter = new RevisionStore(candidate, request.dependencies?.now).resetDatabaseIdentity(
      createRevisionMutationCapability(candidate),
      epoch
    );
    const bytes = candidate.export();
    const inspection = inspectDatabaseBytes(bytes, { path: getPaths().database, kind: 'temp' }, opener, versionAfter);
    if (inspection.status !== 'valid' || inspection.metadata !== 'present') {
      throw new MaintenanceOperationError('DATABASE_CANDIDATE_INVALID', 'candidate_validation', 'Replacement database failed integrity or version validation');
    }
    await request.dependencies?.onStage?.('candidate_validated');

    const prepared = await prepareReplacementManifest(request, operationId, versionBefore, versionAfter);
    journal = prepared.journal;
    staged = await journal.stage(await journal.prepare(prepared.manifest));
    await request.dependencies?.onStage?.('recovery_package_staged');
    const transitionStore = new EpochTransitionStore(path.normalize(path.join(app.getPath('userData'), 'agent-recovery', 'epoch-transitions')));
    await transitionStore.publish(createEpochTransitionEvidence({
      instanceId: safeLifecycleId((request.dependencies?.randomId ?? randomUUID)()),
      operationId,
      livePath: path.normalize(getPaths().database),
      fromVersion: versionBefore,
      toVersion: versionAfter,
      createdAt: (request.dependencies?.now ?? (() => new Date().toISOString()))()
    }));

    const publication = await atomicPersist({
      livePath: getPaths().database,
      requestId: operationId,
      bytes,
      expectedVersion: versionAfter,
      dependencies: {
        opener,
        files: defaultAtomicFileDependencies,
        randomId: request.dependencies?.randomId,
        hook: request.dependencies?.atomicHook
      }
    });
    if (publication.status === 'failed') {
      await journal.compensate(staged, journalError(publication.error, publication.failure.phase));
      coordinator.finishMaintenance(lease, 'writable');
      throw new MaintenanceOperationError('DATABASE_PUBLICATION_FAILED', publication.failure.phase, 'Database replacement was not published', true, publication.error);
    }
    if (publication.status === 'indeterminate') {
      await journal.needsRecovery(staged, journalError(publication.error, publication.failure.phase));
      coordinator.finishMaintenance(lease, 'needs_recovery');
      throw new MaintenanceOperationError('DATABASE_PUBLICATION_INDETERMINATE', publication.failure.phase, 'Database replacement requires recovery before writes can resume', false, publication.error);
    }
    databasePublished = true;
    await request.dependencies?.onStage?.('database_published');
    try {
      const completed = await journal.commitFiles(await journal.markDatabaseCommitted(staged));
      if (completed.state !== 'completed') throw new Error('Replacement journal did not complete');
    } catch (error) {
      resetDatabaseConnection();
      const recovered = await initializeDatabase();
      if (recovered.state !== 'writable') {
        throw new MaintenanceOperationError('RECOVERY_FENCE', 'journal_finalization', 'Published replacement could not be reconciled', false, error);
      }
    }
    await request.dependencies?.onStage?.('files_committed');

    resetDatabaseConnection();
    await initializeDatabase();
    await request.dependencies?.onStage?.('runtime_reopened');
    return { value, versionBefore, versionAfter, recoveryDatabasePath: prepared.recoveryDatabasePath };
  } catch (error) {
    if (databaseCoordinator === coordinator && coordinator.state === 'maintenance') {
      if (databasePublished) {
        resetDatabaseConnection();
        await initializeDatabase().catch(() => undefined);
      } else if (staged && journal) {
        await journal.compensate(staged, journalError(error, 'replacement')).catch(async (compensationError) => {
          await journal!.needsRecovery(staged!, journalError(compensationError, 'compensation')).catch(() => undefined);
          coordinator.finishMaintenance(lease, 'needs_recovery');
        });
      }
      if (coordinator.state === 'maintenance') coordinator.finishMaintenance(lease, 'writable');
    }
    throw error;
  } finally {
    candidate?.close();
  }
}

function hasCandidateRecoveryEvidence(livePath: string): boolean {
  const liveName = path.basename(livePath);
  return fs.readdirSync(path.dirname(livePath)).some((name) =>
    name.includes(liveName) && name.endsWith('.quarantine')
  );
}

async function publishInitializedDatabase(
  database: Database,
  livePath: string,
  SQL: SqlJsStatic,
  dependencies: DatabaseInitializationDependencies
): Promise<void> {
  const version = new RevisionStore(database).readCurrentVersion();
  const opener = createSqlJsCandidateOpener(SQL);
  const publication = await atomicPersist({
    livePath,
    requestId: 'startup-bootstrap',
    bytes: database.export(),
    expectedVersion: version,
    dependencies: {
      opener,
      files: defaultAtomicFileDependencies,
      randomId: () => safeLifecycleId((dependencies.randomId ?? randomUUID)())
    }
  });
  if (publication.status !== 'success') {
    throw new Error(`Database bootstrap publication failed: ${publication.failure.code}`);
  }
}

async function createAgentControlPlane(
  coordinator: DatabaseCoordinator,
  readDatabase: ReadOnlyDatabaseFacade,
  application: QuestionsApplication,
  tickTick: TickTickApplication,
  knowledge: KnowledgeApplication,
  operationJournalStores: readonly OperationManifestStore[],
  dependencies: DatabaseInitializationDependencies = {},
  onStage: (stage: DatabaseLifecycleStage) => void = () => undefined
): Promise<AgentGatewayComposition> {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const randomId = dependencies.randomId ?? randomUUID;
  const commandBus = dependencies.agent?.commandBus ?? application.gateway.commandBus;
  const queryBus = dependencies.agent?.queryBus ?? application.gateway.queryBus;
  const appInstanceId = dependencies.agent?.appInstanceId ?? defaultAgentInstanceId;
  const credentialVerifier = dependencies.agent?.credentialVerifier ?? Object.freeze({
    verify(): never {
      throw new Error('No external credential adapter is installed');
    }
  });
  const composition = await bootstrapAgentGateway({
    coordinator,
    commandBus,
    queryBus,
    selectedCandidateEvidence: true,
    appInstanceId,
    credentialVerifier,
    cursorSecret: dependencies.agent?.cursorSecret ?? createHash('sha256').update(appInstanceId).digest(),
    jobResultRoot: path.normalize(dependencies.agent?.jobResultRoot ?? path.join(getPaths().data, 'agent-jobs', 'results')),
    operationJournalStores,
    jobStoreHook: dependencies.agent?.jobStoreHook,
    jobExecutorOnError: dependencies.agent?.jobExecutorOnError,
    now,
    randomUUID: randomId,
    resolveState: (envelope, descriptor) => descriptor.domain === 'questions'
      ? application.gateway.resolveState(envelope, descriptor)
      : ['knowledge', 'textbooks', 'analytics'].includes(descriptor.domain)
        ? knowledge.resolveState(envelope, descriptor)
        : tickTick.resolveState(envelope, descriptor),
    executeBusinessCommand: (command, context, dispatch) => application.gateway.execute(command as QuestionCommand, context, dispatch),
    tickTickApplication: tickTick,
    knowledgeApplication: knowledge,
    onRecoveryStage(stage) {
      onStage(stage === 'audit_verified' ? 'audit_ledger_verified' : stage === 'receipts_reconciled' ? 'agent_receipts_reconciled' : 'agent_jobs_reconciled');
    }
  });
  onStage('agent_gateway_ready');
  return composition;
}

async function initializeDatabaseOnce(
  dependencies: DatabaseInitializationDependencies = {}
): Promise<DatabaseInitializationResult> {
  const onStage = dependencies.onStage ?? (() => undefined);
  const now = dependencies.now ?? (() => new Date().toISOString());
  const randomId = dependencies.randomId ?? randomUUID;
  const SQL = await initSqlJs({ locateFile: () => resolveSqlWasmPath() });
  const opener = createSqlJsCandidateOpener(SQL);
  const paths = getPaths();
  fs.mkdirSync(path.dirname(paths.database), { recursive: true });
  const transitionStore = new EpochTransitionStore(path.normalize(path.join(app.getPath('userData'), 'agent-recovery', 'epoch-transitions')));
  let transitions;
  try {
    transitions = await transitionStore.transitionsFor(paths.database);
    await validateApplicableEpochTransitions(paths.database, opener, transitions);
  } catch (error) {
    throw new Error(`Database transition recovery failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  onStage('candidate_recovery_started');
  const recovered = await recoverStartupDatabase({
    livePath: paths.database,
    opener,
    transitions,
    randomId: () => safeLifecycleId(randomId())
  });
  const noCandidates = recovered.status === 'needs_recovery' &&
    recovered.reason === 'no_valid_candidate' && recovered.decision.candidates.length === 0 &&
    !hasCandidateRecoveryEvidence(paths.database);
  if (recovered.status === 'needs_recovery' && !noCandidates) {
    onStage('needs_recovery');
    throw new Error(`Database candidate recovery failed: ${recovered.reason}`);
  }
  if (recovered.status === 'ready') {
    const selectedTransitions = transitions.filter((transition) =>
      transition.toVersion.dataEpoch === recovered.version.dataEpoch &&
      transition.toVersion.dataRevision === recovered.version.dataRevision
    );
    await Promise.all(selectedTransitions.map((transition) => transitionStore.consume(transition.operationId)));
  }
  onStage('candidate_recovery_completed');

  const workingDatabase = recovered.status === 'ready' || recovered.status === 'legacy_ready'
    ? new SQL.Database(recovered.bytes)
    : new SQL.Database();
  let bootstrapChanged = false;
  try {
    workingDatabase.run('PRAGMA foreign_keys = ON;');
    workingDatabase.exec(schemaSql);
    migrateDatabase(workingDatabase);
    const bootstrap = bootstrapControlMetadata(workingDatabase, {
      createEpoch: dependencies.createEpoch,
      now
    });
    bootstrapChanged = bootstrap.changed;
    await publishInitializedDatabase(workingDatabase, paths.database, SQL, dependencies);
  } finally {
    workingDatabase.close();
  }
  onStage('metadata_bootstrap_published');

  const activeDatabase = new SQL.Database(fs.readFileSync(paths.database));
  activeDatabase.run('PRAGMA foreign_keys = ON;');
  db = activeDatabase;
  const coordinator = new DatabaseCoordinator({
    database: activeDatabase,
    livePath: paths.database,
    opener,
    openDatabase: (bytes) => new SQL.Database(bytes),
    persistDependencies: {
      opener,
      files: defaultAtomicFileDependencies,
      randomId: () => safeLifecycleId(randomId())
    },
    replaceDatabase(next, previous) {
      if (db !== previous) throw new Error('Database service handle changed outside the coordinator');
      // A9/A10 still contain legacy flows that cache getDatabase() across an
      // awaited question command. Their exported SQL helpers must follow the
      // coordinator's replacement until those callers are migrated.
      retiredCoordinatorHandles.add(previous);
      db = next;
    },
    now
  });
  databaseCoordinator = coordinator;
  readOnlyDatabase = createReadOnlyDatabaseFacade(() => {
    if (!db) throw new Error('Database connection is closed');
    return db;
  });
  questionsApplication = registerQuestions({ coordinator, readOnlyDatabase });
  tickTickApplication = registerTickTick({ coordinator, readOnlyDatabase });
  knowledgeApplication = registerKnowledge({ coordinator, readOnlyDatabase });
  onStage('coordinator_created');

  const dataJournalRoot = path.normalize(dependencies.dataJournalRoot ?? path.join(paths.data, 'operation-journal'));
  const externalJournalRoot = path.normalize(
    dependencies.externalJournalRoot ?? path.join(app.getPath('userData'), 'agent-recovery', 'operation-journal')
  );
  const operationJournalStores = [new OperationManifestStore(dataJournalRoot), new OperationManifestStore(externalJournalRoot)] as const;
  const journalRecovery = await (dependencies.recoverOperations ?? recoverOperationStores)(
    operationJournalStores,
    () => coordinator.currentVersion()
  );
  onStage('operation_journal_recovered');

  if (journalRecovery.needsRecovery > 0) {
    const lease = await coordinator.beginMaintenance();
    coordinator.finishMaintenance(lease, 'needs_recovery');
    onStage('needs_recovery');
  } else {
    try {
      agentControlPlane = await createAgentControlPlane(coordinator, readOnlyDatabase, questionsApplication, tickTickApplication, knowledgeApplication, operationJournalStores, dependencies, onStage);
    } catch (error) {
      if (coordinator.state !== 'needs_recovery') {
        const gatewayFailureLease = await coordinator.beginMaintenance();
        coordinator.finishMaintenance(gatewayFailureLease, 'needs_recovery');
      }
      onStage('needs_recovery');
      throw error;
    }
    onStage('ready');
  }

  const result: DatabaseInitializationResult = Object.freeze({
    state: journalRecovery.needsRecovery > 0 ? 'needs_recovery' : 'writable',
    bootstrapChanged,
    databaseRecovery: noCandidates ? { status: 'empty' as const } : recovered,
    journalRecovery
  });
  initializationResult = result;
  return result;
}

function migrateDatabase(database: Database) {
  const scopeSql = String(all<{ sql: string }>(database, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_client_scopes'")[0]?.sql ?? '');
  if (scopeSql && !scopeSql.includes("'knowledge.read'")) {
    database.run('ALTER TABLE agent_client_scopes RENAME TO agent_client_scopes_legacy');
    database.run(`CREATE TABLE agent_client_scopes (
      client_id TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN (
        'system.read', 'control.manage', 'clients.read', 'clients.manage', 'sessions.read', 'sessions.manage',
        'r4.read', 'r4.manage', 'approvals.read', 'approvals.manage', 'changesets.read', 'changesets.manage',
        'policy.read', 'policy.manage', 'audit.read', 'audit.export', 'questions.read', 'questions.write',
        'questions.archive', 'reviews.read', 'reviews.submit', 'knowledge.read', 'knowledge.write', 'textbooks.read', 'analytics.read', 'operations.batch', 'tasks.read',
        'tasks.write', 'tasks.execute', 'jobs.read', 'jobs.execute', 'jobs.cancel', 'jobs.admin', 'focus.read', 'focus.control', 'files.images.read'
      )), catalog_version TEXT NOT NULL CHECK (length(trim(catalog_version)) > 0), created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
      PRIMARY KEY (client_id, scope), FOREIGN KEY (client_id) REFERENCES agent_clients(client_id) ON DELETE CASCADE
    )`);
    database.run('INSERT INTO agent_client_scopes (client_id, scope, catalog_version, created_at) SELECT client_id, scope, catalog_version, created_at FROM agent_client_scopes_legacy');
    database.run('DROP TABLE agent_client_scopes_legacy');
    database.run('CREATE INDEX IF NOT EXISTS idx_agent_client_scopes_scope ON agent_client_scopes(scope, client_id)');
  }
  const columns = all<{ name: string }>(database, 'PRAGMA table_info(questions)').map((column) => column.name);
  const addQuestionColumn = (name: string, sql: string) => {
    if (!columns.includes(name)) database.run(`ALTER TABLE questions ADD COLUMN ${name} ${sql}`);
  };
  if (!columns.includes('wrong_thinking')) {
    database.run("ALTER TABLE questions ADD COLUMN wrong_thinking TEXT DEFAULT ''");
    database.run("UPDATE questions SET wrong_thinking = COALESCE(wrong_solution, '') WHERE wrong_thinking = ''");
  }
  if (!columns.includes('answer')) {
    database.run("ALTER TABLE questions ADD COLUMN answer TEXT DEFAULT ''");
  }
  addQuestionColumn('correct_count', 'INTEGER NOT NULL DEFAULT 0');
  addQuestionColumn('wrong_count', 'INTEGER NOT NULL DEFAULT 0');
  addQuestionColumn('no_idea_count', 'INTEGER NOT NULL DEFAULT 0');
  addQuestionColumn('consecutive_correct', 'INTEGER NOT NULL DEFAULT 0');
  addQuestionColumn('last_reviewed_at', 'TEXT');
  addQuestionColumn('next_review_at', 'TEXT');
  addQuestionColumn('review_count', 'INTEGER NOT NULL DEFAULT 0');
  addQuestionColumn('subject', "TEXT DEFAULT '高等数学'");
  addQuestionColumn('import_batch_id', 'TEXT');
  database.run("UPDATE questions SET subject = '高等数学' WHERE subject IS NULL OR TRIM(subject) = ''");

  database.run(`
    UPDATE questions SET mastery_level = CASE mastery_level
      WHEN '有点懂' THEN '较弱'
      WHEN '基本掌握' THEN '较好'
      WHEN '反复出错' THEN '未掌握'
      WHEN '未掌握' THEN '未掌握'
      WHEN '较弱' THEN '较弱'
      WHEN '一般' THEN '一般'
      WHEN '较好' THEN '较好'
      WHEN '已掌握' THEN '已掌握'
      ELSE '一般'
    END
  `);

  const reviewColumns = all<{ name: string }>(database, 'PRAGMA table_info(review_logs)').map((column) => column.name);
  const addReviewColumn = (name: string, sql: string) => {
    if (!reviewColumns.includes(name)) database.run(`ALTER TABLE review_logs ADD COLUMN ${name} ${sql}`);
  };
  addReviewColumn('mastery_before', 'TEXT');
  addReviewColumn('mastery_after', 'TEXT');
  addReviewColumn('reviewed_at', 'TEXT');
  addReviewColumn('next_review_at', 'TEXT');
  addReviewColumn('review_date', 'TEXT');
  addReviewColumn('review_round', 'INTEGER');
  addReviewColumn('duration_minutes', 'INTEGER NOT NULL DEFAULT 0');
  addReviewColumn('created_at', 'TEXT');
  database.run("UPDATE review_logs SET reviewed_at = COALESCE(reviewed_at, review_date, created_at) WHERE reviewed_at IS NULL");
  database.run("UPDATE review_logs SET created_at = COALESCE(created_at, reviewed_at, review_date) WHERE created_at IS NULL");
  database.run("CREATE INDEX IF NOT EXISTS idx_review_logs_question ON review_logs(question_id)");
  database.run("CREATE INDEX IF NOT EXISTS idx_review_logs_reviewed_at ON review_logs(reviewed_at)");
  database.run("CREATE INDEX IF NOT EXISTS idx_questions_next_review_at ON questions(next_review_at)");
  database.run("CREATE INDEX IF NOT EXISTS idx_questions_mastery ON questions(mastery_level)");
  database.run("CREATE INDEX IF NOT EXISTS idx_questions_subject ON questions(subject)");

  const textbookColumns = all<{ name: string }>(database, 'PRAGMA table_info(textbooks)').map((column) => column.name);
  if (!textbookColumns.includes('subject')) {
    database.run("ALTER TABLE textbooks ADD COLUMN subject TEXT DEFAULT '高等数学'");
  }
  database.run("UPDATE textbooks SET subject = '高等数学' WHERE subject IS NULL OR TRIM(subject) = ''");
  database.run("CREATE INDEX IF NOT EXISTS idx_textbooks_subject ON textbooks(subject)");

  const knowledgeColumns = all<{ name: string }>(database, 'PRAGMA table_info(knowledge_points)').map((column) => column.name);
  if (!knowledgeColumns.includes('subject')) {
    database.run("ALTER TABLE knowledge_points ADD COLUMN subject TEXT DEFAULT '高等数学'");
  }
  if (!knowledgeColumns.includes('import_batch_id')) {
    database.run("ALTER TABLE knowledge_points ADD COLUMN import_batch_id TEXT");
  }
  if (!knowledgeColumns.includes('deleted_at')) {
    database.run("ALTER TABLE knowledge_points ADD COLUMN deleted_at TEXT");
  }
  database.run("UPDATE knowledge_points SET subject = '高等数学' WHERE subject IS NULL OR TRIM(subject) = ''");
  database.run("CREATE INDEX IF NOT EXISTS idx_knowledge_points_subject ON knowledge_points(subject)");

  const externalColumns = all<{ name: string }>(database, 'PRAGMA table_info(external_questions)').map((column) => column.name);
  if (externalColumns.length) {
    if (!externalColumns.includes('added_to_mistakes')) {
      database.run('ALTER TABLE external_questions ADD COLUMN added_to_mistakes INTEGER NOT NULL DEFAULT 0');
    }
    if (!externalColumns.includes('created_question_id')) {
      database.run('ALTER TABLE external_questions ADD COLUMN created_question_id INTEGER');
    }
    if (!externalColumns.includes('import_batch_id')) {
      database.run("ALTER TABLE external_questions ADD COLUMN import_batch_id TEXT DEFAULT ''");
    }
    if (!externalColumns.includes('asset_base_path')) {
      database.run("ALTER TABLE external_questions ADD COLUMN asset_base_path TEXT DEFAULT ''");
    }
    if (!externalColumns.includes('solution_pdf_path')) {
      database.run("ALTER TABLE external_questions ADD COLUMN solution_pdf_path TEXT DEFAULT ''");
    }
  }

  const imageTable = one<{ sql: string }>(
    database,
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'question_images'"
  );
  if (imageTable?.sql && !imageTable.sql.includes("'original'")) {
    database.run(`
      CREATE TABLE question_images_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question_id INTEGER NOT NULL,
        image_type TEXT NOT NULL CHECK (image_type IN ('original', 'question', 'solution')),
        file_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
      )
    `);
    database.run(`
      INSERT INTO question_images_new (id, question_id, image_type, file_path, created_at)
      SELECT id, question_id, image_type, file_path, created_at FROM question_images
    `);
    database.run('DROP TABLE question_images');
    database.run('ALTER TABLE question_images_new RENAME TO question_images');
  }
}

export function runSql(database: Database, sql: string, params: unknown[] = []) {
  const active = retiredCoordinatorHandles.has(database) && db ? db : database;
  const stmt = active.prepare(sql);
  try {
    stmt.bind(params as SqlValue[]);
    stmt.step();
  } finally {
    stmt.free();
  }
}

export function allSql<T>(database: Database, sql: string, params: unknown[] = []) {
  const active = retiredCoordinatorHandles.has(database) && db ? db : database;
  const stmt = active.prepare(sql);
  const rows: T[] = [];
  try {
    stmt.bind(params as SqlValue[]);
    while (stmt.step()) rows.push(stmt.getAsObject() as T);
  } finally {
    stmt.free();
  }
  return rows;
}

export function oneSql<T>(database: Database, sql: string, params: unknown[] = []) {
  return allSql<T>(database, sql, params)[0] ?? null;
}

export function lastInsertId(database: Database) {
  const row = oneSql<{ id: number }>(database, 'SELECT last_insert_rowid() AS id');
  return Number(row?.id);
}

const getDb = getDatabase;
const run = runSql;
const all = allSql;
const one = oneSql;

function hydrateQuestions(database: Database, rows: Array<Omit<Question, 'tags' | 'question_images' | 'solution_images'>>) {
  return rows.map((row) => hydrateQuestion(database, row));
}

function getQuestionKnowledgePoints(database: Database, questionId: number) {
  return all<KnowledgePoint>(
    database,
    `SELECT kp.* FROM knowledge_points kp
     INNER JOIN question_knowledge_points qkp ON qkp.knowledge_node_id = kp.node_id
     WHERE qkp.question_id = ?
     ORDER BY kp.level ASC, kp.sort_order ASC, kp.title ASC`,
    [questionId]
  );
}

function hydrateQuestion(database: Database, row: Omit<Question, 'tags' | 'question_images' | 'solution_images'>): Question {
  const images = all<QuestionImage>(database, 'SELECT * FROM question_images WHERE question_id = ? ORDER BY id ASC', [row.id]);
  const tags = all<{ name: string }>(
    database,
    `SELECT t.name FROM tags t
     INNER JOIN question_tags qt ON qt.tag_id = t.id
     WHERE qt.question_id = ?
     ORDER BY t.name ASC`,
    [row.id]
  ).map((tag) => tag.name);

  return {
    ...row,
    subject: normalizeSubject(row.subject),
    tags,
    question_images: images.filter((image) => image.image_type === 'original' || image.image_type === 'question'),
    solution_images: images.filter((image) => image.image_type === 'solution'),
    knowledge_points: getQuestionKnowledgePoints(database, row.id)
  };
}

function buildFilterSql(filters: QuestionFilters = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  const filterValue = (value?: string) => {
    const text = value?.trim() || '';
    return text && text !== '全部' ? text : '';
  };

  if (filters.search?.trim()) {
    where.push('(title LIKE ? OR content LIKE ? OR correct_solution LIKE ? OR answer LIKE ?)');
    params.push(`%${filters.search.trim()}%`, `%${filters.search.trim()}%`, `%${filters.search.trim()}%`, `%${filters.search.trim()}%`);
  }
  if (filterValue(filters.category)) {
    where.push('category = ?');
    params.push(filterValue(filters.category));
  }
  if (filterValue(filters.subject)) {
    where.push("COALESCE(NULLIF(subject, ''), '高等数学') = ?");
    params.push(normalizeSubject(filters.subject));
  }
  if (filterValue(filters.questionType)) {
    where.push('question_type = ?');
    params.push(filterValue(filters.questionType));
  }
  if (filterValue(filters.errorReason)) {
    where.push('error_reason = ?');
    params.push(filterValue(filters.errorReason));
  }
  if (filterValue(filters.masteryLevel)) {
    where.push('mastery_level = ?');
    params.push(filterValue(filters.masteryLevel));
  }
  if (filters.weakOnly) {
    where.push("(mastery_level IN ('\u672a\u638c\u63e1', '\u8f83\u5f31') OR COALESCE(wrong_count, 0) > COALESCE(correct_count, 0) OR COALESCE(no_idea_count, 0) > 0)");
  }
  if (filterValue(filters.difficulty)) {
    where.push('difficulty = ?');
    params.push(filterValue(filters.difficulty));
  }
  if (filterValue(filters.source)) {
    where.push('source = ?');
    params.push(filterValue(filters.source));
  }
  if (filters.tag?.trim()) {
    where.push(`id IN (
      SELECT qt.question_id FROM question_tags qt
      INNER JOIN tags t ON t.id = qt.tag_id
      WHERE t.name LIKE ?
    )`);
    params.push(`%${filters.tag.trim()}%`);
  }

  const sortBy = ['created_at', 'last_reviewed_at', 'review_count'].includes(filters.sortBy || '')
    ? filters.sortBy
    : 'created_at';
  const sortOrder = filters.sortOrder === 'asc' ? 'ASC' : 'DESC';
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  if (process.env.KAOYAN_DEBUG_FILTERS === '1') {
    console.debug('[QuestionFilters]', { filters, whereSql, params });
  }
  return { whereSql, params, orderSql: `ORDER BY ${sortBy} ${sortOrder}, id DESC` };
}

export async function initializeDatabase(dependencies: DatabaseInitializationDependencies = {}) {
  if (initializationResult) return initializationResult;
  if (!initializationPromise) initializationPromise = initializeDatabaseOnce(dependencies);
  try {
    return await initializationPromise;
  } catch (error) {
    initializationPromise = null;
    throw error;
  }
}

/**
 * Migrate old category values to match the new exam point summary structure.
 * Called once on startup after seed import, before knowledge point re-matching.
 */
export async function migrateCategoryValues(): Promise<{ migrated: number }> {
  let migrated = 0;
  while (true) {
    const result = await executeLegacyQuestionCommand({ type: 'questions.migrate_categories', payload: { limit: 500 } });
    migrated += result.value.migrated;
    if (result.value.migrated < 500) break;
  }
  return { migrated };
}

export async function createQuestion(input: QuestionInput) {
  return (await executeLegacyQuestionCommand({ type: 'questions.create', payload: { input } })).value;
}

export async function listQuestions(filters: QuestionFilters = {}) {
  const database = await getDb();
  const { whereSql, params, orderSql } = buildFilterSql(filters);
  const rows = all<Omit<Question, 'tags' | 'question_images' | 'solution_images'>>(
    database,
    `SELECT * FROM questions ${whereSql} ${orderSql}`,
    params
  );
  return hydrateQuestions(database, rows);
}

export async function getQuestion(id: number) {
  const database = await getDb();
  const row = one<Omit<Question, 'tags' | 'question_images' | 'solution_images'>>(database, 'SELECT * FROM questions WHERE id = ?', [id]);
  return row ? hydrateQuestion(database, row) : null;
}

export async function getQuestionsByIds(ids: number[]) {
  if (!ids.length) return [];
  const database = await getDb();
  const uniqueIds = Array.from(new Set(ids));
  const placeholders = uniqueIds.map(() => '?').join(', ');
  const rows = all<Omit<Question, 'tags' | 'question_images' | 'solution_images'>>(
    database,
    `SELECT * FROM questions WHERE id IN (${placeholders})`,
    uniqueIds
  );
  const order = new Map(uniqueIds.map((id, index) => [id, index]));
  return hydrateQuestions(database, rows).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

export async function updateQuestion(id: number, input: QuestionInput) {
  return (await executeLegacyQuestionCommand({ type: 'questions.update', payload: { questionId: id, input } })).value;
}

function splitKnowledgeTokens(values: string[]) {
  return values
    .flatMap((value) => value.split(/[;,，；]/))
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function linkQuestionKnowledgePoints(questionId: number, values: string[], matchType: 'gpt' | 'auto' | 'manual' = 'gpt') {
  const database = await getDb();
  const warnings: string[] = [];
  const tokens = Array.from(new Set(splitKnowledgeTokens(values)));
  for (const token of tokens) {
    const byNodeId = one<KnowledgePoint>(database, 'SELECT * FROM knowledge_points WHERE node_id = ?', [token]);
    const matches = byNodeId
      ? [byNodeId]
      : all<KnowledgePoint>(database, 'SELECT * FROM knowledge_points WHERE title = ? ORDER BY level ASC, sort_order ASC', [token]);
    if (!matches.length) warnings.push(`未匹配到知识点：${token}`);
    else if (!byNodeId && matches.length > 1) warnings.push(`知识点标题重复，已使用第一个匹配项：${token}`);
  }
  await executeLegacyQuestionCommand({
    type: 'questions.link_knowledge',
    payload: { questionId, knowledgeNodeIds: tokens, matchType }
  });
  return warnings;
}

export async function deleteQuestion(id: number, deleteImages: boolean) {
  return (await executeLegacyQuestionCommand({ type: 'questions.delete', payload: { questionId: id, deleteImages } })).value;
}

export async function removeImage(imageId: number, deleteFile: boolean) {
  return (await executeLegacyQuestionCommand({ type: 'questions.remove_image', payload: { imageId, deleteFile } })).value;
}

export async function listReviewLogs(questionId: number) {
  const database = await getDb();
  return all<ReviewLog>(
    database,
    'SELECT * FROM review_logs WHERE question_id = ? ORDER BY COALESCE(reviewed_at, review_date, created_at) DESC, id DESC',
    [questionId]
  );
}

function normalizeMastery(value: string | null | undefined): MasteryLevel {
  return OLD_MASTERY_MAP[value || ''] ?? '一般';
}

function toReviewResultV2(result: ReviewResult): ReviewResultV2 {
  if (result === '做对了') return 'correct';
  if (result === '做错了') return 'wrong';
  return 'no_idea';
}

export async function submitReviewResult(input: ReviewSubmitInput): Promise<ReviewSubmitResult> {
  return (await executeLegacyQuestionCommand({ type: 'questions.submit_review', payload: input })).value;
}

export async function addReviewLog(input: ReviewInput) {
  const result = await submitReviewResult({
    questionId: input.questionId,
    result: toReviewResultV2(input.result),
    note: input.note
  });
  return result.question;
}

export async function markMastery(id: number, mastery: MasteryLevel) {
  return (await executeLegacyQuestionCommand({ type: 'questions.mark_mastery', payload: { questionId: id, mastery } })).value;
}

export async function getDashboard() {
  const database = await getDb();
  const today = dateOnly();
  const weekStart = new Date();
  const day = weekStart.getDay() || 7;
  weekStart.setDate(weekStart.getDate() - day + 1);
  const weekStartText = dateOnly(weekStart);
  const dueSql = "((next_review_at IS NOT NULL AND next_review_at != '' AND substr(next_review_at, 1, 10) <= ?) OR ((next_review_at IS NULL OR next_review_at = '') AND COALESCE(review_count, 0) = 0))";
  const weakSql = "(mastery_level IN ('\u672a\u638c\u63e1', '\u8f83\u5f31') OR COALESCE(wrong_count, 0) > COALESCE(correct_count, 0) OR COALESCE(no_idea_count, 0) > 0)";
  const reviewDateSql = "substr(COALESCE(reviewed_at, review_date, created_at), 1, 10)";

  const total = one<{ count: number }>(database, 'SELECT COUNT(*) AS count FROM questions')?.count ?? 0;
  const due = one<{ count: number }>(database, `SELECT COUNT(*) AS count FROM questions WHERE ${dueSql}`, [today])?.count ?? 0;
  const unmastered = one<{ count: number }>(database, "SELECT COUNT(*) AS count FROM questions WHERE mastery_level = '\u672a\u638c\u63e1'")?.count ?? 0;
  const weakQuestions = one<{ count: number }>(database, `SELECT COUNT(*) AS count FROM questions WHERE ${weakSql}`)?.count ?? 0;
  const weeklyRows = all<{ result: string }>(database, `SELECT result FROM review_logs WHERE ${reviewDateSql} >= ?`, [weekStartText]);
  const reviewedThisWeek = weeklyRows.length;
  const correct = weeklyRows.filter((row) => row.result === 'correct').length;
  const wrong = weeklyRows.filter((row) => row.result === 'wrong').length;
  const noIdea = weeklyRows.filter((row) => row.result === 'no_idea').length;
  const correctRateThisWeek = reviewedThisWeek ? Math.round((correct / reviewedThisWeek) * 100) : null;
  const recent = hydrateQuestions(
    database,
    all<Omit<Question, 'tags' | 'question_images' | 'solution_images'>>(
      database,
      'SELECT * FROM questions ORDER BY created_at DESC LIMIT 5'
    )
  );
  const topCategories = all<{ name: string; count: number }>(
    database,
    'SELECT category AS name, COUNT(*) AS count FROM questions GROUP BY category ORDER BY count DESC LIMIT 3'
  );
  const subjectCounts = all<{ name: string; count: number }>(
    database,
    "SELECT COALESCE(NULLIF(subject, ''), '高等数学') AS name, COUNT(*) AS count FROM questions GROUP BY COALESCE(NULLIF(subject, ''), '高等数学') ORDER BY count DESC"
  );
  const topErrorReasons = all<{ name: string; count: number }>(
    database,
    "SELECT COALESCE(NULLIF(error_reason, ''), '\u5176\u4ed6') AS name, COUNT(*) AS count FROM questions GROUP BY COALESCE(NULLIF(error_reason, ''), '\u5176\u4ed6') ORDER BY count DESC LIMIT 5"
  );
  return {
    total,
    due,
    unmastered,
    weakQuestions,
    reviewedThisWeek,
    correctRateThisWeek,
    weeklyReviewSummary: { total: reviewedThisWeek, correct, wrong, noIdea, correctRate: correctRateThisWeek },
    topErrorReasons,
    recent,
    topCategories,
    subjectCounts
  };
}

export async function getReviewBuckets() {
  const database = await getDb();
  const today = dateOnly();
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 6);
  const weekStartText = dateOnly(weekStart);
  const due = hydrateQuestions(
    database,
    all<Omit<Question, 'tags' | 'question_images' | 'solution_images'>>(
      database,
      `SELECT * FROM questions
       WHERE mastery_level != '已掌握'
         AND ((next_review_at IS NOT NULL AND substr(next_review_at, 1, 10) <= ?)
           OR (next_review_at IS NULL AND COALESCE(review_count, 0) = 0))
       ORDER BY
         CASE mastery_level WHEN '未掌握' THEN 0 WHEN '较弱' THEN 1 WHEN '一般' THEN 2 WHEN '较好' THEN 3 ELSE 4 END ASC,
         COALESCE(wrong_count, 0) DESC,
         COALESCE(no_idea_count, 0) DESC,
         COALESCE(last_reviewed_at, created_at) ASC`,
      [today]
    )
  );
  const unmastered = hydrateQuestions(
    database,
    all<Omit<Question, 'tags' | 'question_images' | 'solution_images'>>(
      database,
      "SELECT * FROM questions WHERE mastery_level = '未掌握' ORDER BY COALESCE(no_idea_count, 0) DESC, COALESCE(wrong_count, 0) DESC, created_at DESC"
    )
  );
  const weak = hydrateQuestions(
    database,
    all<Omit<Question, 'tags' | 'question_images' | 'solution_images'>>(
      database,
      `SELECT * FROM questions
       WHERE mastery_level IN ('未掌握', '较弱') OR COALESCE(wrong_count, 0) >= 2 OR COALESCE(no_idea_count, 0) >= 1
       ORDER BY
         CASE mastery_level WHEN '未掌握' THEN 0 WHEN '较弱' THEN 1 ELSE 2 END ASC,
         COALESCE(no_idea_count, 0) DESC,
         COALESCE(wrong_count, 0) DESC,
         updated_at DESC`
    )
  );
  const repeatedWrong = hydrateQuestions(
    database,
    all<Omit<Question, 'tags' | 'question_images' | 'solution_images'>>(
      database,
      "SELECT * FROM questions WHERE COALESCE(wrong_count, 0) >= 2 OR COALESCE(no_idea_count, 0) >= 1 ORDER BY COALESCE(no_idea_count, 0) DESC, COALESCE(wrong_count, 0) DESC, updated_at DESC"
    )
  );
  const weekReviewedCount = one<{ count: number }>(
    database,
    "SELECT COUNT(*) AS count FROM review_logs WHERE substr(COALESCE(reviewed_at, review_date, created_at), 1, 10) >= ?",
    [weekStartText]
  )?.count ?? 0;

  return {
    due,
    unmastered,
    repeatedWrong,
    weak,
    weekReviewedCount,
    counts: {
      due: due.length,
      unmastered: unmastered.length,
      weak: weak.length,
      weekReviewed: weekReviewedCount
    }
  };
}

function countBy(database: Database, column: string) {
  return all<{ name: string; count: number }>(
    database,
    `SELECT ${column} AS name, COUNT(*) AS count FROM questions GROUP BY ${column} ORDER BY count DESC`
  );
}

function lastSevenDaysCounts(database: Database, table: 'questions' | 'review_logs', dateColumn: string) {
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (6 - index));
    return dateOnly(date);
  });
  const rows = all<{ date: string; count: number }>(
    database,
    `SELECT substr(${dateColumn}, 1, 10) AS date, COUNT(*) AS count
     FROM ${table}
     WHERE substr(${dateColumn}, 1, 10) >= ?
     GROUP BY substr(${dateColumn}, 1, 10)`,
    [days[0]]
  );
  return days.map((date) => ({ date, count: rows.find((row) => row.date === date)?.count ?? 0 }));
}

export async function getStats(): Promise<StatsData> {
  const database = await getDb();
  const total = one<{ count: number }>(database, 'SELECT COUNT(*) AS count FROM questions')?.count ?? 0;
  const mastered = one<{ count: number }>(database, "SELECT COUNT(*) AS count FROM questions WHERE mastery_level = '已掌握'")?.count ?? 0;
  const repeatedWrong = one<{ count: number }>(database, "SELECT COUNT(*) AS count FROM questions WHERE COALESCE(wrong_count, 0) >= 2 OR COALESCE(no_idea_count, 0) >= 1")?.count ?? 0;
  const unmastered = one<{ count: number }>(
    database,
    "SELECT COUNT(*) AS count FROM questions WHERE mastery_level IN ('未掌握', '较弱')"
  )?.count ?? 0;
  const byCategory = countBy(database, 'category');
  const byType = countBy(database, 'question_type');
  const byReason = countBy(database, 'error_reason');

  return {
    total,
    mastered,
    unmastered,
    repeatedWrong,
    byCategory,
    byType,
    byReason,
    recentNew: lastSevenDaysCounts(database, 'questions', 'created_at'),
    recentReviews: lastSevenDaysCounts(database, 'review_logs', 'reviewed_at'),
    weakestCategories: byCategory.slice(0, 3),
    topReasons: byReason.slice(0, 3)
  };
}

export async function exportData() {
  const database = await getDb();
  const payload = {
    version: 1,
    exportedAt: nowIso(),
    questions: all(database, 'SELECT * FROM questions'),
    question_images: all(database, 'SELECT * FROM question_images'),
    review_logs: all(database, 'SELECT * FROM review_logs'),
    tags: all(database, 'SELECT * FROM tags'),
    question_tags: all(database, 'SELECT * FROM question_tags'),
    textbooks: all(database, 'SELECT * FROM textbooks'),
    knowledge_points: all(database, 'SELECT * FROM knowledge_points'),
    question_knowledge_points: all(database, 'SELECT * FROM question_knowledge_points'),
    external_questions: all(database, 'SELECT * FROM external_questions'),
    external_question_attempts: all(database, 'SELECT * FROM external_question_attempts'),
    import_batches: all(database, 'SELECT * FROM import_batches'),
    import_batch_items: all(database, 'SELECT * FROM import_batch_items'),
    import_assets: all(database, 'SELECT * FROM import_assets'),
    study_settings: all(database, 'SELECT * FROM study_settings'),
    study_subjects: all(database, 'SELECT * FROM study_subjects'),
    study_materials: all(database, 'SELECT * FROM study_materials'),
    study_tasks: all(database, 'SELECT * FROM study_tasks'),
    study_sessions: all(database, 'SELECT * FROM study_sessions'),
    daily_reviews: all(database, 'SELECT * FROM daily_reviews')
  };
  const fileName = `kaoyan-math-mistakes-${dateOnly()}-${Date.now()}.json`;
  const target = path.join(getPaths().exports, fileName);
  fs.writeFileSync(target, JSON.stringify(payload, null, 2), 'utf8');
  return target;
}

function assertImportPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object') throw new Error('JSON 格式不正确');
  const data = payload as Record<string, unknown>;
  for (const key of ['questions', 'question_images', 'review_logs', 'tags', 'question_tags']) {
    if (!Array.isArray(data[key])) throw new Error(`JSON 缺少 ${key} 数组`);
  }
}

export async function importData(filePath: string) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const payload = JSON.parse(raw) as Record<string, Array<Record<string, unknown>>>;
  assertImportPayload(payload);
  const replacement = await replaceDatabaseIdentity({
    commandType: 'database.import_json',
    inputIdentity: { filePath: path.resolve(filePath), sha256: createHash('sha256').update(raw).digest('hex') },
    async mutate(database) {
      for (const image of payload.question_images) {
        if (typeof image.file_path !== 'string' || image.file_path.trim().length === 0) {
          throw new MaintenanceOperationError('IMPORT_MANAGED_FILE_INVALID', 'import_validation', 'Imported image path is missing or invalid');
        }
        resolveManagedImagePath(image.file_path, 'import_validation', 'IMPORT_MANAGED_FILE_MISSING');
      }
      database.run('BEGIN TRANSACTION');
      try {
    for (const table of ['daily_reviews', 'study_sessions', 'study_tasks', 'study_materials', 'study_subjects', 'study_settings', 'import_assets', 'import_batch_items', 'import_batches', 'external_question_attempts', 'external_questions', 'question_knowledge_points', 'knowledge_points', 'textbooks', 'question_tags', 'tags', 'review_logs', 'question_images', 'questions']) {
      database.run(`DELETE FROM ${table}`);
    }

    for (const q of payload.questions) {
      run(
        database,
        `INSERT INTO questions (
          id, title, content, wrong_thinking, wrong_solution, correct_solution, answer, subject, category, question_type,
          error_reason, source, difficulty, mastery_level, note, review_count,
          correct_count, wrong_count, no_idea_count, consecutive_correct,
          last_reviewed_at, next_review_at, import_batch_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          q.id,
          q.title,
          q.content,
          q.wrong_thinking ?? q.wrong_solution ?? '',
          q.wrong_solution,
          q.correct_solution,
          q.answer ?? '',
          normalizeSubject(q.subject, inferSubjectFromCategory(q.category)),
          q.category,
          q.question_type,
          q.error_reason,
          q.source,
          q.difficulty,
          normalizeMastery(String(q.mastery_level || '一般')),
          q.note,
          q.review_count ?? 0,
          q.correct_count ?? 0,
          q.wrong_count ?? 0,
          q.no_idea_count ?? 0,
          q.consecutive_correct ?? 0,
          q.last_reviewed_at,
          q.next_review_at,
          q.import_batch_id ?? null,
          q.created_at,
          q.updated_at
        ]
      );
    }

    for (const image of payload.question_images) {
      run(database, 'INSERT INTO question_images (id, question_id, image_type, file_path, created_at) VALUES (?, ?, ?, ?, ?)', [
        image.id,
        image.question_id,
        image.image_type,
        image.file_path,
        image.created_at
      ]);
    }

    for (const log of payload.review_logs) {
      run(
        database,
        `INSERT INTO review_logs (
          id, question_id, result, mastery_before, mastery_after, reviewed_at, next_review_at,
          note, review_date, review_round, duration_minutes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          log.id,
          log.question_id,
          log.result,
          log.mastery_before ?? null,
          log.mastery_after ?? null,
          log.reviewed_at ?? log.review_date ?? log.created_at,
          log.next_review_at ?? null,
          log.note ?? '',
          log.review_date ?? (typeof log.reviewed_at === 'string' ? String(log.reviewed_at).slice(0, 10) : null),
          log.review_round ?? null,
          log.duration_minutes ?? 0,
          log.created_at ?? log.reviewed_at ?? log.review_date
        ]
      );
    }

    for (const tag of payload.tags) {
      run(database, 'INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)', [tag.id, tag.name, tag.created_at]);
    }

    for (const qt of payload.question_tags) {
      run(database, 'INSERT INTO question_tags (question_id, tag_id) VALUES (?, ?)', [qt.question_id, qt.tag_id]);
    }

    for (const textbook of payload.textbooks || []) {
      run(database, 'INSERT INTO textbooks (id, title, subject, edition, file_name, file_path, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        textbook.id,
        textbook.title,
        normalizeSubject(textbook.subject),
        textbook.edition ?? '',
        textbook.file_name ?? '',
        textbook.file_path ?? '',
        textbook.note ?? '',
        textbook.created_at,
        textbook.updated_at
      ]);
    }

    for (const point of payload.knowledge_points || []) {
      run(
        database,
        `INSERT INTO knowledge_points (
          id, textbook_id, node_id, parent_node_id, title, subject, category, level, sort_order,
          book_page, pdf_page, summary, core_formulas, common_question_types,
          common_error_reasons, tags, import_batch_id, deleted_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          point.id,
          point.textbook_id,
          point.node_id,
          point.parent_node_id,
          point.title,
          normalizeSubject(point.subject, inferSubjectFromCategory(point.category)),
          point.category ?? '',
          point.level ?? 1,
          point.sort_order ?? 0,
          point.book_page,
          point.pdf_page,
          point.summary ?? '',
          point.core_formulas ?? '[]',
          point.common_question_types ?? '[]',
          point.common_error_reasons ?? '[]',
          point.tags ?? '[]',
          point.import_batch_id ?? null,
          point.deleted_at ?? null,
          point.created_at,
          point.updated_at
        ]
      );
    }

    for (const link of payload.question_knowledge_points || []) {
      run(database, 'INSERT OR IGNORE INTO question_knowledge_points (id, question_id, knowledge_node_id, match_type, created_at) VALUES (?, ?, ?, ?, ?)', [
        link.id,
        link.question_id,
        link.knowledge_node_id,
        link.match_type ?? 'gpt',
        link.created_at
      ]);
    }

    for (const external of payload.external_questions || []) {
      run(
        database,
        `INSERT INTO external_questions (
          id, title, content, options, answer, solution, subject, category, question_format, question_type,
          difficulty, knowledge_points, source, year, exam_type, question_number, section, tags,
          raw_file_path, paper_pdf_path, solution_pdf_path, import_batch_id, asset_base_path,
          added_to_mistakes, created_question_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          external.id,
          external.title,
          external.content,
          external.options ?? '',
          external.answer ?? '',
          external.solution ?? '',
          normalizeSubject(external.subject, inferSubjectFromCategory(external.category)),
          external.category ?? '其他',
          external.question_format ?? '解答题',
          external.question_type ?? '其他',
          external.difficulty ?? '中等',
          external.knowledge_points ?? '',
          external.source ?? '',
          external.year ?? null,
          external.exam_type ?? '',
          external.question_number ?? null,
          external.section ?? '',
          external.tags ?? '',
          external.raw_file_path ?? '',
          external.paper_pdf_path ?? '',
          external.solution_pdf_path ?? '',
          external.import_batch_id ?? '',
          external.asset_base_path ?? '',
          external.added_to_mistakes ?? 0,
          external.created_question_id ?? null,
          external.created_at,
          external.updated_at
        ]
      );
    }

    for (const attempt of payload.external_question_attempts || []) {
      run(
        database,
        `INSERT INTO external_question_attempts (
          id, external_question_id, result, attempted_at, note, added_to_mistakes, created_question_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          attempt.id,
          attempt.external_question_id,
          attempt.result,
          attempt.attempted_at,
          attempt.note ?? '',
          attempt.added_to_mistakes ?? 0,
          attempt.created_question_id ?? null
        ]
      );
    }

    for (const batch of payload.import_batches || []) {
      run(
        database,
        `INSERT INTO import_batches (
          id, type, name, source_file_name, source, imported_at, item_count, asset_count, status, metadata_json, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          batch.id,
          batch.type ?? 'unknown',
          batch.name ?? '',
          batch.source_file_name ?? '',
          batch.source ?? '',
          batch.imported_at,
          batch.item_count ?? 0,
          batch.asset_count ?? 0,
          batch.status ?? 'active',
          batch.metadata_json ?? '',
          batch.deleted_at ?? null
        ]
      );
    }

    for (const item of payload.import_batch_items || []) {
      run(
        database,
        'INSERT INTO import_batch_items (id, batch_id, target_table, target_id, action, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [item.id, item.batch_id, item.target_table, item.target_id, item.action ?? 'created', item.created_at]
      );
    }

    for (const asset of payload.import_assets || []) {
      run(
        database,
        'INSERT INTO import_assets (id, batch_id, asset_type, file_path, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)',
        [asset.id, asset.batch_id, asset.asset_type, asset.file_path, asset.created_at, asset.deleted_at ?? null]
      );
    }

    for (const settings of payload.study_settings || []) {
      run(
        database,
        `INSERT INTO study_settings (
          id, exam_date, daily_target_minutes, supervision_mode, auto_rollover_enabled,
          last_rollover_date, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          settings.id ?? 1,
          settings.exam_date ?? null,
          settings.daily_target_minutes ?? 240,
          settings.supervision_mode ?? 'strict',
          settings.auto_rollover_enabled ?? 1,
          settings.last_rollover_date ?? null,
          settings.created_at ?? nowIso(),
          settings.updated_at ?? nowIso()
        ]
      );
    }

    for (const subject of payload.study_subjects || []) {
      run(
        database,
        'INSERT INTO study_subjects (id, name, sort_order, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [
          subject.id,
          subject.name,
          subject.sort_order ?? 0,
          subject.is_active ?? 1,
          subject.created_at ?? nowIso(),
          subject.updated_at ?? nowIso()
        ]
      );
    }

    for (const material of payload.study_materials || []) {
      run(
        database,
        `INSERT INTO study_materials (
          id, subject_id, name, material_type, progress_unit, custom_unit_name,
          total_amount, current_amount, start_date, target_date, priority, status,
          note, is_deleted, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          material.id,
          material.subject_id,
          material.name,
          material.material_type ?? '其他',
          material.progress_unit ?? '自定义',
          material.custom_unit_name ?? null,
          material.total_amount ?? 0,
          material.current_amount ?? 0,
          material.start_date ?? null,
          material.target_date ?? null,
          material.priority ?? '中',
          material.status ?? '进行中',
          material.note ?? '',
          material.is_deleted ?? 0,
          material.created_at ?? nowIso(),
          material.updated_at ?? nowIso()
        ]
      );
    }

    for (const task of payload.study_tasks || []) {
      run(
        database,
        `INSERT INTO study_tasks (
          id, task_date, subject_id, material_id, title, task_type, estimated_minutes,
          actual_minutes, priority, status, completion_quality, defer_count, original_date,
          skipped_reason, note, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          task.id,
          task.task_date,
          task.subject_id,
          task.material_id ?? null,
          task.title,
          task.task_type ?? '其他',
          task.estimated_minutes ?? 0,
          task.actual_minutes ?? 0,
          task.priority ?? '中',
          task.status ?? '未开始',
          task.completion_quality ?? null,
          task.defer_count ?? 0,
          task.original_date ?? null,
          task.skipped_reason ?? null,
          task.note ?? '',
          task.created_at ?? nowIso(),
          task.updated_at ?? nowIso(),
          task.completed_at ?? null
        ]
      );
    }

    for (const session of payload.study_sessions || []) {
      run(
        database,
        `INSERT INTO study_sessions (
          id, session_date, subject_id, task_id, material_id, start_time, end_time,
          duration_minutes, quality, note, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          session.id,
          session.session_date,
          session.subject_id,
          session.task_id ?? null,
          session.material_id ?? null,
          session.start_time,
          session.end_time ?? null,
          session.duration_minutes ?? 0,
          session.quality ?? null,
          session.note ?? '',
          session.created_at ?? nowIso(),
          session.updated_at ?? nowIso()
        ]
      );
    }

    for (const review of payload.daily_reviews || []) {
      run(
        database,
        `INSERT INTO daily_reviews (
          id, review_date, completion_rate, total_study_minutes, completed_task_count,
          total_task_count, mood, today_summary, main_problem, tomorrow_priority, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          review.id,
          review.review_date,
          review.completion_rate ?? 0,
          review.total_study_minutes ?? 0,
          review.completed_task_count ?? 0,
          review.total_task_count ?? 0,
          review.mood ?? null,
          review.today_summary ?? '',
          review.main_problem ?? '',
          review.tomorrow_priority ?? '',
          review.created_at ?? nowIso(),
          review.updated_at ?? nowIso()
        ]
      );
    }

        database.run('COMMIT');
      } catch (error) {
        database.run('ROLLBACK');
        throw error;
      }
      return true;
    }
  });

  return { imported: true, backup: replacement.recoveryDatabasePath };
}

export async function clearAllData(deleteImages: boolean, dependencies: MaintenanceOperationDependencies = {}) {
  await replaceDatabaseIdentity({
    commandType: 'database.clear_all',
    inputIdentity: { deleteImages },
    quarantinePaths: deleteImages
      ? (database) => all<QuestionImage>(database, 'SELECT * FROM question_images').map((image) => image.file_path)
      : [],
    dependencies,
    mutate(candidate) {
      for (const table of ['daily_reviews', 'study_sessions', 'study_tasks', 'study_materials', 'study_subjects', 'study_settings', 'import_assets', 'import_batch_items', 'import_batches', 'external_question_attempts', 'external_questions', 'question_knowledge_points', 'knowledge_points', 'textbooks', 'question_tags', 'tags', 'review_logs', 'question_images', 'questions']) {
        candidate.run(`DELETE FROM ${table}`);
      }
      return true;
    }
  });
  return true;
}

export async function createVerifiedDatabaseSnapshot(
  targetPath: string,
  dependencies: MaintenanceOperationDependencies = {}
) {
  const coordinator = await getDatabaseCoordinator();
  const lease = await coordinator.beginMaintenance();
  try {
    const expectedVersion = coordinator.currentVersion();
    const bytes = fs.readFileSync(getPaths().database);
    const SQL = await initSqlJs({ locateFile: () => resolveSqlWasmPath() });
    const opener = createSqlJsCandidateOpener(SQL);
    const inspected = inspectDatabaseBytes(bytes, { path: getPaths().database, kind: 'live' }, opener, expectedVersion);
    if (inspected.status !== 'valid' || inspected.metadata !== 'present') {
      throw new MaintenanceOperationError('LIVE_DATABASE_INVALID', 'backup_validation', 'Live database is not a verified backup candidate', false);
    }
    const normalizedTarget = path.normalize(path.resolve(targetPath));
    const nonce = safeLifecycleId((dependencies.randomId ?? randomUUID)());
    const tempPath = path.join(path.dirname(normalizedTarget), `.${path.basename(normalizedTarget)}.${nonce}.tmp`);
    durableWriteNew(tempPath, bytes);
    try {
      const tempInspection = inspectDatabaseBytes(fs.readFileSync(tempPath), { path: tempPath, kind: 'temp' }, opener, expectedVersion);
      if (tempInspection.status !== 'valid' || tempInspection.metadata !== 'present') {
        throw new MaintenanceOperationError('BACKUP_VALIDATION_FAILED', 'backup_validation', 'Backup copy failed verification');
      }
      fs.renameSync(tempPath, normalizedTarget);
      const finalInspection = inspectDatabaseBytes(fs.readFileSync(normalizedTarget), { path: normalizedTarget, kind: 'live' }, opener, expectedVersion);
      if (finalInspection.status !== 'valid' || finalInspection.metadata !== 'present') {
        throw new MaintenanceOperationError('BACKUP_VALIDATION_FAILED', 'backup_validation', 'Published backup failed verification');
      }
    } catch (error) {
      fs.rmSync(tempPath, { force: true });
      throw error;
    }
    return { filePath: normalizedTarget, version: expectedVersion, evidence: evidenceForBytes(bytes) };
  } finally {
    if (coordinator.state === 'maintenance') coordinator.finishMaintenance(lease, 'writable');
  }
}

function createVerifiedDatabaseSnapshotSyncInState(targetPath: string, allowedState: 'writable' | 'maintenance') {
  if (!databaseCoordinator || !db || databaseCoordinator.state !== allowedState) {
    throw new MaintenanceOperationError('DATABASE_NOT_WRITABLE', 'backup_admission', 'Database is not available for a synchronous recovery snapshot');
  }
  if (databaseCoordinator.pendingWrites !== 0 && allowedState === 'writable') {
    throw new MaintenanceOperationError('DATABASE_BUSY', 'backup_admission', 'Synchronous recovery snapshot refused while writes are pending');
  }
  const quickCheck = db.exec('PRAGMA quick_check');
  if (quickCheck[0]?.values[0]?.[0] !== 'ok') {
    throw new MaintenanceOperationError('LIVE_DATABASE_INVALID', 'backup_validation', 'Live database failed quick_check', false);
  }
  const version = new RevisionStore(db).readCurrentVersion();
  const memoryBytes = Buffer.from(db.export());
  const diskBytes = fs.readFileSync(getPaths().database);
  if (!memoryBytes.equals(diskBytes)) {
    throw new MaintenanceOperationError('DATABASE_NOT_FLUSHED', 'backup_validation', 'Live database file does not match the coordinator-owned database');
  }
  const normalizedTarget = path.normalize(path.resolve(targetPath));
  const tempPath = path.join(path.dirname(normalizedTarget), `.${path.basename(normalizedTarget)}.${safeLifecycleId(randomUUID())}.tmp`);
  durableWriteNew(tempPath, diskBytes);
  try {
    if (!fs.readFileSync(tempPath).equals(diskBytes)) throw new Error('Synchronous recovery snapshot hash mismatch');
    fs.renameSync(tempPath, normalizedTarget);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
  return { filePath: normalizedTarget, version, evidence: evidenceForBytes(diskBytes) };
}

export function createVerifiedDatabaseSnapshotSync(targetPath: string) {
  return createVerifiedDatabaseSnapshotSyncInState(targetPath, 'writable');
}

export async function executeWriteWithVerifiedSnapshot<T>(
  targetPath: string,
  request: DatabaseWriteRequest<T>
): Promise<{ snapshot: ReturnType<typeof createVerifiedDatabaseSnapshotSync>; result: DatabaseWriteResult<T> }> {
  const coordinator = await getDatabaseCoordinator();
  const lease = await coordinator.beginMaintenance();
  let snapshot: ReturnType<typeof createVerifiedDatabaseSnapshotSync>;
  try {
    snapshot = createVerifiedDatabaseSnapshotSyncInState(targetPath, 'maintenance');
  } catch (error) {
    coordinator.finishMaintenance(lease, 'writable');
    throw error;
  }
  coordinator.finishMaintenance(lease, 'writable');
  const admittedWrite = coordinator.executeWrite(request);
  return { snapshot, result: await admittedWrite };
}

export async function restoreDatabaseFromFile(
  backupPath: string,
  dependencies: MaintenanceOperationDependencies = {}
) {
  const normalized = path.normalize(path.resolve(backupPath));
  if (!fs.existsSync(normalized)) throw new MaintenanceOperationError('BACKUP_NOT_FOUND', 'restore_validation', `Backup file does not exist: ${normalized}`);
  const bytes = fs.readFileSync(normalized);
  const SQL = await initSqlJs({ locateFile: () => resolveSqlWasmPath() });
  const opener = createSqlJsCandidateOpener(SQL);
  const inspected = inspectDatabaseBytes(bytes, { path: normalized, kind: 'temp' }, opener);
  if (inspected.status !== 'valid' || inspected.metadata !== 'present') {
    throw new MaintenanceOperationError('BACKUP_INVALID', 'restore_validation', 'Backup is corrupt, incompatible, or has ambiguous identity');
  }
  const validationDatabase = new SQL.Database(bytes);
  try {
    const requiredTables = ['questions', 'question_images', 'tags', 'question_tags', 'review_logs', 'question_knowledge_points'];
    const tables = new Set(all<{ name: string }>(validationDatabase, "SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name));
    if (requiredTables.some((table) => !tables.has(table))) {
      throw new MaintenanceOperationError('BACKUP_INCOMPATIBLE', 'restore_validation', 'Backup does not contain the required question schema');
    }
    for (const row of all<{ file_path: string }>(validationDatabase, 'SELECT file_path FROM question_images')) {
      resolveManagedImagePath(row.file_path, 'restore_validation', 'BACKUP_MANAGED_FILES_MISSING');
    }
  } finally {
    validationDatabase.close();
  }
  return replaceDatabaseIdentity({
    commandType: 'database.restore_backup',
    inputIdentity: { backupPath: normalized, ...evidenceForBytes(bytes) },
    sourceBytes: bytes,
    dependencies
  });
}

export interface DataRootSwitchDependencies {
  maintenance?: MaintenanceOperationDependencies;
  root?: RootSwitchDependencies;
}

export async function switchDataRoot(
  root: string,
  migrate: boolean,
  dependencies: DataRootSwitchDependencies = {}
) {
  const coordinator = await getDatabaseCoordinator();
  const lease = await coordinator.beginMaintenance();
  const oldPaths = getPaths();
  let plan: Awaited<ReturnType<typeof stageDataRootSwitch>> | null = null;
  let staged: OperationManifest | null = null;
  let journal: OperationJournal | null = null;
  let configPublished = false;
  try {
    plan = await stageDataRootSwitch(oldPaths, root, migrate, dependencies.root);
    const SQL = await initSqlJs({ locateFile: () => resolveSqlWasmPath() });
    const opener = createSqlJsCandidateOpener(SQL);
    let candidate: Database;
    if (migrate) {
      if (!fs.existsSync(plan.newPaths.database)) throw new MaintenanceOperationError('ROOT_DATABASE_MISSING', 'root_stage', 'Migrated root does not contain a database');
      candidate = new SQL.Database(fs.readFileSync(plan.newPaths.database));
    } else {
      candidate = new SQL.Database();
      candidate.run('PRAGMA foreign_keys = ON;');
      candidate.exec(schemaSql);
      migrateDatabase(candidate);
      bootstrapControlMetadata(candidate, {
        createEpoch: dependencies.maintenance?.createEpoch,
        now: dependencies.maintenance?.now
      });
    }
    try {
      candidate.run('PRAGMA foreign_keys = ON;');
      let versionAfter = new RevisionStore(candidate).readCurrentVersion();
      if (versionAfter.dataEpoch === coordinator.currentVersion().dataEpoch || versionAfter.dataRevision !== 0) {
        versionAfter = new RevisionStore(candidate, dependencies.maintenance?.now).resetDatabaseIdentity(
          createRevisionMutationCapability(candidate),
          (dependencies.maintenance?.createEpoch ?? randomUUID)()
        );
      }
      const request: ReplacementRequest<unknown> = {
        commandType: 'database.switch_root',
        inputIdentity: { root: plan.newPaths.root, migrate, files: plan.copiedFiles },
        dependencies: dependencies.maintenance
      };
      const prepared = await prepareReplacementManifest(
        request,
        safeLifecycleId((dependencies.maintenance?.randomId ?? randomUUID)()),
        coordinator.currentVersion(),
        versionAfter
      );
      journal = prepared.journal;
      staged = await journal.stage(await journal.prepare(prepared.manifest));
      const publication = await atomicPersist({
        livePath: plan.newPaths.database,
        requestId: staged.requestId,
        bytes: candidate.export(),
        expectedVersion: versionAfter,
        dependencies: {
          opener,
          files: defaultAtomicFileDependencies,
          randomId: dependencies.maintenance?.randomId,
          hook: dependencies.maintenance?.atomicHook
        }
      });
      if (publication.status !== 'success') {
        throw new MaintenanceOperationError(
          publication.status === 'indeterminate' ? 'ROOT_DATABASE_INDETERMINATE' : 'ROOT_DATABASE_PUBLICATION_FAILED',
          publication.failure.phase,
          'New-root database could not be verified',
          publication.status !== 'indeterminate',
          publication.error
        );
      }
    } finally {
      candidate.close();
    }

    await publishDataRootSwitch(plan, dependencies.root);
    configPublished = true;
    resetDatabaseConnection();
    const initialized = await initializeDatabase();
    if (initialized.state !== 'writable') throw new MaintenanceOperationError('RECOVERY_FENCE', 'root_reopen', 'New data root requires recovery', false);
    const rootRecovery = initialized.journalRecovery.outcomes.find((outcome) => outcome.operationId === staged?.operationId);
    if (!rootRecovery || rootRecovery.terminalState !== 'completed' || rootRecovery.manifest?.state !== 'completed') {
      throw new MaintenanceOperationError('ROOT_JOURNAL_INCOMPLETE', 'root_reopen', 'Root-switch recovery manifest did not complete', false);
    }
    return getPaths();
  } catch (error) {
    if (configPublished || getPaths().root !== oldPaths.root) {
      try {
        restoreDataRootAuthority(oldPaths, dependencies.root?.randomId);
      } catch (rollbackError) {
        if (databaseCoordinator === coordinator && coordinator.state === 'maintenance') coordinator.finishMaintenance(lease, 'needs_recovery');
        throw new MaintenanceOperationError('ROOT_CONFIG_ROLLBACK_FAILED', 'config_rollback', 'Data-root configuration could not be restored', false, rollbackError);
      }
    }
    if (staged && journal) await journal.compensate(staged, journalError(error, 'root_switch')).catch(() => undefined);
    if (databaseCoordinator !== coordinator) resetDatabaseConnection();
    if (!databaseCoordinator) await initializeDatabase().catch(() => undefined);
    if (databaseCoordinator === coordinator && coordinator.state === 'maintenance') coordinator.finishMaintenance(lease, 'writable');
    throw error;
  }
}

export function resetDatabaseConnection() {
  if (databaseCoordinator?.pendingWrites) {
    throw new Error('Cannot reset the database while coordinator writes are pending');
  }
  agentControlPlane?.jobExecutor.stop();
  if (db) {
    db.close();
    db = null;
  }
  databaseCoordinator = null;
  readOnlyDatabase = null;
  questionsApplication = null;
  tickTickApplication = null;
  knowledgeApplication = null;
  agentControlPlane = null;
  initializationPromise = null;
  initializationResult = null;
  shutdownPromise = null;
}

export function assertDatabaseReadyForRuntimeIpc(): void {
  if (!databaseCoordinator || databaseCoordinator.state !== 'writable') {
    throw new Error('Database recovery requires attention before runtime IPC can be registered');
  }
}

export function shutdownDatabase(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = shutdownDatabaseOnce();
  return shutdownPromise;
}

async function shutdownDatabaseOnce(): Promise<void> {
  const coordinator = databaseCoordinator;
  if (!coordinator) return;
  agentControlPlane?.jobExecutor.stop();
  await coordinator.shutdown();
}

export function getCurrentPaths(): AppPaths {
  return getPaths();
}

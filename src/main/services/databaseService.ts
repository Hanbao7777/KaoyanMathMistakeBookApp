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
import { registerStudy, type StudyApplication } from '../application/study';
import { registerImports, type ImportsApplication } from '../application/imports';
import { DataRootMigrationJournalStore, DatabaseClearJournalStore, DatabaseImportJournalStore, DatabaseRestoreJournalStore, ImportBatchDeletionJournalStore, applyImportBatchDeletion, getInternalGlobalAsset, importBatchDeletionManagedRoot, planDataRootSelection, registerGlobalApplication, resolveImportBatchDeletion, resolveStoredDataRootSelection, transitionGlobalAsset, verifyImportBatchDeletionManagedFile, verifyManagedDatabaseImport, type DataRootMigrationManifest, type DataRootMigrationPhase, type DataRootSelectionPlan, type DatabaseClearFileEvidence, type DatabaseClearManagedFile, type DatabaseClearManifest, type DatabaseClearResolution, type DatabaseImportManifest, type DatabaseImportSemanticEvidence, type DatabaseRestoreFileEvidence, type DatabaseRestoreManifest, type GlobalApplication, type GlobalMaterializer, type ImportBatchDeletionFileEvidence, type ImportBatchDeletionManifest, type ImportBatchDeletionManagedFile, type ImportBatchDeletionResolution, type StoredDataRootSelection } from '../application/global';
import { managedImportInboxRoot } from '../application/imports/managedInbox';
import type { QuestionCommand } from '../../shared/agent/v1/contracts';
import { bootstrapAgentGateway, type AgentGatewayBootstrapOptions, type AgentGatewayComposition } from '../agent/bootstrap';
import { AuditLedger } from '../agent/auditLedger';
import { ExecutionReceipts } from '../agent/executionReceipts';
import { WorkflowStore } from '../agent/workflows';
import {
  atomicPersist, bootstrapControlMetadata,
  createSqlJsCandidateOpener, createDatabaseCoordinatorControlCapability, DatabaseCoordinator,
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
  publishDataRootMigrationAuthority,
  readDataRootAuthoritySnapshot,
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
import { AgentError } from '../../shared/agent/errors';
import { canonicalizeJson, hashCanonicalJson } from '../../shared/agent/v1/gatewaySchemas';
import { operationCatalogIdentity } from '../../shared/agent/v1/operationCatalog';

let db: Database | null = null;
let databaseCoordinator: DatabaseCoordinator | null = null;
let readOnlyDatabase: ReadOnlyDatabaseFacade | null = null;
let questionsApplication: QuestionsApplication | null = null;
let tickTickApplication: TickTickApplication | null = null;
let knowledgeApplication: KnowledgeApplication | null = null;
let studyApplication: StudyApplication | null = null;
let importsApplication: ImportsApplication | null = null;
let globalApplication: GlobalApplication | null = null;
let agentControlPlane: AgentGatewayComposition | null = null;
const retiredCoordinatorHandles = new WeakSet<Database>();
let initializationPromise: Promise<DatabaseInitializationResult> | null = null;
let initializationResult: DatabaseInitializationResult | null = null;
let shutdownPromise: Promise<void> | null = null;
const defaultAgentInstanceId = randomUUID();

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
    readonly jobExecutorOnTerminalized?: AgentGatewayBootstrapOptions['jobExecutorOnTerminalized'];
  };
  onStage?: (stage: DatabaseLifecycleStage) => void;
  databaseClearRecoveryHook?: (stage: 'before_terminalization' | 'after_terminalization') => void | Promise<void>;
  importBatchDeletionRecoveryHook?: (stage: 'before_terminalization' | 'after_terminalization') => void | Promise<void>;
}

export interface DatabaseInitializationResult {
  readonly state: 'writable' | 'needs_recovery';
  readonly bootstrapChanged: boolean;
  readonly databaseRecovery: StartupDatabaseRecoveryResult | { readonly status: 'empty' };
  readonly journalRecovery: RecoveryScanOutcome;
}

export const maintenanceOperationStages = [
  'maintenance_entered',
  'source_validated',
  'recovery_package_staged',
  'files_quarantined',
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
  onStage?: (stage: MaintenanceOperationStage, evidence?: {
    readonly versionAfter?: import('../../shared/agent').DataVersion;
    readonly recoveryDatabasePath?: string;
    readonly recoveryDatabaseEvidence?: DatabaseRestoreFileEvidence;
    readonly recoveryInventoryPath?: string;
    readonly recoveryInventoryEvidence?: DatabaseRestoreFileEvidence;
    readonly liveDatabaseEvidence?: DatabaseRestoreFileEvidence;
  }) => void | Promise<void>;
  databaseClearRecoveryHook?: DatabaseInitializationDependencies['databaseClearRecoveryHook'];
  importBatchDeletionRecoveryHook?: DatabaseInitializationDependencies['importBatchDeletionRecoveryHook'];
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
    'registerIpc.ticktick:whiteNoise',
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

export async function getStudyApplication(): Promise<StudyApplication> {
  if (!studyApplication) await initializeDatabase();
  if (!studyApplication) throw new Error('Study application is unavailable');
  return studyApplication;
}

export async function getImportsApplication(): Promise<ImportsApplication> {
  if (!importsApplication) await initializeDatabase();
  if (!importsApplication) throw new Error('Imports application is unavailable');
  return importsApplication;
}

export async function getGlobalApplication(): Promise<GlobalApplication> {
  if (!globalApplication) await initializeDatabase();
  if (!globalApplication) throw new Error('Global application is unavailable');
  return globalApplication;
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

function sameVersion(left: import('../../shared/agent').DataVersion, right: import('../../shared/agent').DataVersion): boolean {
  return left.dataEpoch === right.dataEpoch && left.dataRevision === right.dataRevision;
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
  validateLive?: (database: Database, version: import('../../shared/agent').DataVersion) => void | Promise<void>;
  quarantineFiles?: readonly ReplacementManagedFile[] | ((database: Database) => readonly ReplacementManagedFile[]);
  dependencies?: MaintenanceOperationDependencies;
}

interface ReplacementManagedFile {
  readonly fileId: string;
  readonly sourceKind: string;
  readonly managedRoot: string;
  readonly internalPath: string;
  readonly pathHash: string;
  readonly contentHash: string;
  readonly contentSize: number;
}

const databaseRestoreTableAllowlist = Object.freeze([
  'questions', 'question_images', 'review_logs', 'tags', 'question_tags',
  'textbooks', 'knowledge_points', 'question_knowledge_points',
  'import_batches', 'import_batch_items', 'import_assets', 'import_drafts', 'import_managed_assets',
  'external_questions', 'external_question_attempts',
  'study_settings', 'study_subjects', 'study_materials', 'study_tasks', 'study_sessions', 'daily_reviews',
  'ticktick_lists', 'ticktick_tasks', 'ticktick_tags', 'ticktick_focus_sessions', 'ticktick_bridge',
  'ticktick_ai_plans', 'ticktick_habits', 'ticktick_habit_logs'
] as const);

export const databaseClearTableAllowlist = databaseRestoreTableAllowlist;
const DATABASE_CLEAR_MAX_AFFECTED_ENTITIES = 500;

interface ClearFileSource {
  readonly sourceKind: string;
  readonly binding: Readonly<Record<string, unknown>>;
  readonly reference: string;
  readonly root: string;
  readonly expectedHash?: string;
  readonly expectedSize?: number;
}

function strictManagedClearFile(source: ClearFileSource): { readonly internalPath: string; readonly pathHash: string; readonly contentHash: string; readonly contentSize: number } {
  const root = path.normalize(source.root);
  if (!path.isAbsolute(root) || !fs.existsSync(root)) throw new AgentError('RECOVERY_FENCE');
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new AgentError('RECOVERY_FENCE');
  const realRoot = path.normalize(fs.realpathSync(root));
  if (path.resolve(realRoot).toLowerCase() !== path.resolve(root).toLowerCase()) throw new AgentError('RECOVERY_FENCE');
  const candidate = path.normalize(path.isAbsolute(source.reference) ? source.reference : path.resolve(getPaths().root, source.reference));
  const relative = path.relative(root, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.existsSync(candidate)) {
    throw new AgentError('RECOVERY_FENCE');
  }
  const linkStat = fs.lstatSync(candidate);
  if (linkStat.isSymbolicLink() || !linkStat.isFile() || linkStat.size < 1) throw new AgentError('RECOVERY_FENCE');
  const realFile = path.normalize(fs.realpathSync(candidate));
  if (!isSameOrDescendant(realFile, realRoot) || realFile === realRoot) throw new AgentError('RECOVERY_FENCE');
  const handle = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const opened = fs.fstatSync(handle);
    if (!opened.isFile() || opened.dev !== linkStat.dev || opened.ino !== linkStat.ino || opened.size !== linkStat.size) throw new AgentError('RECOVERY_FENCE');
    bytes = fs.readFileSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  const contentHash = `sha256-v1:${createHash('sha256').update(bytes).digest('hex')}`;
  if ((source.expectedHash && contentHash !== source.expectedHash) ||
      (source.expectedSize !== undefined && bytes.byteLength !== source.expectedSize)) throw new AgentError('RECOVERY_FENCE');
  return Object.freeze({
    internalPath: candidate,
    pathHash: hashCanonicalJson({ root: source.sourceKind, relativePath: relative.replaceAll(path.sep, '/') }),
    contentHash,
    contentSize: bytes.byteLength
  });
}

function databaseClearResolutionFrom(database: Database, deleteManagedImages: boolean): DatabaseClearResolution {
  if (typeof deleteManagedImages !== 'boolean') throw new AgentError('VALIDATION_ERROR', { field: 'deleteManagedImages' });
  const tableCounts = databaseClearTableAllowlist.map((table) => Object.freeze({
    table,
    count: Number(one<{ count: number }>(database, `SELECT COUNT(*) AS count FROM ${quoteSqlIdentifier(table)}`)?.count ?? 0)
  }));
  const businessRowCount = tableCounts.reduce((total, entry) => total + entry.count, 0);
  if (!tableCounts.every((entry) => Number.isSafeInteger(entry.count) && entry.count >= 0) || businessRowCount > DATABASE_CLEAR_MAX_AFFECTED_ENTITIES) {
    throw new AgentError('POLICY_DENIED');
  }
  const rowBindings: Array<Readonly<{ table: string; rowHash: string }>> = [];
  const rowEntities: Array<Readonly<{ entityType: string; entityId: string }>> = [];
  for (const { table } of tableCounts) {
    const columns = all<{ name: string }>(database, `PRAGMA table_info(${quoteSqlIdentifier(table)})`).map((column) => column.name);
    if (columns.length === 0) throw new AgentError('RECOVERY_FENCE');
    const rows = all<Record<string, SqlValue>>(database, `SELECT ${columns.map(quoteSqlIdentifier).join(',')} FROM ${quoteSqlIdentifier(table)}`)
      .map((entry) => Object.freeze(Object.fromEntries(columns.map((column) => [column, normalizedSqlValue(entry[column])]))) as Readonly<Record<string, unknown>>)
      .sort((left, right) => canonicalizeJson(left).localeCompare(canonicalizeJson(right)));
    rows.forEach((row, index) => {
      const rowHash = hashCanonicalJson({ table, index, row });
      rowBindings.push(Object.freeze({ table, rowHash }));
      rowEntities.push(Object.freeze({ entityType: `database_row_${table}`, entityId: rowHash }));
    });
  }
  if (rowBindings.length !== businessRowCount) throw new AgentError('RECOVERY_FENCE');

  const paths = getPaths();
  const sources: Array<ClearFileSource & { readonly sourceKind: DatabaseClearManagedFile['sourceKind'] }> = [
    ...all<{ id: number; question_id: number; file_path: string }>(database, 'SELECT id,question_id,file_path FROM question_images ORDER BY id').map((image) => Object.freeze({
      sourceKind: 'question_image' as const,
      binding: Object.freeze({ imageId: image.id, questionId: image.question_id }),
      reference: image.file_path,
      root: path.normalize(paths.images)
    })),
    ...all<{ asset_id: string; file_path: string; sha256: string; size: number; state: string }>(database, "SELECT asset_id,file_path,sha256,size,state FROM import_managed_assets WHERE state IN ('staged','consumed') ORDER BY asset_id").map((asset) => Object.freeze({
      sourceKind: 'import_managed_image' as const,
      binding: Object.freeze({ assetId: asset.asset_id, state: asset.state }),
      reference: asset.file_path,
      root: managedImportInboxRoot(),
      expectedHash: `sha256-v1:${asset.sha256}`,
      expectedSize: asset.size
    }))
  ];
  const collected = new Map<string, { evidence: ReturnType<typeof strictManagedClearFile>; kinds: Set<DatabaseClearManagedFile['sourceKind']>; bindings: Readonly<Record<string, unknown>>[] }>();
  for (const source of sources) {
    const evidence = strictManagedClearFile(source);
    const key = path.resolve(evidence.internalPath).toLowerCase();
    const existing = collected.get(key);
    if (existing) {
      if (existing.evidence.contentHash !== evidence.contentHash || existing.evidence.contentSize !== evidence.contentSize || existing.evidence.pathHash !== evidence.pathHash) {
        throw new AgentError('RECOVERY_FENCE');
      }
      existing.kinds.add(source.sourceKind);
      existing.bindings.push(source.binding);
    } else {
      collected.set(key, { evidence, kinds: new Set([source.sourceKind]), bindings: [source.binding] });
    }
  }
  const managedFiles = Object.freeze([...collected.values()].map(({ evidence, kinds, bindings }) => {
    const sourceKind = kinds.has('question_image') ? 'question_image' as const : 'import_managed_image' as const;
    const sourceBindingsHash = hashCanonicalJson([...bindings].sort((left, right) => canonicalizeJson(left).localeCompare(canonicalizeJson(right))));
    return Object.freeze({
      fileId: `managed-image-${evidence.pathHash.slice(10, 50)}`,
      sourceKind,
      internalPath: evidence.internalPath,
      pathHash: evidence.pathHash,
      contentHash: evidence.contentHash,
      contentSize: evidence.contentSize,
      sourceBindingsHash
    });
  }).sort((left, right) => left.pathHash.localeCompare(right.pathHash)));
  const affectedEntityCount = businessRowCount + managedFiles.length;
  if (affectedEntityCount > DATABASE_CLEAR_MAX_AFFECTED_ENTITIES) throw new AgentError('POLICY_DENIED');
  const fileBindings = managedFiles.map(({ fileId, sourceKind, pathHash, contentHash, contentSize, sourceBindingsHash }) =>
    Object.freeze({ fileId, sourceKind, pathHash, contentHash, contentSize, sourceBindingsHash }));
  const fileEntities = fileBindings.map((file) => Object.freeze({ entityType: 'managed_image', entityId: hashCanonicalJson(file) }));
  const affectedEntities = Object.freeze([...rowEntities, ...fileEntities]
    .sort((left, right) => `${left.entityType}\0${left.entityId}`.localeCompare(`${right.entityType}\0${right.entityId}`)));
  const sortedRowBindings = [...rowBindings]
    .sort((left, right) => `${left.table}\0${left.rowHash}`.localeCompare(`${right.table}\0${right.rowHash}`));
  const inventoryHash = hashCanonicalJson({ schemaVersion: 1, rowBindings: sortedRowBindings, fileBindings });
  const affectedSetHash = hashCanonicalJson(affectedEntities);
  const targetHash = hashCanonicalJson({
    operation: 'database.clear_all', deleteManagedImages, inventoryHash, affectedSetHash,
    businessRowCount, managedImageCount: managedFiles.length
  });
  return Object.freeze({
    deleteManagedImages, businessRowCount, managedImageCount: managedFiles.length, affectedEntityCount,
    inventoryHash, managedFiles, affectedEntities, affectedSetHash, targetHash,
    dataVersion: Object.freeze({ ...new RevisionStore(database).readCurrentVersion() })
  });
}

export function resolveDatabaseClearInventory(deleteManagedImages: boolean, databaseOverride?: Database): DatabaseClearResolution {
  const database = databaseOverride ?? db;
  if (!database) throw new AgentError('RECOVERY_FENCE');
  return databaseClearResolutionFrom(database, deleteManagedImages);
}

export function resolveImportBatchDeletionInventory(
  batchId: string,
  deleteManagedAssets: boolean,
  identity: { readonly clientId: string; readonly renderer: boolean },
  databaseOverride?: Database
): ImportBatchDeletionResolution {
  const database = databaseOverride ?? db;
  if (!database) throw new AgentError('RECOVERY_FENCE');
  return resolveImportBatchDeletion(database, batchId, deleteManagedAssets, identity);
}

const databaseImportPackageFormat = 'kaoyan-full-data-v1' as const;
const MAX_DATABASE_IMPORT_ROWS = 250_000;
const MAX_DATABASE_IMPORT_ROWS_PER_TABLE = 100_000;
const MAX_DATABASE_IMPORT_STRING_BYTES = 1_048_576;

type DatabaseImportTable = typeof databaseRestoreTableAllowlist[number];
type DatabaseImportRows = Readonly<Record<DatabaseImportTable, readonly Readonly<Record<string, SqlValue>>[]>>;

export interface DatabaseImportPackageMetadata {
  readonly format: typeof databaseImportPackageFormat;
  readonly version: 1;
  readonly semanticHash: string;
  readonly semanticSize: number;
  readonly rowCount: number;
  readonly tableCounts: Readonly<Record<DatabaseImportTable, number>>;
}

interface ParsedDatabaseImportPackage {
  readonly metadata: DatabaseImportPackageMetadata;
  readonly rows: DatabaseImportRows;
}

function exactObject(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MaintenanceOperationError('IMPORT_PACKAGE_INVALID', 'import_validation', `${field} must be an object`);
  const result = value as Record<string, unknown>;
  const expected = [...keys].sort();
  const actual = Object.keys(result).sort();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) throw new MaintenanceOperationError('IMPORT_PACKAGE_INVALID', 'import_validation', `${field} has an incompatible shape`);
  return result;
}

function parseDatabaseImportPackage(bytes: Uint8Array): ParsedDatabaseImportPackage {
  if (bytes.byteLength < 1 || bytes.byteLength > 64 * 1024 * 1024) throw new MaintenanceOperationError('IMPORT_PACKAGE_INVALID', 'import_validation', 'Import package size is outside the supported bounds');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new MaintenanceOperationError('IMPORT_PACKAGE_INVALID', 'import_validation', 'Import package is not valid UTF-8'); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new MaintenanceOperationError('IMPORT_PACKAGE_INVALID', 'import_validation', 'Import package is not valid JSON'); }
  const keys = ['format', 'version', 'exportedAt', ...databaseRestoreTableAllowlist] as const;
  const payload = exactObject(parsed, keys, 'package');
  if (payload.format !== databaseImportPackageFormat || payload.version !== 1 || typeof payload.exportedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(payload.exportedAt) || new Date(payload.exportedAt).toISOString() !== payload.exportedAt) {
    throw new MaintenanceOperationError('IMPORT_PACKAGE_INVALID', 'import_validation', 'Import package identity is invalid');
  }
  let rowCount = 0;
  const rows = {} as Record<DatabaseImportTable, readonly Readonly<Record<string, SqlValue>>[]>;
  const tableCounts = {} as Record<DatabaseImportTable, number>;
  const semanticTables = {} as Record<DatabaseImportTable, readonly Readonly<Record<string, SqlValue>>[]>;
  for (const table of databaseRestoreTableAllowlist) {
    const tableRows = payload[table];
    if (!Array.isArray(tableRows) || tableRows.length > MAX_DATABASE_IMPORT_ROWS_PER_TABLE) throw new MaintenanceOperationError('IMPORT_PACKAGE_INVALID', 'import_validation', `Import table ${table} is outside the supported bounds`);
    const normalized = tableRows.map((value, index) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MaintenanceOperationError('IMPORT_PACKAGE_INVALID', 'import_validation', `Import table ${table} row ${index} is invalid`);
      const row: Record<string, SqlValue> = {};
      for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
        if (!key || key.length > 128 || (candidate !== null && typeof candidate !== 'string' && typeof candidate !== 'number')) throw new MaintenanceOperationError('IMPORT_PACKAGE_INVALID', 'import_validation', `Import table ${table} row ${index} contains an invalid value`);
        if (typeof candidate === 'number' && (!Number.isSafeInteger(candidate) || !Number.isFinite(candidate))) throw new MaintenanceOperationError('IMPORT_PACKAGE_INVALID', 'import_validation', `Import table ${table} row ${index} contains an invalid number`);
        if (typeof candidate === 'string' && Buffer.byteLength(candidate, 'utf8') > MAX_DATABASE_IMPORT_STRING_BYTES) throw new MaintenanceOperationError('IMPORT_PACKAGE_INVALID', 'import_validation', `Import table ${table} row ${index} contains an oversized value`);
        row[key] = candidate as SqlValue;
      }
      return Object.freeze(row);
    });
    rowCount += normalized.length;
    if (rowCount > MAX_DATABASE_IMPORT_ROWS) throw new MaintenanceOperationError('IMPORT_PACKAGE_INVALID', 'import_validation', 'Import package contains too many rows');
    rows[table] = Object.freeze(normalized);
    tableCounts[table] = normalized.length;
    semanticTables[table] = Object.freeze([...normalized].sort((left, right) => canonicalizeJson(left).localeCompare(canonicalizeJson(right))));
  }
  const semantic = Object.freeze({ format: databaseImportPackageFormat, version: 1, tables: Object.freeze(semanticTables) });
  const semanticJson = canonicalizeJson(semantic);
  return Object.freeze({
    metadata: Object.freeze({
      format: databaseImportPackageFormat,
      version: 1 as const,
      semanticHash: hashCanonicalJson(semantic),
      semanticSize: Buffer.byteLength(semanticJson, 'utf8'),
      rowCount,
      tableCounts: Object.freeze(tableCounts)
    }),
    rows: Object.freeze(rows) as DatabaseImportRows
  });
}

function createDatabaseImportPackageDatabase(SQL: SqlJsStatic, parsed: ParsedDatabaseImportPackage): Database {
  const database = new SQL.Database();
  try {
    database.run('PRAGMA foreign_keys = OFF;');
    database.exec(schemaSql);
    migrateDatabase(database);
    for (const table of databaseRestoreTableAllowlist) {
      const columns = all<{ name: string; type: string; notnull: number }>(database, `PRAGMA table_info(${quoteSqlIdentifier(table)})`);
      const columnNames = columns.map((column) => column.name);
      if (columnNames.length === 0) throw new MaintenanceOperationError('IMPORT_PACKAGE_INVALID', 'import_validation', `Import table ${table} is unavailable`);
      const statement = database.prepare(`INSERT INTO ${quoteSqlIdentifier(table)} (${columnNames.map(quoteSqlIdentifier).join(',')}) VALUES (${columnNames.map(() => '?').join(',')})`);
      try {
        for (const [index, row] of parsed.rows[table].entries()) {
          exactObject(row, columnNames, `${table}[${index}]`);
          const values = columns.map((column) => {
            const value = row[column.name];
            if (value === null) return value;
            if (column.type.toUpperCase().includes('INT') && (typeof value !== 'number' || !Number.isSafeInteger(value))) throw new MaintenanceOperationError('IMPORT_PACKAGE_INVALID', 'import_validation', `${table}[${index}].${column.name} must be an integer`);
            if (column.type.toUpperCase().includes('TEXT') && typeof value !== 'string') throw new MaintenanceOperationError('IMPORT_PACKAGE_INVALID', 'import_validation', `${table}[${index}].${column.name} must be text`);
            return value;
          });
          statement.run(values as SqlValue[]);
        }
      } finally {
        statement.free();
      }
    }
    database.run('PRAGMA foreign_keys = ON;');
    if ((database.exec('PRAGMA foreign_key_check')[0]?.values ?? []).length > 0 || database.exec('PRAGMA quick_check')[0]?.values?.[0]?.[0] !== 'ok') {
      throw new MaintenanceOperationError('IMPORT_PACKAGE_INVALID', 'import_validation', 'Import package violates database integrity constraints');
    }
    for (const row of all<{ file_path: string }>(database, 'SELECT file_path FROM question_images')) resolveManagedImagePath(row.file_path, 'import_validation', 'IMPORT_MANAGED_FILE_MISSING');
    return database;
  } catch (error) {
    database.close();
    if (error instanceof MaintenanceOperationError) throw error;
    throw new MaintenanceOperationError('IMPORT_PACKAGE_INVALID', 'import_validation', 'Import package is incompatible with the current schema', true, error);
  }
}

export async function inspectDatabaseImportPackage(bytes: Uint8Array): Promise<DatabaseImportPackageMetadata> {
  const parsed = parseDatabaseImportPackage(bytes);
  const SQL = await initSqlJs({ locateFile: () => resolveSqlWasmPath() });
  const packageDatabase = createDatabaseImportPackageDatabase(SQL, parsed);
  packageDatabase.close();
  return parsed.metadata;
}

function copyRestorableTablesFromBackup(candidate: Database, backup: Database): void {
  candidate.exec(schemaSql);
  migrateDatabase(candidate);
  backup.exec(schemaSql);
  migrateDatabase(backup);
  candidate.run('PRAGMA foreign_keys = OFF;');
  try {
    for (const table of [...databaseRestoreTableAllowlist].reverse()) candidate.run(`DELETE FROM ${table}`);
    for (const table of databaseRestoreTableAllowlist) {
      const candidateColumns = all<{ name: string }>(candidate, `PRAGMA table_info(${table})`).map((column) => column.name);
      const backupColumns = all<{ name: string }>(backup, `PRAGMA table_info(${table})`).map((column) => column.name);
      if (candidateColumns.length === 0 || candidateColumns.join('\0') !== backupColumns.join('\0')) {
        throw new MaintenanceOperationError('BACKUP_INCOMPATIBLE', 'restore_validation', `Backup table schema is incompatible: ${table}`);
      }
      const rows = all<Record<string, SqlValue>>(backup, `SELECT ${candidateColumns.join(',')} FROM ${table}`);
      const placeholders = candidateColumns.map(() => '?').join(',');
      const statement = candidate.prepare(`INSERT INTO ${table} (${candidateColumns.join(',')}) VALUES (${placeholders})`);
      try {
        for (const row of rows) {
          statement.run(candidateColumns.map((column) => row[column]) as SqlValue[]);
        }
      } finally {
        statement.free();
      }
    }
  } finally {
    candidate.run('PRAGMA foreign_keys = ON;');
  }
  const violations = candidate.exec('PRAGMA foreign_key_check')[0]?.values ?? [];
  if (violations.length) throw new MaintenanceOperationError('BACKUP_INCOMPATIBLE', 'restore_validation', 'Restored backup violates foreign-key constraints');
}

function restoreEvidence(filePath: string): DatabaseRestoreFileEvidence {
  const evidence = fileEvidence(filePath);
  return Object.freeze({ contentHash: `sha256-v1:${evidence.sha256}`, contentSize: evidence.size });
}

function restoreEvidenceForBytes(bytes: Uint8Array): DatabaseRestoreFileEvidence {
  const evidence = evidenceForBytes(bytes);
  return Object.freeze({ contentHash: `sha256-v1:${evidence.sha256}`, contentSize: evidence.size });
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function normalizedSqlValue(value: SqlValue): unknown {
  if (value instanceof Uint8Array) return Object.freeze({ blobHex: Buffer.from(value).toString('hex') });
  return value;
}

function restoreSemanticLiveEvidence(SQL: SqlJsStatic, bytes: Uint8Array, manifest: DatabaseRestoreManifest, expectedVersion: import('../../shared/agent').DataVersion): DatabaseRestoreFileEvidence {
  const opener = createSqlJsCandidateOpener(SQL);
  let inspected;
  try {
    inspected = inspectDatabaseBytes(bytes, { path: getPaths().database, kind: 'temp' }, opener, expectedVersion);
  } catch {
    throw new AgentError('RECOVERY_FENCE');
  }
  if (inspected.status !== 'valid' || inspected.metadata !== 'present') throw new AgentError('RECOVERY_FENCE');
  const database = new SQL.Database(bytes);
  try {
    database.run('PRAGMA foreign_keys = ON;');
    database.exec(schemaSql);
    migrateDatabase(database);
    const version = new RevisionStore(database).readCurrentVersion();
    if (version.dataEpoch !== expectedVersion.dataEpoch || version.dataRevision !== expectedVersion.dataRevision) throw new AgentError('RECOVERY_FENCE');
    const businessTables = databaseRestoreTableAllowlist.map((table) => {
      const columns = all<{ name: string; type: string; notnull: number; dflt_value: SqlValue; pk: number }>(database, `PRAGMA table_info(${quoteSqlIdentifier(table)})`);
      if (columns.length === 0) throw new AgentError('RECOVERY_FENCE');
      const columnNames = columns.map((column) => column.name);
      const tableSql = one<{ sql: string }>(database, "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", [table])?.sql;
      if (typeof tableSql !== 'string') throw new AgentError('RECOVERY_FENCE');
      const indexes = all<{ name: string; sql: string | null }>(database, "SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name=? ORDER BY name", [table])
        .map((entry) => Object.freeze({ name: entry.name, sql: entry.sql ?? null }));
      const rows = all<Record<string, SqlValue>>(database, `SELECT ${columnNames.map(quoteSqlIdentifier).join(',')} FROM ${quoteSqlIdentifier(table)}`)
        .map((row) => Object.freeze(Object.fromEntries(columnNames.map((column) => [column, normalizedSqlValue(row[column])]))) as Readonly<Record<string, unknown>>)
        .sort((left, right) => canonicalizeJson(left).localeCompare(canonicalizeJson(right)));
      return Object.freeze({
        table,
        schema: tableSql,
        columns: Object.freeze(columns.map((column) => Object.freeze({
          name: column.name, type: column.type, notnull: column.notnull, dflt: normalizedSqlValue(column.dflt_value), pk: column.pk
        }))),
        indexes: Object.freeze(indexes),
        rows: Object.freeze(rows)
      });
    });
    const receipt = one<Record<string, SqlValue>>(database, `SELECT receipt_id,client_id,request_id,operation,payload_hash,affected_set_hash,
        base_data_epoch,base_data_revision,catalog_version,catalog_hash,risk,status,reservation_id,grant_id,r4_target_hash,
        r4_recovery,r4_max_affected_entities,r4_reservation_expires_at,terminal_outcome_hash
      FROM agent_idempotency WHERE receipt_id=?`, [manifest.receiptId]);
    const grant = one<Record<string, SqlValue>>(database, `SELECT grant_id,client_id,operation,payload_hash,target_hash,catalog_version,catalog_hash,
        recovery,max_affected_entities,status,reservation_id,reserved_client_id,reserved_request_id,reserved_payload_hash,
        reserved_affected_set_hash,reserved_base_epoch,reserved_base_revision,reserved_catalog_version,reserved_catalog_hash,consumed_at
      FROM agent_r4_grants WHERE grant_id=?`, [manifest.grantId]);
    if (!receipt || !grant) throw new AgentError('RECOVERY_FENCE');
    const changeSet = manifest.changeSetId ? one<Record<string, SqlValue>>(database, `SELECT c.change_set_id,c.client_id,c.status,c.catalog_version,c.catalog_hash,
        c.base_data_epoch,c.base_data_revision,c.affected_set_hash,c.recovery,o.operation,o.payload_hash
      FROM agent_changesets c INNER JOIN agent_changeset_operations o ON o.change_set_id=c.change_set_id
      WHERE c.change_set_id=?`, [manifest.changeSetId]) : undefined;
    if (manifest.changeSetId && !changeSet) throw new AgentError('RECOVERY_FENCE');
    const semantic = Object.freeze({
      schemaVersion: 1,
      version: Object.freeze({ ...version }),
      operationId: manifest.operationId,
      receiptId: manifest.receiptId,
      requestId: manifest.requestId,
      ownerClientId: manifest.ownerClientId,
      businessTables: Object.freeze(businessTables),
      terminalBindings: Object.freeze({
        receipt: Object.freeze(Object.fromEntries(Object.entries(receipt).map(([key, value]) => [key, normalizedSqlValue(value)]))),
        grant: Object.freeze(Object.fromEntries(Object.entries(grant).map(([key, value]) => [key, normalizedSqlValue(value)]))),
        ...(changeSet ? { changeSet: Object.freeze(Object.fromEntries(Object.entries(changeSet).map(([key, value]) => [key, normalizedSqlValue(value)]))) } : {})
      })
    });
    const canonical = canonicalizeJson(semantic);
    return Object.freeze({ contentHash: hashCanonicalJson(semantic), contentSize: Buffer.byteLength(canonical, 'utf8') });
  } finally {
    database.close();
  }
}

function databaseImportLiveSemanticEvidence(SQL: SqlJsStatic, bytes: Uint8Array, manifest: DatabaseImportManifest, expectedVersion: import('../../shared/agent').DataVersion): DatabaseImportSemanticEvidence {
  const opener = createSqlJsCandidateOpener(SQL);
  let inspected;
  try { inspected = inspectDatabaseBytes(bytes, { path: getPaths().database, kind: 'temp' }, opener, expectedVersion); } catch { throw new AgentError('RECOVERY_FENCE'); }
  if (inspected.status !== 'valid' || inspected.metadata !== 'present') throw new AgentError('RECOVERY_FENCE');
  const database = new SQL.Database(bytes);
  try {
    database.run('PRAGMA foreign_keys = ON;');
    database.exec(schemaSql);
    migrateDatabase(database);
    const version = new RevisionStore(database).readCurrentVersion();
    if (version.dataEpoch !== expectedVersion.dataEpoch || version.dataRevision !== expectedVersion.dataRevision) throw new AgentError('RECOVERY_FENCE');
    const businessTables = databaseRestoreTableAllowlist.map((table) => {
      const columns = all<{ name: string }>(database, `PRAGMA table_info(${quoteSqlIdentifier(table)})`).map((column) => column.name);
      if (columns.length === 0) throw new AgentError('RECOVERY_FENCE');
      const rows = all<Record<string, SqlValue>>(database, `SELECT ${columns.map(quoteSqlIdentifier).join(',')} FROM ${quoteSqlIdentifier(table)}`)
        .map((row) => Object.freeze(Object.fromEntries(columns.map((column) => [column, normalizedSqlValue(row[column])]))) as Readonly<Record<string, unknown>>)
        .sort((left, right) => canonicalizeJson(left).localeCompare(canonicalizeJson(right)));
      return Object.freeze({ table, rows: Object.freeze(rows) });
    });
    const semantic = Object.freeze({
      schemaVersion: 1,
      operation: 'database.replace_from_import',
      operationId: manifest.operationId,
      ownerClientId: manifest.ownerClientId,
      assetId: manifest.package.assetId,
      version: Object.freeze({ ...version }),
      businessTables: Object.freeze(businessTables)
    });
    const canonical = canonicalizeJson(semantic);
    return Object.freeze({ contentHash: hashCanonicalJson(semantic), contentSize: Buffer.byteLength(canonical, 'utf8') });
  } finally {
    database.close();
  }
}

function databaseClearLiveSemanticEvidence(SQL: SqlJsStatic, bytes: Uint8Array, manifest: DatabaseClearManifest, expectedVersion: import('../../shared/agent').DataVersion): DatabaseClearFileEvidence {
  const opener = createSqlJsCandidateOpener(SQL);
  let inspected;
  try { inspected = inspectDatabaseBytes(bytes, { path: getPaths().database, kind: 'temp' }, opener, expectedVersion); } catch { throw new AgentError('RECOVERY_FENCE'); }
  if (inspected.status !== 'valid' || inspected.metadata !== 'present') throw new AgentError('RECOVERY_FENCE');
  const database = new SQL.Database(bytes);
  try {
    database.run('PRAGMA foreign_keys = ON;');
    database.exec(schemaSql);
    migrateDatabase(database);
    const version = new RevisionStore(database).readCurrentVersion();
    if (!sameVersion(version, expectedVersion)) throw new AgentError('RECOVERY_FENCE');
    const tableCounts = databaseClearTableAllowlist.map((table) => Object.freeze({
      table,
      count: Number(one<{ count: number }>(database, `SELECT COUNT(*) AS count FROM ${quoteSqlIdentifier(table)}`)?.count ?? -1)
    }));
    if (tableCounts.some((entry) => entry.count !== 0)) throw new AgentError('RECOVERY_FENCE');
    const semantic = Object.freeze({
      schemaVersion: 1,
      operation: 'database.clear_all',
      operationId: manifest.operationId,
      ownerClientId: manifest.ownerClientId,
      deleteManagedImages: manifest.deleteManagedImages,
      inventoryHash: manifest.inventoryHash,
      affectedSetHash: manifest.affectedSetHash,
      businessRowCount: manifest.businessRowCount,
      managedImageCount: manifest.managedImageCount,
      version: Object.freeze({ ...version }),
      tableCounts: Object.freeze(tableCounts)
    });
    const canonical = canonicalizeJson(semantic);
    return Object.freeze({ contentHash: hashCanonicalJson(semantic), contentSize: Buffer.byteLength(canonical, 'utf8') });
  } finally {
    database.close();
  }
}

function sameRestoreEvidence(left: DatabaseRestoreFileEvidence, right: DatabaseRestoreFileEvidence): boolean {
  return left.contentHash === right.contentHash && left.contentSize === right.contentSize;
}

function restoreResult(manifest: DatabaseRestoreManifest, versionAfter: import('../../shared/agent').DataVersion) {
  return Object.freeze({
    changed: true,
    value: Object.freeze({ backupId: manifest.backup.assetId, restored: true }),
    events: Object.freeze([]),
    dataVersion: Object.freeze({ ...versionAfter })
  });
}

function dataRootMigrationResult(manifest: DataRootMigrationManifest, versionAfter: import('../../shared/agent').DataVersion) {
  return Object.freeze({
    changed: true,
    value: Object.freeze({ rootSelectionId: manifest.selectionId, migrated: true, fileCount: manifest.inventoryCount, totalBytes: manifest.inventoryBytes }),
    events: Object.freeze([]),
    dataVersion: Object.freeze({ ...versionAfter })
  });
}

async function terminalizeRecoveredDataRootMigration(
  coordinator: DatabaseCoordinator,
  manifest: DataRootMigrationManifest,
  versionAfter: import('../../shared/agent').DataVersion,
  now: () => string
): Promise<void> {
  const controlCapability = createDatabaseCoordinatorControlCapability(coordinator);
  const executeControlWrite = <T>(request: import('../persistence/databaseCoordinator').DatabaseControlWriteRequest<T>) =>
    coordinator.executeControlWrite(controlCapability, request);
  const audit = new AuditLedger({ executeControlWrite, catalog: operationCatalogIdentity, now, randomUUID });
  const workflows = new WorkflowStore({ executeControlWrite, audit, now, randomUUID });
  const receipts = new ExecutionReceipts({ audit, workflows, now });
  const prepared = Object.freeze({
    receiptId: manifest.receiptId,
    clientId: manifest.ownerClientId,
    requestId: manifest.requestId,
    operation: manifest.receiptOperation,
    payloadHash: manifest.receiptPayloadHash,
    affectedSetHash: manifest.affectedSetHash,
    baseVersion: Object.freeze({ ...manifest.baseVersion }),
    catalog: Object.freeze({ ...manifest.catalog }),
    risk: 'R4' as const,
    createdAt: manifest.receiptCreatedAt,
    reservation: Object.freeze({
      apiVersion: 1 as const,
      reservationId: manifest.reservationId,
      grantId: manifest.grantId,
      clientId: manifest.ownerClientId,
      requestId: manifest.requestId,
      operation: 'data_root.migrate' as const,
      payloadHash: manifest.migratePayloadHash,
      affectedSetHash: manifest.affectedSetHash,
      baseVersion: Object.freeze({ ...manifest.baseVersion }),
      catalog: Object.freeze({ ...manifest.catalog }),
      reservedAt: manifest.reservedAt,
      expiresAt: manifest.reservationExpiresAt
    }),
    r4Authority: Object.freeze({
      grantId: manifest.grantId,
      targetHash: manifest.targetHash,
      recovery: manifest.recovery,
      maxAffectedEntities: manifest.maxAffectedEntities,
      reservationExpiresAt: manifest.reservationExpiresAt
    })
  });
  const changeSet = manifest.changeSetId ? Object.freeze({
    changeSetId: manifest.changeSetId,
    clientId: manifest.ownerClientId,
    operation: 'data_root.migrate' as const,
    payloadHash: manifest.migratePayloadHash,
    affectedSetHash: manifest.affectedSetHash,
    baseVersion: Object.freeze({ ...manifest.baseVersion }),
    catalog: Object.freeze({ ...manifest.catalog })
  }) : undefined;
  const result = dataRootMigrationResult(manifest, versionAfter);
  const terminalHook = receipts.createTerminalHook(prepared, { ...(changeSet ? { changeSet } : {}) });
  await coordinator.executeControlWrite(controlCapability, {
    requestId: `global-root-terminal-${manifest.operationId}`,
    execute: (database, scope) => {
      const existing = one<Record<string, SqlValue>>(database, 'SELECT status,terminal_outcome_hash FROM agent_idempotency WHERE receipt_id=?', [manifest.receiptId]);
      if (!existing) throw new AgentError('RECOVERY_FENCE');
      if (existing.status === 'completed') {
        if (existing.terminal_outcome_hash !== hashCanonicalJson(result)) throw new AgentError('RECOVERY_FENCE');
        return { changed: false, value: undefined };
      }
      terminalHook.execute(database, scope, {
        value: result,
        semanticChanged: true,
        versionBefore: manifest.baseVersion,
        versionAfter,
        generationBefore: coordinator.currentGeneration(),
        generationAfterDataMutation: coordinator.currentGeneration()
      });
      database.run(`INSERT OR REPLACE INTO agent_data_root_migration_journals (
        operation_id,owner_client_id,request_id,receipt_id,reservation_id,grant_id,change_set_id,selection_id,
        affected_entities_json,affected_set_hash,target_hash,inventory_hash,file_count,total_bytes,base_data_epoch,base_data_revision,
        catalog_version,catalog_hash,status,version_after_epoch,version_after_revision,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        manifest.operationId, manifest.ownerClientId, manifest.requestId, manifest.receiptId, manifest.reservationId,
        manifest.grantId, manifest.changeSetId ?? null, manifest.selectionId, canonicalizeJson(manifest.affectedEntities),
        manifest.affectedSetHash, manifest.targetHash, manifest.inventoryHash, manifest.inventoryCount, manifest.inventoryBytes,
        manifest.baseVersion.dataEpoch, manifest.baseVersion.dataRevision, manifest.catalog.version, manifest.catalog.hash,
        'completed', versionAfter.dataEpoch, versionAfter.dataRevision, manifest.createdAt, now()
      ]);
      const selection = getInternalGlobalAsset(database, manifest.selectionId);
      if (!selection || selection.kind !== 'root_selection' || selection.ownerClientId !== manifest.ownerClientId) throw new AgentError('RECOVERY_FENCE');
      if (selection.status === 'published') transitionGlobalAsset(database, manifest.selectionId, 'consumed', now(), { operationJournalId: manifest.operationId }, scope);
      else if (selection.status !== 'consumed') throw new AgentError('RECOVERY_FENCE');
      return { changed: true, value: undefined };
    }
  });
}

async function terminalizeRecoveredDatabaseRestore(
  coordinator: DatabaseCoordinator,
  manifest: DatabaseRestoreManifest,
  versionAfter: import('../../shared/agent').DataVersion,
  now: () => string
): Promise<boolean> {
  const controlCapability = createDatabaseCoordinatorControlCapability(coordinator);
  const executeControlWrite = <T>(request: import('../persistence/databaseCoordinator').DatabaseControlWriteRequest<T>) =>
    coordinator.executeControlWrite(controlCapability, request);
  const audit = new AuditLedger({ executeControlWrite, catalog: operationCatalogIdentity, now, randomUUID });
  const workflows = new WorkflowStore({ executeControlWrite, audit, now, randomUUID });
  const receipts = new ExecutionReceipts({ audit, workflows, now });
  const prepared = Object.freeze({
    receiptId: manifest.receiptId,
    clientId: manifest.ownerClientId,
    requestId: manifest.requestId,
    operation: manifest.receiptOperation,
    payloadHash: manifest.receiptPayloadHash,
    affectedSetHash: manifest.affectedSetHash,
    baseVersion: Object.freeze({ ...manifest.baseVersion }),
    catalog: Object.freeze({ ...manifest.catalog }),
    risk: manifest.risk,
    createdAt: manifest.receiptCreatedAt,
    reservation: Object.freeze({
      apiVersion: 1 as const,
      reservationId: manifest.reservationId,
      grantId: manifest.grantId,
      clientId: manifest.ownerClientId,
      requestId: manifest.requestId,
      operation: 'database.restore' as const,
      payloadHash: manifest.restorePayloadHash,
      affectedSetHash: manifest.affectedSetHash,
      baseVersion: Object.freeze({ ...manifest.baseVersion }),
      catalog: Object.freeze({ ...manifest.catalog }),
      reservedAt: manifest.reservedAt,
      expiresAt: manifest.reservationExpiresAt
    }),
    r4Authority: Object.freeze({
      grantId: manifest.grantId,
      targetHash: manifest.targetHash,
      recovery: manifest.recovery,
      maxAffectedEntities: manifest.maxAffectedEntities,
      reservationExpiresAt: manifest.reservationExpiresAt
    })
  });
  const changeSet = manifest.changeSetId ? Object.freeze({
    changeSetId: manifest.changeSetId,
    clientId: manifest.ownerClientId,
    operation: 'database.restore' as const,
    payloadHash: manifest.restorePayloadHash,
    affectedSetHash: manifest.affectedSetHash,
    baseVersion: Object.freeze({ ...manifest.baseVersion }),
    catalog: Object.freeze({ ...manifest.catalog })
  }) : undefined;
  const result = restoreResult(manifest, versionAfter);
  const terminalHook = receipts.createTerminalHook(prepared, {
    ...(changeSet ? { changeSet } : {})
  });
  const terminal = await coordinator.executeControlWrite(controlCapability, {
    requestId: `global-restore-terminal-${manifest.operationId}`,
    execute: (database, scope) => {
      const row = one<{ status: string; terminal_outcome_hash?: string }>(database, 'SELECT status,terminal_outcome_hash FROM agent_idempotency WHERE receipt_id=?', [manifest.receiptId]);
      if (!row) throw new AgentError('RECOVERY_FENCE');
      if (row.status === 'completed') {
        if (row.terminal_outcome_hash !== hashCanonicalJson(result)) throw new AgentError('RECOVERY_FENCE');
        return { changed: false, value: false };
      }
      terminalHook.execute(database, scope, {
        value: result,
        semanticChanged: true,
        versionBefore: manifest.baseVersion,
        versionAfter,
        generationBefore: coordinator.currentGeneration(),
        generationAfterDataMutation: coordinator.currentGeneration()
      });
      database.run(`INSERT OR REPLACE INTO agent_database_restore_journals (
        operation_id, owner_client_id, request_id, receipt_id, reservation_id, grant_id, change_set_id, asset_id,
        affected_set_hash, target_hash, backup_content_hash, backup_content_size, base_data_epoch, base_data_revision,
        catalog_version, catalog_hash, status, version_after_epoch, version_after_revision, recovery_database_path,
        created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        manifest.operationId, manifest.ownerClientId, manifest.requestId, manifest.receiptId, manifest.reservationId, manifest.grantId,
        manifest.changeSetId ?? null, manifest.backup.assetId, manifest.affectedSetHash, manifest.targetHash, manifest.backup.contentHash,
        manifest.backup.contentSize, manifest.baseVersion.dataEpoch, manifest.baseVersion.dataRevision, manifest.catalog.version,
        manifest.catalog.hash, 'completed', versionAfter.dataEpoch, versionAfter.dataRevision, manifest.recoveryDatabasePath!,
        manifest.createdAt, now()
      ]);
      return { changed: true, value: true };
    }
  });
  return terminal.value;
}

async function verifyCompletedDatabaseRestore(
  coordinator: DatabaseCoordinator,
  manifest: DatabaseRestoreManifest,
  now: () => string
): Promise<void> {
  if (!manifest.versionAfter) throw new AgentError('RECOVERY_FENCE');
  const current = coordinator.currentVersion();
  if (current.dataEpoch !== manifest.versionAfter.dataEpoch || current.dataRevision < manifest.versionAfter.dataRevision) throw new AgentError('RECOVERY_FENCE');
  const expectedResultHash = hashCanonicalJson(restoreResult(manifest, manifest.versionAfter));
  const database = db;
  if (!database) throw new AgentError('RECOVERY_FENCE');
  const receipt = one<Record<string, SqlValue>>(database, `SELECT status,terminal_outcome_hash,reservation_id,grant_id,operation,payload_hash,affected_set_hash
    FROM agent_idempotency WHERE receipt_id=? AND client_id=? AND request_id=?`, [manifest.receiptId, manifest.ownerClientId, manifest.requestId]);
  if (!receipt || receipt.status !== 'completed' || receipt.terminal_outcome_hash !== expectedResultHash ||
      receipt.reservation_id !== manifest.reservationId || receipt.grant_id !== manifest.grantId ||
      receipt.operation !== manifest.receiptOperation || receipt.payload_hash !== manifest.receiptPayloadHash ||
      receipt.affected_set_hash !== manifest.affectedSetHash) throw new AgentError('RECOVERY_FENCE');
  const grant = one<Record<string, SqlValue>>(database, `SELECT status,reservation_id,operation,reserved_payload_hash,reserved_affected_set_hash,
      reserved_base_epoch,reserved_base_revision,reserved_catalog_version,reserved_catalog_hash,target_hash
    FROM agent_r4_grants WHERE grant_id=?`, [manifest.grantId]);
  if (!grant || grant.status !== 'consumed' || grant.reservation_id !== manifest.reservationId || grant.operation !== 'database.restore' ||
      grant.reserved_payload_hash !== manifest.restorePayloadHash || grant.reserved_affected_set_hash !== manifest.affectedSetHash ||
      grant.reserved_base_epoch !== manifest.baseVersion.dataEpoch || grant.reserved_base_revision !== manifest.baseVersion.dataRevision ||
      grant.reserved_catalog_version !== manifest.catalog.version || grant.reserved_catalog_hash !== manifest.catalog.hash ||
      grant.target_hash !== manifest.targetHash) throw new AgentError('RECOVERY_FENCE');
  if (manifest.changeSetId) {
    const changeSet = one<Record<string, SqlValue>>(database, `SELECT c.status,c.client_id,c.affected_set_hash,c.base_data_epoch,c.base_data_revision,
        c.catalog_version,c.catalog_hash,o.operation,o.payload_hash
      FROM agent_changesets c INNER JOIN agent_changeset_operations o ON o.change_set_id=c.change_set_id
      WHERE c.change_set_id=?`, [manifest.changeSetId]);
    if (!changeSet || changeSet.status !== 'applied' || changeSet.client_id !== manifest.ownerClientId ||
        changeSet.affected_set_hash !== manifest.affectedSetHash || changeSet.base_data_epoch !== manifest.baseVersion.dataEpoch ||
        changeSet.base_data_revision !== manifest.baseVersion.dataRevision || changeSet.catalog_version !== manifest.catalog.version ||
        changeSet.catalog_hash !== manifest.catalog.hash || changeSet.operation !== 'database.restore' ||
        changeSet.payload_hash !== manifest.restorePayloadHash) throw new AgentError('RECOVERY_FENCE');
  }
  const journal = one<Record<string, SqlValue>>(database, `SELECT status,receipt_id,reservation_id,grant_id,asset_id,affected_set_hash,target_hash,
      backup_content_hash,backup_content_size,version_after_epoch,version_after_revision,recovery_database_path
    FROM agent_database_restore_journals WHERE operation_id=?`, [manifest.operationId]);
  if (!journal || journal.status !== 'completed' || journal.receipt_id !== manifest.receiptId ||
      journal.reservation_id !== manifest.reservationId || journal.grant_id !== manifest.grantId ||
      journal.asset_id !== manifest.backup.assetId || journal.affected_set_hash !== manifest.affectedSetHash ||
      journal.target_hash !== manifest.targetHash || journal.backup_content_hash !== manifest.backup.contentHash ||
      journal.backup_content_size !== manifest.backup.contentSize || journal.version_after_epoch !== manifest.versionAfter.dataEpoch ||
      journal.version_after_revision !== manifest.versionAfter.dataRevision || journal.recovery_database_path !== manifest.recoveryDatabasePath) throw new AgentError('RECOVERY_FENCE');
  const controlCapability = createDatabaseCoordinatorControlCapability(coordinator);
  const executeControlWrite = <T>(request: import('../persistence/databaseCoordinator').DatabaseControlWriteRequest<T>) =>
    coordinator.executeControlWrite(controlCapability, request);
  const audit = new AuditLedger({ executeControlWrite, catalog: operationCatalogIdentity, now, randomUUID });
  const verification = await audit.verify();
  if (!verification.valid) throw new AgentError('RECOVERY_FENCE');
  const terminalAudit = one<Record<string, SqlValue>>(database, `SELECT kind FROM agent_audit_events
    WHERE kind='success' AND receipt_id=? AND client_id=? AND request_id=? AND operation=?`, [
    manifest.receiptId, manifest.ownerClientId, manifest.requestId, manifest.receiptOperation
  ]);
  if (!terminalAudit) throw new AgentError('RECOVERY_FENCE');
}

function databaseImportResult(manifest: DatabaseImportManifest, versionAfter: import('../../shared/agent').DataVersion) {
  return Object.freeze({
    changed: true,
    value: Object.freeze({ importAssetId: manifest.package.assetId, replaced: true }),
    events: Object.freeze([]),
    dataVersion: Object.freeze({ ...versionAfter })
  });
}

function verifyDatabaseImportPackageManifest(manifest: DatabaseImportManifest): ParsedDatabaseImportPackage {
  const importsRoot = path.normalize(path.join(getPaths().data, 'managed-database-imports'));
  const verified = verifyManagedDatabaseImport(manifest.package.internalPath, importsRoot, { hash: manifest.package.contentHash, size: manifest.package.contentSize });
  const parsed = parseDatabaseImportPackage(verified.bytes);
  if (parsed.metadata.semanticHash !== manifest.package.semanticHash || parsed.metadata.rowCount !== manifest.package.rowCount) throw new AgentError('RECOVERY_FENCE');
  return parsed;
}

async function terminalizeRecoveredDatabaseImport(
  coordinator: DatabaseCoordinator,
  manifest: DatabaseImportManifest,
  versionAfter: import('../../shared/agent').DataVersion,
  now: () => string
): Promise<void> {
  const controlCapability = createDatabaseCoordinatorControlCapability(coordinator);
  const executeControlWrite = <T>(request: import('../persistence/databaseCoordinator').DatabaseControlWriteRequest<T>) => coordinator.executeControlWrite(controlCapability, request);
  const audit = new AuditLedger({ executeControlWrite, catalog: operationCatalogIdentity, now, randomUUID });
  const workflows = new WorkflowStore({ executeControlWrite, audit, now, randomUUID });
  const receipts = new ExecutionReceipts({ audit, workflows, now });
  const prepared = Object.freeze({
    receiptId: manifest.receiptId,
    clientId: manifest.ownerClientId,
    requestId: manifest.requestId,
    operation: manifest.receiptOperation,
    payloadHash: manifest.receiptPayloadHash,
    affectedSetHash: manifest.affectedSetHash,
    baseVersion: Object.freeze({ ...manifest.baseVersion }),
    catalog: Object.freeze({ ...manifest.catalog }),
    risk: manifest.risk,
    createdAt: manifest.receiptCreatedAt,
    reservation: Object.freeze({
      apiVersion: 1 as const,
      reservationId: manifest.reservationId,
      grantId: manifest.grantId,
      clientId: manifest.ownerClientId,
      requestId: manifest.requestId,
      operation: 'database.replace_from_import' as const,
      payloadHash: manifest.importPayloadHash,
      affectedSetHash: manifest.affectedSetHash,
      baseVersion: Object.freeze({ ...manifest.baseVersion }),
      catalog: Object.freeze({ ...manifest.catalog }),
      reservedAt: manifest.reservedAt,
      expiresAt: manifest.reservationExpiresAt
    }),
    r4Authority: Object.freeze({
      grantId: manifest.grantId,
      targetHash: manifest.targetHash,
      recovery: manifest.recovery,
      maxAffectedEntities: manifest.maxAffectedEntities,
      reservationExpiresAt: manifest.reservationExpiresAt
    })
  });
  const changeSet = manifest.changeSetId ? Object.freeze({
    changeSetId: manifest.changeSetId,
    clientId: manifest.ownerClientId,
    operation: 'database.replace_from_import' as const,
    payloadHash: manifest.importPayloadHash,
    affectedSetHash: manifest.affectedSetHash,
    baseVersion: Object.freeze({ ...manifest.baseVersion }),
    catalog: Object.freeze({ ...manifest.catalog })
  }) : undefined;
  const result = databaseImportResult(manifest, versionAfter);
  const terminalHook = receipts.createTerminalHook(prepared, { ...(changeSet ? { changeSet } : {}) });
  await coordinator.executeControlWrite(controlCapability, {
    requestId: `global-import-terminal-${manifest.operationId}`,
    execute: async (database, scope) => {
      const receipt = one<{ status: string; terminal_outcome_hash?: string }>(database, 'SELECT status,terminal_outcome_hash FROM agent_idempotency WHERE receipt_id=?', [manifest.receiptId]);
      if (!receipt) throw new AgentError('RECOVERY_FENCE');
      if (receipt.status === 'completed') {
        const journal = one<{ status: string }>(database, 'SELECT status FROM agent_database_import_journals WHERE operation_id=?', [manifest.operationId]);
        const asset = getInternalGlobalAsset(database, manifest.package.assetId);
        if (receipt.terminal_outcome_hash !== hashCanonicalJson(result) || journal?.status !== 'completed' || asset?.status !== 'consumed') throw new AgentError('RECOVERY_FENCE');
        return { changed: false, value: undefined };
      }
      const asset = getInternalGlobalAsset(database, manifest.package.assetId);
      if (!asset || asset.ownerClientId !== manifest.ownerClientId || asset.kind !== 'database_import' || asset.status !== 'published' ||
          asset.contentHash !== manifest.package.contentHash || asset.contentSize !== manifest.package.contentSize || asset.internalPath !== manifest.package.internalPath) throw new AgentError('RECOVERY_FENCE');
      await terminalHook.execute(database, scope, {
        value: result,
        semanticChanged: true,
        versionBefore: manifest.baseVersion,
        versionAfter,
        generationBefore: coordinator.currentGeneration(),
        generationAfterDataMutation: coordinator.currentGeneration()
      });
      transitionGlobalAsset(database, manifest.package.assetId, 'consumed', now(), {}, scope);
      database.run(`INSERT INTO agent_database_import_journals (
        operation_id,owner_client_id,request_id,receipt_id,reservation_id,grant_id,change_set_id,asset_id,
        affected_set_hash,target_hash,package_content_hash,package_content_size,package_semantic_hash,package_row_count,
        live_semantic_hash,live_semantic_size,base_data_epoch,base_data_revision,catalog_version,catalog_hash,status,
        version_after_epoch,version_after_revision,recovery_database_path,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        manifest.operationId, manifest.ownerClientId, manifest.requestId, manifest.receiptId, manifest.reservationId, manifest.grantId,
        manifest.changeSetId ?? null, manifest.package.assetId, manifest.affectedSetHash, manifest.targetHash, manifest.package.contentHash,
        manifest.package.contentSize, manifest.package.semanticHash, manifest.package.rowCount, manifest.liveDatabaseEvidence!.contentHash,
        manifest.liveDatabaseEvidence!.contentSize, manifest.baseVersion.dataEpoch, manifest.baseVersion.dataRevision, manifest.catalog.version,
        manifest.catalog.hash, 'completed', versionAfter.dataEpoch, versionAfter.dataRevision, manifest.recoveryDatabasePath!, manifest.createdAt, now()
      ]);
      return { changed: true, value: undefined };
    }
  });
}

async function verifyCompletedDatabaseImport(
  coordinator: DatabaseCoordinator,
  SQL: SqlJsStatic,
  manifest: DatabaseImportManifest,
  now: () => string
): Promise<void> {
  if (!manifest.versionAfter || !manifest.liveDatabaseEvidence) throw new AgentError('RECOVERY_FENCE');
  verifyDatabaseImportPackageManifest(manifest);
  const current = coordinator.currentVersion();
  if (current.dataEpoch !== manifest.versionAfter.dataEpoch || current.dataRevision < manifest.versionAfter.dataRevision) throw new AgentError('RECOVERY_FENCE');
  if (current.dataRevision === manifest.versionAfter.dataRevision && !sameRestoreEvidence(
    databaseImportLiveSemanticEvidence(SQL, fs.readFileSync(getPaths().database), manifest, manifest.versionAfter), manifest.liveDatabaseEvidence
  )) throw new AgentError('RECOVERY_FENCE');
  const database = db;
  if (!database) throw new AgentError('RECOVERY_FENCE');
  const resultHash = hashCanonicalJson(databaseImportResult(manifest, manifest.versionAfter));
  const receipt = one<Record<string, SqlValue>>(database, `SELECT status,terminal_outcome_hash,reservation_id,grant_id,operation,payload_hash,affected_set_hash
    FROM agent_idempotency WHERE receipt_id=? AND client_id=? AND request_id=?`, [manifest.receiptId, manifest.ownerClientId, manifest.requestId]);
  if (!receipt || receipt.status !== 'completed' || receipt.terminal_outcome_hash !== resultHash || receipt.reservation_id !== manifest.reservationId ||
      receipt.grant_id !== manifest.grantId || receipt.operation !== manifest.receiptOperation || receipt.payload_hash !== manifest.receiptPayloadHash ||
      receipt.affected_set_hash !== manifest.affectedSetHash) throw new AgentError('RECOVERY_FENCE');
  const grant = one<Record<string, SqlValue>>(database, `SELECT status,reservation_id,operation,reserved_payload_hash,reserved_affected_set_hash,
      reserved_base_epoch,reserved_base_revision,reserved_catalog_version,reserved_catalog_hash,target_hash FROM agent_r4_grants WHERE grant_id=?`, [manifest.grantId]);
  if (!grant || grant.status !== 'consumed' || grant.reservation_id !== manifest.reservationId || grant.operation !== 'database.replace_from_import' ||
      grant.reserved_payload_hash !== manifest.importPayloadHash || grant.reserved_affected_set_hash !== manifest.affectedSetHash ||
      grant.reserved_base_epoch !== manifest.baseVersion.dataEpoch || grant.reserved_base_revision !== manifest.baseVersion.dataRevision ||
      grant.reserved_catalog_version !== manifest.catalog.version || grant.reserved_catalog_hash !== manifest.catalog.hash || grant.target_hash !== manifest.targetHash) throw new AgentError('RECOVERY_FENCE');
  if (manifest.changeSetId) {
    const changeSet = one<Record<string, SqlValue>>(database, `SELECT c.status,c.client_id,c.affected_set_hash,c.base_data_epoch,c.base_data_revision,
        c.catalog_version,c.catalog_hash,o.operation,o.payload_hash FROM agent_changesets c INNER JOIN agent_changeset_operations o ON o.change_set_id=c.change_set_id
      WHERE c.change_set_id=?`, [manifest.changeSetId]);
    if (!changeSet || changeSet.status !== 'applied' || changeSet.client_id !== manifest.ownerClientId || changeSet.affected_set_hash !== manifest.affectedSetHash ||
        changeSet.base_data_epoch !== manifest.baseVersion.dataEpoch || changeSet.base_data_revision !== manifest.baseVersion.dataRevision ||
        changeSet.catalog_version !== manifest.catalog.version || changeSet.catalog_hash !== manifest.catalog.hash ||
        changeSet.operation !== 'database.replace_from_import' || changeSet.payload_hash !== manifest.importPayloadHash) throw new AgentError('RECOVERY_FENCE');
  }
  const asset = getInternalGlobalAsset(database, manifest.package.assetId);
  const journal = one<Record<string, SqlValue>>(database, `SELECT * FROM agent_database_import_journals WHERE operation_id=?`, [manifest.operationId]);
  if (!asset || asset.status !== 'consumed' || asset.ownerClientId !== manifest.ownerClientId || asset.kind !== 'database_import' ||
      !journal || journal.status !== 'completed' || journal.receipt_id !== manifest.receiptId || journal.reservation_id !== manifest.reservationId ||
      journal.grant_id !== manifest.grantId || journal.asset_id !== manifest.package.assetId || journal.affected_set_hash !== manifest.affectedSetHash ||
      journal.target_hash !== manifest.targetHash || journal.package_content_hash !== manifest.package.contentHash || journal.package_content_size !== manifest.package.contentSize ||
      journal.package_semantic_hash !== manifest.package.semanticHash || journal.package_row_count !== manifest.package.rowCount ||
      journal.live_semantic_hash !== manifest.liveDatabaseEvidence.contentHash || journal.live_semantic_size !== manifest.liveDatabaseEvidence.contentSize ||
      journal.version_after_epoch !== manifest.versionAfter.dataEpoch || journal.version_after_revision !== manifest.versionAfter.dataRevision ||
      journal.recovery_database_path !== manifest.recoveryDatabasePath) throw new AgentError('RECOVERY_FENCE');
  const controlCapability = createDatabaseCoordinatorControlCapability(coordinator);
  const executeControlWrite = <T>(request: import('../persistence/databaseCoordinator').DatabaseControlWriteRequest<T>) => coordinator.executeControlWrite(controlCapability, request);
  const audit = new AuditLedger({ executeControlWrite, catalog: operationCatalogIdentity, now, randomUUID });
  if (!(await audit.verify()).valid) throw new AgentError('RECOVERY_FENCE');
  const terminalAudit = one<Record<string, SqlValue>>(database, "SELECT kind FROM agent_audit_events WHERE kind='success' AND receipt_id=? AND client_id=? AND request_id=? AND operation=?", [
    manifest.receiptId, manifest.ownerClientId, manifest.requestId, manifest.receiptOperation
  ]);
  if (!terminalAudit) throw new AgentError('RECOVERY_FENCE');
}

function databaseClearResult(manifest: DatabaseClearManifest, versionAfter: import('../../shared/agent').DataVersion) {
  return Object.freeze({
    changed: true,
    value: Object.freeze({
      cleared: true as const,
      deleteManagedImages: manifest.deleteManagedImages,
      businessRowCount: manifest.businessRowCount,
      managedImageCount: manifest.managedImageCount
    }),
    events: Object.freeze([]),
    dataVersion: Object.freeze({ ...versionAfter })
  });
}

function clearQuarantinePath(operationId: string, index: number): string {
  return path.normalize(path.join(getPaths().temp, 'a11-quarantine', `${operationId}-${index}.quarantine`));
}

function assertClearPrivateFilePath(file: DatabaseClearManagedFile): void {
  const root = file.sourceKind === 'question_image' ? path.normalize(getPaths().images) : managedImportInboxRoot();
  const relative = path.relative(root, file.internalPath);
  if (!path.isAbsolute(file.internalPath) || path.normalize(file.internalPath) !== file.internalPath || !relative ||
      relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
      hashCanonicalJson({ root: file.sourceKind, relativePath: relative.replaceAll(path.sep, '/') }) !== file.pathHash) throw new AgentError('RECOVERY_FENCE');
}

function verifyDatabaseClearFiles(manifest: DatabaseClearManifest, verifyPreservedSources: boolean): void {
  manifest.managedFiles.forEach((file, index) => {
    assertClearPrivateFilePath(file);
    const quarantinePath = clearQuarantinePath(manifest.operationId, index);
    if (manifest.deleteManagedImages) {
      if (fs.existsSync(file.internalPath) || !fs.existsSync(quarantinePath) ||
          !sameRestoreEvidence(restoreEvidence(quarantinePath), { contentHash: file.contentHash, contentSize: file.contentSize })) {
        throw new AgentError('RECOVERY_FENCE');
      }
      const quarantineStat = fs.lstatSync(quarantinePath);
      if (quarantineStat.isSymbolicLink() || !quarantineStat.isFile()) throw new AgentError('RECOVERY_FENCE');
      const quarantineRoot = path.normalize(path.join(getPaths().temp, 'a11-quarantine'));
      const realRoot = path.normalize(fs.realpathSync(quarantineRoot));
      const realFile = path.normalize(fs.realpathSync(quarantinePath));
      if (!isSameOrDescendant(realFile, realRoot) || realFile === realRoot) throw new AgentError('RECOVERY_FENCE');
    } else if (verifyPreservedSources) {
      const root = file.sourceKind === 'question_image' ? path.normalize(getPaths().images) : managedImportInboxRoot();
      const verified = strictManagedClearFile({
        sourceKind: file.sourceKind,
        binding: Object.freeze({ fileId: file.fileId }),
        reference: file.internalPath,
        root,
        expectedHash: file.contentHash,
        expectedSize: file.contentSize
      });
      if (verified.pathHash !== file.pathHash || fs.existsSync(quarantinePath)) throw new AgentError('RECOVERY_FENCE');
    }
  });
}

function verifyDatabaseClearRecoveryPackage(manifest: DatabaseClearManifest): void {
  if (!manifest.recoveryDatabasePath || !manifest.recoveryDatabaseEvidence || !manifest.recoveryInventoryPath || !manifest.recoveryInventoryEvidence ||
      !fs.existsSync(manifest.recoveryDatabasePath) || !fs.existsSync(manifest.recoveryInventoryPath) ||
      !sameRestoreEvidence(restoreEvidence(manifest.recoveryDatabasePath), manifest.recoveryDatabaseEvidence) ||
      !sameRestoreEvidence(restoreEvidence(manifest.recoveryInventoryPath), manifest.recoveryInventoryEvidence)) throw new AgentError('RECOVERY_FENCE');
}

async function terminalizeRecoveredDatabaseClear(
  coordinator: DatabaseCoordinator,
  manifest: DatabaseClearManifest,
  versionAfter: import('../../shared/agent').DataVersion,
  now: () => string
): Promise<void> {
  const controlCapability = createDatabaseCoordinatorControlCapability(coordinator);
  const executeControlWrite = <T>(request: import('../persistence/databaseCoordinator').DatabaseControlWriteRequest<T>) => coordinator.executeControlWrite(controlCapability, request);
  const audit = new AuditLedger({ executeControlWrite, catalog: operationCatalogIdentity, now, randomUUID });
  const workflows = new WorkflowStore({ executeControlWrite, audit, now, randomUUID });
  const receipts = new ExecutionReceipts({ audit, workflows, now });
  const prepared = Object.freeze({
    receiptId: manifest.receiptId,
    clientId: manifest.ownerClientId,
    requestId: manifest.requestId,
    operation: manifest.receiptOperation,
    payloadHash: manifest.receiptPayloadHash,
    affectedSetHash: manifest.affectedSetHash,
    baseVersion: Object.freeze({ ...manifest.baseVersion }),
    catalog: Object.freeze({ ...manifest.catalog }),
    risk: manifest.risk,
    createdAt: manifest.receiptCreatedAt,
    reservation: Object.freeze({
      apiVersion: 1 as const,
      reservationId: manifest.reservationId,
      grantId: manifest.grantId,
      clientId: manifest.ownerClientId,
      requestId: manifest.requestId,
      operation: 'database.clear_all' as const,
      payloadHash: manifest.clearPayloadHash,
      affectedSetHash: manifest.affectedSetHash,
      baseVersion: Object.freeze({ ...manifest.baseVersion }),
      catalog: Object.freeze({ ...manifest.catalog }),
      reservedAt: manifest.reservedAt,
      expiresAt: manifest.reservationExpiresAt
    }),
    r4Authority: Object.freeze({
      grantId: manifest.grantId,
      targetHash: manifest.targetHash,
      recovery: manifest.recovery,
      maxAffectedEntities: manifest.maxAffectedEntities,
      reservationExpiresAt: manifest.reservationExpiresAt
    })
  });
  const changeSet = manifest.changeSetId ? Object.freeze({
    changeSetId: manifest.changeSetId,
    clientId: manifest.ownerClientId,
    operation: 'database.clear_all' as const,
    payloadHash: manifest.clearPayloadHash,
    affectedSetHash: manifest.affectedSetHash,
    baseVersion: Object.freeze({ ...manifest.baseVersion }),
    catalog: Object.freeze({ ...manifest.catalog })
  }) : undefined;
  const result = databaseClearResult(manifest, versionAfter);
  const terminalHook = receipts.createTerminalHook(prepared, { ...(changeSet ? { changeSet } : {}) });
  await coordinator.executeControlWrite(controlCapability, {
    requestId: `global-clear-terminal-${manifest.operationId}`,
    execute: async (database, scope) => {
      const receipt = one<{ status: string; terminal_outcome_hash?: string }>(database, 'SELECT status,terminal_outcome_hash FROM agent_idempotency WHERE receipt_id=?', [manifest.receiptId]);
      if (!receipt) throw new AgentError('RECOVERY_FENCE');
      if (receipt.status === 'completed') {
        const journal = one<{ status: string }>(database, 'SELECT status FROM agent_database_clear_journals WHERE operation_id=?', [manifest.operationId]);
        if (receipt.terminal_outcome_hash !== hashCanonicalJson(result) || journal?.status !== 'completed') throw new AgentError('RECOVERY_FENCE');
        return { changed: false, value: undefined };
      }
      await terminalHook.execute(database, scope, {
        value: result,
        semanticChanged: true,
        versionBefore: manifest.baseVersion,
        versionAfter,
        generationBefore: coordinator.currentGeneration(),
        generationAfterDataMutation: coordinator.currentGeneration()
      });
      database.run(`INSERT INTO agent_database_clear_journals (
        operation_id,owner_client_id,request_id,receipt_id,reservation_id,grant_id,change_set_id,delete_managed_images,
        business_row_count,managed_image_count,affected_entity_count,inventory_hash,affected_set_hash,target_hash,
        live_semantic_hash,live_semantic_size,base_data_epoch,base_data_revision,catalog_version,catalog_hash,status,
        version_after_epoch,version_after_revision,recovery_database_path,recovery_inventory_path,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        manifest.operationId, manifest.ownerClientId, manifest.requestId, manifest.receiptId, manifest.reservationId, manifest.grantId,
        manifest.changeSetId ?? null, manifest.deleteManagedImages ? 1 : 0, manifest.businessRowCount, manifest.managedImageCount,
        manifest.affectedEntityCount, manifest.inventoryHash, manifest.affectedSetHash, manifest.targetHash,
        manifest.liveDatabaseEvidence!.contentHash, manifest.liveDatabaseEvidence!.contentSize,
        manifest.baseVersion.dataEpoch, manifest.baseVersion.dataRevision, manifest.catalog.version, manifest.catalog.hash, 'completed',
        versionAfter.dataEpoch, versionAfter.dataRevision, manifest.recoveryDatabasePath!, manifest.recoveryInventoryPath!, manifest.createdAt, now()
      ]);
      return { changed: true, value: undefined };
    }
  });
}

async function verifyCompletedDatabaseClear(
  coordinator: DatabaseCoordinator,
  SQL: SqlJsStatic,
  manifest: DatabaseClearManifest,
  now: () => string
): Promise<void> {
  if (!manifest.versionAfter || !manifest.liveDatabaseEvidence) throw new AgentError('RECOVERY_FENCE');
  verifyDatabaseClearRecoveryPackage(manifest);
  const current = coordinator.currentVersion();
  if (current.dataEpoch !== manifest.versionAfter.dataEpoch || current.dataRevision < manifest.versionAfter.dataRevision) throw new AgentError('RECOVERY_FENCE');
  const sameClearVersion = current.dataRevision === manifest.versionAfter.dataRevision;
  verifyDatabaseClearFiles(manifest, sameClearVersion);
  if (sameClearVersion && !sameRestoreEvidence(
    databaseClearLiveSemanticEvidence(SQL, fs.readFileSync(getPaths().database), manifest, manifest.versionAfter), manifest.liveDatabaseEvidence
  )) throw new AgentError('RECOVERY_FENCE');
  const database = db;
  if (!database) throw new AgentError('RECOVERY_FENCE');
  const resultHash = hashCanonicalJson(databaseClearResult(manifest, manifest.versionAfter));
  const receipt = one<Record<string, SqlValue>>(database, `SELECT status,terminal_outcome_hash,reservation_id,grant_id,operation,payload_hash,affected_set_hash
    FROM agent_idempotency WHERE receipt_id=? AND client_id=? AND request_id=?`, [manifest.receiptId, manifest.ownerClientId, manifest.requestId]);
  if (!receipt || receipt.status !== 'completed' || receipt.terminal_outcome_hash !== resultHash || receipt.reservation_id !== manifest.reservationId ||
      receipt.grant_id !== manifest.grantId || receipt.operation !== manifest.receiptOperation || receipt.payload_hash !== manifest.receiptPayloadHash ||
      receipt.affected_set_hash !== manifest.affectedSetHash) throw new AgentError('RECOVERY_FENCE');
  const grant = one<Record<string, SqlValue>>(database, `SELECT status,reservation_id,operation,reserved_payload_hash,reserved_affected_set_hash,
      reserved_base_epoch,reserved_base_revision,reserved_catalog_version,reserved_catalog_hash,target_hash FROM agent_r4_grants WHERE grant_id=?`, [manifest.grantId]);
  if (!grant || grant.status !== 'consumed' || grant.reservation_id !== manifest.reservationId || grant.operation !== 'database.clear_all' ||
      grant.reserved_payload_hash !== manifest.clearPayloadHash || grant.reserved_affected_set_hash !== manifest.affectedSetHash ||
      grant.reserved_base_epoch !== manifest.baseVersion.dataEpoch || grant.reserved_base_revision !== manifest.baseVersion.dataRevision ||
      grant.reserved_catalog_version !== manifest.catalog.version || grant.reserved_catalog_hash !== manifest.catalog.hash || grant.target_hash !== manifest.targetHash) {
    throw new AgentError('RECOVERY_FENCE');
  }
  if (manifest.changeSetId) {
    const changeSet = one<Record<string, SqlValue>>(database, `SELECT c.status,c.client_id,c.affected_set_hash,c.base_data_epoch,c.base_data_revision,
        c.catalog_version,c.catalog_hash,o.operation,o.payload_hash FROM agent_changesets c INNER JOIN agent_changeset_operations o ON o.change_set_id=c.change_set_id
      WHERE c.change_set_id=?`, [manifest.changeSetId]);
    if (!changeSet || changeSet.status !== 'applied' || changeSet.client_id !== manifest.ownerClientId ||
        changeSet.affected_set_hash !== manifest.affectedSetHash || changeSet.base_data_epoch !== manifest.baseVersion.dataEpoch ||
        changeSet.base_data_revision !== manifest.baseVersion.dataRevision || changeSet.catalog_version !== manifest.catalog.version ||
        changeSet.catalog_hash !== manifest.catalog.hash || changeSet.operation !== 'database.clear_all' || changeSet.payload_hash !== manifest.clearPayloadHash) {
      throw new AgentError('RECOVERY_FENCE');
    }
  }
  const journal = one<Record<string, SqlValue>>(database, 'SELECT * FROM agent_database_clear_journals WHERE operation_id=?', [manifest.operationId]);
  if (!journal || journal.status !== 'completed' || journal.receipt_id !== manifest.receiptId || journal.reservation_id !== manifest.reservationId ||
      journal.grant_id !== manifest.grantId || Number(journal.delete_managed_images) !== Number(manifest.deleteManagedImages) ||
      journal.business_row_count !== manifest.businessRowCount || journal.managed_image_count !== manifest.managedImageCount ||
      journal.affected_entity_count !== manifest.affectedEntityCount || journal.inventory_hash !== manifest.inventoryHash ||
      journal.affected_set_hash !== manifest.affectedSetHash || journal.target_hash !== manifest.targetHash ||
      journal.live_semantic_hash !== manifest.liveDatabaseEvidence.contentHash || journal.live_semantic_size !== manifest.liveDatabaseEvidence.contentSize ||
      journal.version_after_epoch !== manifest.versionAfter.dataEpoch || journal.version_after_revision !== manifest.versionAfter.dataRevision ||
      journal.recovery_database_path !== manifest.recoveryDatabasePath || journal.recovery_inventory_path !== manifest.recoveryInventoryPath) {
    throw new AgentError('RECOVERY_FENCE');
  }
  const controlCapability = createDatabaseCoordinatorControlCapability(coordinator);
  const executeControlWrite = <T>(request: import('../persistence/databaseCoordinator').DatabaseControlWriteRequest<T>) => coordinator.executeControlWrite(controlCapability, request);
  const audit = new AuditLedger({ executeControlWrite, catalog: operationCatalogIdentity, now, randomUUID });
  if (!(await audit.verify()).valid) throw new AgentError('RECOVERY_FENCE');
  const terminalAudit = one<Record<string, SqlValue>>(database, "SELECT kind FROM agent_audit_events WHERE kind='success' AND receipt_id=? AND client_id=? AND request_id=? AND operation=?", [
    manifest.receiptId, manifest.ownerClientId, manifest.requestId, manifest.receiptOperation
  ]);
  if (!terminalAudit) throw new AgentError('RECOVERY_FENCE');
}

function importBatchDeletionResult(manifest: ImportBatchDeletionManifest, versionAfter: import('../../shared/agent').DataVersion) {
  return Object.freeze({
    changed: true,
    value: Object.freeze({
      batchId: manifest.batchId,
      status: 'deleted' as const,
      deleteManagedAssets: manifest.deleteManagedAssets,
      deletedQuestions: manifest.deletedQuestionCount,
      deletedExternalQuestions: manifest.deletedExternalQuestionCount,
      deletedAttempts: manifest.deletedAttemptCount,
      softDeletedKnowledgePoints: manifest.softDeletedKnowledgeCount,
      quarantinedManagedAssets: manifest.quarantinedFileCount
    }),
    events: Object.freeze([]),
    dataVersion: Object.freeze({ ...versionAfter })
  });
}

function importBatchDeletionQuarantinePath(operationId: string, index: number): string {
  return path.normalize(path.join(getPaths().temp, 'a11-quarantine', `${operationId}-${index}.quarantine`));
}

function verifyImportBatchDeletionFiles(manifest: ImportBatchDeletionManifest, verifyPreservedSources: boolean): void {
  let quarantineIndex = 0;
  for (const file of manifest.managedFiles) {
    if (file.action === 'quarantine') {
      const quarantinePath = importBatchDeletionQuarantinePath(manifest.operationId, quarantineIndex);
      quarantineIndex += 1;
      if (fs.existsSync(file.internalPath) || !fs.existsSync(quarantinePath) ||
          !sameRestoreEvidence(restoreEvidence(quarantinePath), { contentHash: file.contentHash, contentSize: file.contentSize })) {
        throw new AgentError('RECOVERY_FENCE');
      }
      const quarantineStat = fs.lstatSync(quarantinePath);
      if (quarantineStat.isSymbolicLink() || !quarantineStat.isFile()) throw new AgentError('RECOVERY_FENCE');
      const quarantineRoot = path.normalize(path.join(getPaths().temp, 'a11-quarantine'));
      const realRoot = path.normalize(fs.realpathSync(quarantineRoot));
      const realFile = path.normalize(fs.realpathSync(quarantinePath));
      if (!isSameOrDescendant(realFile, realRoot) || realFile === realRoot) throw new AgentError('RECOVERY_FENCE');
    } else if (verifyPreservedSources) {
      verifyImportBatchDeletionManagedFile(file, manifest.batchId);
    }
  }
  if (quarantineIndex !== manifest.quarantinedFileCount) throw new AgentError('RECOVERY_FENCE');
}

function verifyImportBatchDeletionRecoveryPackage(manifest: ImportBatchDeletionManifest): void {
  if (!manifest.recoveryDatabasePath || !manifest.recoveryDatabaseEvidence || !manifest.recoveryInventoryPath || !manifest.recoveryInventoryEvidence ||
      !fs.existsSync(manifest.recoveryDatabasePath) || !fs.existsSync(manifest.recoveryInventoryPath) ||
      !sameRestoreEvidence(restoreEvidence(manifest.recoveryDatabasePath), manifest.recoveryDatabaseEvidence) ||
      !sameRestoreEvidence(restoreEvidence(manifest.recoveryInventoryPath), manifest.recoveryInventoryEvidence)) throw new AgentError('RECOVERY_FENCE');
}

function importBatchDeletionLiveSemanticEvidence(
  SQL: SqlJsStatic,
  bytes: Uint8Array,
  manifest: ImportBatchDeletionManifest,
  expectedVersion: import('../../shared/agent').DataVersion
): ImportBatchDeletionFileEvidence {
  const opener = createSqlJsCandidateOpener(SQL);
  let inspected;
  try { inspected = inspectDatabaseBytes(bytes, { path: getPaths().database, kind: 'temp' }, opener, expectedVersion); } catch { throw new AgentError('RECOVERY_FENCE'); }
  if (inspected.status !== 'valid' || inspected.metadata !== 'present') throw new AgentError('RECOVERY_FENCE');
  const database = new SQL.Database(bytes);
  try {
    database.run('PRAGMA foreign_keys = ON;');
    database.exec(schemaSql);
    migrateDatabase(database);
    const version = new RevisionStore(database).readCurrentVersion();
    if (!sameVersion(version, expectedVersion)) throw new AgentError('RECOVERY_FENCE');
    const batch = one<Record<string, SqlValue>>(database, 'SELECT status,deleted_at,owner_client_id,type FROM import_batches WHERE id=?', [manifest.batchId]);
    if (!batch || batch.status !== 'deleted' || batch.deleted_at !== manifest.deletedAt || batch.owner_client_id !== manifest.batchOwnerClientId ||
        batch.type !== manifest.batchType) throw new AgentError('RECOVERY_FENCE');
    const businessTables = databaseRestoreTableAllowlist.map((table) => {
      const columns = all<{ name: string }>(database, `PRAGMA table_info(${quoteSqlIdentifier(table)})`).map((column) => column.name);
      if (columns.length === 0) throw new AgentError('RECOVERY_FENCE');
      const rows = all<Record<string, SqlValue>>(database, `SELECT ${columns.map(quoteSqlIdentifier).join(',')} FROM ${quoteSqlIdentifier(table)}`)
        .map((row) => Object.freeze(Object.fromEntries(columns.map((column) => [column, normalizedSqlValue(row[column])]))) as Readonly<Record<string, unknown>>)
        .sort((left, right) => canonicalizeJson(left).localeCompare(canonicalizeJson(right)));
      return Object.freeze({ table, rows: Object.freeze(rows) });
    });
    const semantic = Object.freeze({
      schemaVersion: 1,
      operation: 'imports.delete_batch',
      operationId: manifest.operationId,
      ownerClientId: manifest.ownerClientId,
      batchId: manifest.batchId,
      deleteManagedAssets: manifest.deleteManagedAssets,
      inventoryHash: manifest.inventoryHash,
      affectedSetHash: manifest.affectedSetHash,
      version: Object.freeze({ ...version }),
      businessTables: Object.freeze(businessTables)
    });
    const canonical = canonicalizeJson(semantic);
    return Object.freeze({ contentHash: hashCanonicalJson(semantic), contentSize: Buffer.byteLength(canonical, 'utf8') });
  } finally {
    database.close();
  }
}

async function terminalizeRecoveredImportBatchDeletion(
  coordinator: DatabaseCoordinator,
  manifest: ImportBatchDeletionManifest,
  versionAfter: import('../../shared/agent').DataVersion,
  now: () => string
): Promise<void> {
  const controlCapability = createDatabaseCoordinatorControlCapability(coordinator);
  const executeControlWrite = <T>(request: import('../persistence/databaseCoordinator').DatabaseControlWriteRequest<T>) => coordinator.executeControlWrite(controlCapability, request);
  const audit = new AuditLedger({ executeControlWrite, catalog: operationCatalogIdentity, now, randomUUID });
  const workflows = new WorkflowStore({ executeControlWrite, audit, now, randomUUID });
  const receipts = new ExecutionReceipts({ audit, workflows, now });
  const prepared = Object.freeze({
    receiptId: manifest.receiptId,
    clientId: manifest.ownerClientId,
    requestId: manifest.requestId,
    operation: manifest.receiptOperation,
    payloadHash: manifest.receiptPayloadHash,
    affectedSetHash: manifest.affectedSetHash,
    baseVersion: Object.freeze({ ...manifest.baseVersion }),
    catalog: Object.freeze({ ...manifest.catalog }),
    risk: manifest.risk,
    createdAt: manifest.receiptCreatedAt,
    reservation: Object.freeze({
      apiVersion: 1 as const,
      reservationId: manifest.reservationId,
      grantId: manifest.grantId,
      clientId: manifest.ownerClientId,
      requestId: manifest.requestId,
      operation: 'imports.delete_batch' as const,
      payloadHash: manifest.deletePayloadHash,
      affectedSetHash: manifest.affectedSetHash,
      baseVersion: Object.freeze({ ...manifest.baseVersion }),
      catalog: Object.freeze({ ...manifest.catalog }),
      reservedAt: manifest.reservedAt,
      expiresAt: manifest.reservationExpiresAt
    }),
    r4Authority: Object.freeze({
      grantId: manifest.grantId,
      targetHash: manifest.targetHash,
      recovery: manifest.recovery,
      maxAffectedEntities: manifest.maxAffectedEntities,
      reservationExpiresAt: manifest.reservationExpiresAt
    })
  });
  const changeSet = manifest.changeSetId ? Object.freeze({
    changeSetId: manifest.changeSetId,
    clientId: manifest.ownerClientId,
    operation: 'imports.delete_batch' as const,
    payloadHash: manifest.deletePayloadHash,
    affectedSetHash: manifest.affectedSetHash,
    baseVersion: Object.freeze({ ...manifest.baseVersion }),
    catalog: Object.freeze({ ...manifest.catalog })
  }) : undefined;
  const result = importBatchDeletionResult(manifest, versionAfter);
  const terminalHook = receipts.createTerminalHook(prepared, { ...(changeSet ? { changeSet } : {}) });
  await coordinator.executeControlWrite(controlCapability, {
    requestId: `global-import-batch-delete-terminal-${manifest.operationId}`,
    execute: async (database, scope) => {
      const receipt = one<{ status: string; terminal_outcome_hash?: string }>(database, 'SELECT status,terminal_outcome_hash FROM agent_idempotency WHERE receipt_id=?', [manifest.receiptId]);
      if (!receipt) throw new AgentError('RECOVERY_FENCE');
      if (receipt.status === 'completed') {
        const journal = one<{ status: string }>(database, 'SELECT status FROM agent_import_batch_deletion_journals WHERE operation_id=?', [manifest.operationId]);
        if (receipt.terminal_outcome_hash !== hashCanonicalJson(result) || journal?.status !== 'completed') throw new AgentError('RECOVERY_FENCE');
        return { changed: false, value: undefined };
      }
      await terminalHook.execute(database, scope, {
        value: result,
        semanticChanged: true,
        versionBefore: manifest.baseVersion,
        versionAfter,
        generationBefore: coordinator.currentGeneration(),
        generationAfterDataMutation: coordinator.currentGeneration()
      });
      database.run(`INSERT INTO agent_import_batch_deletion_journals (
        operation_id,owner_client_id,request_id,receipt_id,reservation_id,grant_id,change_set_id,batch_id,batch_owner_client_id,
        delete_managed_assets,deleted_question_count,deleted_external_question_count,deleted_attempt_count,soft_deleted_knowledge_count,
        managed_file_count,quarantined_file_count,affected_entity_count,inventory_hash,affected_set_hash,target_hash,
        live_semantic_hash,live_semantic_size,base_data_epoch,base_data_revision,catalog_version,catalog_hash,status,
        version_after_epoch,version_after_revision,recovery_database_path,recovery_inventory_path,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        manifest.operationId, manifest.ownerClientId, manifest.requestId, manifest.receiptId, manifest.reservationId, manifest.grantId,
        manifest.changeSetId ?? null, manifest.batchId, manifest.batchOwnerClientId, manifest.deleteManagedAssets ? 1 : 0,
        manifest.deletedQuestionCount, manifest.deletedExternalQuestionCount, manifest.deletedAttemptCount, manifest.softDeletedKnowledgeCount,
        manifest.managedFileCount, manifest.quarantinedFileCount, manifest.affectedEntityCount, manifest.inventoryHash,
        manifest.affectedSetHash, manifest.targetHash, manifest.liveDatabaseEvidence!.contentHash, manifest.liveDatabaseEvidence!.contentSize,
        manifest.baseVersion.dataEpoch, manifest.baseVersion.dataRevision, manifest.catalog.version, manifest.catalog.hash, 'completed',
        versionAfter.dataEpoch, versionAfter.dataRevision, manifest.recoveryDatabasePath!, manifest.recoveryInventoryPath!, manifest.createdAt, now()
      ]);
      return { changed: true, value: undefined };
    }
  });
}

async function verifyCompletedImportBatchDeletion(
  coordinator: DatabaseCoordinator,
  SQL: SqlJsStatic,
  manifest: ImportBatchDeletionManifest,
  now: () => string
): Promise<void> {
  if (!manifest.versionAfter || !manifest.liveDatabaseEvidence) throw new AgentError('RECOVERY_FENCE');
  verifyImportBatchDeletionRecoveryPackage(manifest);
  const current = coordinator.currentVersion();
  if (current.dataEpoch !== manifest.versionAfter.dataEpoch || current.dataRevision < manifest.versionAfter.dataRevision) throw new AgentError('RECOVERY_FENCE');
  const sameDeletionVersion = current.dataRevision === manifest.versionAfter.dataRevision;
  verifyImportBatchDeletionFiles(manifest, sameDeletionVersion);
  if (sameDeletionVersion && !sameRestoreEvidence(
    importBatchDeletionLiveSemanticEvidence(SQL, fs.readFileSync(getPaths().database), manifest, manifest.versionAfter), manifest.liveDatabaseEvidence
  )) throw new AgentError('RECOVERY_FENCE');
  const database = db;
  if (!database) throw new AgentError('RECOVERY_FENCE');
  const resultHash = hashCanonicalJson(importBatchDeletionResult(manifest, manifest.versionAfter));
  const receipt = one<Record<string, SqlValue>>(database, `SELECT status,terminal_outcome_hash,reservation_id,grant_id,operation,payload_hash,affected_set_hash
    FROM agent_idempotency WHERE receipt_id=? AND client_id=? AND request_id=?`, [manifest.receiptId, manifest.ownerClientId, manifest.requestId]);
  if (!receipt || receipt.status !== 'completed' || receipt.terminal_outcome_hash !== resultHash || receipt.reservation_id !== manifest.reservationId ||
      receipt.grant_id !== manifest.grantId || receipt.operation !== manifest.receiptOperation || receipt.payload_hash !== manifest.receiptPayloadHash ||
      receipt.affected_set_hash !== manifest.affectedSetHash) throw new AgentError('RECOVERY_FENCE');
  const grant = one<Record<string, SqlValue>>(database, `SELECT status,reservation_id,operation,reserved_payload_hash,reserved_affected_set_hash,
      reserved_base_epoch,reserved_base_revision,reserved_catalog_version,reserved_catalog_hash,target_hash FROM agent_r4_grants WHERE grant_id=?`, [manifest.grantId]);
  if (!grant || grant.status !== 'consumed' || grant.reservation_id !== manifest.reservationId || grant.operation !== 'imports.delete_batch' ||
      grant.reserved_payload_hash !== manifest.deletePayloadHash || grant.reserved_affected_set_hash !== manifest.affectedSetHash ||
      grant.reserved_base_epoch !== manifest.baseVersion.dataEpoch || grant.reserved_base_revision !== manifest.baseVersion.dataRevision ||
      grant.reserved_catalog_version !== manifest.catalog.version || grant.reserved_catalog_hash !== manifest.catalog.hash ||
      grant.target_hash !== manifest.targetHash) throw new AgentError('RECOVERY_FENCE');
  if (manifest.changeSetId) {
    const changeSet = one<Record<string, SqlValue>>(database, `SELECT c.status,c.client_id,c.affected_set_hash,c.base_data_epoch,c.base_data_revision,
        c.catalog_version,c.catalog_hash,o.operation,o.payload_hash FROM agent_changesets c INNER JOIN agent_changeset_operations o ON o.change_set_id=c.change_set_id
      WHERE c.change_set_id=?`, [manifest.changeSetId]);
    if (!changeSet || changeSet.status !== 'applied' || changeSet.client_id !== manifest.ownerClientId ||
        changeSet.affected_set_hash !== manifest.affectedSetHash || changeSet.base_data_epoch !== manifest.baseVersion.dataEpoch ||
        changeSet.base_data_revision !== manifest.baseVersion.dataRevision || changeSet.catalog_version !== manifest.catalog.version ||
        changeSet.catalog_hash !== manifest.catalog.hash || changeSet.operation !== 'imports.delete_batch' ||
        changeSet.payload_hash !== manifest.deletePayloadHash) throw new AgentError('RECOVERY_FENCE');
  }
  const journal = one<Record<string, SqlValue>>(database, 'SELECT * FROM agent_import_batch_deletion_journals WHERE operation_id=?', [manifest.operationId]);
  if (!journal || journal.status !== 'completed' || journal.receipt_id !== manifest.receiptId || journal.reservation_id !== manifest.reservationId ||
      journal.grant_id !== manifest.grantId || journal.batch_id !== manifest.batchId || journal.batch_owner_client_id !== manifest.batchOwnerClientId ||
      Number(journal.delete_managed_assets) !== Number(manifest.deleteManagedAssets) || journal.deleted_question_count !== manifest.deletedQuestionCount ||
      journal.deleted_external_question_count !== manifest.deletedExternalQuestionCount || journal.deleted_attempt_count !== manifest.deletedAttemptCount ||
      journal.soft_deleted_knowledge_count !== manifest.softDeletedKnowledgeCount || journal.managed_file_count !== manifest.managedFileCount ||
      journal.quarantined_file_count !== manifest.quarantinedFileCount || journal.affected_entity_count !== manifest.affectedEntityCount ||
      journal.inventory_hash !== manifest.inventoryHash || journal.affected_set_hash !== manifest.affectedSetHash || journal.target_hash !== manifest.targetHash ||
      journal.live_semantic_hash !== manifest.liveDatabaseEvidence.contentHash || journal.live_semantic_size !== manifest.liveDatabaseEvidence.contentSize ||
      journal.version_after_epoch !== manifest.versionAfter.dataEpoch || journal.version_after_revision !== manifest.versionAfter.dataRevision ||
      journal.recovery_database_path !== manifest.recoveryDatabasePath || journal.recovery_inventory_path !== manifest.recoveryInventoryPath) {
    throw new AgentError('RECOVERY_FENCE');
  }
  const controlCapability = createDatabaseCoordinatorControlCapability(coordinator);
  const executeControlWrite = <T>(request: import('../persistence/databaseCoordinator').DatabaseControlWriteRequest<T>) => coordinator.executeControlWrite(controlCapability, request);
  const audit = new AuditLedger({ executeControlWrite, catalog: operationCatalogIdentity, now, randomUUID });
  if (!(await audit.verify()).valid) throw new AgentError('RECOVERY_FENCE');
  const terminalAudit = one<Record<string, SqlValue>>(database, "SELECT kind FROM agent_audit_events WHERE kind='success' AND receipt_id=? AND client_id=? AND request_id=? AND operation=?", [
    manifest.receiptId, manifest.ownerClientId, manifest.requestId, manifest.receiptOperation
  ]);
  if (!terminalAudit) throw new AgentError('RECOVERY_FENCE');
}

async function prepareReplacementManifest(
  request: ReplacementRequest<unknown>,
  operationId: string,
  versionBefore: import('../../shared/agent').DataVersion,
  versionAfter: import('../../shared/agent').DataVersion
): Promise<{ journal: OperationJournal; manifest: OperationManifest; recoveryDatabasePath: string; recoveryInventoryPath: string; sourceInventoryPath: string }> {
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
  const quarantineFiles = typeof request.quarantineFiles === 'function' ? request.quarantineFiles(db!) : request.quarantineFiles ?? [];
  for (const [index, managedFile] of quarantineFiles.entries()) {
    const verified = strictManagedClearFile({
      sourceKind: managedFile.sourceKind,
      binding: Object.freeze({ fileId: managedFile.fileId }),
      reference: managedFile.internalPath,
      root: managedFile.managedRoot,
      expectedHash: managedFile.contentHash,
      expectedSize: managedFile.contentSize
    });
    if (verified.pathHash !== managedFile.pathHash) throw new AgentError('RECOVERY_FENCE');
    files.push({
      fileId: `clear-image-${index}`,
      kind: 'quarantine_delete',
      targetPath: verified.internalPath,
      quarantinePath: path.normalize(path.join(paths.temp, 'a11-quarantine', `${operationId}-${index}.quarantine`)),
      content: { sha256: managedFile.contentHash.slice(10), size: managedFile.contentSize },
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
    recoveryInventoryPath,
    sourceInventoryPath
  };
}

async function replaceDatabaseIdentity<T>(request: ReplacementRequest<T>): Promise<{
  value: T;
  versionBefore: import('../../shared/agent').DataVersion;
  versionAfter: import('../../shared/agent').DataVersion;
  recoveryDatabasePath: string;
  recoveryInventoryPath: string;
}> {
  const jobExecutor = agentControlPlane?.jobExecutor;
  const coordinator = await getDatabaseCoordinator();
  let lease: Awaited<ReturnType<DatabaseCoordinator['beginMaintenance']>> | undefined;
  let versionBefore = coordinator.currentVersion();
  let candidate: Database | null = null;
  let staged: OperationManifest | null = null;
  let journal: OperationJournal | null = null;
  let databasePublished = false;
  try {
    lease = await coordinator.beginMaintenance();
    await jobExecutor?.stopAndDrain();
    await request.dependencies?.onStage?.('maintenance_entered');
    versionBefore = coordinator.currentVersion();
    await request.validateLive?.(db!, versionBefore);
    await request.dependencies?.onStage?.('source_validated');
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
    const recoveryFile = staged.files.find((file) => file.fileId === 'database-snapshot');
    const recoveryInventoryFile = staged.files.find((file) => file.fileId === 'managed-files-inventory');
    const stagedRecoveryPath = recoveryFile?.stagingPath;
    const stagedRecoveryInventoryPath = recoveryInventoryFile?.stagingPath;
    await request.dependencies?.onStage?.('recovery_package_staged', {
      recoveryDatabasePath: prepared.recoveryDatabasePath,
      ...(stagedRecoveryPath ? { recoveryDatabaseEvidence: restoreEvidence(stagedRecoveryPath) } : {}),
      recoveryInventoryPath: prepared.recoveryInventoryPath,
      ...(stagedRecoveryInventoryPath ? { recoveryInventoryEvidence: restoreEvidence(stagedRecoveryInventoryPath) } : {})
    });
    await request.dependencies?.onStage?.('files_quarantined', {
      recoveryDatabasePath: prepared.recoveryDatabasePath,
      ...(stagedRecoveryPath ? { recoveryDatabaseEvidence: restoreEvidence(stagedRecoveryPath) } : {}),
      recoveryInventoryPath: prepared.recoveryInventoryPath,
      ...(stagedRecoveryInventoryPath ? { recoveryInventoryEvidence: restoreEvidence(stagedRecoveryInventoryPath) } : {})
    });
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
    await request.dependencies?.onStage?.('database_published', {
      versionAfter,
      recoveryDatabasePath: prepared.recoveryDatabasePath,
      ...(stagedRecoveryPath ? { recoveryDatabaseEvidence: restoreEvidence(stagedRecoveryPath) } : {}),
      recoveryInventoryPath: prepared.recoveryInventoryPath,
      ...(stagedRecoveryInventoryPath ? { recoveryInventoryEvidence: restoreEvidence(stagedRecoveryInventoryPath) } : {})
    });
    try {
      const completed = await journal.commitFiles(await journal.markDatabaseCommitted(staged));
      if (completed.state !== 'completed') throw new Error('Replacement journal did not complete');
    } catch (error) {
      await resetDatabaseConnectionAsync();
      const recovered = await initializeDatabase({
        ...(request.dependencies?.now ? { now: request.dependencies.now } : {}),
        ...(request.dependencies?.databaseClearRecoveryHook ? { databaseClearRecoveryHook: request.dependencies.databaseClearRecoveryHook } : {}),
        ...(request.dependencies?.importBatchDeletionRecoveryHook ? { importBatchDeletionRecoveryHook: request.dependencies.importBatchDeletionRecoveryHook } : {})
      });
      if (recovered.state !== 'writable') {
        throw new MaintenanceOperationError('RECOVERY_FENCE', 'journal_finalization', 'Published replacement could not be reconciled', false, error);
      }
    }
    await request.dependencies?.onStage?.('files_committed');

    await resetDatabaseConnectionAsync();
    await initializeDatabase({
      ...(request.dependencies?.now ? { now: request.dependencies.now } : {}),
      ...(request.dependencies?.databaseClearRecoveryHook ? { databaseClearRecoveryHook: request.dependencies.databaseClearRecoveryHook } : {}),
      ...(request.dependencies?.importBatchDeletionRecoveryHook ? { importBatchDeletionRecoveryHook: request.dependencies.importBatchDeletionRecoveryHook } : {})
    });
    await request.dependencies?.onStage?.('runtime_reopened');
    return { value, versionBefore, versionAfter, recoveryDatabasePath: prepared.recoveryDatabasePath, recoveryInventoryPath: prepared.recoveryInventoryPath };
  } catch (error) {
    if (lease && databaseCoordinator === coordinator && coordinator.state === 'maintenance') {
      if (databasePublished) {
        await resetDatabaseConnectionAsync();
      } else if (staged && journal) {
        await journal.compensate(staged, journalError(error, 'replacement')).catch(async (compensationError) => {
          await journal!.needsRecovery(staged!, journalError(compensationError, 'compensation')).catch(() => undefined);
          coordinator.finishMaintenance(lease!, 'needs_recovery');
        });
      }
      if (coordinator.state === 'maintenance') coordinator.finishMaintenance(lease, 'writable');
    }
    throw error;
  } finally {
    try {
      candidate?.close();
    } finally {
      if (jobExecutor && agentControlPlane?.jobExecutor === jobExecutor && databaseCoordinator === coordinator && coordinator.state === 'writable') {
        await jobExecutor.resume();
      }
    }
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
  study: StudyApplication,
  imports: ImportsApplication,
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
  const global = registerGlobalApplication({
    coordinator,
    readOnlyDatabase: readDatabase,
    getJobs: () => {
      if (!agentControlPlane) throw new Error('Agent jobs are unavailable pending Gateway bootstrap');
      return agentControlPlane.jobs;
    },
    currentVersion: () => coordinator.currentVersion(),
    cursorSecret: dependencies.agent?.cursorSecret ?? createHash('sha256').update(appInstanceId).digest(),
    now,
    randomUUID: randomId,
    managedPaths: Object.freeze({
      backups: path.normalize(path.join(getPaths().backups, 'agent-materialized')),
      exports: path.normalize(path.join(getPaths().exports, 'agent-materialized')),
      imports: path.normalize(path.join(getPaths().data, 'managed-database-imports')),
      temp: path.normalize(path.join(getPaths().temp, 'agent-global')),
      journal: path.normalize(path.join(getPaths().data, 'operation-journal', 'global-materialization')),
      quarantine: path.normalize(path.join(getPaths().temp, 'agent-global-quarantine'))
    }),
    materializer: Object.freeze({
      async stage(input: Parameters<GlobalMaterializer['stage']>[0]) {
        if (input.kind === 'backup') {
          const backup = require('./backupService') as typeof import('./backupService');
          await backup.createDatabaseBackupAt(input.stagedPath);
          return Object.freeze({ backupKind: input.metadata.backupKind ?? 'manual' });
        }
        const pdf = require('./pdfExportService') as typeof import('./pdfExportService');
        const specification = input.metadata.specification as { readonly scope: 'all' | 'questions'; readonly questionIds?: readonly number[]; readonly mode: 'full' | 'practice' };
        await pdf.exportQuestionsToPdfAt({
          scope: specification.scope === 'all' ? 'all' : 'questionIds',
          mode: specification.mode,
          ...(specification.questionIds ? { questionIds: [...specification.questionIds] } : {})
        }, input.stagedPath);
        return Object.freeze({ scope: specification.scope, mode: specification.mode });
      }
    }),
    databaseRestore: (input) => restoreManagedDatabaseBackup(input),
    databaseImport: Object.freeze({
      inspect: (bytes: Uint8Array) => inspectDatabaseImportPackage(bytes),
      replace: (input: Parameters<typeof replaceManagedDatabaseFromImport>[0]) => replaceManagedDatabaseFromImport(input)
    }),
    databaseClear: Object.freeze({
      resolve: (deleteManagedImages: boolean) => resolveDatabaseClearInventory(deleteManagedImages),
      replace: (input: Parameters<typeof replaceManagedDatabaseClear>[0]) => replaceManagedDatabaseClear(input)
    }),
    importBatchDelete: Object.freeze({
      resolve: (batchId: string, deleteManagedAssets: boolean, identity: { readonly clientId: string; readonly renderer: boolean }) =>
        resolveImportBatchDeletionInventory(batchId, deleteManagedAssets, identity),
      replace: (input: Parameters<typeof replaceManagedImportBatchDeletion>[0]) => replaceManagedImportBatchDeletion(input)
    }),
    dataRootMigration: Object.freeze({
      planSelection: (targetPath: string, selectionId: string, at: string) => planDataRootSelection({
        targetPath,
        sourcePaths: getPaths(),
        baseVersion: coordinator.currentVersion(),
        schemaHash: hashCanonicalJson({ schemaSql }),
        selectionId,
        now: at
      }),
      resolveSelection: (asset, allowPopulatedTarget = false) => resolveStoredDataRootSelection({
        selectionId: asset.assetId,
        targetPath: asset.internalPath!,
        stored: asset.metadata as unknown as StoredDataRootSelection,
        sourcePaths: getPaths(),
        baseVersion: coordinator.currentVersion(),
        schemaHash: hashCanonicalJson({ schemaSql }),
        allowPopulatedTarget
      }),
      migrate: (input) => migrateManagedDataRoot(input)
    })
  });
  globalApplication = global;
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
    jobExecutorOnTerminalized: dependencies.agent?.jobExecutorOnTerminalized,
    now,
    randomUUID: randomId,
    resolveState: (envelope, descriptor) => descriptor.domain === 'questions'
      ? application.gateway.resolveState(envelope, descriptor)
      : ['knowledge', 'textbooks', 'analytics'].includes(descriptor.domain)
        ? knowledge.resolveState(envelope, descriptor)
        : descriptor.domain === 'study' ? study.resolveState(envelope, descriptor) : descriptor.domain === 'imports' ? imports.resolveState(envelope, descriptor) : tickTick.resolveState(envelope, descriptor),
    executeBusinessCommand: (command, context, dispatch) => application.gateway.execute(command as QuestionCommand, context, dispatch),
    tickTickApplication: tickTick,
    knowledgeApplication: knowledge,
    studyApplication: study,
    importsApplication: imports,
    globalApplication: global,
    onRecoveryStage(stage) {
      onStage(stage === 'audit_verified' ? 'audit_ledger_verified' : stage === 'receipts_reconciled' ? 'agent_receipts_reconciled' : 'agent_jobs_reconciled');
    }
  });
  await global.recoverMaterializations();
  onStage('agent_gateway_ready');
  return composition;
}

function dataRootMigrationJournalRoot(): string {
  return path.normalize(path.join(app.getPath('userData'), 'agent-recovery', 'data-root-migrations'));
}

function ensureParentDirectory(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function copyManagedMigrationFiles(plan: DataRootSelectionPlan): void {
  for (const file of plan.inventory) {
    const source = path.normalize(path.join(plan.sourcePath, file.relativePath.replaceAll('/', path.sep)));
    const target = path.normalize(path.join(plan.targetPath, file.relativePath.replaceAll('/', path.sep)));
    const relative = path.relative(plan.targetPath, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new AgentError('RECOVERY_FENCE');
    ensureParentDirectory(target);
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
    fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL);
    const handle = fs.openSync(temp, 'r');
    try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    fs.renameSync(temp, target);
  }
}

function verifyManagedMigrationFiles(plan: DataRootSelectionPlan): void {
  for (const file of plan.inventory) {
    const target = path.normalize(path.join(plan.targetPath, file.relativePath.replaceAll('/', path.sep)));
    const bytes = fs.readFileSync(target);
    const hash = `sha256-v1:${createHash('sha256').update(bytes).digest('hex')}`;
    if (hash !== file.contentHash || bytes.byteLength !== file.contentSize) throw new AgentError('RECOVERY_FENCE');
  }
}

async function migrateManagedDataRoot(input: {
  readonly manifest: Omit<DataRootMigrationManifest, 'schemaVersion' | 'phase' | 'createdAt' | 'updatedAt'>;
  readonly plan: DataRootSelectionPlan;
  readonly onStage: (phase: DataRootMigrationPhase, versionAfter?: import('../../shared/agent').DataVersion) => void | Promise<void>;
}): Promise<{ readonly versionAfter: import('../../shared/agent').DataVersion }> {
  const jobExecutor = agentControlPlane?.jobExecutor;
  const coordinator = await getDatabaseCoordinator();
  let lease: Awaited<ReturnType<DatabaseCoordinator['beginMaintenance']>> | undefined;
  let journalManifest: DataRootMigrationManifest | undefined;
  const journal = new DataRootMigrationJournalStore(dataRootMigrationJournalRoot());
  try {
    lease = await coordinator.beginMaintenance();
    await jobExecutor?.stopAndDrain();
    const repeated = resolveStoredDataRootSelection({
      selectionId: input.manifest.selectionId,
      targetPath: input.plan.targetPath,
      stored: {
        targetIdentity: input.plan.targetIdentity,
        sourceIdentity: input.plan.sourceIdentity,
        inventoryHash: input.plan.inventoryHash,
        inventoryBytes: input.plan.inventoryBytes,
        inventoryCount: input.plan.inventory.length,
        planningAvailableBytes: input.plan.planningAvailableBytes,
        requiredBytes: input.plan.requiredBytes,
        schemaHash: input.plan.schemaHash,
        baseDataEpoch: input.plan.baseVersion.dataEpoch,
        baseDataRevision: input.plan.baseVersion.dataRevision,
        affectedSetHash: input.plan.affectedSetHash,
        targetHash: input.plan.targetHash,
        selectionBindingHash: input.plan.selectionBindingHash,
        expiresAt: input.plan.expiresAt
      },
      sourcePaths: getPaths(),
      baseVersion: coordinator.currentVersion(),
      schemaHash: input.plan.schemaHash
    });
    if (repeated.targetHash !== input.plan.targetHash || repeated.affectedSetHash !== input.plan.affectedSetHash) throw new AgentError('RECOVERY_FENCE');
    journalManifest = journal.ensureIntent(input.manifest, (input.manifest as { receiptCreatedAt: string }).receiptCreatedAt);
    await input.onStage('intent');
    journalManifest = journal.advance(journalManifest, 'verified', new Date().toISOString());
    await input.onStage('verified');
    journalManifest = journal.advance(journalManifest, 'copying', new Date().toISOString());
    copyManagedMigrationFiles(input.plan);
    journalManifest = journal.advance(journalManifest, 'copied', new Date().toISOString());
    verifyManagedMigrationFiles(input.plan);
    journalManifest = journal.advance(journalManifest, 'hash_verified', new Date().toISOString());
    const SQL = await initSqlJs({ locateFile: () => resolveSqlWasmPath() });
    const candidate = new SQL.Database(fs.readFileSync(getPaths().database));
    let versionAfter;
    try {
      candidate.run('PRAGMA foreign_keys = ON;');
      versionAfter = new RevisionStore(candidate).resetDatabaseIdentity(createRevisionMutationCapability(candidate), randomUUID());
      const bytes = candidate.export();
      const opener = createSqlJsCandidateOpener(SQL);
      const targetDatabase = path.join(input.plan.targetPath, 'data', 'mistakes.db');
      const publication = await atomicPersist({
        livePath: targetDatabase,
        requestId: input.manifest.operationId,
        bytes,
        expectedVersion: versionAfter,
        dependencies: { opener, files: defaultAtomicFileDependencies, randomId: randomUUID }
      });
      if (publication.status !== 'success') throw new AgentError('RECOVERY_FENCE');
    } finally {
      candidate.close();
    }
    journalManifest = journal.advance(journalManifest, 'candidate_published', new Date().toISOString(), { versionAfter });
    await input.onStage('candidate_published', versionAfter);
    const authority = readDataRootAuthoritySnapshot();
    await publishDataRootMigrationAuthority({
      expected: authority,
      operationId: input.manifest.operationId,
      nextRoot: input.plan.targetPath,
      previousRootBinding: input.plan.sourceIdentity,
      nextRootBinding: input.plan.targetIdentity,
      publishedAt: new Date().toISOString()
    });
    journalManifest = journal.advance(journalManifest, 'config_published', new Date().toISOString(), { versionAfter });
    await input.onStage('config_published', versionAfter);
    await resetDatabaseConnectionAsync();
    const initialized = await initializeDatabase();
    if (initialized.state !== 'writable') throw new AgentError('RECOVERY_FENCE');
    journalManifest = journal.advance(journalManifest, 'runtime_reopened', new Date().toISOString(), { versionAfter });
    const newCoordinator = await getDatabaseCoordinator();
    await terminalizeRecoveredDataRootMigration(newCoordinator, journalManifest, versionAfter, () => new Date().toISOString());
    journalManifest = journal.advance(journalManifest, 'receipt_terminalized', new Date().toISOString(), { versionAfter });
    journal.advance(journalManifest, 'completed', new Date().toISOString(), { versionAfter });
    return { versionAfter };
  } catch (error) {
    if (journalManifest && journalManifest.phase !== 'completed' && journalManifest.phase !== 'needs_recovery') {
      try { journal.advance(journalManifest, 'needs_recovery', new Date().toISOString(), { reason: error instanceof Error ? error.message.slice(0, 120) : 'migration_failed' }); } catch { /* preserve original */ }
    }
    if (lease && databaseCoordinator === coordinator && coordinator.state === 'maintenance') coordinator.finishMaintenance(lease, 'needs_recovery');
    throw error;
  } finally {
    if (lease && databaseCoordinator === coordinator && coordinator.state === 'maintenance') coordinator.finishMaintenance(lease, 'writable');
    if (jobExecutor && agentControlPlane?.jobExecutor === jobExecutor && databaseCoordinator === coordinator && coordinator.state === 'writable') await jobExecutor.resume();
  }
}

async function recoverDatabaseClearReceipts(
  coordinator: DatabaseCoordinator,
  SQL: SqlJsStatic,
  dependencies: DatabaseInitializationDependencies = {}
): Promise<void> {
  const journalRoot = path.normalize(path.join(getPaths().data, 'operation-journal', 'global-materialization', 'database-clears'));
  const store = new DatabaseClearJournalStore(journalRoot);
  const manifests = store.scan();
  if (manifests.length === 0) return;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const fence = async (): Promise<never> => {
    const lease = await coordinator.beginMaintenance();
    coordinator.finishMaintenance(lease, 'needs_recovery');
    throw new AgentError('RECOVERY_FENCE');
  };
  for (const manifest of manifests) {
    if (manifest.phase === 'completed') {
      try { await verifyCompletedDatabaseClear(coordinator, SQL, manifest, now); } catch { await fence(); }
      continue;
    }
    if (manifest.phase !== 'live_published') {
      if (manifest.phase !== 'needs_recovery') await store.advance(manifest, 'needs_recovery', now(), { reason: 'clear_not_live_published' });
      await fence();
    }
    const versionAfter = manifest.versionAfter;
    const liveDatabaseEvidence = manifest.liveDatabaseEvidence;
    if (!versionAfter || !liveDatabaseEvidence) await fence();
    try {
      verifyDatabaseClearRecoveryPackage(manifest);
      verifyDatabaseClearFiles(manifest, true);
      if (!sameVersion(coordinator.currentVersion(), versionAfter!) || !sameRestoreEvidence(
        databaseClearLiveSemanticEvidence(SQL, fs.readFileSync(getPaths().database), manifest, versionAfter!), liveDatabaseEvidence!
      )) throw new AgentError('RECOVERY_FENCE');
    } catch {
      await fence();
    }
    await dependencies.databaseClearRecoveryHook?.('before_terminalization');
    await terminalizeRecoveredDatabaseClear(coordinator, manifest, versionAfter!, now);
    await dependencies.databaseClearRecoveryHook?.('after_terminalization');
    const completed = await store.advance(manifest, 'completed', now(), {
      versionAfter: versionAfter!,
      recoveryDatabasePath: manifest.recoveryDatabasePath,
      recoveryDatabaseEvidence: manifest.recoveryDatabaseEvidence,
      recoveryInventoryPath: manifest.recoveryInventoryPath,
      recoveryInventoryEvidence: manifest.recoveryInventoryEvidence,
      liveDatabaseEvidence: liveDatabaseEvidence!
    });
    await verifyCompletedDatabaseClear(coordinator, SQL, completed, now);
  }
}

async function recoverDatabaseRestoreReceipts(
  coordinator: DatabaseCoordinator,
  SQL: SqlJsStatic,
  dependencies: DatabaseInitializationDependencies = {}
): Promise<void> {
  const paths = getPaths();
  const journalRoot = path.normalize(path.join(paths.data, 'operation-journal', 'global-materialization', 'database-restores'));
  const store = new DatabaseRestoreJournalStore(journalRoot);
  const manifests = store.scan();
  if (manifests.length === 0) return;
  const now = dependencies.now ?? (() => new Date().toISOString());
  for (const manifest of manifests) {
    if (manifest.recoveryDatabasePath && (!fs.existsSync(manifest.recoveryDatabasePath) || !manifest.recoveryDatabaseEvidence || !sameRestoreEvidence(restoreEvidence(manifest.recoveryDatabasePath), manifest.recoveryDatabaseEvidence))) {
      const lease = await coordinator.beginMaintenance();
      coordinator.finishMaintenance(lease, 'needs_recovery');
      throw new AgentError('RECOVERY_FENCE');
    }
    if (manifest.phase === 'completed') {
      await verifyCompletedDatabaseRestore(coordinator, manifest, now);
      continue;
    }
    if (manifest.phase !== 'live_published') {
      await store.advance(manifest, 'needs_recovery', now(), { reason: 'restore_not_live_published' });
      const lease = await coordinator.beginMaintenance();
      coordinator.finishMaintenance(lease, 'needs_recovery');
      throw new AgentError('RECOVERY_FENCE');
    }
    if (!manifest.versionAfter || !manifest.liveDatabaseEvidence ||
        coordinator.currentVersion().dataEpoch !== manifest.versionAfter.dataEpoch || coordinator.currentVersion().dataRevision !== manifest.versionAfter.dataRevision) {
      const lease = await coordinator.beginMaintenance();
      coordinator.finishMaintenance(lease, 'needs_recovery');
      throw new AgentError('RECOVERY_FENCE');
    }
    if (!sameRestoreEvidence(restoreSemanticLiveEvidence(SQL, fs.readFileSync(paths.database), manifest, manifest.versionAfter), manifest.liveDatabaseEvidence)) {
      const lease = await coordinator.beginMaintenance();
      coordinator.finishMaintenance(lease, 'needs_recovery');
      throw new AgentError('RECOVERY_FENCE');
    }
    const changed = await terminalizeRecoveredDatabaseRestore(coordinator, manifest, manifest.versionAfter, now);
    if (changed) await store.advance(manifest, 'completed', now(), {
      versionAfter: manifest.versionAfter,
      recoveryDatabasePath: manifest.recoveryDatabasePath,
      recoveryDatabaseEvidence: manifest.recoveryDatabaseEvidence,
      liveDatabaseEvidence: manifest.liveDatabaseEvidence
    });
  }
}

async function recoverDatabaseImportReceipts(
  coordinator: DatabaseCoordinator,
  SQL: SqlJsStatic,
  dependencies: DatabaseInitializationDependencies = {}
): Promise<void> {
  const paths = getPaths();
  const journalRoot = path.normalize(path.join(paths.data, 'operation-journal', 'global-materialization', 'database-imports'));
  const store = new DatabaseImportJournalStore(journalRoot);
  const manifests = store.scan();
  if (manifests.length === 0) return;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const fence = async (): Promise<never> => {
    const lease = await coordinator.beginMaintenance();
    coordinator.finishMaintenance(lease, 'needs_recovery');
    throw new AgentError('RECOVERY_FENCE');
  };
  for (const manifest of manifests) {
    try { verifyDatabaseImportPackageManifest(manifest); } catch { await fence(); }
    if (manifest.recoveryDatabasePath && (!fs.existsSync(manifest.recoveryDatabasePath) || !manifest.recoveryDatabaseEvidence ||
        !sameRestoreEvidence(restoreEvidence(manifest.recoveryDatabasePath), manifest.recoveryDatabaseEvidence))) await fence();
    if (manifest.phase === 'completed') {
      try { await verifyCompletedDatabaseImport(coordinator, SQL, manifest, now); } catch { await fence(); }
      continue;
    }
    if (manifest.phase !== 'live_published') {
      await store.advance(manifest, 'needs_recovery', now(), { reason: 'import_not_live_published' });
      await fence();
    }
    const versionAfter = manifest.versionAfter;
    const liveDatabaseEvidence = manifest.liveDatabaseEvidence;
    if (!versionAfter || !liveDatabaseEvidence) {
      await fence();
      throw new AgentError('RECOVERY_FENCE');
    }
    if (coordinator.currentVersion().dataEpoch !== versionAfter.dataEpoch || coordinator.currentVersion().dataRevision !== versionAfter.dataRevision) await fence();
    if (!sameRestoreEvidence(databaseImportLiveSemanticEvidence(SQL, fs.readFileSync(paths.database), manifest, versionAfter), liveDatabaseEvidence)) await fence();
    await terminalizeRecoveredDatabaseImport(coordinator, manifest, versionAfter, now);
    const completed = await store.advance(manifest, 'completed', now(), {
      versionAfter,
      recoveryDatabasePath: manifest.recoveryDatabasePath,
      recoveryDatabaseEvidence: manifest.recoveryDatabaseEvidence,
      liveDatabaseEvidence
    });
    await verifyCompletedDatabaseImport(coordinator, SQL, completed, now);
  }
}

async function recoverImportBatchDeletionReceipts(
  coordinator: DatabaseCoordinator,
  SQL: SqlJsStatic,
  dependencies: DatabaseInitializationDependencies = {}
): Promise<void> {
  const journalRoot = path.normalize(path.join(getPaths().data, 'operation-journal', 'global-materialization', 'import-batch-deletions'));
  const store = new ImportBatchDeletionJournalStore(journalRoot);
  const manifests = store.scan();
  if (manifests.length === 0) return;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const fence = async (): Promise<never> => {
    const lease = await coordinator.beginMaintenance();
    coordinator.finishMaintenance(lease, 'needs_recovery');
    throw new AgentError('RECOVERY_FENCE');
  };
  for (const manifest of manifests) {
    if (manifest.phase === 'completed') {
      try { await verifyCompletedImportBatchDeletion(coordinator, SQL, manifest, now); } catch { await fence(); }
      continue;
    }
    if (manifest.phase !== 'live_published') {
      if (manifest.phase !== 'needs_recovery') await store.advance(manifest, 'needs_recovery', now(), { reason: 'import_batch_delete_not_live_published' });
      await fence();
    }
    const versionAfter = manifest.versionAfter;
    const liveDatabaseEvidence = manifest.liveDatabaseEvidence;
    if (!versionAfter || !liveDatabaseEvidence) await fence();
    try {
      verifyImportBatchDeletionRecoveryPackage(manifest);
      verifyImportBatchDeletionFiles(manifest, true);
      if (!sameVersion(coordinator.currentVersion(), versionAfter!) || !sameRestoreEvidence(
        importBatchDeletionLiveSemanticEvidence(SQL, fs.readFileSync(getPaths().database), manifest, versionAfter!), liveDatabaseEvidence!
      )) throw new AgentError('RECOVERY_FENCE');
    } catch {
      await fence();
    }
    await dependencies.importBatchDeletionRecoveryHook?.('before_terminalization');
    await terminalizeRecoveredImportBatchDeletion(coordinator, manifest, versionAfter!, now);
    await dependencies.importBatchDeletionRecoveryHook?.('after_terminalization');
    const completed = await store.advance(manifest, 'completed', now(), {
      versionAfter: versionAfter!,
      recoveryDatabasePath: manifest.recoveryDatabasePath,
      recoveryDatabaseEvidence: manifest.recoveryDatabaseEvidence,
      recoveryInventoryPath: manifest.recoveryInventoryPath,
      recoveryInventoryEvidence: manifest.recoveryInventoryEvidence,
      liveDatabaseEvidence: liveDatabaseEvidence!
    });
    await verifyCompletedImportBatchDeletion(coordinator, SQL, completed, now);
  }
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
  studyApplication = registerStudy({ coordinator, readOnlyDatabase, now });
  importsApplication = registerImports({ coordinator, readOnlyDatabase, now, randomUUID: randomId });
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
      await recoverDatabaseClearReceipts(coordinator, SQL, dependencies);
      await recoverDatabaseRestoreReceipts(coordinator, SQL, dependencies);
      await recoverDatabaseImportReceipts(coordinator, SQL, dependencies);
      await recoverImportBatchDeletionReceipts(coordinator, SQL, dependencies);
      agentControlPlane = await createAgentControlPlane(coordinator, readOnlyDatabase, questionsApplication, tickTickApplication, knowledgeApplication, studyApplication, importsApplication, operationJournalStores, dependencies, onStage);
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
  const importBatchColumns = all<{ name: string }>(database, 'PRAGMA table_info(import_batches)').map((column) => column.name);
  if (importBatchColumns.length && !importBatchColumns.includes('owner_client_id')) {
    database.run('ALTER TABLE import_batches ADD COLUMN owner_client_id TEXT');
  }
  database.run('CREATE INDEX IF NOT EXISTS idx_import_batches_owner ON import_batches(owner_client_id, imported_at, id)');
  const globalAssetColumns = all<{ name: string }>(database, 'PRAGMA table_info(agent_global_assets)').map((column) => column.name);
  if (globalAssetColumns.length) {
    if (!globalAssetColumns.includes('staged_path')) database.run('ALTER TABLE agent_global_assets ADD COLUMN staged_path TEXT');
    if (!globalAssetColumns.includes('content_hash')) database.run('ALTER TABLE agent_global_assets ADD COLUMN content_hash TEXT');
    if (!globalAssetColumns.includes('content_size')) database.run('ALTER TABLE agent_global_assets ADD COLUMN content_size INTEGER');
    const globalAssetSql = String(one<{ sql: string }>(database, "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_global_assets'")?.sql ?? '');
    if (!globalAssetSql.includes("'consumed'") || !globalAssetSql.includes("'database_import'")) {
      database.run('ALTER TABLE agent_global_assets RENAME TO agent_global_assets_legacy');
      database.run(`CREATE TABLE agent_global_assets (
        asset_id TEXT PRIMARY KEY, owner_client_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('backup', 'export', 'database_import', 'root_selection')),
        status TEXT NOT NULL CHECK (status IN ('intent', 'staged', 'published', 'consumed', 'quarantined', 'failed', 'needs_recovery')),
        metadata_json TEXT NOT NULL, metadata_hash TEXT NOT NULL, internal_path TEXT, staged_path TEXT,
        content_hash TEXT, content_size INTEGER, operation_journal_id TEXT, job_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`);
      database.run(`INSERT INTO agent_global_assets (
        asset_id,owner_client_id,kind,status,metadata_json,metadata_hash,internal_path,staged_path,content_hash,content_size,
        operation_journal_id,job_id,created_at,updated_at
      ) SELECT asset_id,owner_client_id,kind,status,metadata_json,metadata_hash,internal_path,staged_path,content_hash,content_size,
        operation_journal_id,job_id,created_at,updated_at FROM agent_global_assets_legacy`);
      database.run('DROP TABLE agent_global_assets_legacy');
      database.run('CREATE INDEX IF NOT EXISTS idx_agent_global_assets_owner_kind ON agent_global_assets(owner_client_id, kind, created_at, asset_id)');
      database.run('CREATE INDEX IF NOT EXISTS idx_agent_global_assets_recovery ON agent_global_assets(status, updated_at)');
    }
  }
  const deletionJournalColumns = all<{ name: string }>(database, 'PRAGMA table_info(agent_backup_deletion_journals)').map((column) => column.name);
  if (deletionJournalColumns.length) {
    // Existing development journals predate replay bindings and are deliberately fenced by NULL checks.
    for (const column of ['request_id', 'receipt_id', 'reservation_id', 'grant_id', 'affected_set_hash']) {
      if (!deletionJournalColumns.includes(column)) database.run(`ALTER TABLE agent_backup_deletion_journals ADD COLUMN ${column} TEXT`);
    }
  }
  const scopeSql = String(all<{ sql: string }>(database, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_client_scopes'")[0]?.sql ?? '');
  if (scopeSql && (!scopeSql.includes("'imports.read'") || !scopeSql.includes("'imports.write'") || !scopeSql.includes("'ticktick.lists.read'") || !scopeSql.includes("'ticktick.bridges.write'") || !scopeSql.includes("'backups.read'") || !scopeSql.includes("'data_root.migrate'"))) {
    database.run('ALTER TABLE agent_client_scopes RENAME TO agent_client_scopes_legacy');
    database.run(`CREATE TABLE agent_client_scopes (
      client_id TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN (
        'system.read', 'control.manage', 'clients.read', 'clients.manage', 'sessions.read', 'sessions.manage',
        'r4.read', 'r4.manage', 'approvals.read', 'approvals.manage', 'changesets.read', 'changesets.manage',
        'policy.read', 'policy.manage', 'audit.read', 'audit.export', 'questions.read', 'questions.write',
        'questions.archive', 'reviews.read', 'reviews.submit', 'knowledge.read', 'knowledge.write', 'textbooks.read', 'analytics.read', 'study.read', 'study.write', 'imports.read', 'imports.write', 'operations.batch', 'tasks.read',
        'tasks.write', 'tasks.execute', 'jobs.read', 'jobs.execute', 'jobs.cancel', 'jobs.admin', 'focus.read', 'focus.control', 'files.images.read',
        'ticktick.lists.read', 'ticktick.lists.write', 'ticktick.habits.read', 'ticktick.habits.write', 'ticktick.calendar.read', 'ticktick.bridges.read', 'ticktick.bridges.write',
        'backups.read', 'backups.create', 'backups.delete', 'exports.create', 'exports.read', 'database.restore', 'database.replace', 'database.clear', 'imports.delete', 'data_root.migrate'
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
    format: databaseImportPackageFormat,
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
    import_drafts: all(database, 'SELECT * FROM import_drafts'),
    import_managed_assets: all(database, 'SELECT * FROM import_managed_assets'),
    study_settings: all(database, 'SELECT * FROM study_settings'),
    study_subjects: all(database, 'SELECT * FROM study_subjects'),
    study_materials: all(database, 'SELECT * FROM study_materials'),
    study_tasks: all(database, 'SELECT * FROM study_tasks'),
    study_sessions: all(database, 'SELECT * FROM study_sessions'),
    daily_reviews: all(database, 'SELECT * FROM daily_reviews'),
    ticktick_lists: all(database, 'SELECT * FROM ticktick_lists'),
    ticktick_tasks: all(database, 'SELECT * FROM ticktick_tasks'),
    ticktick_tags: all(database, 'SELECT * FROM ticktick_tags'),
    ticktick_focus_sessions: all(database, 'SELECT * FROM ticktick_focus_sessions'),
    ticktick_bridge: all(database, 'SELECT * FROM ticktick_bridge'),
    ticktick_ai_plans: all(database, 'SELECT * FROM ticktick_ai_plans'),
    ticktick_habits: all(database, 'SELECT * FROM ticktick_habits'),
    ticktick_habit_logs: all(database, 'SELECT * FROM ticktick_habit_logs')
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
          id, owner_client_id, type, name, source_file_name, source, imported_at, item_count, asset_count, status, metadata_json, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          batch.id,
          batch.owner_client_id ?? null,
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
  let resolution: DatabaseClearResolution | undefined;
  await replaceDatabaseIdentity({
    commandType: 'database.clear_all',
    inputIdentity: { deleteImages },
    validateLive(database, version) {
      resolution = databaseClearResolutionFrom(database, deleteImages);
      if (!sameVersion(version, resolution.dataVersion)) throw new AgentError('DATA_REVISION_CONFLICT');
    },
    quarantineFiles: deleteImages ? () => {
      if (!resolution) throw new AgentError('RECOVERY_FENCE');
      return resolution.managedFiles.map((file) => Object.freeze({
        ...file,
        managedRoot: file.sourceKind === 'question_image' ? path.normalize(getPaths().images) : managedImportInboxRoot()
      }));
    } : [],
    dependencies,
    mutate(candidate) {
      candidate.run('PRAGMA foreign_keys = OFF;');
      try { for (const table of [...databaseClearTableAllowlist].reverse()) candidate.run(`DELETE FROM ${quoteSqlIdentifier(table)}`); }
      finally { candidate.run('PRAGMA foreign_keys = ON;'); }
      if ((candidate.exec('PRAGMA foreign_key_check')[0]?.values.length ?? 0) !== 0) throw new AgentError('RECOVERY_FENCE');
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
  let inspected;
  try {
    inspected = inspectDatabaseBytes(bytes, { path: normalized, kind: 'temp' }, opener);
  } catch {
    throw new MaintenanceOperationError('BACKUP_INVALID', 'restore_validation', 'Backup is corrupt, incompatible, or has ambiguous identity');
  }
  if (inspected.status !== 'valid' || inspected.metadata !== 'present') {
    throw new MaintenanceOperationError('BACKUP_INVALID', 'restore_validation', 'Backup is corrupt, incompatible, or has ambiguous identity');
  }
  let validationDatabase: Database;
  try {
    validationDatabase = new SQL.Database(bytes);
  } catch {
    throw new MaintenanceOperationError('BACKUP_INVALID', 'restore_validation', 'Backup is corrupt, incompatible, or has ambiguous identity');
  }
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

export async function restoreManagedDatabaseBackup(input: {
  readonly backupPath: string;
  readonly operationId: string;
  readonly manifest: DatabaseRestoreManifest;
  readonly now?: () => string;
  readonly onStage: (stage: 'backup_validated' | 'recovery_package_staged' | 'database_published', evidence?: { readonly versionAfter?: import('../../shared/agent').DataVersion; readonly recoveryDatabasePath?: string; readonly recoveryDatabaseEvidence?: DatabaseRestoreFileEvidence; readonly liveDatabaseEvidence?: DatabaseRestoreFileEvidence }) => void | Promise<void>;
  readonly atomicHook?: import('../persistence').AtomicPersistHook;
}) {
  const normalized = path.normalize(path.resolve(input.backupPath));
  if (!fs.existsSync(normalized)) throw new MaintenanceOperationError('BACKUP_NOT_FOUND', 'restore_validation', 'Backup file does not exist');
  const bytes = fs.readFileSync(normalized);
  const SQL = await initSqlJs({ locateFile: () => resolveSqlWasmPath() });
  const opener = createSqlJsCandidateOpener(SQL);
  let inspected;
  try {
    inspected = inspectDatabaseBytes(bytes, { path: normalized, kind: 'temp' }, opener);
  } catch {
    throw new MaintenanceOperationError('BACKUP_INVALID', 'restore_validation', 'Backup is corrupt, incompatible, or has ambiguous identity');
  }
  if (inspected.status !== 'valid' || inspected.metadata !== 'present') {
    throw new MaintenanceOperationError('BACKUP_INVALID', 'restore_validation', 'Backup is corrupt, incompatible, or has ambiguous identity');
  }
  let validationDatabase: Database;
  try {
    validationDatabase = new SQL.Database(bytes);
  } catch {
    throw new MaintenanceOperationError('BACKUP_INVALID', 'restore_validation', 'Backup is corrupt, incompatible, or has ambiguous identity');
  }
  try {
    const requiredTables = ['questions', 'question_images', 'tags', 'question_tags', 'review_logs', 'question_knowledge_points'];
    const tables = new Set(all<{ name: string }>(validationDatabase, "SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name));
    if (requiredTables.some((table) => !tables.has(table))) {
      throw new MaintenanceOperationError('BACKUP_INCOMPATIBLE', 'restore_validation', 'Backup does not contain the required question schema');
    }
    for (const row of all<{ file_path: string }>(validationDatabase, 'SELECT file_path FROM question_images')) {
      resolveManagedImagePath(row.file_path, 'restore_validation', 'BACKUP_MANAGED_FILES_MISSING');
    }
    validationDatabase.exec(schemaSql);
    migrateDatabase(validationDatabase);
  } catch (error) {
    if (error instanceof MaintenanceOperationError) throw error;
    throw new MaintenanceOperationError('BACKUP_INVALID', 'restore_validation', 'Backup is corrupt, incompatible, or has ambiguous identity');
  }
  await input.onStage('backup_validated');
  const recoveryDatabasePath = path.normalize(path.join(app.getPath('userData'), 'agent-recovery', 'consistency-packages', `${input.operationId}.before.db`));
  try {
    return await replaceDatabaseIdentity({
      commandType: 'database.restore',
      inputIdentity: { managedBackup: evidenceForBytes(bytes), operationId: input.operationId },
      mutate(candidate) {
        copyRestorableTablesFromBackup(candidate, validationDatabase);
        return Object.freeze({ restored: true });
      },
      dependencies: {
        randomId: () => input.operationId,
        ...(input.now ? { now: input.now } : {}),
        ...(input.atomicHook ? { atomicHook: input.atomicHook } : {}),
        async onStage(stage, evidence) {
          if (stage === 'recovery_package_staged') await input.onStage(stage, {
            recoveryDatabasePath,
            ...(evidence?.recoveryDatabaseEvidence ? { recoveryDatabaseEvidence: evidence.recoveryDatabaseEvidence } : {})
          });
          if (stage === 'database_published') await input.onStage(stage, {
            ...(evidence?.versionAfter ? { versionAfter: evidence.versionAfter } : {}),
            recoveryDatabasePath,
            ...(evidence?.recoveryDatabaseEvidence ? { recoveryDatabaseEvidence: evidence.recoveryDatabaseEvidence } : {}),
            ...(evidence?.versionAfter ? { liveDatabaseEvidence: restoreSemanticLiveEvidence(SQL, fs.readFileSync(getPaths().database), input.manifest, evidence.versionAfter) } : {})
          });
        }
      }
    });
  } finally {
    validationDatabase.close();
  }
}

export async function replaceManagedDatabaseFromImport(input: {
  readonly packagePath: string;
  readonly operationId: string;
  readonly manifest: DatabaseImportManifest;
  readonly now?: () => string;
  readonly onStage: (stage: 'package_validated' | 'recovery_package_staged' | 'database_published', evidence?: {
    readonly versionAfter?: import('../../shared/agent').DataVersion;
    readonly recoveryDatabasePath?: string;
    readonly recoveryDatabaseEvidence?: DatabaseImportSemanticEvidence;
    readonly liveDatabaseEvidence?: DatabaseImportSemanticEvidence;
  }) => void | Promise<void>;
  readonly atomicHook?: import('../persistence').AtomicPersistHook;
}) {
  const normalized = path.normalize(path.resolve(input.packagePath));
  if (!fs.existsSync(normalized)) throw new MaintenanceOperationError('IMPORT_PACKAGE_NOT_FOUND', 'import_validation', 'Managed import package does not exist');
  const bytes = fs.readFileSync(normalized);
  const content = evidenceForBytes(bytes);
  if (`sha256-v1:${content.sha256}` !== input.manifest.package.contentHash || content.size !== input.manifest.package.contentSize) throw new MaintenanceOperationError('IMPORT_PACKAGE_INVALID', 'import_validation', 'Managed import package evidence changed');
  const parsed = parseDatabaseImportPackage(bytes);
  if (parsed.metadata.semanticHash !== input.manifest.package.semanticHash || parsed.metadata.rowCount !== input.manifest.package.rowCount) throw new MaintenanceOperationError('IMPORT_PACKAGE_INVALID', 'import_validation', 'Managed import package semantics changed');
  const SQL = await initSqlJs({ locateFile: () => resolveSqlWasmPath() });
  const packageDatabase = createDatabaseImportPackageDatabase(SQL, parsed);
  try {
    await input.onStage('package_validated');
    const recoveryDatabasePath = path.normalize(path.join(app.getPath('userData'), 'agent-recovery', 'consistency-packages', `${input.operationId}.before.db`));
    return await replaceDatabaseIdentity({
      commandType: 'database.replace_from_import',
      inputIdentity: { managedImport: content, semanticHash: parsed.metadata.semanticHash, operationId: input.operationId },
      mutate(candidate) {
        copyRestorableTablesFromBackup(candidate, packageDatabase);
        return Object.freeze({ replaced: true });
      },
      dependencies: {
        randomId: () => input.operationId,
        ...(input.now ? { now: input.now } : {}),
        ...(input.atomicHook ? { atomicHook: input.atomicHook } : {}),
        async onStage(stage, evidence) {
          if (stage === 'recovery_package_staged') await input.onStage(stage, {
            recoveryDatabasePath,
            ...(evidence?.recoveryDatabaseEvidence ? { recoveryDatabaseEvidence: evidence.recoveryDatabaseEvidence } : {})
          });
          if (stage === 'database_published') await input.onStage(stage, {
            ...(evidence?.versionAfter ? { versionAfter: evidence.versionAfter } : {}),
            recoveryDatabasePath,
            ...(evidence?.recoveryDatabaseEvidence ? { recoveryDatabaseEvidence: evidence.recoveryDatabaseEvidence } : {}),
            ...(evidence?.versionAfter ? { liveDatabaseEvidence: databaseImportLiveSemanticEvidence(SQL, fs.readFileSync(getPaths().database), input.manifest, evidence.versionAfter) } : {})
          });
        }
      }
    });
  } finally {
    packageDatabase.close();
  }
}

export async function replaceManagedDatabaseClear(input: {
  readonly operationId: string;
  readonly manifest: DatabaseClearManifest;
  readonly resolution: DatabaseClearResolution;
  readonly now?: () => string;
  readonly onStage: (stage: 'inventory_validated' | 'recovery_package_staged' | 'files_quarantined' | 'database_published' | 'cleanup_reconciled', evidence?: {
    readonly versionAfter?: import('../../shared/agent').DataVersion;
    readonly recoveryDatabasePath?: string;
    readonly recoveryDatabaseEvidence?: DatabaseClearFileEvidence;
    readonly recoveryInventoryPath?: string;
    readonly recoveryInventoryEvidence?: DatabaseClearFileEvidence;
    readonly liveDatabaseEvidence?: DatabaseClearFileEvidence;
  }) => void | Promise<void>;
  readonly atomicHook?: import('../persistence').AtomicPersistHook;
  readonly journal?: OperationJournalDependencies;
  readonly recoveryHook?: DatabaseInitializationDependencies['databaseClearRecoveryHook'];
}) {
  if (input.operationId !== input.manifest.operationId || input.resolution.deleteManagedImages !== input.manifest.deleteManagedImages ||
      input.resolution.businessRowCount !== input.manifest.businessRowCount || input.resolution.managedImageCount !== input.manifest.managedImageCount ||
      input.resolution.affectedEntityCount !== input.manifest.affectedEntityCount || input.resolution.inventoryHash !== input.manifest.inventoryHash ||
      input.resolution.affectedSetHash !== input.manifest.affectedSetHash || input.resolution.targetHash !== input.manifest.targetHash ||
      !sameVersion(input.resolution.dataVersion, input.manifest.baseVersion)) throw new AgentError('RECOVERY_FENCE');
  const SQL = await initSqlJs({ locateFile: () => resolveSqlWasmPath() });
  return replaceDatabaseIdentity({
    commandType: 'database.clear_all',
    inputIdentity: Object.freeze({
      operationId: input.operationId,
      deleteManagedImages: input.manifest.deleteManagedImages,
      inventoryHash: input.manifest.inventoryHash,
      affectedSetHash: input.manifest.affectedSetHash,
      targetHash: input.manifest.targetHash
    }),
    async validateLive(database, version) {
      const repeated = databaseClearResolutionFrom(database, input.manifest.deleteManagedImages);
      if (!sameVersion(version, input.manifest.baseVersion) || repeated.inventoryHash !== input.manifest.inventoryHash ||
          repeated.affectedSetHash !== input.manifest.affectedSetHash || repeated.targetHash !== input.manifest.targetHash ||
          canonicalizeJson(repeated.managedFiles) !== canonicalizeJson(input.manifest.managedFiles)) throw new AgentError('RECOVERY_FENCE');
      await input.onStage('inventory_validated');
    },
    quarantineFiles: input.manifest.deleteManagedImages ? input.manifest.managedFiles.map((file) => Object.freeze({
      ...file,
      managedRoot: file.sourceKind === 'question_image' ? path.normalize(getPaths().images) : managedImportInboxRoot()
    })) : [],
    mutate(candidate) {
      candidate.run('PRAGMA foreign_keys = OFF;');
      try {
        for (const table of [...databaseClearTableAllowlist].reverse()) candidate.run(`DELETE FROM ${quoteSqlIdentifier(table)}`);
      } finally {
        candidate.run('PRAGMA foreign_keys = ON;');
      }
      if ((candidate.exec('PRAGMA foreign_key_check')[0]?.values.length ?? 0) !== 0) throw new AgentError('RECOVERY_FENCE');
      return Object.freeze({ cleared: true });
    },
    dependencies: {
      randomId: () => input.operationId,
      ...(input.now ? { now: input.now } : {}),
      ...(input.atomicHook ? { atomicHook: input.atomicHook } : {}),
      ...(input.journal ? { journal: input.journal } : {}),
      ...(input.recoveryHook ? { databaseClearRecoveryHook: input.recoveryHook } : {}),
      async onStage(stage, evidence) {
        if (stage === 'recovery_package_staged') await input.onStage(stage, evidence);
        if (stage === 'files_quarantined') await input.onStage(stage, evidence);
        if (stage === 'database_published') await input.onStage(stage, {
          ...(evidence?.versionAfter ? { versionAfter: evidence.versionAfter } : {}),
          ...(evidence?.recoveryDatabasePath ? { recoveryDatabasePath: evidence.recoveryDatabasePath } : {}),
          ...(evidence?.recoveryDatabaseEvidence ? { recoveryDatabaseEvidence: evidence.recoveryDatabaseEvidence } : {}),
          ...(evidence?.recoveryInventoryPath ? { recoveryInventoryPath: evidence.recoveryInventoryPath } : {}),
          ...(evidence?.recoveryInventoryEvidence ? { recoveryInventoryEvidence: evidence.recoveryInventoryEvidence } : {}),
          ...(evidence?.versionAfter ? { liveDatabaseEvidence: databaseClearLiveSemanticEvidence(SQL, fs.readFileSync(getPaths().database), input.manifest, evidence.versionAfter) } : {})
        });
        if (stage === 'files_committed') await input.onStage('cleanup_reconciled');
      }
    }
  });
}

export async function replaceManagedImportBatchDeletion(input: {
  readonly operationId: string;
  readonly manifest: ImportBatchDeletionManifest;
  readonly resolution: ImportBatchDeletionResolution;
  readonly now?: () => string;
  readonly onStage: (stage: 'inventory_validated' | 'recovery_package_staged' | 'files_quarantined' | 'database_published' | 'cleanup_reconciled', evidence?: {
    readonly versionAfter?: import('../../shared/agent').DataVersion;
    readonly recoveryDatabasePath?: string;
    readonly recoveryDatabaseEvidence?: ImportBatchDeletionFileEvidence;
    readonly recoveryInventoryPath?: string;
    readonly recoveryInventoryEvidence?: ImportBatchDeletionFileEvidence;
    readonly liveDatabaseEvidence?: ImportBatchDeletionFileEvidence;
  }) => void | Promise<void>;
  readonly atomicHook?: import('../persistence').AtomicPersistHook;
  readonly journal?: OperationJournalDependencies;
  readonly recoveryHook?: DatabaseInitializationDependencies['importBatchDeletionRecoveryHook'];
}) {
  if (input.operationId !== input.manifest.operationId || input.resolution.batchId !== input.manifest.batchId ||
      input.resolution.batchType !== input.manifest.batchType || input.resolution.batchOwnerClientId !== input.manifest.batchOwnerClientId ||
      input.resolution.ownershipPolicy !== input.manifest.ownershipPolicy ||
      input.resolution.deleteManagedAssets !== input.manifest.deleteManagedAssets ||
      input.resolution.deletedQuestionCount !== input.manifest.deletedQuestionCount ||
      input.resolution.deletedExternalQuestionCount !== input.manifest.deletedExternalQuestionCount ||
      input.resolution.deletedAttemptCount !== input.manifest.deletedAttemptCount ||
      input.resolution.softDeletedKnowledgeCount !== input.manifest.softDeletedKnowledgeCount ||
      input.resolution.managedFileCount !== input.manifest.managedFileCount ||
      input.resolution.quarantinedFileCount !== input.manifest.quarantinedFileCount ||
      input.resolution.affectedEntityCount !== input.manifest.affectedEntityCount ||
      input.resolution.inventoryHash !== input.manifest.inventoryHash || input.resolution.affectedSetHash !== input.manifest.affectedSetHash ||
      input.resolution.targetHash !== input.manifest.targetHash || !sameVersion(input.resolution.dataVersion, input.manifest.baseVersion) ||
      canonicalizeJson(input.resolution.inventoryRows) !== canonicalizeJson(input.manifest.inventoryRows) ||
      canonicalizeJson(input.resolution.managedFiles) !== canonicalizeJson(input.manifest.managedFiles) ||
      canonicalizeJson(input.resolution.affectedEntities) !== canonicalizeJson(input.manifest.affectedEntities)) throw new AgentError('RECOVERY_FENCE');
  const SQL = await initSqlJs({ locateFile: () => resolveSqlWasmPath() });
  return replaceDatabaseIdentity({
    commandType: 'imports.delete_batch',
    inputIdentity: Object.freeze({
      operationId: input.operationId,
      batchId: input.manifest.batchId,
      deleteManagedAssets: input.manifest.deleteManagedAssets,
      inventoryHash: input.manifest.inventoryHash,
      affectedSetHash: input.manifest.affectedSetHash,
      targetHash: input.manifest.targetHash
    }),
    async validateLive(database, version) {
      const repeated = resolveImportBatchDeletion(database, input.manifest.batchId, input.manifest.deleteManagedAssets, {
        clientId: input.manifest.ownerClientId,
        renderer: input.manifest.ownershipPolicy === 'legacy_local_renderer_only'
      });
      if (!sameVersion(version, input.manifest.baseVersion) || repeated.inventoryHash !== input.manifest.inventoryHash ||
          repeated.affectedSetHash !== input.manifest.affectedSetHash || repeated.targetHash !== input.manifest.targetHash ||
          canonicalizeJson(repeated.inventoryRows) !== canonicalizeJson(input.manifest.inventoryRows) ||
          canonicalizeJson(repeated.managedFiles) !== canonicalizeJson(input.manifest.managedFiles) ||
          canonicalizeJson(repeated.affectedEntities) !== canonicalizeJson(input.manifest.affectedEntities) ||
          canonicalizeJson(repeated.mutation) !== canonicalizeJson(input.resolution.mutation)) throw new AgentError('RECOVERY_FENCE');
      await input.onStage('inventory_validated');
    },
    quarantineFiles: input.manifest.managedFiles.filter((file) => file.action === 'quarantine').map((file) => Object.freeze({
      fileId: file.fileId,
      sourceKind: file.rootKind === 'question_bank_batch' ? `question_bank_batch:${input.manifest.batchId}` : file.rootKind,
      managedRoot: importBatchDeletionManagedRoot(file, input.manifest.batchId),
      internalPath: file.internalPath,
      pathHash: file.pathHash,
      contentHash: file.contentHash,
      contentSize: file.contentSize
    })),
    mutate(candidate) {
      applyImportBatchDeletion(candidate, input.resolution, input.manifest.deletedAt);
      return Object.freeze({ deleted: true });
    },
    dependencies: {
      randomId: () => input.operationId,
      ...(input.now ? { now: input.now } : {}),
      ...(input.atomicHook ? { atomicHook: input.atomicHook } : {}),
      ...(input.journal ? { journal: input.journal } : {}),
      ...(input.recoveryHook ? { importBatchDeletionRecoveryHook: input.recoveryHook } : {}),
      async onStage(stage, evidence) {
        if (stage === 'recovery_package_staged') await input.onStage(stage, evidence);
        if (stage === 'files_quarantined') await input.onStage(stage, evidence);
        if (stage === 'database_published') await input.onStage(stage, {
          ...(evidence?.versionAfter ? { versionAfter: evidence.versionAfter } : {}),
          ...(evidence?.recoveryDatabasePath ? { recoveryDatabasePath: evidence.recoveryDatabasePath } : {}),
          ...(evidence?.recoveryDatabaseEvidence ? { recoveryDatabaseEvidence: evidence.recoveryDatabaseEvidence } : {}),
          ...(evidence?.recoveryInventoryPath ? { recoveryInventoryPath: evidence.recoveryInventoryPath } : {}),
          ...(evidence?.recoveryInventoryEvidence ? { recoveryInventoryEvidence: evidence.recoveryInventoryEvidence } : {}),
          ...(evidence?.versionAfter ? { liveDatabaseEvidence: importBatchDeletionLiveSemanticEvidence(SQL, fs.readFileSync(getPaths().database), input.manifest, evidence.versionAfter) } : {})
        });
        if (stage === 'files_committed') await input.onStage('cleanup_reconciled');
      }
    }
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
  const jobExecutor = agentControlPlane?.jobExecutor;
  const coordinator = await getDatabaseCoordinator();
  const oldPaths = getPaths();
  let lease: Awaited<ReturnType<DatabaseCoordinator['beginMaintenance']>> | undefined;
  let plan: Awaited<ReturnType<typeof stageDataRootSwitch>> | null = null;
  let staged: OperationManifest | null = null;
  let journal: OperationJournal | null = null;
  let configPublished = false;
  try {
    lease = await coordinator.beginMaintenance();
    await jobExecutor?.stopAndDrain();
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
    await resetDatabaseConnectionAsync();
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
        if (lease && databaseCoordinator === coordinator && coordinator.state === 'maintenance') coordinator.finishMaintenance(lease, 'needs_recovery');
        throw new MaintenanceOperationError('ROOT_CONFIG_ROLLBACK_FAILED', 'config_rollback', 'Data-root configuration could not be restored', false, rollbackError);
      }
    }
    if (staged && journal) await journal.compensate(staged, journalError(error, 'root_switch')).catch(() => undefined);
    if (databaseCoordinator !== coordinator) await resetDatabaseConnectionAsync();
    if (!databaseCoordinator) await initializeDatabase().catch(() => undefined);
    if (lease && databaseCoordinator === coordinator && coordinator.state === 'maintenance') coordinator.finishMaintenance(lease, 'writable');
    throw error;
  } finally {
    if (jobExecutor && agentControlPlane?.jobExecutor === jobExecutor && databaseCoordinator === coordinator && coordinator.state === 'writable') {
      await jobExecutor.resume();
    }
  }
}

export function resetDatabaseConnection(): void {
  if (databaseCoordinator?.pendingWrites) throw new Error('Cannot reset the database while coordinator writes are pending');
  const jobExecutor = agentControlPlane?.jobExecutor;
  if (jobExecutor && !jobExecutor.isIdle()) {
    throw new Error('Cannot synchronously reset the database while JobExecutor is active; await resetDatabaseConnectionAsync()');
  }
  jobExecutor?.stop();
  if (db) {
    db.close();
    db = null;
  }
  databaseCoordinator = null;
  readOnlyDatabase = null;
  questionsApplication = null;
  tickTickApplication = null;
  knowledgeApplication = null;
  studyApplication = null;
  importsApplication = null;
  globalApplication = null;
  agentControlPlane = null;
  initializationPromise = null;
  initializationResult = null;
  shutdownPromise = null;
}

export async function resetDatabaseConnectionAsync(): Promise<void> {
  await shutdownDatabase();
  resetDatabaseConnection();
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
  const jobExecutor = agentControlPlane?.jobExecutor;
  const executorDrain = jobExecutor?.stopAndDrain() ?? Promise.resolve();
  if (!jobExecutor || jobExecutor.isIdle()) {
    const coordinatorDrain = coordinator?.shutdown();
    await executorDrain;
    await coordinatorDrain;
    return;
  }
  await executorDrain;
  await coordinator?.shutdown();
}

export function getCurrentPaths(): AppPaths {
  return getPaths();
}

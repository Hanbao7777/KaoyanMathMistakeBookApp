import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AgentError } from '../../../shared/agent/errors';
import type { CommandResult, EntityRef, QueryResult, TrustedExecutionContext } from '../../../shared/agent/v1/contracts';
import type { AgentCommandEnvelope, AgentPrincipal, AgentQueryEnvelope, JsonObject, OperationDescriptor } from '../../../shared/agent/v1/gatewayContracts';
import { canonicalizeJson, hashCanonicalJson } from '../../../shared/agent/v1/gatewaySchemas';
import { operationCatalogIdentity } from '../../../shared/agent/v1/operationCatalog';
import type { GatewayResolvedState } from '../../agent/agentGateway';
import { JobStore, localRendererJobSessionId, type JobCreateIdentity } from '../../agent/jobStore';
import { isDurableJobPrincipal } from '../../agent/clientAuthenticator';
import { PaginationService } from '../../agent/pagination';
import { createDatabaseCoordinatorBusinessCapability, createDatabaseCoordinatorControlCapability, type DatabaseCoordinator, type DatabaseTerminalHook } from '../../persistence/databaseCoordinator';
import type { ReadOnlyDatabaseFacade } from '../queryBus';
import { assertBackupDeletionReceiptTarget, assertDatabaseClearReceiptTarget, assertDatabaseImportReceiptTarget, assertDatabaseRestoreReceiptTarget, assertDataRootMigrationReceiptTarget, assertImportBatchDeletionReceiptTarget, backupDeletionJournalStatus, bindGlobalAssetMaterialization, createGlobalAsset, ensureBackupDeletionJournal, getGlobalAsset, getInternalGlobalAsset, listGlobalAssets, listInternalGlobalAssets, transitionBackupDeletionJournal, transitionGlobalAsset, type DatabaseRestoreAdmission, type InternalGlobalAsset } from './assetStore';
import type { GlobalCommand, GlobalQuery } from './contracts';
import { globalCommandTypes, globalQueryTypes, validateGlobalCommand, validateGlobalQuery } from './contracts';
import { DatabaseRestoreJournalStore, type DatabaseRestoreFileEvidence, type DatabaseRestoreManifest } from './databaseRestoreJournal';
import { DatabaseImportJournalStore, type DatabaseImportManifest, type DatabaseImportSemanticEvidence } from './databaseImportJournal';
import { DatabaseClearJournalStore, type DatabaseClearFileEvidence, type DatabaseClearManagedFile, type DatabaseClearManifest } from './databaseClearJournal';
import { ImportBatchDeletionJournalStore, type ImportBatchDeletionFileEvidence, type ImportBatchDeletionManifest } from './importBatchDeletionJournal';
import type { ImportBatchDeletionResolution } from './importBatchDeletion';
import { MaterializationJournalStore, flushMaterializationFile, materializationEvidence, materializationMetadataHash, publishMaterializationFile, quarantineMaterializationFile, removeMaterializationFile, type MaterializationDurabilityDependencies, type MaterializationManifest, type MaterializationPhase } from './materializationJournal';
import { planUserSelectedDatabaseImport, publishManagedDatabaseImport, removeManagedDatabaseImport, verifyManagedDatabaseImport } from './managedDatabaseImport';
import { assertSelectionNotExpired, storedSelection, type DataRootSelectionPlan, type StoredDataRootSelection } from './dataRootMigration';
import type { DataRootMigrationManifest, DataRootMigrationPhase } from './dataRootMigrationJournal';

export interface RegisterGlobalOptions {
  readonly coordinator: DatabaseCoordinator;
  readonly readOnlyDatabase: ReadOnlyDatabaseFacade;
  readonly getJobs: () => JobStore;
  readonly currentVersion: () => { readonly dataEpoch: string; readonly dataRevision: number };
  readonly cursorSecret?: Uint8Array | string;
  readonly now?: () => string;
  readonly randomUUID?: () => string;
  readonly managedPaths?: { readonly backups: string; readonly exports: string; readonly imports?: string; readonly temp: string; readonly journal?: string; readonly quarantine?: string };
  readonly materializer?: GlobalMaterializer;
  readonly materializationHook?: (phase: MaterializationPhase, manifest: MaterializationManifest) => void | Promise<void>;
  readonly materializationDurability?: MaterializationDurabilityDependencies;
  readonly materializationFaultHook?: (boundary: 'before_job_terminal_journal', manifest: MaterializationManifest) => void | Promise<void>;
  readonly backupDeletionFaultHook?: (boundary: 'after_quarantine_rename', journalId: string) => void | Promise<void>;
  readonly databaseRestore?: (input: {
    readonly backupPath: string;
    readonly operationId: string;
    readonly manifest: DatabaseRestoreManifest;
    readonly now?: () => string;
    readonly onStage: (stage: 'backup_validated' | 'recovery_package_staged' | 'database_published', evidence?: { readonly versionAfter?: { readonly dataEpoch: string; readonly dataRevision: number }; readonly recoveryDatabasePath?: string; readonly recoveryDatabaseEvidence?: DatabaseRestoreFileEvidence; readonly liveDatabaseEvidence?: DatabaseRestoreFileEvidence }) => void | Promise<void>;
  }) => Promise<{ readonly versionAfter: { readonly dataEpoch: string; readonly dataRevision: number }; readonly recoveryDatabasePath: string }>;
  readonly databaseImport?: {
    inspect(bytes: Uint8Array): Promise<{ readonly format: 'kaoyan-full-data-v1'; readonly version: 1; readonly semanticHash: string; readonly semanticSize: number; readonly rowCount: number; readonly tableCounts: Readonly<Record<string, number>> }>;
    replace(input: {
      readonly packagePath: string;
      readonly operationId: string;
      readonly manifest: DatabaseImportManifest;
      readonly now?: () => string;
      readonly onStage: (stage: 'package_validated' | 'recovery_package_staged' | 'database_published', evidence?: { readonly versionAfter?: { readonly dataEpoch: string; readonly dataRevision: number }; readonly recoveryDatabasePath?: string; readonly recoveryDatabaseEvidence?: DatabaseImportSemanticEvidence; readonly liveDatabaseEvidence?: DatabaseImportSemanticEvidence }) => void | Promise<void>;
    }): Promise<{ readonly versionAfter: { readonly dataEpoch: string; readonly dataRevision: number }; readonly recoveryDatabasePath: string }>;
  };
  readonly databaseClear?: {
    resolve(deleteManagedImages: boolean): DatabaseClearResolution;
    replace(input: {
      readonly operationId: string;
      readonly manifest: DatabaseClearManifest;
      readonly resolution: DatabaseClearResolution;
      readonly now?: () => string;
      readonly onStage: (stage: 'inventory_validated' | 'recovery_package_staged' | 'files_quarantined' | 'database_published' | 'cleanup_reconciled', evidence?: {
        readonly versionAfter?: { readonly dataEpoch: string; readonly dataRevision: number };
        readonly recoveryDatabasePath?: string;
        readonly recoveryDatabaseEvidence?: DatabaseClearFileEvidence;
        readonly recoveryInventoryPath?: string;
        readonly recoveryInventoryEvidence?: DatabaseClearFileEvidence;
        readonly liveDatabaseEvidence?: DatabaseClearFileEvidence;
      }) => void | Promise<void>;
    }): Promise<{ readonly versionAfter: { readonly dataEpoch: string; readonly dataRevision: number }; readonly recoveryDatabasePath: string; readonly recoveryInventoryPath: string }>;
  };
  readonly importBatchDelete?: {
    resolve(batchId: string, deleteManagedAssets: boolean, identity: { readonly clientId: string; readonly renderer: boolean }): ImportBatchDeletionResolution;
    replace(input: {
      readonly operationId: string;
      readonly manifest: ImportBatchDeletionManifest;
      readonly resolution: ImportBatchDeletionResolution;
      readonly now?: () => string;
      readonly onStage: (stage: 'inventory_validated' | 'recovery_package_staged' | 'files_quarantined' | 'database_published' | 'cleanup_reconciled', evidence?: {
        readonly versionAfter?: { readonly dataEpoch: string; readonly dataRevision: number };
        readonly recoveryDatabasePath?: string;
        readonly recoveryDatabaseEvidence?: ImportBatchDeletionFileEvidence;
        readonly recoveryInventoryPath?: string;
        readonly recoveryInventoryEvidence?: ImportBatchDeletionFileEvidence;
        readonly liveDatabaseEvidence?: ImportBatchDeletionFileEvidence;
      }) => void | Promise<void>;
    }): Promise<{ readonly versionAfter: { readonly dataEpoch: string; readonly dataRevision: number }; readonly recoveryDatabasePath: string; readonly recoveryInventoryPath: string }>;
  };
  readonly dataRootMigration?: {
    readonly planSelection: (targetPath: string, selectionId: string, now: string) => DataRootSelectionPlan;
    readonly resolveSelection: (asset: InternalGlobalAsset, allowPopulatedTarget?: boolean) => DataRootSelectionPlan;
    readonly migrate: (input: {
      readonly manifest: Omit<DataRootMigrationManifest, 'schemaVersion' | 'phase' | 'createdAt' | 'updatedAt'>;
      readonly plan: DataRootSelectionPlan;
      readonly onStage: (phase: DataRootMigrationPhase, versionAfter?: { readonly dataEpoch: string; readonly dataRevision: number }) => void | Promise<void>;
    }) => Promise<{ readonly versionAfter: { readonly dataEpoch: string; readonly dataRevision: number } }>;
  };
}

export interface DatabaseClearResolution {
  readonly deleteManagedImages: boolean;
  readonly businessRowCount: number;
  readonly managedImageCount: number;
  readonly affectedEntityCount: number;
  readonly inventoryHash: string;
  readonly managedFiles: readonly DatabaseClearManagedFile[];
  readonly affectedEntities: readonly EntityRef[];
  readonly affectedSetHash: string;
  readonly targetHash: string;
  readonly dataVersion: { readonly dataEpoch: string; readonly dataRevision: number };
}

export interface GlobalMaterializer {
  stage(input: { readonly kind: 'backup' | 'export'; readonly assetId: string; readonly metadata: Readonly<Record<string, unknown>>; readonly stagedPath: string }): Promise<Readonly<Record<string, unknown>>>;
}

export interface GlobalIntentResult {
  readonly assetId: string;
  readonly jobId: string;
  readonly status: 'intent';
}

export interface GlobalApplication {
  readonly shouldKickJobs: boolean;
  validateCommand(value: unknown): asserts value is GlobalCommand;
  validateQuery(value: unknown): asserts value is GlobalQuery;
  execute(command: GlobalCommand, context: TrustedExecutionContext, terminalHook?: DatabaseTerminalHook<CommandResult>, principal?: AgentPrincipal): Promise<CommandResult>;
  query(query: GlobalQuery, context: TrustedExecutionContext): QueryResult;
  resolveState(envelope: AgentCommandEnvelope | AgentQueryEnvelope, descriptor: OperationDescriptor, principal?: AgentPrincipal): GatewayResolvedState;
  recoverMaterializations(): Promise<void>;
  noteMaterializationJobTerminal(jobId: string, status: 'completed' | 'failed' | 'interrupted'): Promise<void>;
  stageSelectedDatabaseImport(filePath: string, context: TrustedExecutionContext, proof?: { readonly kind: 'main_process_selection' }): Promise<{ readonly importAssetId: string; readonly fileName: string; readonly contentHash: string; readonly contentSize: number; readonly semanticHash: string; readonly rowCount: number }>;
  stageSelectedDataRoot(rootPath: string, context: TrustedExecutionContext, proof?: { readonly kind: 'main_process_selection' }): Promise<{ readonly rootSelectionId: string; readonly status: 'published' }>;
}

function entities(envelope: AgentCommandEnvelope | AgentQueryEnvelope): readonly EntityRef[] {
  const payload = envelope.payload;
  const reference = typeof payload.backupId === 'string' ? ['backup', payload.backupId] as const
    : typeof payload.importAssetId === 'string' ? ['import_asset', payload.importAssetId] as const
      : typeof payload.batchId === 'string' ? ['import_batch', payload.batchId] as const
        : typeof payload.rootSelectionId === 'string' ? ['root_selection', payload.rootSelectionId] as const
          : typeof payload.exportId === 'string' ? ['export', payload.exportId] as const
            : [envelope.operation.replace(/\./g, '_'), hashCanonicalJson(payload)] as const;
  return Object.freeze([Object.freeze({ entityType: reference[0], entityId: reference[1] })]);
}

function sameVersion(left: { readonly dataEpoch: string; readonly dataRevision: number }, right: { readonly dataEpoch: string; readonly dataRevision: number }): boolean {
  return left.dataEpoch === right.dataEpoch && left.dataRevision === right.dataRevision;
}

function freezeResult<T>(changed: boolean, value: T, version: { readonly dataEpoch: string; readonly dataRevision: number }): CommandResult<T> {
  return Object.freeze({ changed, value, events: Object.freeze([]), dataVersion: Object.freeze({ ...version }) });
}

function deterministicAssetId(value: unknown): string {
  return `asset-${createHash('sha256').update(canonicalizeJson(value)).digest('hex').slice(0, 40)}`;
}

function deterministicUuid(value: unknown): string {
  const bytes = Buffer.from(createHash('sha256').update(canonicalizeJson(value)).digest('hex').slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function materializationPaths(paths: NonNullable<RegisterGlobalOptions['managedPaths']>) {
  const temp = path.normalize(paths.temp);
  return Object.freeze({
    backups: path.normalize(paths.backups), exports: path.normalize(paths.exports), imports: path.normalize(paths.imports ?? path.join(temp, 'database-imports')), temp,
    journal: path.normalize(paths.journal ?? path.join(temp, 'journal')),
    quarantine: path.normalize(paths.quarantine ?? path.join(temp, 'quarantine'))
  });
}

function sameEvidence(left: { readonly hash: string; readonly size: number }, right: { readonly hash: string; readonly size: number }): boolean {
  return left.hash === right.hash && left.size === right.size;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function deletionJournalId(assetId: string): string {
  return `backup-delete-${createHash('sha256').update(assetId).digest('hex').slice(0, 40)}`;
}

function restoreJournalId(assetId: string, requestId: string): string {
  return `database-restore-${createHash('sha256').update(`${assetId}\0${requestId}`).digest('hex').slice(0, 40)}`;
}

function importJournalId(assetId: string, requestId: string): string {
  return `database-import-${createHash('sha256').update(`${assetId}\0${requestId}`).digest('hex').slice(0, 40)}`;
}

function clearJournalId(requestId: string): string {
  return `database-clear-${createHash('sha256').update(requestId).digest('hex').slice(0, 40)}`;
}

function importBatchDeleteJournalId(batchId: string, requestId: string): string {
  return `import-batch-delete-${createHash('sha256').update(`${batchId}\0${requestId}`).digest('hex').slice(0, 40)}`;
}

function dataRootMigrationId(selectionId: string, requestId: string): string {
  return `data-root-${createHash('sha256').update(`${selectionId}\0${requestId}`).digest('hex').slice(0, 40)}`;
}

function backupDeletionPaths(options: RegisterGlobalOptions, asset: { readonly assetId: string; readonly internalPath: string }) {
  if (!options.managedPaths) throw new AgentError('RECOVERY_FENCE');
  const roots = materializationPaths(options.managedPaths);
  const source = path.normalize(asset.internalPath);
  const backups = path.normalize(roots.backups);
  if (!isWithin(backups, source) || !fs.existsSync(source)) throw new AgentError('RECOVERY_FENCE');
  const canonicalRoot = fs.realpathSync(backups);
  const canonicalSource = fs.realpathSync(source);
  if (!isWithin(canonicalRoot, canonicalSource)) throw new AgentError('RECOVERY_FENCE');
  const journalRoot = path.normalize(path.join(roots.journal, 'backup-deletions'));
  const quarantineRoot = path.normalize(path.join(roots.quarantine, 'backups'));
  const journalId = deletionJournalId(asset.assetId);
  return Object.freeze({ source, journalId, journalRoot, quarantineRoot,
    quarantinePath: path.normalize(path.join(quarantineRoot, `${journalId}.quarantine`)) });
}

function backupDeletionEvidence(options: RegisterGlobalOptions, asset: ReturnType<typeof getInternalGlobalAsset>, ownerClientId: string) {
  const resolved = managedBackupEvidence(options, asset, ownerClientId);
  const paths = backupDeletionPaths(options, resolved.asset as Required<Pick<NonNullable<typeof asset>, 'assetId' | 'internalPath'>>);
  return Object.freeze({ ...resolved, paths });
}

function managedBackupEvidence(options: RegisterGlobalOptions, asset: ReturnType<typeof getInternalGlobalAsset>, ownerClientId: string) {
  if (!asset || asset.ownerClientId !== ownerClientId || asset.kind !== 'backup' || asset.status !== 'published' ||
      !asset.internalPath || !asset.contentHash || asset.contentSize === undefined) throw new AgentError('HANDLER_NOT_FOUND');
  if (!options.managedPaths) throw new AgentError('RECOVERY_FENCE');
  const roots = materializationPaths(options.managedPaths);
  const source = path.normalize(asset.internalPath);
  const backups = path.normalize(roots.backups);
  if (!isWithin(backups, source) || !fs.existsSync(source)) throw new AgentError('RECOVERY_FENCE');
  const canonicalRoot = fs.realpathSync(backups);
  const canonicalSource = fs.realpathSync(source);
  if (!isWithin(canonicalRoot, canonicalSource)) throw new AgentError('RECOVERY_FENCE');
  const evidence = materializationEvidence(source);
  if (!sameEvidence(evidence, { hash: asset.contentHash, size: asset.contentSize })) throw new AgentError('RECOVERY_FENCE');
  return Object.freeze({ asset, source, evidence });
}

function managedDatabaseImportEvidence(options: RegisterGlobalOptions, asset: ReturnType<typeof getInternalGlobalAsset>, ownerClientId: string, allowConsumed = false) {
  if (!asset || asset.ownerClientId !== ownerClientId || asset.kind !== 'database_import' ||
      (asset.status !== 'published' && !(allowConsumed && asset.status === 'consumed')) ||
      !asset.internalPath || !asset.contentHash || asset.contentSize === undefined) throw new AgentError('HANDLER_NOT_FOUND');
  if (!options.managedPaths || !options.databaseImport) throw new AgentError('RECOVERY_FENCE');
  const metadata = asset.metadata;
  if (metadata.format !== 'kaoyan-full-data-v1' || metadata.version !== 1 || typeof metadata.fileName !== 'string' ||
      !/^sha256-v1:[0-9a-f]{64}$/.test(String(metadata.semanticHash)) || !Number.isSafeInteger(metadata.semanticSize) || Number(metadata.semanticSize) < 0 ||
      !Number.isSafeInteger(metadata.rowCount) || Number(metadata.rowCount) < 0 || !metadata.tableCounts || typeof metadata.tableCounts !== 'object' || Array.isArray(metadata.tableCounts)) throw new AgentError('RECOVERY_FENCE');
  let counted = 0;
  for (const [table, count] of Object.entries(metadata.tableCounts as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9_]{0,99}$/.test(table) || !Number.isSafeInteger(count) || Number(count) < 0) throw new AgentError('RECOVERY_FENCE');
    counted += Number(count);
  }
  if (counted !== metadata.rowCount) throw new AgentError('RECOVERY_FENCE');
  const roots = materializationPaths(options.managedPaths);
  const verified = verifyManagedDatabaseImport(asset.internalPath, roots.imports, { hash: asset.contentHash, size: asset.contentSize });
  const packageEvidence = Object.freeze({
    hash: verified.hash,
    size: verified.size,
    semanticHash: String(metadata.semanticHash),
    semanticSize: Number(metadata.semanticSize),
    rowCount: Number(metadata.rowCount),
    tableCounts: Object.freeze({ ...(metadata.tableCounts as Record<string, number>) })
  });
  return Object.freeze({ asset, source: path.normalize(asset.internalPath), bytes: verified.bytes, packageEvidence });
}


function intentOperation(command: GlobalCommand): command is Extract<GlobalCommand, { readonly type: 'backups.create' | 'exports.create' }> {
  return command.type === 'backups.create' || command.type === 'exports.create';
}

function materializeOperation(command: GlobalCommand): command is Extract<GlobalCommand, { readonly type: 'backups.materialize' | 'exports.materialize' }> {
  return command.type === 'backups.materialize' || command.type === 'exports.materialize';
}

function intentKind(command: Extract<GlobalCommand, { readonly type: 'backups.create' | 'exports.create' }>): 'backup' | 'export' {
  return command.type === 'backups.create' ? 'backup' : 'export';
}

export function registerGlobalApplication(options: RegisterGlobalOptions): GlobalApplication {
  const businessCapability = createDatabaseCoordinatorBusinessCapability(options.coordinator);
  const controlCapability = createDatabaseCoordinatorControlCapability(options.coordinator);
  const pagination = new PaginationService(options.cursorSecret ?? 'c13-global-default-cursor-secret-32-bytes');
  const now = options.now ?? (() => new Date().toISOString());
  const allocateUuid = options.randomUUID ?? randomUUID;

  const stageSelectedDatabaseImport = async (filePath: string, context: TrustedExecutionContext, proof?: { readonly kind: 'main_process_selection' }) => {
    if (!options.managedPaths || !options.databaseImport || context.source === 'mcp' || (context.source === 'renderer' && proof?.kind !== 'main_process_selection')) throw new AgentError('SCOPE_DENIED');
    const version = options.currentVersion();
    if (context.expectedVersion && !sameVersion(context.expectedVersion, version)) throw new AgentError('DATA_REVISION_CONFLICT');
    const paths = materializationPaths(options.managedPaths);
    const assetId = `asset-${allocateUuid().toLowerCase()}`;
    const plan = await planUserSelectedDatabaseImport(filePath, paths.imports, assetId);
    const inspected = await options.databaseImport.inspect(plan.bytes);
    const metadata = Object.freeze({
      format: inspected.format,
      version: inspected.version,
      fileName: plan.fileName,
      semanticHash: inspected.semanticHash,
      semanticSize: inspected.semanticSize,
      rowCount: inspected.rowCount,
      tableCounts: Object.freeze({ ...inspected.tableCounts })
    });
    await publishManagedDatabaseImport(plan, paths.imports);
    try {
      await options.coordinator.executeControlWrite(controlCapability, {
        requestId: `global-import-stage-${context.requestId}`,
        execute: (database, scope) => {
          createGlobalAsset(database, { assetId, ownerClientId: context.client.clientId, kind: 'database_import', metadata, internalPath: plan.internalPath, now: now() }, scope);
          const operationJournalId = `database-import-stage-${createHash('sha256').update(`${assetId}\0${context.requestId}`).digest('hex').slice(0, 40)}`;
          bindGlobalAssetMaterialization(database, assetId, { internalPath: plan.internalPath, contentHash: plan.contentHash, contentSize: plan.contentSize, operationJournalId }, now(), scope);
          transitionGlobalAsset(database, assetId, 'staged', now(), { operationJournalId }, scope);
          transitionGlobalAsset(database, assetId, 'published', now(), { operationJournalId }, scope);
          return { changed: true, value: undefined };
        }
      });
    } catch (error) {
      const existing = getInternalGlobalAsset(options.readOnlyDatabase, assetId);
      if (!existing) await removeManagedDatabaseImport(plan.internalPath, paths.imports).catch(() => undefined);
      throw error;
    }
    return Object.freeze({ importAssetId: assetId, fileName: plan.fileName, contentHash: plan.contentHash, contentSize: plan.contentSize, semanticHash: inspected.semanticHash, rowCount: inspected.rowCount });
  };

  const stageSelectedDataRoot = async (rootPath: string, context: TrustedExecutionContext, proof?: { readonly kind: 'main_process_selection' }) => {
    if (!options.dataRootMigration || context.source !== 'renderer' || context.client.clientId !== 'local-renderer-management' || proof?.kind !== 'main_process_selection') throw new AgentError('SCOPE_DENIED');
    const version = options.currentVersion();
    if (context.expectedVersion && !sameVersion(context.expectedVersion, version)) throw new AgentError('DATA_REVISION_CONFLICT');
    const selectionId = `asset-${allocateUuid().toLowerCase()}`;
    const plan = options.dataRootMigration.planSelection(rootPath, selectionId, now());
    await options.coordinator.executeControlWrite(controlCapability, {
      requestId: `global-root-selection-${context.requestId}`,
      execute: (database, scope) => {
        createGlobalAsset(database, { assetId: selectionId, ownerClientId: context.client.clientId, kind: 'root_selection',
          metadata: storedSelection(plan) as unknown as Record<string, unknown>, internalPath: plan.targetPath, now: now() }, scope);
        bindGlobalAssetMaterialization(database, selectionId, { internalPath: plan.targetPath, contentHash: plan.selectionBindingHash,
          contentSize: 0 }, now(), scope);
        transitionGlobalAsset(database, selectionId, 'staged', now(), {}, scope);
        transitionGlobalAsset(database, selectionId, 'published', now(), {}, scope);
        return { changed: true, value: undefined };
      }
    });
    return Object.freeze({ rootSelectionId: selectionId, status: 'published' as const });
  };

  const executeNoOp = async (command: GlobalCommand, context: TrustedExecutionContext, terminalHook?: DatabaseTerminalHook<CommandResult>): Promise<CommandResult> => {
    const terminal = await options.coordinator.executeBusinessWrite(businessCapability, {
      requestId: context.requestId,
      concurrency: context.concurrency,
      expectedVersion: context.expectedVersion,
      terminalHook,
      execute: () => ({ changed: false, value: Object.freeze({ operation: command.type, validated: true }) }),
      finalizeValue(value) {
        return freezeResult(value.semanticChanged, value.value, value.versionAfter);
      }
    });
    return terminal.value;
  };

  const executeIntent = async (
    command: Extract<GlobalCommand, { readonly type: 'backups.create' | 'exports.create' }>,
    context: TrustedExecutionContext,
    terminalHook: DatabaseTerminalHook<CommandResult> | undefined,
    principal: AgentPrincipal | undefined
  ): Promise<CommandResult<GlobalIntentResult>> => {
    const creatingSessionId = principal?.renderer ? localRendererJobSessionId : principal?.sessionId;
    if (!principal || !creatingSessionId || principal.clientId !== context.client.clientId || (principal.renderer && principal.clientId !== 'local-renderer-management')) throw new AgentError('SCOPE_DENIED');
    const version = options.currentVersion();
    if (context.expectedVersion && !sameVersion(context.expectedVersion, version)) throw new AgentError('DATA_REVISION_CONFLICT');
    const assetId = deterministicAssetId({ requestId: context.requestId, operation: command.type });
    const expectedVersion = context.expectedVersion ?? version;
    const kind = intentKind(command);
    const metadata = command.type === 'exports.create'
      ? { specification: command.payload.specification }
      : { backupKind: command.payload.kind };
    const control = await options.coordinator.executeControlWrite<CommandResult<GlobalIntentResult>>(controlCapability, {
      requestId: `global-intent-${context.requestId}`,
      execute: async (database, scope) => {
        const existing = getInternalGlobalAsset(database, assetId);
        const identity: JobCreateIdentity = Object.freeze({
          jobId: existing?.jobId ?? allocateUuid(),
          gatewayRequestId: deterministicUuid({ requestId: context.requestId, operation: `${command.type}.materialize` })
        });
        if (options.managedPaths && options.materializer) {
          const roots = materializationPaths(options.managedPaths);
          const journal = new MaterializationJournalStore(roots.journal, [roots.backups, roots.exports, roots.temp, roots.quarantine], options.materializationDurability);
          const finalPath = path.normalize(path.join(kind === 'backup' ? roots.backups : roots.exports, `${assetId}${kind === 'backup' ? '.db' : '.pdf'}`));
          const stagedPath = path.normalize(path.join(roots.temp, `${assetId}.${identity.jobId}.stage`));
          const quarantinePath = path.normalize(path.join(roots.quarantine, `${assetId}.${identity.jobId}.quarantine`));
          await journal.ensureIntent({ operationId: assetId, assetId, jobId: identity.jobId, requestId: identity.gatewayRequestId,
            ownerClientId: principal.clientId, sessionId: creatingSessionId, kind, expectedVersion, metadataHash: materializationMetadataHash(metadata),
            stagedPath, finalPath, quarantinePath }, now());
        }
        const asset = createGlobalAsset(database, {
          assetId,
          ownerClientId: principal.clientId,
          kind,
          metadata,
          jobId: identity.jobId,
          now: now()
        }, scope);
        const job = options.getJobs().createInTransaction(database, scope, {
          target: {
            operation: command.type === 'backups.create' ? 'backups.materialize' : 'exports.materialize',
            kind: 'command',
            payload: Object.freeze({ assetId }) as JsonObject,
            expectedVersion
          },
          retentionClass: 'protected_30d'
        }, principal, identity);
        const result = freezeResult(!existing || job.changed, Object.freeze({ assetId: asset.assetId, jobId: job.value.jobId, status: 'intent' as const }), version);
        let hookChanged = false;
        if (terminalHook) {
          const terminal = await terminalHook.execute(database, scope, {
            value: result,
            semanticChanged: result.changed,
            versionBefore: version,
            versionAfter: version,
            generationBefore: options.coordinator.currentGeneration(),
            generationAfterDataMutation: options.coordinator.currentGeneration()
          });
          hookChanged = terminal.changed;
        }
        return { changed: result.changed || hookChanged, value: result };
      }
    });
    return control.value;
  };

  const executeMaterialization = async (
    command: Extract<GlobalCommand, { readonly type: 'backups.materialize' | 'exports.materialize' }>,
    context: TrustedExecutionContext,
    terminalHook: DatabaseTerminalHook<CommandResult> | undefined,
    principal: AgentPrincipal | undefined
  ): Promise<CommandResult> => {
    if (!principal || !isDurableJobPrincipal(principal) || !principal.sessionId || principal.clientId !== context.client.clientId || !options.managedPaths || !options.materializer) throw new AgentError('SCOPE_DENIED');
    const kind = command.type === 'backups.materialize' ? 'backup' : 'export';
    let asset = getInternalGlobalAsset(options.readOnlyDatabase, command.payload.assetId);
    if (!asset || asset.ownerClientId !== principal.clientId || asset.kind !== kind || !asset.jobId) throw new AgentError('HANDLER_NOT_FOUND');
    const job = await options.getJobs().get(asset.jobId, principal);
    if (job.gatewayRequestId !== context.requestId || job.operation !== command.type || job.status !== 'running' || job.creatingSessionId !== principal.sessionId || !context.expectedVersion || !sameVersion(context.expectedVersion, options.currentVersion())) throw new AgentError('RECOVERY_FENCE');
    const paths = materializationPaths(options.managedPaths);
    for (const root of [paths.backups, paths.exports, paths.temp, paths.journal, paths.quarantine]) fs.mkdirSync(root, { recursive: true });
    const journal = new MaterializationJournalStore(paths.journal, [paths.backups, paths.exports, paths.temp, paths.quarantine], options.materializationDurability);
    const manifest = journal.read(asset.assetId);
    if (!manifest || manifest.jobId !== job.jobId || manifest.requestId !== job.gatewayRequestId || manifest.ownerClientId !== asset.ownerClientId ||
        manifest.sessionId !== job.creatingSessionId || manifest.kind !== kind || manifest.metadataHash !== materializationMetadataHash(asset.metadata) ||
        !sameVersion(manifest.expectedVersion, context.expectedVersion)) throw new AgentError('RECOVERY_FENCE');
    const publish = async (phase: MaterializationPhase, evidence?: { readonly hash: string; readonly size: number }) => {
      const next = await journal.advance(manifestRef.value, phase, now(), evidence);
      manifestRef.value = next;
      await options.materializationHook?.(phase, next);
      return next;
    };
    const manifestRef: { value: MaterializationManifest } = { value: manifest };
    const quarantine = async (reason: string): Promise<never> => {
      for (const [candidate, suffix] of [[manifestRef.value.stagedPath, 'stage'], [manifestRef.value.finalPath, 'final']] as const) {
        if (!fs.existsSync(candidate)) continue;
        const target = `${manifestRef.value.quarantinePath}.${suffix}`;
        await quarantineMaterializationFile(candidate, target, options.materializationDurability);
      }
      manifestRef.value = await journal.advance(manifestRef.value, 'needs_recovery', now(), undefined, reason);
      await options.materializationHook?.('needs_recovery', manifestRef.value);
      await markAssetNeedsRecovery(asset.assetId, job.jobId);
      throw new AgentError('RECOVERY_FENCE');
    };
    const stageEvidence = (): { readonly hash: string; readonly size: number } | undefined => fs.existsSync(manifestRef.value.stagedPath) ? materializationEvidence(manifestRef.value.stagedPath) : undefined;
    const finalEvidence = (): { readonly hash: string; readonly size: number } | undefined => fs.existsSync(manifestRef.value.finalPath) ? materializationEvidence(manifestRef.value.finalPath) : undefined;
    const markStaged = async (evidence: { readonly hash: string; readonly size: number }) => {
      await options.coordinator.executeControlWrite(controlCapability, { requestId: `global-stage-${job.jobId.replace(/-/g, '')}`, execute: (database, scope) => {
        const current = getInternalGlobalAsset(database, asset!.assetId);
        if (!current || (current.contentHash && (current.contentHash !== evidence.hash || current.contentSize !== evidence.size))) throw new AgentError('RECOVERY_FENCE');
        bindGlobalAssetMaterialization(database, asset!.assetId, { stagedPath: manifestRef.value.stagedPath, internalPath: manifestRef.value.finalPath, contentHash: evidence.hash, contentSize: evidence.size, operationJournalId: manifestRef.value.operationId }, now(), scope);
        if (current.status === 'intent') transitionGlobalAsset(database, asset!.assetId, 'staged', now(), { jobId: job.jobId, operationJournalId: manifestRef.value.operationId }, scope);
        return { changed: true, value: undefined };
      }});
    };
    const markPublished = async (evidence: { readonly hash: string; readonly size: number }, receiptResult?: CommandResult) => {
      await options.coordinator.executeControlWrite(controlCapability, { requestId: `global-publish-${job.jobId.replace(/-/g, '')}`, execute: async (database, scope) => {
        const current = getInternalGlobalAsset(database, asset!.assetId);
        if (!current || current.contentHash !== evidence.hash || current.contentSize !== evidence.size || current.internalPath !== manifestRef.value.finalPath) throw new AgentError('RECOVERY_FENCE');
        if (current.status === 'intent') transitionGlobalAsset(database, asset!.assetId, 'staged', now(), { jobId: job.jobId, operationJournalId: manifestRef.value.operationId }, scope);
        const staged = getInternalGlobalAsset(database, asset!.assetId)!;
        if (staged.status === 'staged') transitionGlobalAsset(database, asset!.assetId, 'published', now(), { jobId: job.jobId, operationJournalId: manifestRef.value.operationId }, scope);
        if (receiptResult && terminalHook) {
          await terminalHook.execute(database, scope, { value: receiptResult, semanticChanged: true, versionBefore: receiptResult.dataVersion,
            versionAfter: receiptResult.dataVersion, generationBefore: options.coordinator.currentGeneration(), generationAfterDataMutation: options.coordinator.currentGeneration() });
        }
        return { changed: true, value: undefined };
      }});
    };
    const markAssetNeedsRecovery = async (assetId: string, jobId: string) => {
      await options.coordinator.executeControlWrite(controlCapability, { requestId: `global-recovery-fence-${jobId.replace(/-/g, '')}`, execute: (database, scope) => {
        const current = getInternalGlobalAsset(database, assetId);
        if (current && current.status !== 'needs_recovery') transitionGlobalAsset(database, assetId, 'needs_recovery', now(), { jobId, operationJournalId: manifestRef.value.operationId }, scope);
        return { changed: true, value: undefined };
      }});
    };
    if (manifestRef.value.phase === 'needs_recovery') throw new AgentError('RECOVERY_FENCE');
    if (manifestRef.value.phase === 'intent') {
      if (fs.existsSync(manifestRef.value.finalPath)) await quarantine('final_without_staged_evidence');
      if (fs.existsSync(manifestRef.value.stagedPath)) await removeMaterializationFile(manifestRef.value.stagedPath, options.materializationDurability);
      await options.materializationHook?.('intent', manifestRef.value);
      const metadata = await options.materializer.stage({ kind, assetId: asset.assetId, metadata: asset.metadata, stagedPath: manifestRef.value.stagedPath });
      if (!metadata || typeof metadata !== 'object' || !fs.existsSync(manifestRef.value.stagedPath)) throw new AgentError('RECOVERY_FENCE');
      await flushMaterializationFile(manifestRef.value.stagedPath, options.materializationDurability);
      const evidence = stageEvidence(); if (!evidence) throw new AgentError('RECOVERY_FENCE');
      await publish('staged_file_written', evidence);
    }
    const evidence = manifestRef.value.evidence;
    if (!evidence) throw new AgentError('RECOVERY_FENCE');
    const staged = stageEvidence(); const final = finalEvidence();
    if ((staged && !sameEvidence(staged, evidence)) || (final && !sameEvidence(final, evidence)) || (staged && final)) await quarantine('materialized_file_mismatch_or_dual_file');
    if (manifestRef.value.phase === 'staged_file_written') { if (!staged) await quarantine('staged_file_missing'); await markStaged(evidence); await publish('staged_evidence_persisted', evidence); }
    if (manifestRef.value.phase === 'staged_evidence_persisted') {
      if (!final) { if (!staged) await quarantine('staged_file_missing'); await publishMaterializationFile(manifestRef.value.stagedPath, manifestRef.value.finalPath, options.materializationDurability); }
      const published = finalEvidence(); if (!published || !sameEvidence(published, evidence)) await quarantine('published_file_mismatch');
      await publish('final_file_published', evidence);
    }
    const result = freezeResult(true, Object.freeze({ assetId: asset.assetId, status: 'published', size: evidence.size }), options.currentVersion());
    if (manifestRef.value.phase === 'final_file_published') {
      await publish('published_evidence_persisted', evidence);
      await markPublished(evidence, result);
      if (terminalHook) await publish('terminal_receipt_persisted', evidence);
    }
    if (manifestRef.value.phase === 'published_evidence_persisted' && terminalHook) {
      // This state is only reachable after a crash before the publication/receipt transaction. Re-run it atomically.
      await markPublished(evidence, result);
      await publish('terminal_receipt_persisted', evidence);
    }
    return result;
  };

  const executeBackupDeletion = async (
    command: Extract<GlobalCommand, { readonly type: 'backups.delete' }>,
    context: TrustedExecutionContext,
    terminalHook: DatabaseTerminalHook<CommandResult> | undefined,
    principal: AgentPrincipal | undefined
  ): Promise<CommandResult> => {
    if (!principal || principal.clientId !== context.client.clientId || !terminalHook) throw new AgentError('SCOPE_DENIED');
    const resolved = backupDeletionEvidence(options, getInternalGlobalAsset(options.readOnlyDatabase, command.payload.backupId), principal.clientId);
    const version = options.currentVersion();
    if (!sameVersion(context.expectedVersion ?? version, version)) throw new AgentError('DATA_REVISION_CONFLICT');
    const { asset, paths, evidence } = resolved;
    const targetHash = hashCanonicalJson({ operation: command.type, backupId: asset.assetId, evidence });
    fs.mkdirSync(paths.journalRoot, { recursive: true });
    fs.mkdirSync(paths.quarantineRoot, { recursive: true });
    await options.coordinator.executeControlWrite(controlCapability, {
      requestId: `global-delete-intent-${paths.journalId}`,
      execute: (database, scope) => {
        // Admission is verified before creating durable intent or moving a file.
        const admission = assertBackupDeletionReceiptTarget(database, principal.clientId, context.requestId, targetHash, scope);
        const status = ensureBackupDeletionJournal(database, { journalId: paths.journalId, assetId: asset.assetId, ownerClientId: principal.clientId, contentHash: evidence.hash, contentSize: evidence.size, targetHash, admission, now: now() }, scope);
        if (!['intent', 'moved'].includes(status)) throw new AgentError('RECOVERY_FENCE');
        return { changed: status === 'intent', value: undefined };
      }
    });
    if (fs.existsSync(paths.source)) {
      const current = materializationEvidence(paths.source);
      if (!sameEvidence(current, evidence)) throw new AgentError('RECOVERY_FENCE');
      await quarantineMaterializationFile(paths.source, paths.quarantinePath, options.materializationDurability);
      await options.backupDeletionFaultHook?.('after_quarantine_rename', paths.journalId);
    } else if (!fs.existsSync(paths.quarantinePath) || !sameEvidence(materializationEvidence(paths.quarantinePath), evidence)) {
      throw new AgentError('RECOVERY_FENCE');
    }
    await options.coordinator.executeControlWrite(controlCapability, {
      requestId: `global-delete-moved-${paths.journalId}`,
      execute: (database, scope) => {
        const changed = transitionBackupDeletionJournal(database, paths.journalId, 'intent', 'moved', now(), scope);
        if (!changed && backupDeletionJournalStatus(database, paths.journalId) !== 'moved') throw new AgentError('RECOVERY_FENCE');
        return { changed, value: undefined };
      }
    });
    const terminal = await options.coordinator.executeControlWrite(controlCapability, {
      requestId: `global-delete-terminal-${paths.journalId}`,
      execute: async (database, scope) => {
        const current = getInternalGlobalAsset(database, asset.assetId);
        if (!current || current.ownerClientId !== principal.clientId || current.status !== 'published' || current.contentHash !== evidence.hash || current.contentSize !== evidence.size) throw new AgentError('RECOVERY_FENCE');
        assertBackupDeletionReceiptTarget(database, principal.clientId, context.requestId, targetHash, scope);
        transitionGlobalAsset(database, asset.assetId, 'quarantined', now(), { operationJournalId: paths.journalId }, scope);
        if (!transitionBackupDeletionJournal(database, paths.journalId, 'moved', 'completed', now(), scope)) throw new AgentError('RECOVERY_FENCE');
        const result = freezeResult(true, Object.freeze({ backupId: asset.assetId, status: 'quarantined' as const }), version);
        if (terminalHook) {
          await terminalHook.execute(database, scope, {
            value: result, semanticChanged: true, versionBefore: version, versionAfter: version,
            generationBefore: options.coordinator.currentGeneration(), generationAfterDataMutation: options.coordinator.currentGeneration()
          });
        }
        return { changed: true, value: result };
      }
    });
    return terminal.value;
  };

  const executeDatabaseRestore = async (
    command: Extract<GlobalCommand, { readonly type: 'database.restore' }>,
    context: TrustedExecutionContext,
    terminalHook: DatabaseTerminalHook<CommandResult> | undefined,
    principal: AgentPrincipal | undefined
  ): Promise<CommandResult> => {
    if (!principal || principal.clientId !== context.client.clientId || !terminalHook || !options.databaseRestore) throw new AgentError('SCOPE_DENIED');
    const resolved = managedBackupEvidence(options, getInternalGlobalAsset(options.readOnlyDatabase, command.payload.backupId), principal.clientId);
    const version = options.currentVersion();
    if (!sameVersion(context.expectedVersion ?? version, version)) throw new AgentError('DATA_REVISION_CONFLICT');
    const affectedEntities = Object.freeze([Object.freeze({ entityType: 'backup', entityId: resolved.asset.assetId })]);
    const targetHash = hashCanonicalJson({ operation: command.type, backupId: resolved.asset.assetId, evidence: resolved.evidence });
    const operationId = restoreJournalId(resolved.asset.assetId, context.requestId);
    const paths = materializationPaths(options.managedPaths!);
    const restoreJournal = new DatabaseRestoreJournalStore(path.normalize(path.join(paths.journal, 'database-restores')), options.materializationDurability);
    let manifest: DatabaseRestoreManifest;
    await options.coordinator.executeControlWrite(controlCapability, {
      requestId: `global-restore-intent-${operationId}`,
      execute: (database, scope) => {
        const admission = assertDatabaseRestoreReceiptTarget(database, principal.clientId, context.requestId, targetHash, scope);
        manifest = Object.freeze({
          schemaVersion: 1 as const,
          operationId,
          ownerClientId: principal.clientId,
          requestId: context.requestId,
          receiptId: admission.receiptId,
          receiptOperation: admission.receiptOperation,
          receiptPayloadHash: admission.receiptPayloadHash,
          risk: admission.risk,
          reservationId: admission.reservationId,
          grantId: admission.grantId,
          ...(admission.changeSetId ? { changeSetId: admission.changeSetId } : {}),
          restorePayloadHash: admission.restorePayloadHash,
          affectedSetHash: admission.affectedSetHash,
          targetHash,
          recovery: admission.recovery,
          maxAffectedEntities: admission.maxAffectedEntities,
          reservationExpiresAt: admission.reservationExpiresAt,
          reservedAt: admission.reservedAt,
          receiptCreatedAt: admission.receiptCreatedAt,
          backup: Object.freeze({
            assetId: resolved.asset.assetId,
            contentHash: resolved.evidence.hash,
            contentSize: resolved.evidence.size,
            internalPath: resolved.source
          }),
          baseVersion: Object.freeze({ ...version }),
          catalog: Object.freeze({ ...operationCatalogIdentity }),
          phase: 'intent' as const,
          createdAt: now(),
          updatedAt: now()
        });
        return { changed: false, value: undefined };
      }
    });
    const intent = await restoreJournal.ensureIntent({
      operationId: manifest!.operationId,
      ownerClientId: manifest!.ownerClientId,
      requestId: manifest!.requestId,
      receiptId: manifest!.receiptId,
      receiptOperation: manifest!.receiptOperation,
      reservationId: manifest!.reservationId,
      grantId: manifest!.grantId,
      ...(manifest!.changeSetId ? { changeSetId: manifest!.changeSetId } : {}),
      affectedSetHash: manifest!.affectedSetHash,
      targetHash: manifest!.targetHash,
      backup: manifest!.backup,
      baseVersion: manifest!.baseVersion,
      catalog: manifest!.catalog,
      receiptPayloadHash: manifest!.receiptPayloadHash,
      risk: manifest!.risk,
      restorePayloadHash: manifest!.restorePayloadHash,
      recovery: manifest!.recovery,
      maxAffectedEntities: manifest!.maxAffectedEntities,
      reservationExpiresAt: manifest!.reservationExpiresAt,
      reservedAt: manifest!.reservedAt,
      receiptCreatedAt: manifest!.receiptCreatedAt,
      ...(manifest!.versionAfter ? { versionAfter: manifest!.versionAfter } : {}),
      ...(manifest!.recoveryDatabasePath ? { recoveryDatabasePath: manifest!.recoveryDatabasePath } : {}),
      ...(manifest!.recoveryDatabaseEvidence ? { recoveryDatabaseEvidence: manifest!.recoveryDatabaseEvidence } : {}),
      ...(manifest!.liveDatabaseEvidence ? { liveDatabaseEvidence: manifest!.liveDatabaseEvidence } : {})
    }, now());
    let currentManifest = intent;
    let restored: { readonly versionAfter: { readonly dataEpoch: string; readonly dataRevision: number }; readonly recoveryDatabasePath: string };
    try {
      restored = await options.databaseRestore({
        backupPath: resolved.source,
        operationId,
        manifest: currentManifest,
        now,
        async onStage(stage, evidence) {
          const phase = stage === 'backup_validated' ? 'backup_validated' : stage === 'recovery_package_staged' ? 'recovery_published' : 'live_published';
          currentManifest = await restoreJournal.advance(currentManifest, phase, now(), {
            ...(evidence?.versionAfter ? { versionAfter: evidence.versionAfter } : {}),
            ...(evidence?.recoveryDatabasePath ? { recoveryDatabasePath: evidence.recoveryDatabasePath } : {}),
            ...(evidence?.recoveryDatabaseEvidence ? { recoveryDatabaseEvidence: evidence.recoveryDatabaseEvidence } : {}),
            ...(evidence?.liveDatabaseEvidence ? { liveDatabaseEvidence: evidence.liveDatabaseEvidence } : {})
          });
        }
      });
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      if (code.startsWith('BACKUP_')) throw new AgentError('HANDLER_NOT_FOUND');
      throw error;
    }
    currentManifest = restoreJournal.read(operationId) ?? currentManifest;
    if (currentManifest.phase !== 'completed') {
      if (!currentManifest.liveDatabaseEvidence) throw new AgentError('RECOVERY_FENCE');
      currentManifest = await restoreJournal.advance(currentManifest, 'completed', now(), {
        versionAfter: restored.versionAfter,
        recoveryDatabasePath: restored.recoveryDatabasePath,
        ...(currentManifest.recoveryDatabaseEvidence ? { recoveryDatabaseEvidence: currentManifest.recoveryDatabaseEvidence } : {}),
        liveDatabaseEvidence: currentManifest.liveDatabaseEvidence
      });
    }
    return freezeResult(true, Object.freeze({ backupId: resolved.asset.assetId, restored: true }), restored.versionAfter);
  };

  const executeDatabaseImport = async (
    command: Extract<GlobalCommand, { readonly type: 'database.replace_from_import' }>,
    context: TrustedExecutionContext,
    terminalHook: DatabaseTerminalHook<CommandResult> | undefined,
    principal: AgentPrincipal | undefined
  ): Promise<CommandResult> => {
    if (!principal || principal.clientId !== context.client.clientId || !terminalHook || !options.databaseImport) throw new AgentError('SCOPE_DENIED');
    const resolved = managedDatabaseImportEvidence(options, getInternalGlobalAsset(options.readOnlyDatabase, command.payload.importAssetId), principal.clientId);
    const version = options.currentVersion();
    if (!sameVersion(context.expectedVersion ?? version, version)) throw new AgentError('DATA_REVISION_CONFLICT');
    const affectedEntities = Object.freeze([Object.freeze({ entityType: 'import_asset', entityId: resolved.asset.assetId })]);
    const targetHash = hashCanonicalJson({ operation: command.type, importAssetId: resolved.asset.assetId, evidence: resolved.packageEvidence });
    const operationId = importJournalId(resolved.asset.assetId, context.requestId);
    const paths = materializationPaths(options.managedPaths!);
    const importJournal = new DatabaseImportJournalStore(path.normalize(path.join(paths.journal, 'database-imports')), options.materializationDurability);
    let manifest: DatabaseImportManifest;
    await options.coordinator.executeControlWrite(controlCapability, {
      requestId: `global-import-intent-${operationId}`,
      execute: (database, scope) => {
        const admission = assertDatabaseImportReceiptTarget(database, principal.clientId, context.requestId, targetHash, scope);
        manifest = Object.freeze({
          schemaVersion: 1 as const,
          operationId,
          ownerClientId: principal.clientId,
          requestId: context.requestId,
          receiptId: admission.receiptId,
          receiptOperation: admission.receiptOperation,
          receiptPayloadHash: admission.receiptPayloadHash,
          risk: admission.risk,
          reservationId: admission.reservationId,
          grantId: admission.grantId,
          ...(admission.changeSetId ? { changeSetId: admission.changeSetId } : {}),
          importPayloadHash: admission.importPayloadHash,
          affectedSetHash: admission.affectedSetHash,
          targetHash,
          recovery: admission.recovery,
          maxAffectedEntities: admission.maxAffectedEntities,
          reservationExpiresAt: admission.reservationExpiresAt,
          reservedAt: admission.reservedAt,
          receiptCreatedAt: admission.receiptCreatedAt,
          package: Object.freeze({
            assetId: resolved.asset.assetId,
            contentHash: resolved.packageEvidence.hash,
            contentSize: resolved.packageEvidence.size,
            semanticHash: resolved.packageEvidence.semanticHash,
            rowCount: resolved.packageEvidence.rowCount,
            internalPath: resolved.source
          }),
          baseVersion: Object.freeze({ ...version }),
          catalog: Object.freeze({ ...operationCatalogIdentity }),
          phase: 'intent' as const,
          createdAt: now(),
          updatedAt: now()
        });
        return { changed: false, value: undefined };
      }
    });
    let currentManifest = await importJournal.ensureIntent({
      operationId: manifest!.operationId,
      ownerClientId: manifest!.ownerClientId,
      requestId: manifest!.requestId,
      receiptId: manifest!.receiptId,
      receiptOperation: manifest!.receiptOperation,
      receiptPayloadHash: manifest!.receiptPayloadHash,
      risk: manifest!.risk,
      reservationId: manifest!.reservationId,
      grantId: manifest!.grantId,
      ...(manifest!.changeSetId ? { changeSetId: manifest!.changeSetId } : {}),
      importPayloadHash: manifest!.importPayloadHash,
      affectedSetHash: manifest!.affectedSetHash,
      targetHash: manifest!.targetHash,
      recovery: manifest!.recovery,
      maxAffectedEntities: manifest!.maxAffectedEntities,
      reservationExpiresAt: manifest!.reservationExpiresAt,
      reservedAt: manifest!.reservedAt,
      receiptCreatedAt: manifest!.receiptCreatedAt,
      package: manifest!.package,
      baseVersion: manifest!.baseVersion,
      catalog: manifest!.catalog
    }, now());
    let replaced: { readonly versionAfter: { readonly dataEpoch: string; readonly dataRevision: number }; readonly recoveryDatabasePath: string };
    try {
      replaced = await options.databaseImport.replace({
        packagePath: resolved.source,
        operationId,
        manifest: currentManifest,
        now,
        async onStage(stage, evidence) {
          const phase = stage === 'package_validated' ? 'package_validated' : stage === 'recovery_package_staged' ? 'recovery_published' : 'live_published';
          currentManifest = await importJournal.advance(currentManifest, phase, now(), {
            ...(evidence?.versionAfter ? { versionAfter: evidence.versionAfter } : {}),
            ...(evidence?.recoveryDatabasePath ? { recoveryDatabasePath: evidence.recoveryDatabasePath } : {}),
            ...(evidence?.recoveryDatabaseEvidence ? { recoveryDatabaseEvidence: evidence.recoveryDatabaseEvidence } : {}),
            ...(evidence?.liveDatabaseEvidence ? { liveDatabaseEvidence: evidence.liveDatabaseEvidence } : {})
          });
        }
      });
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      if (code.startsWith('IMPORT_PACKAGE') || code.startsWith('IMPORT_MANAGED')) throw new AgentError('HANDLER_NOT_FOUND');
      throw error;
    }
    currentManifest = importJournal.read(operationId) ?? currentManifest;
    if (currentManifest.phase !== 'completed') {
      if (!currentManifest.liveDatabaseEvidence) throw new AgentError('RECOVERY_FENCE');
      currentManifest = await importJournal.advance(currentManifest, 'completed', now(), {
        versionAfter: replaced.versionAfter,
        recoveryDatabasePath: replaced.recoveryDatabasePath,
        ...(currentManifest.recoveryDatabaseEvidence ? { recoveryDatabaseEvidence: currentManifest.recoveryDatabaseEvidence } : {}),
        liveDatabaseEvidence: currentManifest.liveDatabaseEvidence
      });
    }
    return freezeResult(true, Object.freeze({ importAssetId: resolved.asset.assetId, replaced: true }), replaced.versionAfter);
  };

  const executeDatabaseClear = async (
    command: Extract<GlobalCommand, { readonly type: 'database.clear_all' }>,
    context: TrustedExecutionContext,
    terminalHook: DatabaseTerminalHook<CommandResult> | undefined,
    principal: AgentPrincipal | undefined
  ): Promise<CommandResult> => {
    if (!principal || principal.clientId !== context.client.clientId || !terminalHook || !options.databaseClear || !options.managedPaths) {
      throw new AgentError('SCOPE_DENIED');
    }
    const resolution = options.databaseClear.resolve(command.payload.deleteManagedImages);
    const version = options.currentVersion();
    if (!sameVersion(context.expectedVersion ?? version, version) || !sameVersion(resolution.dataVersion, version) ||
        resolution.affectedEntityCount !== resolution.affectedEntities.length || resolution.affectedEntityCount > 500 ||
        resolution.affectedSetHash !== hashCanonicalJson(resolution.affectedEntities)) throw new AgentError('DATA_REVISION_CONFLICT');
    const operationId = clearJournalId(context.requestId);
    const paths = materializationPaths(options.managedPaths);
    const store = new DatabaseClearJournalStore(path.normalize(path.join(paths.journal, 'database-clears')), options.materializationDurability);
    let manifest: DatabaseClearManifest;
    await options.coordinator.executeControlWrite(controlCapability, {
      requestId: `global-clear-intent-${operationId}`,
      execute: (database, scope) => {
        const admission = assertDatabaseClearReceiptTarget(database, principal.clientId, context.requestId, {
          targetHash: resolution.targetHash,
          affectedSetHash: resolution.affectedSetHash,
          baseVersion: version,
          catalog: operationCatalogIdentity
        }, scope);
        if (admission.clearPayloadHash !== hashCanonicalJson(command.payload)) throw new AgentError('RECOVERY_FENCE');
        manifest = Object.freeze({
          schemaVersion: 1 as const,
          operationId,
          ownerClientId: principal.clientId,
          requestId: context.requestId,
          receiptId: admission.receiptId,
          receiptOperation: admission.receiptOperation,
          receiptPayloadHash: admission.receiptPayloadHash,
          risk: admission.risk,
          reservationId: admission.reservationId,
          grantId: admission.grantId,
          ...(admission.changeSetId ? { changeSetId: admission.changeSetId } : {}),
          clearPayloadHash: admission.clearPayloadHash,
          affectedSetHash: resolution.affectedSetHash,
          targetHash: resolution.targetHash,
          recovery: admission.recovery,
          maxAffectedEntities: admission.maxAffectedEntities,
          reservationExpiresAt: admission.reservationExpiresAt,
          reservedAt: admission.reservedAt,
          receiptCreatedAt: admission.receiptCreatedAt,
          deleteManagedImages: resolution.deleteManagedImages,
          businessRowCount: resolution.businessRowCount,
          managedImageCount: resolution.managedImageCount,
          affectedEntityCount: resolution.affectedEntityCount,
          affectedEntities: resolution.affectedEntities,
          inventoryHash: resolution.inventoryHash,
          managedFiles: resolution.managedFiles,
          baseVersion: Object.freeze({ ...version }),
          catalog: Object.freeze({ ...operationCatalogIdentity }),
          phase: 'intent' as const,
          createdAt: now(),
          updatedAt: now()
        });
        return { changed: false, value: undefined };
      }
    });
    let currentManifest = await store.ensureIntent({
      operationId: manifest!.operationId,
      ownerClientId: manifest!.ownerClientId,
      requestId: manifest!.requestId,
      receiptId: manifest!.receiptId,
      receiptOperation: manifest!.receiptOperation,
      receiptPayloadHash: manifest!.receiptPayloadHash,
      risk: manifest!.risk,
      reservationId: manifest!.reservationId,
      grantId: manifest!.grantId,
      ...(manifest!.changeSetId ? { changeSetId: manifest!.changeSetId } : {}),
      clearPayloadHash: manifest!.clearPayloadHash,
      affectedSetHash: manifest!.affectedSetHash,
      targetHash: manifest!.targetHash,
      recovery: manifest!.recovery,
      maxAffectedEntities: manifest!.maxAffectedEntities,
      reservationExpiresAt: manifest!.reservationExpiresAt,
      reservedAt: manifest!.reservedAt,
      receiptCreatedAt: manifest!.receiptCreatedAt,
      deleteManagedImages: manifest!.deleteManagedImages,
      businessRowCount: manifest!.businessRowCount,
      managedImageCount: manifest!.managedImageCount,
      affectedEntityCount: manifest!.affectedEntityCount,
      affectedEntities: manifest!.affectedEntities,
      inventoryHash: manifest!.inventoryHash,
      managedFiles: manifest!.managedFiles,
      baseVersion: manifest!.baseVersion,
      catalog: manifest!.catalog
    }, now());
    const replaced = await options.databaseClear.replace({
      operationId,
      manifest: currentManifest,
      resolution,
      now,
      async onStage(stage, evidence) {
        if (stage === 'cleanup_reconciled') return;
        if (stage === 'inventory_validated') {
          currentManifest = await store.advance(currentManifest, 'inventory_validated', now());
          return;
        }
        if (stage === 'recovery_package_staged') {
          currentManifest = await store.advance(currentManifest, 'recovery_published', now(), {
            recoveryDatabasePath: evidence?.recoveryDatabasePath,
            recoveryDatabaseEvidence: evidence?.recoveryDatabaseEvidence,
            recoveryInventoryPath: evidence?.recoveryInventoryPath,
            recoveryInventoryEvidence: evidence?.recoveryInventoryEvidence
          });
          return;
        }
        if (stage === 'files_quarantined') {
          currentManifest = await store.advance(currentManifest, 'files_quarantined', now(), {
            recoveryDatabasePath: evidence?.recoveryDatabasePath,
            recoveryDatabaseEvidence: evidence?.recoveryDatabaseEvidence,
            recoveryInventoryPath: evidence?.recoveryInventoryPath,
            recoveryInventoryEvidence: evidence?.recoveryInventoryEvidence
          });
          return;
        }
        currentManifest = await store.advance(currentManifest, 'live_published', now(), {
          versionAfter: evidence?.versionAfter,
          recoveryDatabasePath: evidence?.recoveryDatabasePath,
          recoveryDatabaseEvidence: evidence?.recoveryDatabaseEvidence,
          recoveryInventoryPath: evidence?.recoveryInventoryPath,
          recoveryInventoryEvidence: evidence?.recoveryInventoryEvidence,
          liveDatabaseEvidence: evidence?.liveDatabaseEvidence
        });
      }
    });
    currentManifest = store.read(operationId) ?? currentManifest;
    if (currentManifest.phase !== 'completed' || !sameVersion(currentManifest.versionAfter!, replaced.versionAfter)) throw new AgentError('RECOVERY_FENCE');
    return freezeResult(true, Object.freeze({
      cleared: true as const,
      deleteManagedImages: currentManifest.deleteManagedImages,
      businessRowCount: currentManifest.businessRowCount,
      managedImageCount: currentManifest.managedImageCount
    }), replaced.versionAfter);
  };

  const executeImportBatchDeletion = async (
    command: Extract<GlobalCommand, { readonly type: 'imports.delete_batch' }>,
    context: TrustedExecutionContext,
    terminalHook: DatabaseTerminalHook<CommandResult> | undefined,
    principal: AgentPrincipal | undefined
  ): Promise<CommandResult> => {
    if (!principal || principal.clientId !== context.client.clientId || !terminalHook || !options.importBatchDelete || !options.managedPaths) {
      throw new AgentError('SCOPE_DENIED');
    }
    const identity = Object.freeze({ clientId: principal.clientId, renderer: principal.renderer === true });
    const resolution = options.importBatchDelete.resolve(command.payload.batchId, command.payload.deleteManagedAssets, identity);
    const version = options.currentVersion();
    if (!sameVersion(context.expectedVersion ?? version, version) || !sameVersion(resolution.dataVersion, version) ||
        resolution.affectedEntityCount !== resolution.affectedEntities.length || resolution.affectedEntityCount > 500 ||
        resolution.affectedSetHash !== hashCanonicalJson(resolution.affectedEntities)) throw new AgentError('DATA_REVISION_CONFLICT');
    const operationId = importBatchDeleteJournalId(resolution.batchId, context.requestId);
    const paths = materializationPaths(options.managedPaths);
    const store = new ImportBatchDeletionJournalStore(path.normalize(path.join(paths.journal, 'import-batch-deletions')), options.materializationDurability);
    let manifest: ImportBatchDeletionManifest;
    await options.coordinator.executeControlWrite(controlCapability, {
      requestId: `global-import-batch-delete-intent-${operationId}`,
      execute: (database, scope) => {
        const admission = assertImportBatchDeletionReceiptTarget(database, principal.clientId, context.requestId, {
          targetHash: resolution.targetHash,
          affectedSetHash: resolution.affectedSetHash,
          baseVersion: version,
          catalog: operationCatalogIdentity
        }, scope);
        if (admission.deletePayloadHash !== hashCanonicalJson(command.payload)) throw new AgentError('RECOVERY_FENCE');
        const timestamp = now();
        manifest = Object.freeze({
          schemaVersion: 1 as const,
          operationId,
          ownerClientId: principal.clientId,
          requestId: context.requestId,
          receiptId: admission.receiptId,
          receiptOperation: admission.receiptOperation,
          receiptPayloadHash: admission.receiptPayloadHash,
          risk: admission.risk,
          reservationId: admission.reservationId,
          grantId: admission.grantId,
          ...(admission.changeSetId ? { changeSetId: admission.changeSetId } : {}),
          deletePayloadHash: admission.deletePayloadHash,
          affectedSetHash: resolution.affectedSetHash,
          targetHash: resolution.targetHash,
          recovery: admission.recovery,
          maxAffectedEntities: admission.maxAffectedEntities,
          reservationExpiresAt: admission.reservationExpiresAt,
          reservedAt: admission.reservedAt,
          receiptCreatedAt: admission.receiptCreatedAt,
          batchId: resolution.batchId,
          batchType: resolution.batchType,
          batchOwnerClientId: resolution.batchOwnerClientId,
          ownershipPolicy: resolution.ownershipPolicy,
          deleteManagedAssets: resolution.deleteManagedAssets,
          deletedAt: timestamp,
          deletedQuestionCount: resolution.deletedQuestionCount,
          deletedExternalQuestionCount: resolution.deletedExternalQuestionCount,
          deletedAttemptCount: resolution.deletedAttemptCount,
          softDeletedKnowledgeCount: resolution.softDeletedKnowledgeCount,
          managedFileCount: resolution.managedFileCount,
          quarantinedFileCount: resolution.quarantinedFileCount,
          affectedEntityCount: resolution.affectedEntityCount,
          inventoryRows: resolution.inventoryRows,
          managedFiles: resolution.managedFiles,
          affectedEntities: resolution.affectedEntities,
          inventoryHash: resolution.inventoryHash,
          baseVersion: Object.freeze({ ...version }),
          catalog: Object.freeze({ ...operationCatalogIdentity }),
          phase: 'intent' as const,
          createdAt: timestamp,
          updatedAt: timestamp
        });
        return { changed: false, value: undefined };
      }
    });
    let currentManifest = await store.ensureIntent({
      operationId: manifest!.operationId,
      ownerClientId: manifest!.ownerClientId,
      requestId: manifest!.requestId,
      receiptId: manifest!.receiptId,
      receiptOperation: manifest!.receiptOperation,
      receiptPayloadHash: manifest!.receiptPayloadHash,
      risk: manifest!.risk,
      reservationId: manifest!.reservationId,
      grantId: manifest!.grantId,
      ...(manifest!.changeSetId ? { changeSetId: manifest!.changeSetId } : {}),
      deletePayloadHash: manifest!.deletePayloadHash,
      affectedSetHash: manifest!.affectedSetHash,
      targetHash: manifest!.targetHash,
      recovery: manifest!.recovery,
      maxAffectedEntities: manifest!.maxAffectedEntities,
      reservationExpiresAt: manifest!.reservationExpiresAt,
      reservedAt: manifest!.reservedAt,
      receiptCreatedAt: manifest!.receiptCreatedAt,
      batchId: manifest!.batchId,
      batchType: manifest!.batchType,
      batchOwnerClientId: manifest!.batchOwnerClientId,
      ownershipPolicy: manifest!.ownershipPolicy,
      deleteManagedAssets: manifest!.deleteManagedAssets,
      deletedAt: manifest!.deletedAt,
      deletedQuestionCount: manifest!.deletedQuestionCount,
      deletedExternalQuestionCount: manifest!.deletedExternalQuestionCount,
      deletedAttemptCount: manifest!.deletedAttemptCount,
      softDeletedKnowledgeCount: manifest!.softDeletedKnowledgeCount,
      managedFileCount: manifest!.managedFileCount,
      quarantinedFileCount: manifest!.quarantinedFileCount,
      affectedEntityCount: manifest!.affectedEntityCount,
      inventoryRows: manifest!.inventoryRows,
      managedFiles: manifest!.managedFiles,
      affectedEntities: manifest!.affectedEntities,
      inventoryHash: manifest!.inventoryHash,
      baseVersion: manifest!.baseVersion,
      catalog: manifest!.catalog
    }, manifest!.createdAt);
    const replaced = await options.importBatchDelete.replace({
      operationId,
      manifest: currentManifest,
      resolution,
      now,
      async onStage(stage, evidence) {
        if (stage === 'cleanup_reconciled') return;
        if (stage === 'inventory_validated') {
          currentManifest = await store.advance(currentManifest, 'inventory_validated', now());
          return;
        }
        if (stage === 'recovery_package_staged') {
          currentManifest = await store.advance(currentManifest, 'recovery_published', now(), {
            recoveryDatabasePath: evidence?.recoveryDatabasePath,
            recoveryDatabaseEvidence: evidence?.recoveryDatabaseEvidence,
            recoveryInventoryPath: evidence?.recoveryInventoryPath,
            recoveryInventoryEvidence: evidence?.recoveryInventoryEvidence
          });
          return;
        }
        if (stage === 'files_quarantined') {
          currentManifest = await store.advance(currentManifest, 'files_quarantined', now(), {
            recoveryDatabasePath: evidence?.recoveryDatabasePath,
            recoveryDatabaseEvidence: evidence?.recoveryDatabaseEvidence,
            recoveryInventoryPath: evidence?.recoveryInventoryPath,
            recoveryInventoryEvidence: evidence?.recoveryInventoryEvidence
          });
          return;
        }
        currentManifest = await store.advance(currentManifest, 'live_published', now(), {
          versionAfter: evidence?.versionAfter,
          recoveryDatabasePath: evidence?.recoveryDatabasePath,
          recoveryDatabaseEvidence: evidence?.recoveryDatabaseEvidence,
          recoveryInventoryPath: evidence?.recoveryInventoryPath,
          recoveryInventoryEvidence: evidence?.recoveryInventoryEvidence,
          liveDatabaseEvidence: evidence?.liveDatabaseEvidence
        });
      }
    });
    currentManifest = store.read(operationId) ?? currentManifest;
    if (currentManifest.phase !== 'completed' || !currentManifest.versionAfter || !sameVersion(currentManifest.versionAfter, replaced.versionAfter)) {
      throw new AgentError('RECOVERY_FENCE');
    }
    return freezeResult(true, Object.freeze({
      batchId: currentManifest.batchId,
      status: 'deleted' as const,
      deleteManagedAssets: currentManifest.deleteManagedAssets,
      deletedQuestions: currentManifest.deletedQuestionCount,
      deletedExternalQuestions: currentManifest.deletedExternalQuestionCount,
      deletedAttempts: currentManifest.deletedAttemptCount,
      softDeletedKnowledgePoints: currentManifest.softDeletedKnowledgeCount,
      quarantinedManagedAssets: currentManifest.quarantinedFileCount
    }), replaced.versionAfter);
  };

  const resolveDataRootSelection = (selectionId: string, ownerClientId: string, requestId?: string, allowPopulatedTarget = false) => {
    if (!options.dataRootMigration) throw new AgentError('SCOPE_DENIED');
    const asset = getInternalGlobalAsset(options.readOnlyDatabase, selectionId);
    if (!asset || asset.ownerClientId !== ownerClientId || asset.kind !== 'root_selection' || !asset.internalPath || !asset.contentHash ||
        (asset.status !== 'published' && asset.status !== 'consumed')) throw new AgentError('HANDLER_NOT_FOUND');
    const expectedOperationId = requestId ? dataRootMigrationId(selectionId, requestId) : undefined;
    if (asset.operationJournalId && asset.operationJournalId !== expectedOperationId) throw new AgentError('HANDLER_NOT_FOUND');
    const stored = asset.metadata as unknown as StoredDataRootSelection;
    if (!asset.operationJournalId) assertSelectionNotExpired(stored.expiresAt, now());
    const plan = options.dataRootMigration.resolveSelection(asset, allowPopulatedTarget || asset.status === 'consumed');
    if (plan.selectionBindingHash !== asset.contentHash || plan.targetHash !== stored.targetHash) throw new AgentError('RECOVERY_FENCE');
    return Object.freeze({ asset, plan });
  };

  const executeDataRootMigration = async (
    command: Extract<GlobalCommand, { readonly type: 'data_root.migrate' }>,
    context: TrustedExecutionContext,
    terminalHook: DatabaseTerminalHook<CommandResult> | undefined,
    principal: AgentPrincipal | undefined
  ): Promise<CommandResult> => {
    if (!principal || principal.clientId !== context.client.clientId || !terminalHook || !options.dataRootMigration) throw new AgentError('SCOPE_DENIED');
    const resolved = resolveDataRootSelection(command.payload.rootSelectionId, principal.clientId, context.requestId);
    const version = options.currentVersion();
    if (!sameVersion(context.expectedVersion ?? version, version) || !sameVersion(resolved.plan.baseVersion, version)) throw new AgentError('DATA_REVISION_CONFLICT');
    const operationId = dataRootMigrationId(resolved.asset.assetId, context.requestId);
    let admission: ReturnType<typeof assertDataRootMigrationReceiptTarget>;
    await options.coordinator.executeControlWrite(controlCapability, {
      requestId: `global-root-claim-${operationId}`,
      execute: (database, scope) => {
        admission = assertDataRootMigrationReceiptTarget(database, principal.clientId, context.requestId, {
          targetHash: resolved.plan.targetHash, affectedSetHash: resolved.plan.affectedSetHash, baseVersion: version, catalog: operationCatalogIdentity
        }, scope);
        if (admission.migratePayloadHash !== hashCanonicalJson(command.payload)) throw new AgentError('RECOVERY_FENCE');
        const current = getInternalGlobalAsset(database, resolved.asset.assetId);
        if (!current || current.status !== 'published' || (current.operationJournalId && current.operationJournalId !== operationId)) throw new AgentError('HANDLER_NOT_FOUND');
        bindGlobalAssetMaterialization(database, current.assetId, { internalPath: resolved.plan.targetPath,
          contentHash: resolved.plan.selectionBindingHash, contentSize: 0, operationJournalId: operationId }, now(), scope);
        return { changed: true, value: undefined };
      }
    });
    const migrated = await options.dataRootMigration.migrate({
      plan: resolved.plan,
      manifest: {
        operationId, ownerClientId: principal.clientId, requestId: context.requestId, receiptId: admission!.receiptId,
        receiptOperation: admission!.receiptOperation, receiptPayloadHash: admission!.receiptPayloadHash,
        migratePayloadHash: admission!.migratePayloadHash, reservationId: admission!.reservationId, grantId: admission!.grantId,
        ...(admission!.changeSetId ? { changeSetId: admission!.changeSetId } : {}), selectionId: resolved.asset.assetId,
        targetPath: resolved.plan.targetPath, targetIdentity: resolved.plan.targetIdentity, sourcePath: resolved.plan.sourcePath, sourceIdentity: resolved.plan.sourceIdentity,
        inventoryHash: resolved.plan.inventoryHash, inventoryCount: resolved.plan.inventory.length, inventoryBytes: resolved.plan.inventoryBytes,
        requiredBytes: resolved.plan.requiredBytes, planningAvailableBytes: resolved.plan.planningAvailableBytes, schemaHash: resolved.plan.schemaHash,
        affectedEntities: resolved.plan.affectedEntities, affectedSetHash: resolved.plan.affectedSetHash, targetHash: resolved.plan.targetHash,
        selectionBindingHash: resolved.plan.selectionBindingHash, baseVersion: resolved.plan.baseVersion, catalog: Object.freeze({ ...operationCatalogIdentity }),
        recovery: admission!.recovery, maxAffectedEntities: 500, reservationExpiresAt: admission!.reservationExpiresAt,
        reservedAt: admission!.reservedAt, receiptCreatedAt: admission!.receiptCreatedAt
      },
      onStage: async () => undefined
    });
    return freezeResult(true, Object.freeze({ rootSelectionId: resolved.asset.assetId, migrated: true as const,
      fileCount: resolved.plan.inventory.length, totalBytes: resolved.plan.inventoryBytes }), migrated.versionAfter);
  };

  const recoverMaterializations = async (): Promise<void> => {
    if (!options.managedPaths) return;
    const paths = materializationPaths(options.managedPaths);
    const deletionRows = options.readOnlyDatabase.select<Record<string, unknown>>('SELECT * FROM agent_backup_deletion_journals WHERE status IN (\'intent\', \'moved\', \'needs_recovery\') ORDER BY journal_id');
    for (const row of deletionRows) {
      const assetId = String(row.asset_id);
      const asset = getInternalGlobalAsset(options.readOnlyDatabase, assetId);
      const journalId = String(row.journal_id);
      const hash = String(row.content_hash);
      const size = Number(row.content_size);
      const quarantinePath = path.normalize(path.join(paths.quarantine, 'backups', `${journalId}.quarantine`));
      const quarantined = fs.existsSync(quarantinePath) && sameEvidence(materializationEvidence(quarantinePath), { hash, size });
      if (row.status === 'intent') {
        const source = asset?.internalPath;
        const sourcePresent = !!source && fs.existsSync(source);
        if (sourcePresent && !fs.existsSync(quarantinePath)) continue;
        // A rename may have completed before the moved journal phase; never ignore it.
        if (!sourcePresent && quarantined) {
          await options.coordinator.executeControlWrite(controlCapability, { requestId: `global-delete-recover-intent-fence-${journalId}`, execute: (database, scope) => {
            const current = getInternalGlobalAsset(database, assetId);
            if (current?.status === 'published') transitionGlobalAsset(database, assetId, 'needs_recovery', now(), { operationJournalId: journalId }, scope);
            transitionBackupDeletionJournal(database, journalId, 'intent', 'needs_recovery', now(), scope);
            return { changed: true, value: undefined };
          }});
        } else {
          await options.coordinator.executeControlWrite(controlCapability, { requestId: `global-delete-recover-intent-ambiguity-${journalId}`, execute: (database, scope) => {
            const current = getInternalGlobalAsset(database, assetId);
            if (current?.status === 'published') transitionGlobalAsset(database, assetId, 'needs_recovery', now(), { operationJournalId: journalId }, scope);
            transitionBackupDeletionJournal(database, journalId, 'intent', 'needs_recovery', now(), scope);
            return { changed: true, value: undefined };
          }});
        }
        throw new AgentError('RECOVERY_FENCE');
      }
      if (row.status === 'moved' && asset?.status === 'quarantined' && quarantined) {
        await options.coordinator.executeControlWrite(controlCapability, { requestId: `global-delete-recover-complete-${journalId}`, execute: (database, scope) => {
          return { changed: transitionBackupDeletionJournal(database, journalId, 'moved', 'completed', now(), scope), value: undefined };
        }});
        continue;
      }
      await options.coordinator.executeControlWrite(controlCapability, { requestId: `global-delete-recover-fence-${journalId}`, execute: (database, scope) => {
        const current = getInternalGlobalAsset(database, assetId);
        if (current && current.status === 'published') transitionGlobalAsset(database, assetId, 'needs_recovery', now(), { operationJournalId: journalId }, scope);
        transitionBackupDeletionJournal(database, journalId, row.status as 'moved' | 'needs_recovery', 'needs_recovery', now(), scope);
        return { changed: true, value: undefined };
      }});
      throw new AgentError('RECOVERY_FENCE');
    }
    if (!options.materializer) return;
    for (const root of [paths.backups, paths.exports, paths.temp, paths.journal, paths.quarantine]) fs.mkdirSync(root, { recursive: true });
    const journal = new MaterializationJournalStore(paths.journal, [paths.backups, paths.exports, paths.temp, paths.quarantine], options.materializationDurability);
    const fence = async (manifest: MaterializationManifest, reason: string) => {
      for (const [candidate, suffix] of [[manifest.stagedPath, 'stage'], [manifest.finalPath, 'final']] as const) {
        if (!fs.existsSync(candidate)) continue;
        const target = `${manifest.quarantinePath}.${suffix}`;
        await quarantineMaterializationFile(candidate, target, options.materializationDurability);
      }
      const fenced = await journal.advance(manifest, 'needs_recovery', now(), undefined, reason);
      await options.materializationHook?.('needs_recovery', fenced);
      await options.coordinator.executeControlWrite(controlCapability, { requestId: `global-startup-fence-${manifest.jobId.replace(/-/g, '')}`, execute: (database, scope) => {
        const asset = getInternalGlobalAsset(database, manifest.assetId);
        if (asset && asset.status !== 'needs_recovery') transitionGlobalAsset(database, manifest.assetId, 'needs_recovery', now(), { jobId: manifest.jobId, operationJournalId: manifest.operationId }, scope);
        return { changed: true, value: undefined };
      }});
      throw new AgentError('RECOVERY_FENCE');
    };
    for (const manifest of journal.scan()) {
      if (manifest.phase === 'needs_recovery') throw new AgentError('RECOVERY_FENCE');
      const asset = getInternalGlobalAsset(options.readOnlyDatabase, manifest.assetId);
      if (!asset || asset.jobId !== manifest.jobId || asset.ownerClientId !== manifest.ownerClientId || asset.kind !== manifest.kind ||
          materializationMetadataHash(asset.metadata) !== manifest.metadataHash || !sameVersion(manifest.expectedVersion, options.currentVersion())) await fence(manifest, 'asset_or_revision_binding_mismatch');
      const staged = fs.existsSync(manifest.stagedPath) ? materializationEvidence(manifest.stagedPath) : undefined;
      const final = fs.existsSync(manifest.finalPath) ? materializationEvidence(manifest.finalPath) : undefined;
      if (manifest.phase === 'intent') {
        if (final) await fence(manifest, 'final_without_evidence');
        if (staged) await removeMaterializationFile(manifest.stagedPath, options.materializationDurability); // An unrecorded generated stage is safely discarded and regenerated.
        if (await options.getJobs().requeueRecoveredMaterialization(manifest.jobId) === 'completed') await fence(manifest, 'completed_intent_without_receipt');
        continue;
      }
      const evidence = manifest.evidence;
      if (!evidence || (staged && !sameEvidence(staged, evidence)) || (final && !sameEvidence(final, evidence)) || (staged && final)) {
        await fence(manifest, 'materialized_file_mismatch_or_dual_file');
      }
      if (!evidence) throw new AgentError('RECOVERY_FENCE');
      if (!final && !staged) await fence(manifest, 'materialized_file_missing');
      if (staged && !final) {
        await options.coordinator.executeControlWrite(controlCapability, { requestId: `global-startup-stage-${manifest.jobId.replace(/-/g, '')}`, execute: (database, scope) => {
          const current = getInternalGlobalAsset(database, manifest.assetId);
          if (!current || (current.contentHash && (current.contentHash !== evidence.hash || current.contentSize !== evidence.size))) throw new AgentError('RECOVERY_FENCE');
          if (current.status === 'staged' && current.contentHash === evidence.hash && current.contentSize === evidence.size && current.internalPath === manifest.finalPath) {
            return { changed: false, value: undefined };
          }
          bindGlobalAssetMaterialization(database, manifest.assetId, { stagedPath: manifest.stagedPath, internalPath: manifest.finalPath, contentHash: evidence.hash, contentSize: evidence.size, operationJournalId: manifest.operationId }, now(), scope);
          if (current.status === 'intent') transitionGlobalAsset(database, manifest.assetId, 'staged', now(), { jobId: manifest.jobId, operationJournalId: manifest.operationId }, scope);
          return { changed: true, value: undefined };
        }});
      }
      if (final) {
        await options.coordinator.executeControlWrite(controlCapability, { requestId: `global-startup-publish-${manifest.jobId.replace(/-/g, '')}`, execute: (database, scope) => {
          const current = getInternalGlobalAsset(database, manifest.assetId);
          if (!current || (current.contentHash && (current.contentHash !== evidence.hash || current.contentSize !== evidence.size))) throw new AgentError('RECOVERY_FENCE');
          if (current.status === 'published' && current.contentHash === evidence.hash && current.contentSize === evidence.size && current.internalPath === manifest.finalPath) {
            return { changed: false, value: undefined };
          }
          bindGlobalAssetMaterialization(database, manifest.assetId, { stagedPath: manifest.stagedPath, internalPath: manifest.finalPath, contentHash: evidence.hash, contentSize: evidence.size, operationJournalId: manifest.operationId }, now(), scope);
          if (current.status === 'intent') transitionGlobalAsset(database, manifest.assetId, 'staged', now(), { jobId: manifest.jobId, operationJournalId: manifest.operationId }, scope);
          if (getInternalGlobalAsset(database, manifest.assetId)!.status === 'staged') transitionGlobalAsset(database, manifest.assetId, 'published', now(), { jobId: manifest.jobId, operationJournalId: manifest.operationId }, scope);
          return { changed: true, value: undefined };
        }});
        if (manifest.phase !== 'terminal_receipt_persisted' && manifest.phase !== 'job_terminalized') {
          const afterPublish = manifest.phase === 'staged_file_written' || manifest.phase === 'staged_evidence_persisted'
            ? await journal.advance(manifest, 'final_file_published', now(), evidence)
            : manifest;
          if (afterPublish.phase === 'final_file_published') await journal.advance(afterPublish, 'published_evidence_persisted', now(), evidence);
        }
      }
      const latest = journal.read(manifest.operationId) ?? manifest;
      if (latest.phase === 'job_terminalized') continue;
      const jobState = await options.getJobs().requeueRecoveredMaterialization(manifest.jobId);
      if (jobState === 'completed') {
        if (latest.phase !== 'terminal_receipt_persisted') await fence(latest, 'completed_without_terminal_receipt');
        const terminal = await journal.advance(latest, 'job_terminalized', now(), latest.evidence);
        await options.materializationHook?.('job_terminalized', terminal);
      }
    }
    for (const asset of listInternalGlobalAssets(options.readOnlyDatabase)) {
      if (!asset.jobId || !['intent', 'staged', 'published'].includes(asset.status) || journal.read(asset.assetId)) continue;
      await options.coordinator.executeControlWrite(controlCapability, { requestId: `global-orphan-fence-${asset.jobId.replace(/-/g, '')}`, execute: (database, scope) => {
        const current = getInternalGlobalAsset(database, asset.assetId);
        if (current && current.status !== 'needs_recovery') transitionGlobalAsset(database, asset.assetId, 'needs_recovery', now(), { jobId: asset.jobId, operationJournalId: asset.assetId }, scope);
        return { changed: true, value: undefined };
      }});
      throw new AgentError('RECOVERY_FENCE');
    }
  };

  const noteMaterializationJobTerminal = async (jobId: string, status: 'completed' | 'failed' | 'interrupted'): Promise<void> => {
    if (!options.managedPaths) return;
    const paths = materializationPaths(options.managedPaths);
    const journal = new MaterializationJournalStore(paths.journal, [paths.backups, paths.exports, paths.temp, paths.quarantine], options.materializationDurability);
    for (const manifest of journal.scan()) {
      if (manifest.jobId !== jobId || manifest.phase === 'job_terminalized') continue;
      if (status !== 'completed') {
        for (const [candidate, suffix] of [[manifest.stagedPath, 'stage'], [manifest.finalPath, 'final']] as const) {
          if (!fs.existsSync(candidate)) continue;
          const target = `${manifest.quarantinePath}.${suffix}`;
          await quarantineMaterializationFile(candidate, target, options.materializationDurability);
        }
        const fenced = await journal.advance(manifest, 'needs_recovery', now(), undefined, `job_${status}`);
        await options.materializationHook?.('needs_recovery', fenced);
        await options.coordinator.executeControlWrite(controlCapability, { requestId: `global-terminal-fence-${jobId.replace(/-/g, '')}`, execute: (database, scope) => {
          const asset = getInternalGlobalAsset(database, manifest.assetId);
          if (asset && asset.status !== 'needs_recovery') transitionGlobalAsset(database, manifest.assetId, 'needs_recovery', now(), { jobId, operationJournalId: manifest.operationId }, scope);
          return { changed: !!asset, value: undefined };
        }});
        continue;
      }
      if (manifest.phase !== 'terminal_receipt_persisted') throw new AgentError('RECOVERY_FENCE');
      const final = fs.existsSync(manifest.finalPath) ? materializationEvidence(manifest.finalPath) : undefined;
      if (!final || !manifest.evidence || !sameEvidence(final, manifest.evidence)) throw new AgentError('RECOVERY_FENCE');
      await options.materializationFaultHook?.('before_job_terminal_journal', manifest);
      const terminal = await journal.advance(manifest, 'job_terminalized', now(), manifest.evidence);
      await options.materializationHook?.('job_terminalized', terminal);
    }
  };

  return Object.freeze({
    shouldKickJobs: !!options.materializer,
    validateCommand: validateGlobalCommand,
    validateQuery: validateGlobalQuery,
    recoverMaterializations,
    noteMaterializationJobTerminal,
    stageSelectedDatabaseImport,
    stageSelectedDataRoot,
    async execute(command: GlobalCommand, context: TrustedExecutionContext, terminalHook?: DatabaseTerminalHook<CommandResult>, principal?: AgentPrincipal) {
      validateGlobalCommand(command);
      if (intentOperation(command)) return executeIntent(command, context, terminalHook, principal);
      if (materializeOperation(command)) return executeMaterialization(command, context, terminalHook, principal);
      if (command.type === 'backups.delete') return executeBackupDeletion(command, context, terminalHook, principal);
      if (command.type === 'database.restore') return executeDatabaseRestore(command, context, terminalHook, principal);
      if (command.type === 'database.replace_from_import') return executeDatabaseImport(command, context, terminalHook, principal);
      if (command.type === 'database.clear_all') return executeDatabaseClear(command, context, terminalHook, principal);
      if (command.type === 'imports.delete_batch') return executeImportBatchDeletion(command, context, terminalHook, principal);
      if (command.type === 'data_root.migrate' && options.dataRootMigration) return executeDataRootMigration(command, context, terminalHook, principal);
      return executeNoOp(command, context, terminalHook);
    },
    query(query: GlobalQuery, context: TrustedExecutionContext) {
      validateGlobalQuery(query);
      if (options.coordinator.state === 'needs_recovery' || options.coordinator.pendingWrites !== 0) throw new AgentError('RECOVERY_FENCE');
      const before = options.currentVersion();
      if (query.type === 'backups.list') {
        const window = pagination.createWindow({ query: { ownerClientId: context.client.clientId, kind: 'backup' }, cursor: query.payload.cursor, pageSize: query.payload.pageSize, maxPageSize: 100 });
        const assets = listGlobalAssets(options.readOnlyDatabase, context.client.clientId, 'backup', window.afterKey, window.pageSize + 1);
        const page = pagination.complete(assets, window, (item) => item.assetId);
        const after = options.currentVersion();
        if (!sameVersion(before, after)) throw new AgentError('MAINTENANCE_FENCE');
        return { value: Object.freeze({ items: page.items, page: page.page }), dataVersion: Object.freeze({ ...after }) };
      }
      let asset;
      try { asset = getGlobalAsset(options.readOnlyDatabase, query.payload.exportId, context.client.clientId); } catch (error) {
        if (error instanceof AgentError && error.code === 'SCOPE_DENIED') throw new AgentError('HANDLER_NOT_FOUND');
        throw error;
      }
      if (!asset || asset.kind !== 'export') throw new AgentError('HANDLER_NOT_FOUND');
      const after = options.currentVersion();
      if (!sameVersion(before, after)) throw new AgentError('MAINTENANCE_FENCE');
      return { value: asset, dataVersion: Object.freeze({ ...after }) };
    },
    resolveState(envelope: AgentCommandEnvelope | AgentQueryEnvelope, descriptor: OperationDescriptor, principal?: AgentPrincipal) {
      if (descriptor.domain !== 'global' || descriptor.name !== envelope.operation) throw new Error('Global Gateway descriptor mismatch');
      if (envelope.operation === 'data_root.migrate') {
        if (!principal || !options.dataRootMigration) throw new AgentError('SCOPE_DENIED');
        const selectionId = String(envelope.payload.rootSelectionId);
        const completed = options.readOnlyDatabase.select<Record<string, unknown>>(`SELECT j.*,i.status AS receipt_status,g.status AS grant_status
          FROM agent_data_root_migration_journals j INNER JOIN agent_idempotency i ON i.receipt_id=j.receipt_id
          INNER JOIN agent_r4_grants g ON g.grant_id=j.grant_id WHERE j.selection_id=? AND j.owner_client_id=? AND j.request_id=? AND j.status='completed'`,
          [selectionId, principal.clientId, envelope.requestId])[0];
        if (completed) {
          if (completed.receipt_status !== 'completed' || completed.grant_status !== 'consumed') throw new AgentError('RECOVERY_FENCE');
          const affectedEntities = JSON.parse(String(completed.affected_entities_json)) as EntityRef[];
          return Object.freeze({ affectedEntityCount: affectedEntities.length, affectedEntities: Object.freeze(affectedEntities),
            affectedSetHash: String(completed.affected_set_hash), targetHash: String(completed.target_hash), dataVersion: Object.freeze({ ...options.currentVersion() }) });
        }
        const resolved = resolveDataRootSelection(selectionId, principal.clientId, envelope.requestId);
        return Object.freeze({ affectedEntityCount: resolved.plan.affectedEntities.length, affectedEntities: resolved.plan.affectedEntities,
          affectedSetHash: resolved.plan.affectedSetHash, targetHash: resolved.plan.targetHash, dataVersion: Object.freeze({ ...resolved.plan.baseVersion }) });
      }
      if (envelope.operation === 'imports.delete_batch') {
        if (!principal || !options.importBatchDelete || !options.managedPaths) throw new AgentError('SCOPE_DENIED');
        const batchId = String(envelope.payload.batchId);
        const operationId = importBatchDeleteJournalId(batchId, envelope.requestId);
        const completed = options.readOnlyDatabase.select<Record<string, unknown>>(`SELECT j.*,i.status AS receipt_status,i.operation AS receipt_operation,
            i.client_id AS receipt_client_id,i.payload_hash AS receipt_payload_hash,i.affected_set_hash AS receipt_affected_set_hash,
            g.status AS grant_status,g.operation AS grant_operation,g.reservation_id AS grant_reservation_id,g.target_hash AS grant_target_hash
          FROM agent_import_batch_deletion_journals j INNER JOIN agent_idempotency i ON i.receipt_id=j.receipt_id
          INNER JOIN agent_r4_grants g ON g.grant_id=j.grant_id
          WHERE j.operation_id=? AND j.owner_client_id=? AND j.request_id=? AND j.status='completed'`, [operationId, principal.clientId, envelope.requestId])[0];
        if (completed) {
          const roots = materializationPaths(options.managedPaths);
          const manifest = new ImportBatchDeletionJournalStore(path.normalize(path.join(roots.journal, 'import-batch-deletions')), options.materializationDurability).read(operationId);
          if (!manifest || manifest.phase !== 'completed' || manifest.batchId !== batchId || completed.receipt_status !== 'completed' ||
              (completed.receipt_operation !== 'imports.delete_batch' && completed.receipt_operation !== 'agent.changesets.apply') ||
              completed.receipt_client_id !== principal.clientId || completed.receipt_payload_hash !== manifest.receiptPayloadHash ||
              completed.receipt_affected_set_hash !== manifest.affectedSetHash || completed.grant_status !== 'consumed' ||
              completed.grant_operation !== 'imports.delete_batch' || completed.grant_reservation_id !== manifest.reservationId ||
              completed.grant_target_hash !== manifest.targetHash || completed.inventory_hash !== manifest.inventoryHash ||
              completed.affected_set_hash !== manifest.affectedSetHash || completed.target_hash !== manifest.targetHash ||
              completed.affected_entity_count !== manifest.affectedEntityCount ||
              Number(completed.delete_managed_assets) !== Number(manifest.deleteManagedAssets)) throw new AgentError('RECOVERY_FENCE');
          return Object.freeze({
            affectedEntityCount: manifest.affectedEntityCount,
            affectedEntities: manifest.affectedEntities,
            affectedSetHash: manifest.affectedSetHash,
            targetHash: manifest.targetHash,
            dataVersion: Object.freeze({ ...options.currentVersion() })
          });
        }
        const resolution = options.importBatchDelete.resolve(batchId, Boolean(envelope.payload.deleteManagedAssets), {
          clientId: principal.clientId,
          renderer: principal.renderer === true
        });
        if (resolution.affectedEntityCount !== resolution.affectedEntities.length || resolution.affectedEntityCount > 500 ||
            resolution.affectedSetHash !== hashCanonicalJson(resolution.affectedEntities)) throw new AgentError('RECOVERY_FENCE');
        return Object.freeze({
          affectedEntityCount: resolution.affectedEntityCount,
          affectedEntities: resolution.affectedEntities,
          affectedSetHash: resolution.affectedSetHash,
          targetHash: resolution.targetHash,
          dataVersion: Object.freeze({ ...resolution.dataVersion })
        });
      }
      if (envelope.operation === 'database.clear_all') {
        if (!principal || !options.databaseClear || !options.managedPaths) throw new AgentError('SCOPE_DENIED');
        const operationId = clearJournalId(envelope.requestId);
        const completed = options.readOnlyDatabase.select<Record<string, unknown>>(`SELECT j.*,i.status AS receipt_status,i.operation AS receipt_operation,
            i.client_id AS receipt_client_id,i.payload_hash AS receipt_payload_hash,i.affected_set_hash AS receipt_affected_set_hash,
            g.status AS grant_status,g.operation AS grant_operation,g.reservation_id AS grant_reservation_id,g.target_hash AS grant_target_hash
          FROM agent_database_clear_journals j INNER JOIN agent_idempotency i ON i.receipt_id=j.receipt_id
          INNER JOIN agent_r4_grants g ON g.grant_id=j.grant_id
          WHERE j.operation_id=? AND j.owner_client_id=? AND j.request_id=? AND j.status='completed'`, [operationId, principal.clientId, envelope.requestId])[0];
        if (completed) {
          const roots = materializationPaths(options.managedPaths);
          const manifest = new DatabaseClearJournalStore(path.normalize(path.join(roots.journal, 'database-clears')), options.materializationDurability).read(operationId);
          if (!manifest || manifest.phase !== 'completed' || completed.receipt_status !== 'completed' ||
              (completed.receipt_operation !== 'database.clear_all' && completed.receipt_operation !== 'agent.changesets.apply') ||
              completed.receipt_client_id !== principal.clientId || completed.receipt_payload_hash !== manifest.receiptPayloadHash ||
              completed.receipt_affected_set_hash !== manifest.affectedSetHash || completed.grant_status !== 'consumed' ||
              completed.grant_operation !== 'database.clear_all' || completed.grant_reservation_id !== manifest.reservationId ||
              completed.grant_target_hash !== manifest.targetHash || completed.inventory_hash !== manifest.inventoryHash ||
              completed.affected_set_hash !== manifest.affectedSetHash || completed.target_hash !== manifest.targetHash ||
              completed.business_row_count !== manifest.businessRowCount || completed.managed_image_count !== manifest.managedImageCount ||
              completed.affected_entity_count !== manifest.affectedEntityCount || Number(completed.delete_managed_images) !== Number(manifest.deleteManagedImages)) {
            throw new AgentError('RECOVERY_FENCE');
          }
          return Object.freeze({
            affectedEntityCount: manifest.affectedEntityCount,
            affectedEntities: manifest.affectedEntities,
            affectedSetHash: manifest.affectedSetHash,
            targetHash: manifest.targetHash,
            dataVersion: Object.freeze({ ...options.currentVersion() })
          });
        }
        const resolution = options.databaseClear.resolve(Boolean(envelope.payload.deleteManagedImages));
        if (resolution.affectedEntityCount !== resolution.affectedEntities.length || resolution.affectedEntityCount > 500 ||
            resolution.affectedSetHash !== hashCanonicalJson(resolution.affectedEntities)) throw new AgentError('RECOVERY_FENCE');
        return Object.freeze({
          affectedEntityCount: resolution.affectedEntityCount,
          affectedEntities: resolution.affectedEntities,
          affectedSetHash: resolution.affectedSetHash,
          targetHash: resolution.targetHash,
          dataVersion: Object.freeze({ ...resolution.dataVersion })
        });
      }
      if (envelope.operation === 'database.replace_from_import') {
        if (!principal) throw new AgentError('SCOPE_DENIED');
        const assetId = String(envelope.payload.importAssetId);
        const completed = options.readOnlyDatabase.select<Record<string, unknown>>(`SELECT j.*,i.status AS receipt_status,i.operation AS receipt_operation,i.client_id AS receipt_client_id,
            g.status AS grant_status,g.operation AS grant_operation,g.reservation_id AS grant_reservation_id
          FROM agent_database_import_journals j INNER JOIN agent_idempotency i ON i.receipt_id=j.receipt_id
          INNER JOIN agent_r4_grants g ON g.grant_id=j.grant_id
          WHERE j.asset_id=? AND j.owner_client_id=? AND j.request_id=? AND j.status='completed'`, [assetId, principal.clientId, envelope.requestId])[0];
        if (completed) {
          const resolved = managedDatabaseImportEvidence(options, getInternalGlobalAsset(options.readOnlyDatabase, assetId), principal.clientId, true);
          if (resolved.asset.status !== 'consumed' || completed.receipt_status !== 'completed' ||
              (completed.receipt_operation !== 'database.replace_from_import' && completed.receipt_operation !== 'agent.changesets.apply') ||
              completed.receipt_client_id !== principal.clientId || completed.grant_status !== 'consumed' || completed.grant_operation !== 'database.replace_from_import' ||
              completed.grant_reservation_id !== completed.reservation_id || completed.package_content_hash !== resolved.packageEvidence.hash ||
              completed.package_content_size !== resolved.packageEvidence.size || completed.package_semantic_hash !== resolved.packageEvidence.semanticHash ||
              completed.package_row_count !== resolved.packageEvidence.rowCount || typeof completed.affected_set_hash !== 'string' || typeof completed.target_hash !== 'string') throw new AgentError('RECOVERY_FENCE');
          const affectedEntities = Object.freeze([Object.freeze({ entityType: 'import_asset', entityId: assetId })]);
          if (hashCanonicalJson(affectedEntities) !== completed.affected_set_hash) throw new AgentError('RECOVERY_FENCE');
          const targetHash = hashCanonicalJson({ operation: envelope.operation, importAssetId: assetId, evidence: resolved.packageEvidence });
          if (targetHash !== completed.target_hash) throw new AgentError('RECOVERY_FENCE');
          return Object.freeze({ affectedEntityCount: 1, affectedEntities, affectedSetHash: completed.affected_set_hash, targetHash, dataVersion: Object.freeze({ ...options.currentVersion() }) });
        }
        const resolved = managedDatabaseImportEvidence(options, getInternalGlobalAsset(options.readOnlyDatabase, assetId), principal.clientId);
        const affectedEntities = Object.freeze([Object.freeze({ entityType: 'import_asset', entityId: resolved.asset.assetId })]);
        return Object.freeze({ affectedEntityCount: 1, affectedEntities, affectedSetHash: hashCanonicalJson(affectedEntities),
          targetHash: hashCanonicalJson({ operation: envelope.operation, importAssetId: resolved.asset.assetId, evidence: resolved.packageEvidence }), dataVersion: Object.freeze({ ...options.currentVersion() }) });
      }
      if (envelope.operation === 'backups.delete' || envelope.operation === 'database.restore') {
        if (!principal) throw new AgentError('SCOPE_DENIED');
        if (envelope.operation === 'database.restore') {
          const resolved = managedBackupEvidence(options, getInternalGlobalAsset(options.readOnlyDatabase, String(envelope.payload.backupId)), principal.clientId);
          const affectedEntities = Object.freeze([Object.freeze({ entityType: 'backup', entityId: resolved.asset.assetId })]);
          return Object.freeze({ affectedEntityCount: 1, affectedEntities, affectedSetHash: hashCanonicalJson(affectedEntities),
            targetHash: hashCanonicalJson({ operation: envelope.operation, backupId: resolved.asset.assetId, evidence: resolved.evidence }), dataVersion: Object.freeze({ ...options.currentVersion() }) });
        }
        const completed = options.readOnlyDatabase.select<Record<string, unknown>>(`SELECT j.*, i.status AS receipt_status, i.operation AS receipt_operation, i.client_id AS receipt_client_id,
            g.operation AS grant_operation, g.reservation_id AS grant_reservation_id
          FROM agent_backup_deletion_journals j INNER JOIN agent_idempotency i ON i.receipt_id=j.receipt_id
          INNER JOIN agent_r4_grants g ON g.grant_id=j.grant_id
          WHERE j.asset_id=? AND j.owner_client_id=? AND j.request_id=? AND j.status='completed'`, [String(envelope.payload.backupId), principal.clientId, envelope.requestId])[0];
        if (completed) {
          if (completed.receipt_status !== 'completed' || (completed.receipt_operation !== 'backups.delete' && completed.receipt_operation !== 'agent.changesets.apply') ||
              completed.receipt_client_id !== principal.clientId || completed.grant_operation !== 'backups.delete' || completed.grant_reservation_id !== completed.reservation_id ||
              typeof completed.affected_set_hash !== 'string' || typeof completed.target_hash !== 'string' || typeof completed.content_hash !== 'string' || !Number.isSafeInteger(completed.content_size)) throw new AgentError('RECOVERY_FENCE');
          const affectedEntities = Object.freeze([Object.freeze({ entityType: 'backup', entityId: String(completed.asset_id) })]);
          if (hashCanonicalJson(affectedEntities) !== completed.affected_set_hash) throw new AgentError('RECOVERY_FENCE');
          return Object.freeze({ affectedEntityCount: 1, affectedEntities, affectedSetHash: completed.affected_set_hash, targetHash: completed.target_hash, dataVersion: Object.freeze({ ...options.currentVersion() }) });
        }
        const resolved = backupDeletionEvidence(options, getInternalGlobalAsset(options.readOnlyDatabase, String(envelope.payload.backupId)), principal.clientId);
        const affectedEntities = Object.freeze([Object.freeze({ entityType: 'backup', entityId: resolved.asset.assetId })]);
        return Object.freeze({ affectedEntityCount: 1, affectedEntities, affectedSetHash: hashCanonicalJson(affectedEntities),
          targetHash: hashCanonicalJson({ operation: envelope.operation, backupId: resolved.asset.assetId, evidence: resolved.evidence }), dataVersion: Object.freeze({ ...options.currentVersion() }) });
      }
      const affectedEntities = entities(envelope);
      return Object.freeze({ affectedEntityCount: affectedEntities.length, affectedEntities, affectedSetHash: hashCanonicalJson(affectedEntities), targetHash: hashCanonicalJson({ operation: envelope.operation, affectedEntities }), dataVersion: Object.freeze({ ...options.currentVersion() }) });
    }
  });
}

export function isGlobalCommandOperation(operation: string): operation is GlobalCommand['type'] { return (globalCommandTypes as readonly string[]).includes(operation); }
export function isGlobalQueryOperation(operation: string): operation is GlobalQuery['type'] { return (globalQueryTypes as readonly string[]).includes(operation); }

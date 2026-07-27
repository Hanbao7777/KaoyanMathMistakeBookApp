import type { DataVersion } from '../../../shared/agent';
import { OperationManifestStore, type ManifestScanIssue } from './manifestStore';
import { moveToQuarantine, quarantineDeletionFiles, restoreFromQuarantine, type QuarantineDependencies } from './quarantine';
import {
  assertRealPathConfined,
  inspectFile,
  publishStagedFile,
  removeVerifiedFile,
  stageOperationFiles,
  type JournalIoDependencies,
  OperationFileError
} from './staging';
import {
  isTerminalOperationState,
  sameDataVersion,
  transitionOperationManifest,
  type OperationFile,
  type OperationManifest,
  type OperationManifestError,
  type OperationTerminalState
} from './types';

export const operationPhases = [
  'prepared_publish',
  'file_stage',
  'files_staged_publish',
  'db_committed_publish',
  'file_commit',
  'files_committed_publish',
  'completed_publish',
  'compensating_publish',
  'compensation',
  'compensated_publish',
  'needs_recovery_publish'
] as const;

export type OperationPhase = (typeof operationPhases)[number];
export type OperationBoundary = 'before' | 'after';

export interface OperationHookContext {
  boundary: OperationBoundary;
  phase: OperationPhase;
  manifest: OperationManifest;
}

export interface OperationJournalDependencies extends QuarantineDependencies {
  now?: () => string;
  hook?: (context: OperationHookContext) => void | Promise<void>;
}

export interface RecoveryOutcome {
  operationId?: string;
  terminalState: OperationTerminalState;
  code: 'already_terminal' | 'completed' | 'compensated' | 'needs_recovery' | 'malformed_manifest';
  manifest?: OperationManifest;
  issuePath?: string;
  error?: OperationManifestError;
}

export interface RecoveryScanOutcome {
  outcomes: RecoveryOutcome[];
  completed: number;
  compensated: number;
  needsRecovery: number;
}

function safeError(error: unknown, phase: string): OperationManifestError {
  if (error instanceof OperationFileError) {
    return { code: error.code, phase: error.phase, message: error.message.slice(0, 1_000) };
  }
  return {
    code: typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code.slice(0, 200)
      : 'operation_failed',
    phase: phase.slice(0, 200),
    message: error instanceof Error ? error.message.slice(0, 1_000) || 'Operation failed' : 'Operation failed'
  };
}

function asOutcome(manifest: OperationManifest, code: RecoveryOutcome['code']): RecoveryOutcome {
  return { operationId: manifest.operationId, terminalState: manifest.state as OperationTerminalState, code, manifest };
}

export class OperationJournal {
  private readonly store: OperationManifestStore;
  private readonly dependencies: OperationJournalDependencies;

  constructor(store: OperationManifestStore, dependencies: OperationJournalDependencies = {}) {
    this.store = store;
    this.dependencies = dependencies;
  }

  private now(manifest?: OperationManifest): string {
    const value = (this.dependencies.now ?? (() => new Date().toISOString()))();
    if (!Number.isFinite(Date.parse(value))) throw new Error('Operation journal clock returned an invalid timestamp');
    return manifest && Date.parse(value) < Date.parse(manifest.updatedAt) ? manifest.updatedAt : value;
  }

  private io(): JournalIoDependencies {
    return { files: this.dependencies.files, directoryDurability: this.dependencies.directoryDurability };
  }

  private async boundary(boundary: OperationBoundary, phase: OperationPhase, manifest: OperationManifest): Promise<void> {
    await this.dependencies.hook?.({ boundary, phase, manifest });
  }

  private async publishAt(manifest: OperationManifest, phase: OperationPhase): Promise<void> {
    await this.boundary('before', phase, manifest);
    await this.store.publish(manifest);
    await this.boundary('after', phase, manifest);
  }

  async prepare(manifest: OperationManifest): Promise<OperationManifest> {
    if (manifest.state !== 'prepared') throw new Error('Operation must be prepared before first publication');
    await this.publishAt(manifest, 'prepared_publish');
    return manifest;
  }

  async stage(manifest: OperationManifest): Promise<OperationManifest> {
    if (manifest.state === 'files_staged') return manifest;
    if (manifest.state !== 'prepared') throw new Error(`Cannot stage operation in ${manifest.state}`);
    await this.boundary('before', 'file_stage', manifest);
    let files = await stageOperationFiles(manifest, this.io());
    files = await quarantineDeletionFiles({ ...manifest, files }, this.dependencies);
    await this.boundary('after', 'file_stage', { ...manifest, files });
    const staged = transitionOperationManifest(manifest, 'files_staged', this.now(manifest), { files, lastError: null });
    await this.publishAt(staged, 'files_staged_publish');
    return staged;
  }

  async markDatabaseCommitted(manifest: OperationManifest): Promise<OperationManifest> {
    if (manifest.state === 'db_committed') return manifest;
    if (manifest.state !== 'files_staged') throw new Error(`Cannot mark database committed in ${manifest.state}`);
    const committed = transitionOperationManifest(manifest, 'db_committed', this.now(manifest), { lastError: null });
    await this.publishAt(committed, 'db_committed_publish');
    return committed;
  }

  private async publishStep(manifest: OperationManifest, files: OperationFile[]): Promise<OperationManifest> {
    const updated = transitionOperationManifest(manifest, manifest.state, this.now(manifest), { files });
    await this.store.publish(updated);
    return updated;
  }

  private async commitReplacement(manifest: OperationManifest, file: OperationFile): Promise<void> {
    const original = file.original!;
    const targetNew = await inspectFile(file.targetPath, file.content, this.io());
    const targetOld = await inspectFile(file.targetPath, original, this.io());
    const quarantined = await inspectFile(file.quarantinePath!, original, this.io());
    if (targetNew.status === 'match') {
      if (quarantined.status !== 'match') throw new OperationFileError('replacement_asset_missing', file.fileId, 'commit', 'Replacement original is not quarantined');
      await removeVerifiedFile(file.stagingPath!, file.content, this.io());
      return;
    }
    if (targetNew.status === 'mismatch' && targetOld.status !== 'match') {
      throw new OperationFileError('target_conflict', file.fileId, 'commit', 'Replacement target contains unexpected content');
    }
    if (targetOld.status === 'match') {
      await moveToQuarantine(file.targetPath, file.quarantinePath!, original, file.fileId, this.dependencies);
    } else if (targetOld.status === 'missing' && quarantined.status !== 'match') {
      throw new OperationFileError('replacement_asset_missing', file.fileId, 'commit', 'Replacement original and quarantine are missing');
    }
    await publishStagedFile(file, this.io());
  }

  private async commitOne(manifest: OperationManifest, file: OperationFile): Promise<OperationFile> {
    if (file.status === 'committed') return file;
    await assertRealPathConfined(file.targetPath, manifest.roots.managedRoots, this.io(), `${file.fileId}.targetPath`);
    if (file.stagingPath) await assertRealPathConfined(file.stagingPath, manifest.roots.managedRoots, this.io(), `${file.fileId}.stagingPath`);
    if (file.quarantinePath) await assertRealPathConfined(file.quarantinePath, manifest.roots.managedRoots, this.io(), `${file.fileId}.quarantinePath`);
    if (file.kind === 'create') {
      await publishStagedFile(file, this.io());
    } else if (file.kind === 'replace') {
      await this.commitReplacement(manifest, file);
    } else {
      await moveToQuarantine(file.targetPath, file.quarantinePath!, file.content, file.fileId, this.dependencies);
    }
    return { ...file, status: 'committed' };
  }

  async commitFiles(manifest: OperationManifest): Promise<OperationManifest> {
    if (manifest.state === 'completed') return manifest;
    if (manifest.state === 'files_committed') return this.complete(manifest);
    if (manifest.state !== 'db_committed') throw new Error(`Cannot commit files in ${manifest.state}`);
    await this.boundary('before', 'file_commit', manifest);
    let current = manifest;
    for (let index = 0; index < current.files.length; index += 1) {
      const nextFile = await this.commitOne(current, current.files[index]);
      if (nextFile !== current.files[index]) {
        const files = current.files.slice();
        files[index] = nextFile;
        current = await this.publishStep(current, files);
      }
    }
    await this.boundary('after', 'file_commit', current);
    const filesCommitted = transitionOperationManifest(current, 'files_committed', this.now(current), { lastError: null });
    await this.publishAt(filesCommitted, 'files_committed_publish');
    return this.complete(filesCommitted);
  }

  async complete(manifest: OperationManifest): Promise<OperationManifest> {
    if (manifest.state === 'completed') return manifest;
    if (manifest.state !== 'files_committed') throw new Error(`Cannot complete operation in ${manifest.state}`);
    await this.verifyCommittedFiles(manifest);
    const completed = transitionOperationManifest(manifest, 'completed', this.now(manifest), { lastError: null });
    await this.publishAt(completed, 'completed_publish');
    return completed;
  }

  private async compensateOne(manifest: OperationManifest, file: OperationFile): Promise<OperationFile> {
    if (file.status === 'compensated') return file;
    await assertRealPathConfined(file.targetPath, manifest.roots.managedRoots, this.io(), `${file.fileId}.targetPath`);
    if (file.stagingPath) await assertRealPathConfined(file.stagingPath, manifest.roots.managedRoots, this.io(), `${file.fileId}.stagingPath`);
    if (file.quarantinePath) await assertRealPathConfined(file.quarantinePath, manifest.roots.managedRoots, this.io(), `${file.fileId}.quarantinePath`);
    if (file.kind === 'create') {
      await removeVerifiedFile(file.stagingPath!, file.content, this.io());
      await removeVerifiedFile(file.targetPath, file.content, this.io());
    } else if (file.kind === 'replace') {
      await removeVerifiedFile(file.stagingPath!, file.content, this.io());
      const targetNew = await inspectFile(file.targetPath, file.content, this.io());
      const targetOld = await inspectFile(file.targetPath, file.original!, this.io());
      if (targetNew.status === 'match') await removeVerifiedFile(file.targetPath, file.content, this.io());
      else if (targetNew.status === 'mismatch' && targetOld.status !== 'match') {
        throw new OperationFileError('target_conflict', file.fileId, 'compensation', 'Replacement target contains unexpected content');
      }
      await restoreFromQuarantine(file.quarantinePath!, file.targetPath, file.original!, file.fileId, this.dependencies);
    } else {
      await restoreFromQuarantine(file.quarantinePath!, file.targetPath, file.content, file.fileId, this.dependencies);
    }
    return { ...file, status: 'compensated' };
  }

  async compensate(manifest: OperationManifest, error?: OperationManifestError): Promise<OperationManifest> {
    let current = manifest;
    if (current.state !== 'compensating') {
      if (current.state !== 'prepared' && current.state !== 'files_staged') throw new Error(`Cannot compensate operation in ${current.state}`);
      current = transitionOperationManifest(current, 'compensating', this.now(current), { lastError: error ?? current.lastError });
      await this.publishAt(current, 'compensating_publish');
    }
    await this.boundary('before', 'compensation', current);
    for (let index = 0; index < current.files.length; index += 1) {
      const nextFile = await this.compensateOne(current, current.files[index]);
      if (nextFile !== current.files[index]) {
        const files = current.files.slice();
        files[index] = nextFile;
        current = await this.publishStep(current, files);
      }
    }
    await this.boundary('after', 'compensation', current);
    const compensated = transitionOperationManifest(current, 'compensated', this.now(current), { lastError: error ?? current.lastError });
    await this.publishAt(compensated, 'compensated_publish');
    return compensated;
  }

  async needsRecovery(manifest: OperationManifest, error: OperationManifestError): Promise<OperationManifest> {
    if (manifest.state === 'needs_recovery') return manifest;
    if (isTerminalOperationState(manifest.state)) return manifest;
    const fenced = transitionOperationManifest(manifest, 'needs_recovery', this.now(manifest), { lastError: error });
    await this.publishAt(fenced, 'needs_recovery_publish');
    return fenced;
  }

  private async verifyCommittedFiles(manifest: OperationManifest): Promise<void> {
    for (const file of manifest.files) {
      await assertRealPathConfined(file.targetPath, manifest.roots.managedRoots, this.io(), `${file.fileId}.targetPath`);
      if (file.quarantinePath) await assertRealPathConfined(file.quarantinePath, manifest.roots.managedRoots, this.io(), `${file.fileId}.quarantinePath`);
      if (file.kind === 'quarantine_delete') {
        const target = await inspectFile(file.targetPath, file.content, this.io());
        const quarantined = await inspectFile(file.quarantinePath!, file.content, this.io());
        if (target.status !== 'missing' || quarantined.status !== 'match') {
          throw new OperationFileError('deletion_state_ambiguous', file.fileId, 'verify', 'Deletion is not durably quarantined');
        }
      } else {
        const target = await inspectFile(file.targetPath, file.content, this.io());
        if (target.status !== 'match') throw new OperationFileError('committed_file_mismatch', file.fileId, 'verify', 'Committed target is missing or changed');
        if (file.kind === 'replace') {
          const quarantined = await inspectFile(file.quarantinePath!, file.original!, this.io());
          if (quarantined.status !== 'match') throw new OperationFileError('replacement_asset_missing', file.fileId, 'verify', 'Replacement recovery asset is missing');
        }
      }
    }
  }

  async recover(manifest: OperationManifest, databaseVersion: DataVersion | null): Promise<RecoveryOutcome> {
    if (isTerminalOperationState(manifest.state)) return asOutcome(manifest, 'already_terminal');
    try {
      let terminal: OperationManifest;
      if (manifest.state === 'prepared') {
        if (databaseVersion && sameDataVersion(databaseVersion, manifest.versionBefore)) {
          terminal = await this.compensate(manifest);
        } else {
          terminal = await this.needsRecovery(manifest, {
            code: 'database_state_ambiguous', phase: 'recovery', message: 'Prepared operation does not match the pre-operation database version'
          });
        }
      } else if (manifest.state === 'files_staged') {
        if (databaseVersion && sameDataVersion(databaseVersion, manifest.versionAfter)) {
          terminal = await this.commitFiles(await this.markDatabaseCommitted(manifest));
        } else if (databaseVersion && sameDataVersion(databaseVersion, manifest.versionBefore)) {
          terminal = await this.compensate(manifest);
        } else {
          terminal = await this.needsRecovery(manifest, {
            code: 'database_state_ambiguous', phase: 'recovery', message: 'Staged operation database version is neither before nor planned after'
          });
        }
      } else if (manifest.state === 'db_committed') {
        terminal = databaseVersion && sameDataVersion(databaseVersion, manifest.versionAfter)
          ? await this.commitFiles(manifest)
          : await this.needsRecovery(manifest, {
              code: 'database_commit_contradiction', phase: 'recovery', message: 'Committed operation does not match the planned database version'
            });
      } else if (manifest.state === 'files_committed') {
        terminal = databaseVersion && sameDataVersion(databaseVersion, manifest.versionAfter)
          ? await this.complete(manifest)
          : await this.needsRecovery(manifest, {
              code: 'database_commit_contradiction', phase: 'recovery', message: 'Files are committed but the database version is not planned after'
            });
      } else {
        terminal = databaseVersion && sameDataVersion(databaseVersion, manifest.versionBefore)
          ? await this.compensate(manifest)
          : await this.needsRecovery(manifest, {
              code: 'compensation_database_contradiction', phase: 'recovery', message: 'Compensation cannot continue against a changed database version'
            });
      }
      return asOutcome(terminal, terminal.state === 'completed' ? 'completed' : terminal.state === 'compensated' ? 'compensated' : 'needs_recovery');
    } catch (error) {
      const failure = safeError(error, 'recovery');
      try {
        const latest = await this.store.read(manifest.operationId) ?? manifest;
        const fenced = await this.needsRecovery(latest, failure);
        return { ...asOutcome(fenced, 'needs_recovery'), error: failure };
      } catch {
        return { operationId: manifest.operationId, terminalState: 'needs_recovery', code: 'needs_recovery', manifest, error: failure };
      }
    }
  }
}

function issueOutcome(issue: ManifestScanIssue): RecoveryOutcome {
  return {
    terminalState: 'needs_recovery',
    code: 'malformed_manifest',
    issuePath: issue.path,
    error: { code: issue.code, phase: 'manifest_scan', message: 'Manifest could not be safely loaded' }
  };
}

export async function recoverOperationStores(
  stores: readonly OperationManifestStore[],
  resolveDatabaseVersion: (manifest: OperationManifest) => DataVersion | null | Promise<DataVersion | null>,
  dependencies: OperationJournalDependencies = {}
): Promise<RecoveryScanOutcome> {
  const outcomes: RecoveryOutcome[] = [];
  for (const store of stores) {
    const scan = await store.scan();
    outcomes.push(...scan.issues.map(issueOutcome));
    const journal = new OperationJournal(store, dependencies);
    for (const manifest of scan.manifests) {
      try {
        outcomes.push(await journal.recover(manifest, await resolveDatabaseVersion(manifest)));
      } catch (error) {
        const failure = safeError(error, 'database_version_resolution');
        try {
          const fenced = await journal.needsRecovery(manifest, failure);
          outcomes.push({ ...asOutcome(fenced, 'needs_recovery'), error: failure });
        } catch {
          outcomes.push({ operationId: manifest.operationId, terminalState: 'needs_recovery', code: 'needs_recovery', manifest, error: failure });
        }
      }
    }
  }
  return {
    outcomes,
    completed: outcomes.filter((outcome) => outcome.terminalState === 'completed').length,
    compensated: outcomes.filter((outcome) => outcome.terminalState === 'compensated').length,
    needsRecovery: outcomes.filter((outcome) => outcome.terminalState === 'needs_recovery').length
  };
}

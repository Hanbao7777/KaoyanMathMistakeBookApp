import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AgentError } from '../../shared/agent/errors';
import type { DataVersion } from '../../shared/agent/v1/contracts';
import type { DatabaseGeneration } from './revisionStore';
import {
  decideDatabaseCandidate,
  inspectDatabaseFile,
  scanDatabaseCandidates,
  type CandidateDecision,
  type CandidateFileDependencies,
  type CandidateOpener,
  type DatabaseCandidate,
  type LegacyDatabaseCandidate,
  type ValidDatabaseCandidate,
  type VersionedDatabaseCandidate
} from './databaseCandidate';
import {
  defaultDirectoryDurabilityDependencies,
  flushDirectory,
  type DirectoryDurabilityDependencies
} from './fileDurability';

export type DatabaseRuntimeState =
  | 'writable'
  | 'read_only'
  | 'maintenance'
  | 'needs_recovery'
  | 'shutting_down'
  | 'shutdown';

export interface MaintenanceLease {
  readonly kind: 'database-maintenance-lease';
}

interface MaintenanceLeaseState {
  readonly owner: DatabaseRuntimeStateController;
  consumed: boolean;
}

const maintenanceLeases = new WeakMap<object, MaintenanceLeaseState>();

export class DatabaseRuntimeStateController {
  private currentState: DatabaseRuntimeState;
  private recoveryReason: unknown;
  private recoveryFenceActive: boolean;
  private shutdownStarted: boolean;

  constructor(initialState: DatabaseRuntimeState = 'writable') {
    this.currentState = initialState;
    this.recoveryFenceActive = initialState === 'needs_recovery';
    this.shutdownStarted = initialState === 'shutting_down' || initialState === 'shutdown';
  }

  get state(): DatabaseRuntimeState {
    return this.currentState;
  }

  get reason(): unknown {
    return this.recoveryReason;
  }

  assertWriteAdmission(): void {
    if (this.recoveryFenceActive) throw new AgentError('RECOVERY_FENCE');
    if (this.currentState === 'writable') return;
    if (this.currentState === 'maintenance' || this.currentState === 'shutting_down' || this.currentState === 'shutdown') {
      throw new AgentError('MAINTENANCE_FENCE');
    }
    throw new AgentError('RECOVERY_FENCE');
  }

  assertAdmittedWriteMayStart(): void {
    if (this.recoveryFenceActive) throw new AgentError('RECOVERY_FENCE');
  }

  beginMaintenance(): MaintenanceLease {
    if (this.currentState !== 'writable') this.assertWriteAdmission();
    this.currentState = 'maintenance';
    const lease = Object.freeze({ kind: 'database-maintenance-lease' as const });
    maintenanceLeases.set(lease, { owner: this, consumed: false });
    return lease;
  }

  finishMaintenance(lease: MaintenanceLease, nextState: 'writable' | 'read_only' | 'needs_recovery' = 'writable'): void {
    const leaseState = maintenanceLeases.get(lease as object);
    if (!leaseState || leaseState.owner !== this || leaseState.consumed || this.currentState !== 'maintenance') {
      throw new Error('A current unconsumed maintenance lease is required');
    }
    leaseState.consumed = true;
    this.currentState = nextState;
    if (nextState === 'needs_recovery') this.recoveryFenceActive = true;
  }

  enterReadOnly(): void {
    if (this.recoveryFenceActive) throw new AgentError('RECOVERY_FENCE');
    if (this.currentState === 'shutdown' || this.currentState === 'shutting_down' || this.currentState === 'maintenance') {
      throw new Error(`Cannot enter read-only state from ${this.currentState}`);
    }
    this.currentState = 'read_only';
  }

  resumeWrites(): void {
    if (this.recoveryFenceActive) throw new AgentError('RECOVERY_FENCE');
    if (this.currentState !== 'read_only') throw new Error('Writes can resume only from read-only state');
    this.currentState = 'writable';
  }

  enterRecovery(reason: unknown): void {
    if (this.currentState === 'shutdown') return;
    this.recoveryReason = reason;
    this.recoveryFenceActive = true;
    this.currentState = 'needs_recovery';
  }

  beginShutdown(): void {
    if (this.currentState === 'shutdown') return;
    this.shutdownStarted = true;
    this.currentState = 'shutting_down';
  }

  finishShutdown(): void {
    const recoveryInterruptedShutdown = this.shutdownStarted && this.currentState === 'needs_recovery' && this.recoveryFenceActive;
    if (this.currentState !== 'shutting_down' && this.currentState !== 'shutdown' && !recoveryInterruptedShutdown) {
      throw new Error('Shutdown must begin before it can finish');
    }
    this.currentState = 'shutdown';
  }
}

export interface CommittedEpochTransition {
  readonly fromEpoch: string;
  readonly toEpoch: string;
}

export type StartupCandidateDecision = CandidateDecision | {
  status: 'selected_by_transition';
  candidate: VersionedDatabaseCandidate;
  transition: CommittedEpochTransition;
  candidates: DatabaseCandidate[];
};

function versionedCandidates(candidates: DatabaseCandidate[]): VersionedDatabaseCandidate[] {
  return candidates.filter(
    (candidate): candidate is VersionedDatabaseCandidate => candidate.status === 'valid' && candidate.metadata === 'present'
  );
}

export function decideStartupDatabaseCandidate(
  candidates: DatabaseCandidate[],
  transitions: readonly CommittedEpochTransition[] = []
): StartupCandidateDecision {
  const ordinary = decideDatabaseCandidate(candidates);
  if (ordinary.status !== 'ambiguous_epochs') return ordinary;

  const availableEpochs = new Set(versionedCandidates(candidates).map((candidate) => candidate.version.dataEpoch));
  const matching = transitions.filter(
    (transition) => transition.fromEpoch !== transition.toEpoch &&
      availableEpochs.has(transition.fromEpoch) && availableEpochs.has(transition.toEpoch)
  );
  const targets = Array.from(new Set(matching.map((transition) => transition.toEpoch)));
  if (targets.length !== 1 || matching.length !== 1) return ordinary;

  const transition = matching.find((entry) => entry.toEpoch === targets[0]);
  if (!transition) return ordinary;
  const targetDecision = decideDatabaseCandidate(candidates.filter(
    (candidate) => candidate.status !== 'valid' || candidate.metadata !== 'present' ||
      candidate.version.dataEpoch === transition.toEpoch
  ));
  if (targetDecision.status !== 'selected') return ordinary;
  if (
    targetDecision.candidate.generation.dataRevision !== 0 ||
    targetDecision.candidate.generation.controlRevision !== 0
  ) return ordinary;
  return {
    status: 'selected_by_transition',
    candidate: targetDecision.candidate,
    transition,
    candidates
  };
}

export interface StartupRecoveryFileDependencies extends CandidateFileDependencies {
  rename(from: string, to: string): Promise<void>;
}

export interface StartupDatabaseRecoveryOptions {
  livePath: string;
  opener: CandidateOpener;
  files?: StartupRecoveryFileDependencies;
  directoryDurability?: DirectoryDurabilityDependencies;
  transitions?: readonly CommittedEpochTransition[];
  randomId?: () => string;
}

export type StartupDatabaseRecoveryResult =
  | {
      status: 'ready';
      candidate: VersionedDatabaseCandidate;
      version: DataVersion;
      generation: DatabaseGeneration;
      bytes: Uint8Array;
      quarantined: string[];
      decision: StartupCandidateDecision;
    }
  | {
      status: 'legacy_ready';
      candidate: LegacyDatabaseCandidate;
      bytes: Uint8Array;
      quarantined: string[];
      decision: StartupCandidateDecision;
    }
  | {
      status: 'needs_recovery';
      reason: 'no_valid_candidate' | 'ambiguous_candidates' | 'scan_failed' | 'publication_failed';
      decision: StartupCandidateDecision;
      quarantined: string[];
      error?: unknown;
    };

function selectedCandidate(decision: StartupCandidateDecision): ValidDatabaseCandidate | null {
  if (decision.status === 'selected' || decision.status === 'legacy_selected' || decision.status === 'selected_by_transition') {
    return decision.candidate;
  }
  return null;
}

function recoveryReason(
  decision: StartupCandidateDecision
): 'no_valid_candidate' | 'ambiguous_candidates' | 'scan_failed' {
  if (decision.status === 'scan_failed') return 'scan_failed';
  if (decision.status === 'none') return 'no_valid_candidate';
  return 'ambiguous_candidates';
}

function safeNonce(randomId: () => string): string {
  const nonce = randomId().replace(/[^A-Za-z0-9_-]/g, '');
  if (!nonce) throw new Error('Recovery quarantine nonce is empty');
  return nonce;
}

async function quarantinePath(
  filePath: string,
  files: StartupRecoveryFileDependencies,
  randomId: () => string
): Promise<string> {
  const quarantinePath = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.recovery-${safeNonce(randomId)}.quarantine`
  );
  await files.rename(filePath, quarantinePath);
  return quarantinePath;
}

async function promoteToLive(
  selected: ValidDatabaseCandidate,
  livePath: string,
  candidates: DatabaseCandidate[],
  files: StartupRecoveryFileDependencies,
  randomId: () => string
): Promise<string[]> {
  const quarantined: string[] = [];
  if (selected.kind !== 'live') {
    const existingLive = candidates.find((candidate) => candidate.kind === 'live');
    if (existingLive) quarantined.push(await quarantinePath(livePath, files, randomId));
    await files.rename(selected.path, livePath);
  }
  for (const candidate of candidates) {
    if (candidate.status === 'invalid' && candidate.path !== livePath) {
      quarantined.push(await quarantinePath(candidate.path, files, randomId));
    }
  }
  return quarantined;
}

async function quarantineInvalidCandidates(
  candidates: DatabaseCandidate[],
  files: StartupRecoveryFileDependencies,
  randomId: () => string
): Promise<string[]> {
  const quarantined: string[] = [];
  for (const candidate of candidates) {
    if (candidate.status === 'invalid') quarantined.push(await quarantinePath(candidate.path, files, randomId));
  }
  return quarantined;
}

export async function recoverStartupDatabase(
  options: StartupDatabaseRecoveryOptions
): Promise<StartupDatabaseRecoveryResult> {
  const files = options.files ?? defaultStartupRecoveryFiles;
  const directoryDurability = options.directoryDurability ?? defaultDirectoryDurabilityDependencies;
  const randomId = options.randomId ?? crypto.randomUUID;
  const scan = await scanDatabaseCandidates({ livePath: options.livePath, opener: options.opener, files });
  const decision = scan.status === 'scan_failed'
    ? scan
    : decideStartupDatabaseCandidate(scan.candidates, options.transitions);
  const selected = selectedCandidate(decision);
  if (!selected) {
    let quarantined: string[] = [];
    try {
      quarantined = await quarantineInvalidCandidates(decision.candidates, files, randomId);
      if (quarantined.length) {
        const durability = await flushDirectory(path.dirname(options.livePath), directoryDurability);
        if (durability.status === 'failed') throw durability.error;
      }
    } catch (error) {
      return { status: 'needs_recovery', reason: 'publication_failed', decision, quarantined, error };
    }
    return { status: 'needs_recovery', reason: recoveryReason(decision), decision, quarantined };
  }

  let quarantined: string[];
  try {
    quarantined = await promoteToLive(selected, options.livePath, decision.candidates, files, randomId);
    const durability = await flushDirectory(path.dirname(options.livePath), directoryDurability);
    if (durability.status === 'failed') throw durability.error;
  } catch (error) {
    return { status: 'needs_recovery', reason: 'publication_failed', decision, quarantined: [], error };
  }

  const expectedVersion = selected.metadata === 'present' ? selected.version : undefined;
  const expectedGeneration = selected.metadata === 'present' ? selected.generation : undefined;
  const live = await inspectDatabaseFile(
    options.livePath,
    'live',
    options.opener,
    expectedVersion,
    files,
    expectedGeneration
  );
  if (live.status !== 'valid' || live.metadata !== selected.metadata) {
    return { status: 'needs_recovery', reason: 'publication_failed', decision, quarantined, error: live };
  }
  let bytes: Uint8Array;
  try {
    bytes = await files.readFile(options.livePath);
  } catch (error) {
    return { status: 'needs_recovery', reason: 'publication_failed', decision, quarantined, error };
  }
  if (live.metadata === 'absent') {
    return { status: 'legacy_ready', candidate: live, bytes, quarantined, decision };
  }
  return {
    status: 'ready',
    candidate: live,
    version: live.version,
    generation: live.generation,
    bytes,
    quarantined,
    decision
  };
}

export const defaultStartupRecoveryFiles: StartupRecoveryFileDependencies = {
  async readFile(filePath) {
    return fs.promises.readFile(filePath);
  },
  async readdir(directoryPath) {
    return fs.promises.readdir(directoryPath);
  },
  async rename(from, to) {
    await fs.promises.rename(from, to);
  }
};

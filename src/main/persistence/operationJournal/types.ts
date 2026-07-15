import path from 'node:path';
import type { DataVersion, EntityRef, ExecutionSource } from '../../../shared/agent';

export const operationManifestVersion = 1 as const;
export const operationManifestSchemaVersion = 1 as const;

export const operationStates = [
  'prepared',
  'files_staged',
  'db_committed',
  'files_committed',
  'completed',
  'compensating',
  'compensated',
  'needs_recovery'
] as const;

export type OperationState = (typeof operationStates)[number];
export type OperationTerminalState = 'completed' | 'compensated' | 'needs_recovery';
export type OperationStorage = 'data_root' | 'external_recovery';
export type OperationFileKind = 'create' | 'replace' | 'quarantine_delete';
export type OperationFileStatus =
  | 'pending'
  | 'staged'
  | 'quarantined'
  | 'original_quarantined'
  | 'committed'
  | 'compensated';

export interface FileEvidence {
  readonly sha256: string;
  readonly size: number;
}

export interface OperationFile {
  readonly fileId: string;
  readonly kind: OperationFileKind;
  readonly sourcePath?: string;
  readonly targetPath: string;
  readonly stagingPath?: string;
  readonly quarantinePath?: string;
  readonly content: FileEvidence;
  readonly original?: FileEvidence;
  readonly status: OperationFileStatus;
}

export interface OperationManifestRoots {
  readonly manifestRoot: string;
  readonly managedRoots: readonly string[];
  readonly sourceRoots: readonly string[];
}

export interface OperationCompensationPlan {
  readonly strategy: 'restore_or_remove';
}

export interface OperationManifestError {
  readonly code: string;
  readonly phase: string;
  readonly message: string;
}

export interface OperationManifest {
  readonly manifestVersion: typeof operationManifestVersion;
  readonly schemaVersion: typeof operationManifestSchemaVersion;
  readonly operationId: string;
  readonly requestId: string;
  readonly commandType: string;
  readonly source: ExecutionSource;
  readonly clientId: string;
  readonly traceId: string;
  readonly inputHash: string;
  readonly storage: OperationStorage;
  readonly state: OperationState;
  readonly versionBefore: DataVersion;
  readonly versionAfter: DataVersion;
  readonly affectedEntities: readonly EntityRef[];
  readonly roots: OperationManifestRoots;
  readonly files: readonly OperationFile[];
  readonly compensation: OperationCompensationPlan;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastError: OperationManifestError | null;
}

export interface CreateOperationManifestInput {
  operationId: string;
  requestId: string;
  commandType: string;
  source: ExecutionSource;
  clientId: string;
  traceId: string;
  inputHash: string;
  storage: OperationStorage;
  versionBefore: DataVersion;
  versionAfter: DataVersion;
  affectedEntities: readonly EntityRef[];
  roots: OperationManifestRoots;
  files: readonly OperationFile[];
  createdAt: string;
}

const exactManifestKeys = [
  'manifestVersion', 'schemaVersion', 'operationId', 'requestId', 'commandType', 'source', 'clientId', 'traceId',
  'inputHash', 'storage', 'state', 'versionBefore', 'versionAfter', 'affectedEntities', 'roots', 'files',
  'compensation', 'createdAt', 'updatedAt', 'lastError'
] as const;

const legalTransitions: Readonly<Record<OperationState, readonly OperationState[]>> = {
  prepared: ['prepared', 'files_staged', 'compensating', 'needs_recovery'],
  files_staged: ['files_staged', 'db_committed', 'compensating', 'needs_recovery'],
  db_committed: ['db_committed', 'files_committed', 'needs_recovery'],
  files_committed: ['files_committed', 'completed', 'needs_recovery'],
  completed: ['completed'],
  compensating: ['compensating', 'compensated', 'needs_recovery'],
  compensated: ['compensated'],
  needs_recovery: ['needs_recovery']
};

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  const result = record(value, name);
  for (const key of Object.keys(result)) {
    if (!keys.includes(key)) throw new Error(`${name}.${key} is not supported`);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) throw new Error(`${name}.${key} is required`);
  }
  return result;
}

function shape(value: unknown, keys: readonly string[], requiredKeys: readonly string[], name: string): Record<string, unknown> {
  const result = record(value, name);
  for (const key of Object.keys(result)) {
    if (!keys.includes(key)) throw new Error(`${name}.${key} is not supported`);
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) throw new Error(`${name}.${key} is required`);
  }
  return result;
}

function boundedString(value: unknown, name: string, maximum = 500): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw new Error(`${name} is invalid`);
}

function safeId(value: unknown, name: string): asserts value is string {
  boundedString(value, name, 200);
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${name} must contain only safe identifier characters`);
}

function isoTimestamp(value: unknown, name: string): asserts value is string {
  boundedString(value, name, 100);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO timestamp`);
}

function sha256(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be a lowercase SHA-256 hash`);
}

function absolutePath(value: unknown, name: string): asserts value is string {
  boundedString(value, name, 32_000);
  if (!path.isAbsolute(value) || path.normalize(value) !== value) throw new Error(`${name} must be a normalized absolute path`);
}

function version(value: unknown, name: string): asserts value is DataVersion {
  const result = exact(value, ['dataEpoch', 'dataRevision'], name);
  boundedString(result.dataEpoch, `${name}.dataEpoch`, 200);
  if (!Number.isSafeInteger(result.dataRevision) || (result.dataRevision as number) < 0) {
    throw new Error(`${name}.dataRevision is invalid`);
  }
}

function evidence(value: unknown, name: string): asserts value is FileEvidence {
  const result = exact(value, ['sha256', 'size'], name);
  sha256(result.sha256, `${name}.sha256`);
  if (!Number.isSafeInteger(result.size) || (result.size as number) < 0) throw new Error(`${name}.size is invalid`);
}

function isSameOrDescendant(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function assertPathConfined(candidate: string, roots: readonly string[], name = 'path'): void {
  absolutePath(candidate, name);
  if (!roots.some((root) => isSameOrDescendant(candidate, root))) throw new Error(`${name} escapes its authorized roots`);
}

export function assertSameVolume(left: string, right: string, name = 'paths'): void {
  const leftRoot = path.parse(left).root.toLowerCase();
  const rightRoot = path.parse(right).root.toLowerCase();
  if (!leftRoot || leftRoot !== rightRoot) throw new Error(`${name} must be on the same volume`);
}

function validateRoots(value: unknown): asserts value is OperationManifestRoots {
  const roots = exact(value, ['manifestRoot', 'managedRoots', 'sourceRoots'], 'manifest.roots');
  absolutePath(roots.manifestRoot, 'manifest.roots.manifestRoot');
  for (const key of ['managedRoots', 'sourceRoots'] as const) {
    const entries = roots[key];
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > 20) throw new Error(`manifest.roots.${key} is invalid`);
    for (const [index, entry] of entries.entries()) absolutePath(entry, `manifest.roots.${key}[${index}]`);
    if (new Set(entries).size !== entries.length) throw new Error(`manifest.roots.${key} contains duplicates`);
  }
}

function validateFile(value: unknown, roots: OperationManifestRoots, index: number): asserts value is OperationFile {
  const name = `manifest.files[${index}]`;
  const file = shape(value, [
    'fileId', 'kind', 'sourcePath', 'targetPath', 'stagingPath', 'quarantinePath', 'content', 'original', 'status'
  ], ['fileId', 'kind', 'targetPath', 'content', 'status'], name);
  safeId(file.fileId, `${name}.fileId`);
  if (!['create', 'replace', 'quarantine_delete'].includes(file.kind as string)) throw new Error(`${name}.kind is invalid`);
  if (!['pending', 'staged', 'quarantined', 'original_quarantined', 'committed', 'compensated'].includes(file.status as string)) {
    throw new Error(`${name}.status is invalid`);
  }
  assertPathConfined(file.targetPath as string, roots.managedRoots, `${name}.targetPath`);
  evidence(file.content, `${name}.content`);

  if (file.sourcePath !== undefined) assertPathConfined(file.sourcePath as string, roots.sourceRoots, `${name}.sourcePath`);
  if (file.stagingPath !== undefined) {
    assertPathConfined(file.stagingPath as string, roots.managedRoots, `${name}.stagingPath`);
    assertSameVolume(file.stagingPath as string, file.targetPath as string, `${name}.stagingPath`);
  }
  if (file.quarantinePath !== undefined) assertPathConfined(file.quarantinePath as string, roots.managedRoots, `${name}.quarantinePath`);
  if (file.original !== undefined) evidence(file.original, `${name}.original`);

  if (file.kind === 'create') {
    if (file.sourcePath === undefined || file.stagingPath === undefined || file.quarantinePath !== undefined || file.original !== undefined) {
      throw new Error(`${name} create paths are inconsistent`);
    }
    if (!['pending', 'staged', 'committed', 'compensated'].includes(file.status as string)) throw new Error(`${name}.status is invalid for create`);
  } else if (file.kind === 'replace') {
    if (file.sourcePath === undefined || file.stagingPath === undefined || file.quarantinePath === undefined || file.original === undefined) {
      throw new Error(`${name} replacement paths are incomplete`);
    }
    if (!['pending', 'staged', 'original_quarantined', 'committed', 'compensated'].includes(file.status as string)) {
      throw new Error(`${name}.status is invalid for replacement`);
    }
  } else {
    if (file.sourcePath !== undefined || file.stagingPath !== undefined || file.quarantinePath === undefined || file.original !== undefined) {
      throw new Error(`${name} quarantine deletion paths are inconsistent`);
    }
    if (!['pending', 'quarantined', 'committed', 'compensated'].includes(file.status as string)) {
      throw new Error(`${name}.status is invalid for quarantine deletion`);
    }
  }
}

export function validateOperationManifest(value: unknown): asserts value is OperationManifest {
  const manifest = exact(value, exactManifestKeys, 'manifest');
  if (manifest.manifestVersion !== operationManifestVersion) throw new Error('Unsupported operation manifest version');
  if (manifest.schemaVersion !== operationManifestSchemaVersion) throw new Error('Unsupported operation manifest schema version');
  safeId(manifest.operationId, 'manifest.operationId');
  safeId(manifest.requestId, 'manifest.requestId');
  boundedString(manifest.commandType, 'manifest.commandType', 200);
  if (!['renderer', 'internal', 'mcp'].includes(manifest.source as string)) throw new Error('manifest.source is invalid');
  boundedString(manifest.clientId, 'manifest.clientId', 200);
  boundedString(manifest.traceId, 'manifest.traceId', 200);
  sha256(manifest.inputHash, 'manifest.inputHash');
  if (!['data_root', 'external_recovery'].includes(manifest.storage as string)) throw new Error('manifest.storage is invalid');
  if (!operationStates.includes(manifest.state as OperationState)) throw new Error('manifest.state is invalid');
  version(manifest.versionBefore, 'manifest.versionBefore');
  version(manifest.versionAfter, 'manifest.versionAfter');
  validateRoots(manifest.roots);
  const roots = manifest.roots;
  if (manifest.storage === 'data_root') assertPathConfined(roots.manifestRoot, roots.managedRoots, 'manifest.roots.manifestRoot');
  if (manifest.storage === 'external_recovery' && roots.managedRoots.some((root) =>
    isSameOrDescendant(roots.manifestRoot, root) || isSameOrDescendant(root, roots.manifestRoot)
  )) {
    throw new Error('External recovery manifest root must be outside managed roots');
  }
  if (!Array.isArray(manifest.affectedEntities) || manifest.affectedEntities.length > 10_000) throw new Error('manifest.affectedEntities is invalid');
  for (const [index, entity] of manifest.affectedEntities.entries()) {
    const entry = exact(entity, ['entityType', 'entityId'], `manifest.affectedEntities[${index}]`);
    boundedString(entry.entityType, `manifest.affectedEntities[${index}].entityType`, 200);
    boundedString(entry.entityId, `manifest.affectedEntities[${index}].entityId`, 500);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > 10_000) throw new Error('manifest.files is invalid');
  for (const [index, file] of manifest.files.entries()) validateFile(file, roots, index);
  if (new Set(manifest.files.map((file) => file.fileId)).size !== manifest.files.length) throw new Error('manifest.files contains duplicate fileId values');
  const effectPaths = manifest.files.flatMap((file) => [file.targetPath, file.stagingPath, file.quarantinePath].filter((entry): entry is string => entry !== undefined));
  const normalizedEffectPaths = effectPaths.map((entry) => path.resolve(entry).toLowerCase());
  if (new Set(normalizedEffectPaths).size !== normalizedEffectPaths.length) throw new Error('manifest.files contains colliding effect paths');
  for (const [index, file] of manifest.files.entries()) {
    if (file.sourcePath && normalizedEffectPaths.includes(path.resolve(file.sourcePath).toLowerCase())) {
      throw new Error(`manifest.files[${index}].sourcePath collides with an operation effect path`);
    }
  }
  if (manifest.state === 'prepared' && manifest.files.some((file) => file.status !== 'pending')) {
    throw new Error('Prepared manifest files must be pending');
  }
  if ((manifest.state === 'files_staged' || manifest.state === 'db_committed') && manifest.files.some((file) =>
    file.kind === 'quarantine_delete'
      ? !['quarantined', 'committed'].includes(file.status)
      : !['staged', 'original_quarantined', 'committed'].includes(file.status)
  )) throw new Error(`${manifest.state} manifest contains an inconsistent file status`);
  if ((manifest.state === 'files_committed' || manifest.state === 'completed') && manifest.files.some((file) => file.status !== 'committed')) {
    throw new Error(`${manifest.state} manifest files must be committed`);
  }
  if (manifest.state === 'compensated' && manifest.files.some((file) => file.status !== 'compensated')) {
    throw new Error('Compensated manifest files must be compensated');
  }
  const compensation = exact(manifest.compensation, ['strategy'], 'manifest.compensation');
  if (compensation.strategy !== 'restore_or_remove') throw new Error('manifest.compensation.strategy is invalid');
  isoTimestamp(manifest.createdAt, 'manifest.createdAt');
  isoTimestamp(manifest.updatedAt, 'manifest.updatedAt');
  if (Date.parse(manifest.updatedAt) < Date.parse(manifest.createdAt)) throw new Error('manifest.updatedAt precedes createdAt');
  if (manifest.lastError !== null) {
    const error = exact(manifest.lastError, ['code', 'phase', 'message'], 'manifest.lastError');
    boundedString(error.code, 'manifest.lastError.code', 200);
    boundedString(error.phase, 'manifest.lastError.phase', 200);
    boundedString(error.message, 'manifest.lastError.message', 1_000);
  }
  if (manifest.versionBefore.dataEpoch === manifest.versionAfter.dataEpoch) {
    if (manifest.versionBefore.dataRevision === Number.MAX_SAFE_INTEGER || manifest.versionAfter.dataRevision !== manifest.versionBefore.dataRevision + 1) {
      throw new Error('manifest.versionAfter must increment revision exactly once');
    }
  } else if (manifest.versionAfter.dataRevision !== 0) {
    throw new Error('A new manifest epoch must begin at revision zero');
  }
}

export function createOperationManifest(input: CreateOperationManifestInput): OperationManifest {
  const manifest: OperationManifest = {
    manifestVersion: operationManifestVersion,
    schemaVersion: operationManifestSchemaVersion,
    ...input,
    state: 'prepared',
    compensation: { strategy: 'restore_or_remove' },
    updatedAt: input.createdAt,
    lastError: null
  };
  validateOperationManifest(manifest);
  return manifest;
}

export function assertLegalOperationTransition(from: OperationState, to: OperationState): void {
  if (!legalTransitions[from].includes(to)) throw new Error(`Illegal operation transition: ${from} -> ${to}`);
}

export function transitionOperationManifest(
  manifest: OperationManifest,
  state: OperationState,
  updatedAt: string,
  changes: { files?: readonly OperationFile[]; lastError?: OperationManifestError | null } = {}
): OperationManifest {
  assertLegalOperationTransition(manifest.state, state);
  const next: OperationManifest = {
    ...manifest,
    state,
    files: changes.files ?? manifest.files,
    updatedAt,
    lastError: changes.lastError === undefined ? manifest.lastError : changes.lastError
  };
  validateOperationManifest(next);
  return next;
}

export function isTerminalOperationState(state: OperationState): state is OperationTerminalState {
  return state === 'completed' || state === 'compensated' || state === 'needs_recovery';
}

export function sameDataVersion(left: DataVersion, right: DataVersion): boolean {
  return left.dataEpoch === right.dataEpoch && left.dataRevision === right.dataRevision;
}

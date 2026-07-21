import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AgentError } from '../../../shared/agent/errors';
import type { EntityRef } from '../../../shared/agent/v1/contracts';
import { hashCanonicalJson } from '../../../shared/agent/v1/gatewaySchemas';
import type { AppPaths } from '../../../shared/types';

const HASH_PREFIX = 'sha256-v1:';
const JOURNAL_ALLOWANCE = 1024 * 1024;
const FIXED_HEADROOM = 16 * 1024 * 1024;
const DATABASE_GROWTH_ALLOWANCE = 16 * 1024 * 1024;
export const DATA_ROOT_SELECTION_TTL_MS = 10 * 60_000;
export const DATA_ROOT_MAX_AFFECTED_ENTITIES = 500;

export interface DataRootFileEvidence {
  readonly relativePath: string;
  readonly contentHash: string;
  readonly contentSize: number;
}

export interface DataRootSelectionPlan {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly targetIdentity: string;
  readonly sourceIdentity: string;
  readonly inventory: readonly DataRootFileEvidence[];
  readonly inventoryHash: string;
  readonly inventoryBytes: number;
  readonly planningAvailableBytes: number;
  readonly requiredBytes: number;
  readonly schemaHash: string;
  readonly baseVersion: { readonly dataEpoch: string; readonly dataRevision: number };
  readonly affectedEntities: readonly EntityRef[];
  readonly affectedSetHash: string;
  readonly targetHash: string;
  readonly selectionBindingHash: string;
  readonly expiresAt: string;
}

export interface StoredDataRootSelection {
  readonly targetIdentity: string;
  readonly sourceIdentity: string;
  readonly inventoryHash: string;
  readonly inventoryBytes: number;
  readonly inventoryCount: number;
  readonly planningAvailableBytes: number;
  readonly requiredBytes: number;
  readonly schemaHash: string;
  readonly baseDataEpoch: string;
  readonly baseDataRevision: number;
  readonly affectedSetHash: string;
  readonly targetHash: string;
  readonly selectionBindingHash: string;
  readonly expiresAt: string;
}

const managedTrees = Object.freeze([
  'data', 'images', 'exports', 'backups', 'temp', 'textbooks',
  path.join('assets', 'question_bank'), 'trash'
]);

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertLocalPath(candidate: string): void {
  if (!path.isAbsolute(candidate) || candidate.startsWith('\\\\') || candidate.startsWith('\\?\\') || candidate.startsWith('\\.\\')) {
    throw new AgentError('VALIDATION_ERROR', { field: 'selectedRoot' });
  }
}

function canonicalDirectory(candidate: string): { readonly path: string; readonly identity: string } {
  const normalized = path.normalize(path.resolve(candidate));
  assertLocalPath(normalized);
  const parsed = path.parse(normalized);
  let current = parsed.root;
  for (const part of normalized.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AgentError('RECOVERY_FENCE');
  }
  const real = path.normalize(fs.realpathSync.native(normalized));
  assertLocalPath(real);
  if (real !== normalized) throw new AgentError('RECOVERY_FENCE');
  const stat = fs.statSync(real, { bigint: true });
  return Object.freeze({ path: real, identity: hashCanonicalJson({ dev: stat.dev.toString(), ino: stat.ino.toString(), root: path.parse(real).root.toLowerCase() }) });
}

function hashFile(filePath: string): { readonly contentHash: string; readonly contentSize: number } {
  const handle = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const digest = crypto.createHash('sha256');
  let total = 0;
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const read = fs.readSync(handle, chunk, 0, chunk.byteLength, null);
      if (read === 0) break;
      digest.update(chunk.subarray(0, read));
      total += read;
    }
  } finally {
    fs.closeSync(handle);
  }
  return Object.freeze({ contentHash: `${HASH_PREFIX}${digest.digest('hex')}`, contentSize: total });
}

function inventoryFor(paths: AppPaths): readonly DataRootFileEvidence[] {
  const root = canonicalDirectory(paths.root).path;
  const files: DataRootFileEvidence[] = [];
  const visit = (relativeDirectory: string): void => {
    const absoluteDirectory = path.normalize(path.join(root, relativeDirectory));
    if (!isWithin(root, absoluteDirectory) || !fs.existsSync(absoluteDirectory)) return;
    const directory = canonicalDirectory(absoluteDirectory);
    if (!isWithin(root, directory.path)) throw new AgentError('RECOVERY_FENCE');
    for (const entry of fs.readdirSync(directory.path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = path.join(relativeDirectory, entry.name);
      const absolute = path.normalize(path.join(root, relative));
      const stat = fs.lstatSync(absolute);
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) throw new AgentError('RECOVERY_FENCE');
      if (entry.isDirectory()) visit(relative);
      else if (entry.isFile()) {
        if (path.normalize(relative).toLowerCase() === path.normalize(path.join('data', 'mistakes.db')).toLowerCase()) continue;
        const real = path.normalize(fs.realpathSync.native(absolute));
        if (real !== absolute || !isWithin(root, real)) throw new AgentError('RECOVERY_FENCE');
        files.push(Object.freeze({ relativePath: relative.split(path.sep).join('/'), ...hashFile(absolute) }));
      } else throw new AgentError('RECOVERY_FENCE');
    }
  };
  for (const tree of managedTrees) visit(tree);
  return Object.freeze(files.sort((a, b) => a.relativePath.localeCompare(b.relativePath)));
}

function availableBytes(target: string): number {
  const stats = fs.statfsSync(target);
  const value = Number(stats.bavail) * Number(stats.bsize);
  if (!Number.isSafeInteger(value) || value < 0) throw new AgentError('RECOVERY_FENCE');
  return value;
}

export function planDataRootSelection(input: {
  readonly targetPath: string;
  readonly sourcePaths: AppPaths;
  readonly baseVersion: { readonly dataEpoch: string; readonly dataRevision: number };
  readonly schemaHash: string;
  readonly selectionId: string;
  readonly now: string;
}): DataRootSelectionPlan {
  const source = canonicalDirectory(input.sourcePaths.root);
  const target = canonicalDirectory(input.targetPath);
  if (isWithin(source.path, target.path) || isWithin(target.path, source.path)) throw new AgentError('VALIDATION_ERROR', { field: 'selectedRoot' });
  if (fs.readdirSync(target.path).length !== 0) throw new AgentError('VALIDATION_ERROR', { field: 'selectedRoot' });
  const inventory = inventoryFor(input.sourcePaths);
  const affectedEntities = Object.freeze([
    Object.freeze({ entityType: 'root_selection', entityId: input.selectionId }),
    Object.freeze({ entityType: 'data_root_database', entityId: hashCanonicalJson({ version: input.baseVersion, schemaHash: input.schemaHash }) }),
    ...inventory.map((file) => Object.freeze({ entityType: 'data_root_file', entityId: hashCanonicalJson({ relativePath: file.relativePath }) }))
  ]);
  if (affectedEntities.length > DATA_ROOT_MAX_AFFECTED_ENTITIES) throw new AgentError('VALIDATION_ERROR', { field: 'affectedEntities' });
  const inventoryBytes = inventory.reduce((sum, file) => sum + file.contentSize, 0);
  const liveDatabaseSize = fs.statSync(input.sourcePaths.database).size;
  const databaseAllowance = (liveDatabaseSize + DATABASE_GROWTH_ALLOWANCE) * 3;
  const requiredBytes = inventoryBytes + databaseAllowance + FIXED_HEADROOM + JOURNAL_ALLOWANCE;
  const planningAvailableBytes = availableBytes(target.path);
  if (planningAvailableBytes < requiredBytes) throw new AgentError('RECOVERY_FENCE');
  const inventoryHash = hashCanonicalJson(inventory);
  const affectedSetHash = hashCanonicalJson(affectedEntities);
  const expiresAt = new Date(new Date(input.now).getTime() + DATA_ROOT_SELECTION_TTL_MS).toISOString();
  const stable = Object.freeze({ selectionId: input.selectionId, targetIdentity: target.identity, sourceIdentity: source.identity,
    inventoryHash, inventoryBytes, inventoryCount: inventory.length, planningAvailableBytes, requiredBytes,
    schemaHash: input.schemaHash, baseVersion: input.baseVersion, affectedSetHash });
  const selectionBindingHash = hashCanonicalJson(stable);
  const targetHash = hashCanonicalJson({ operation: 'data_root.migrate', ...stable, selectionBindingHash });
  return Object.freeze({ sourcePath: source.path, targetPath: target.path, targetIdentity: target.identity, sourceIdentity: source.identity,
    inventory, inventoryHash, inventoryBytes, planningAvailableBytes, requiredBytes, schemaHash: input.schemaHash,
    baseVersion: Object.freeze({ ...input.baseVersion }), affectedEntities, affectedSetHash, targetHash, selectionBindingHash, expiresAt });
}

export function storedSelection(plan: DataRootSelectionPlan): StoredDataRootSelection {
  return Object.freeze({ targetIdentity: plan.targetIdentity, sourceIdentity: plan.sourceIdentity, inventoryHash: plan.inventoryHash,
    inventoryBytes: plan.inventoryBytes, inventoryCount: plan.inventory.length, planningAvailableBytes: plan.planningAvailableBytes,
    requiredBytes: plan.requiredBytes, schemaHash: plan.schemaHash, baseDataEpoch: plan.baseVersion.dataEpoch,
    baseDataRevision: plan.baseVersion.dataRevision, affectedSetHash: plan.affectedSetHash, targetHash: plan.targetHash,
    selectionBindingHash: plan.selectionBindingHash, expiresAt: plan.expiresAt });
}

export function resolveStoredDataRootSelection(input: {
  readonly selectionId: string;
  readonly targetPath: string;
  readonly stored: StoredDataRootSelection;
  readonly sourcePaths: AppPaths;
  readonly baseVersion: { readonly dataEpoch: string; readonly dataRevision: number };
  readonly schemaHash: string;
  readonly allowPopulatedTarget?: boolean;
}): DataRootSelectionPlan {
  const target = canonicalDirectory(input.targetPath);
  const source = canonicalDirectory(input.sourcePaths.root);
  if (target.identity !== input.stored.targetIdentity || source.identity !== input.stored.sourceIdentity ||
      input.schemaHash !== input.stored.schemaHash || input.baseVersion.dataEpoch !== input.stored.baseDataEpoch ||
      input.baseVersion.dataRevision !== input.stored.baseDataRevision) throw new AgentError('RECOVERY_FENCE');
  const inventory = inventoryFor(input.sourcePaths);
  if (hashCanonicalJson(inventory) !== input.stored.inventoryHash || inventory.length !== input.stored.inventoryCount ||
      inventory.reduce((sum, file) => sum + file.contentSize, 0) !== input.stored.inventoryBytes) throw new AgentError('RECOVERY_FENCE');
  if (!input.allowPopulatedTarget && fs.readdirSync(target.path).length !== 0) throw new AgentError('RECOVERY_FENCE');
  if (availableBytes(target.path) < input.stored.requiredBytes) throw new AgentError('RECOVERY_FENCE');
  const affectedEntities = Object.freeze([
    Object.freeze({ entityType: 'root_selection', entityId: input.selectionId }),
    Object.freeze({ entityType: 'data_root_database', entityId: hashCanonicalJson({ version: input.baseVersion, schemaHash: input.schemaHash }) }),
    ...inventory.map((file) => Object.freeze({ entityType: 'data_root_file', entityId: hashCanonicalJson({ relativePath: file.relativePath }) }))
  ]);
  if (hashCanonicalJson(affectedEntities) !== input.stored.affectedSetHash) throw new AgentError('RECOVERY_FENCE');
  return Object.freeze({ sourcePath: source.path, targetPath: target.path, targetIdentity: target.identity, sourceIdentity: source.identity, inventory,
    inventoryHash: input.stored.inventoryHash, inventoryBytes: input.stored.inventoryBytes,
    planningAvailableBytes: input.stored.planningAvailableBytes, requiredBytes: input.stored.requiredBytes,
    schemaHash: input.stored.schemaHash, baseVersion: Object.freeze({ ...input.baseVersion }), affectedEntities,
    affectedSetHash: input.stored.affectedSetHash, targetHash: input.stored.targetHash,
    selectionBindingHash: input.stored.selectionBindingHash, expiresAt: input.stored.expiresAt });
}

export function assertSelectionNotExpired(expiresAt: string, now: string): void {
  if (new Date(expiresAt).getTime() <= new Date(now).getTime()) throw new AgentError('HANDLER_NOT_FOUND');
}

export function managedDataRootTrees(): readonly string[] { return managedTrees; }

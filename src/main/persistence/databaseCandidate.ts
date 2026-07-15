import fs from 'node:fs';
import path from 'node:path';
import type { SqlJsStatic, SqlValue } from 'sql.js';
import type { DataVersion } from '../../shared/agent';

export type DatabaseCandidateKind = 'live' | 'previous' | 'temp';

export interface CandidateDatabase {
  run(sql: string): unknown;
  exec(sql: string): Array<{ columns: string[]; values: SqlValue[][] }>;
  close(): void;
}

export interface CandidateOpener {
  open(bytes: Uint8Array): CandidateDatabase;
}

export type CandidateInvalidReason =
  | 'read_error'
  | 'open_error'
  | 'integrity_error'
  | 'foreign_key_error'
  | 'metadata_error'
  | 'version_mismatch'
  | 'close_error';

interface CandidateIdentity {
  path: string;
  kind: DatabaseCandidateKind;
}

export interface VersionedDatabaseCandidate extends CandidateIdentity {
  status: 'valid';
  metadata: 'present';
  version: DataVersion;
}

export interface LegacyDatabaseCandidate extends CandidateIdentity {
  status: 'valid';
  metadata: 'absent';
}

export type ValidDatabaseCandidate = VersionedDatabaseCandidate | LegacyDatabaseCandidate;

export interface InvalidDatabaseCandidate extends CandidateIdentity {
  status: 'invalid';
  reason: CandidateInvalidReason;
  error?: unknown;
  actualVersion?: DataVersion;
}

export type DatabaseCandidate = ValidDatabaseCandidate | InvalidDatabaseCandidate;

export interface CandidateFileDependencies {
  readFile(filePath: string): Promise<Uint8Array>;
  readdir(directoryPath: string): Promise<string[]>;
}

export interface EnumerateCandidatesOptions {
  livePath: string;
  opener: CandidateOpener;
  files?: CandidateFileDependencies;
  expectedVersion?: DataVersion;
}

export type CandidateScanOutcome =
  | { status: 'scanned'; candidates: DatabaseCandidate[] }
  | { status: 'scan_failed'; directoryPath: string; error: unknown; candidates: [] };

export type CandidateDecision =
  | { status: 'none'; candidates: DatabaseCandidate[] }
  | { status: 'selected'; candidate: VersionedDatabaseCandidate; candidates: DatabaseCandidate[] }
  | { status: 'legacy_selected'; candidate: LegacyDatabaseCandidate; candidates: DatabaseCandidate[] }
  | { status: 'ambiguous_epochs'; epochs: string[]; candidates: DatabaseCandidate[] }
  | { status: 'ambiguous_metadata'; candidates: DatabaseCandidate[] }
  | { status: 'ambiguous_legacy'; candidates: DatabaseCandidate[] }
  | { status: 'scan_failed'; directoryPath: string; error: unknown; candidates: [] };

export function createSqlJsCandidateOpener(SQL: SqlJsStatic): CandidateOpener {
  return {
    open(bytes) {
      return new SQL.Database(bytes);
    }
  };
}

export function databasePreviousPath(livePath: string): string {
  return path.join(path.dirname(livePath), `.${path.basename(livePath)}.previous`);
}

export function databaseTempPrefix(livePath: string): string {
  return `.${path.basename(livePath)}.`;
}

function flattenCells(results: Array<{ values: SqlValue[][] }>): SqlValue[] {
  return results.flatMap((result) => result.values.flat());
}

function readVersion(database: CandidateDatabase): { metadata: 'absent' } | { metadata: 'present'; version: DataVersion } {
  const tableRows = flattenCells(database.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'control_metadata'"
  ));
  if (tableRows.length === 0) return { metadata: 'absent' };
  if (tableRows.length !== 1 || tableRows[0] !== 'control_metadata') throw new Error('control_metadata lookup is malformed');

  const result = database.exec('SELECT id, data_epoch, data_revision FROM control_metadata');
  if (result.length !== 1 || result[0].values.length !== 1) throw new Error('control_metadata must contain one row');
  const [id, dataEpoch, dataRevision] = result[0].values[0];
  if (
    id !== 1 ||
    typeof dataEpoch !== 'string' || dataEpoch.length === 0 || dataEpoch.length > 200 ||
    typeof dataRevision !== 'number' || !Number.isSafeInteger(dataRevision) || dataRevision < 0
  ) throw new Error('control_metadata contains an invalid data version');
  return { metadata: 'present', version: { dataEpoch, dataRevision } };
}

function sameVersion(left: DataVersion, right: DataVersion): boolean {
  return left.dataEpoch === right.dataEpoch && left.dataRevision === right.dataRevision;
}

export function inspectDatabaseBytes(
  bytes: Uint8Array,
  identity: CandidateIdentity,
  opener: CandidateOpener,
  expectedVersion?: DataVersion
): DatabaseCandidate {
  let database: CandidateDatabase;
  try {
    database = opener.open(bytes);
  } catch (error) {
    return { ...identity, status: 'invalid', reason: 'open_error', error };
  }

  let result: DatabaseCandidate;
  try {
    try {
      database.run('PRAGMA foreign_keys = ON');
    } catch (error) {
      result = { ...identity, status: 'invalid', reason: 'foreign_key_error', error };
      return closeCandidate(database, result, identity);
    }

    try {
      const quickCheck = flattenCells(database.exec('PRAGMA quick_check'));
      if (quickCheck.length !== 1 || quickCheck[0] !== 'ok') {
        result = { ...identity, status: 'invalid', reason: 'integrity_error' };
        return closeCandidate(database, result, identity);
      }
    } catch (error) {
      result = { ...identity, status: 'invalid', reason: 'integrity_error', error };
      return closeCandidate(database, result, identity);
    }

    try {
      const foreignKeyRows = database.exec('PRAGMA foreign_key_check');
      if (foreignKeyRows.some((entry) => entry.values.length > 0)) {
        result = { ...identity, status: 'invalid', reason: 'foreign_key_error' };
        return closeCandidate(database, result, identity);
      }
    } catch (error) {
      result = { ...identity, status: 'invalid', reason: 'foreign_key_error', error };
      return closeCandidate(database, result, identity);
    }

    let metadata: ReturnType<typeof readVersion>;
    try {
      metadata = readVersion(database);
    } catch (error) {
      result = { ...identity, status: 'invalid', reason: 'metadata_error', error };
      return closeCandidate(database, result, identity);
    }

    if (metadata.metadata === 'absent') {
      result = expectedVersion
        ? { ...identity, status: 'invalid', reason: 'version_mismatch' }
        : { ...identity, status: 'valid', metadata: 'absent' };
      return closeCandidate(database, result, identity);
    }
    if (expectedVersion && !sameVersion(metadata.version, expectedVersion)) {
      result = { ...identity, status: 'invalid', reason: 'version_mismatch', actualVersion: metadata.version };
      return closeCandidate(database, result, identity);
    }
    result = { ...identity, status: 'valid', metadata: 'present', version: metadata.version };
    return closeCandidate(database, result, identity);
  } catch (error) {
    result = { ...identity, status: 'invalid', reason: 'integrity_error', error };
    return closeCandidate(database, result, identity);
  }
}

function closeCandidate(
  database: CandidateDatabase,
  result: DatabaseCandidate,
  identity: CandidateIdentity
): DatabaseCandidate {
  try {
    database.close();
    return result;
  } catch (error) {
    return { ...identity, status: 'invalid', reason: 'close_error', error };
  }
}

export async function inspectDatabaseFile(
  filePath: string,
  kind: DatabaseCandidateKind,
  opener: CandidateOpener,
  expectedVersion?: DataVersion,
  files: CandidateFileDependencies = defaultCandidateFileDependencies
): Promise<DatabaseCandidate> {
  let bytes: Uint8Array;
  try {
    bytes = await files.readFile(filePath);
  } catch (error) {
    return { path: filePath, kind, status: 'invalid', reason: 'read_error', error };
  }
  return inspectDatabaseBytes(bytes, { path: filePath, kind }, opener, expectedVersion);
}

export async function scanDatabaseCandidates(options: EnumerateCandidatesOptions): Promise<CandidateScanOutcome> {
  const files = options.files ?? defaultCandidateFileDependencies;
  const directoryPath = path.dirname(options.livePath);
  const liveName = path.basename(options.livePath);
  const previousName = path.basename(databasePreviousPath(options.livePath));
  const tempPrefix = databaseTempPrefix(options.livePath);
  let names: string[];
  try {
    names = await files.readdir(directoryPath);
  } catch (error) {
    return { status: 'scan_failed', directoryPath, error, candidates: [] };
  }

  const identities: CandidateIdentity[] = [];
  if (names.includes(liveName)) identities.push({ path: options.livePath, kind: 'live' });
  if (names.includes(previousName)) identities.push({ path: databasePreviousPath(options.livePath), kind: 'previous' });
  for (const name of names.filter((entry) => entry.startsWith(tempPrefix) && entry.endsWith('.tmp')).sort()) {
    identities.push({ path: path.join(directoryPath, name), kind: 'temp' });
  }
  const candidates = await Promise.all(identities.map((identity) => inspectDatabaseFile(
    identity.path,
    identity.kind,
    options.opener,
    options.expectedVersion,
    files
  )));
  return { status: 'scanned', candidates };
}

export async function enumerateDatabaseCandidates(options: EnumerateCandidatesOptions): Promise<DatabaseCandidate[]> {
  return (await scanDatabaseCandidates(options)).candidates;
}

export async function inspectDatabaseCandidates(options: EnumerateCandidatesOptions): Promise<CandidateDecision> {
  const scan = await scanDatabaseCandidates(options);
  return scan.status === 'scan_failed' ? scan : decideDatabaseCandidate(scan.candidates);
}

const kindPriority: Record<DatabaseCandidateKind, number> = { live: 0, temp: 1, previous: 2 };

export function decideDatabaseCandidate(candidates: DatabaseCandidate[]): CandidateDecision {
  const valid = candidates.filter((candidate): candidate is ValidDatabaseCandidate => candidate.status === 'valid');
  if (!valid.length) return { status: 'none', candidates };
  const versioned = valid.filter((candidate): candidate is VersionedDatabaseCandidate => candidate.metadata === 'present');
  const legacy = valid.filter((candidate): candidate is LegacyDatabaseCandidate => candidate.metadata === 'absent');
  if (versioned.length && legacy.length) return { status: 'ambiguous_metadata', candidates };
  if (legacy.length === 1) return { status: 'legacy_selected', candidate: legacy[0], candidates };
  if (legacy.length > 1) return { status: 'ambiguous_legacy', candidates };

  const epochs = Array.from(new Set(versioned.map((candidate) => candidate.version.dataEpoch)));
  if (epochs.length > 1) return { status: 'ambiguous_epochs', epochs, candidates };
  const highestRevision = Math.max(...versioned.map((candidate) => candidate.version.dataRevision));
  const highest = versioned
    .filter((candidate) => candidate.version.dataRevision === highestRevision)
    .sort((left, right) => kindPriority[left.kind] - kindPriority[right.kind] || left.path.localeCompare(right.path));
  return { status: 'selected', candidate: highest[0], candidates };
}

export const defaultCandidateFileDependencies: CandidateFileDependencies = {
  async readFile(filePath) {
    return fs.promises.readFile(filePath);
  },
  async readdir(directoryPath) {
    return fs.promises.readdir(directoryPath);
  }
};

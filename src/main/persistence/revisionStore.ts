import type { Database, SqlValue } from 'sql.js';
import { AgentError } from '../../shared/agent/errors';
import type { DataVersion } from '../../shared/agent/v1/contracts';

interface ControlMetadataRow {
  id: unknown;
  data_epoch: unknown;
  data_revision: unknown;
  schema_version: unknown;
  updated_at: unknown;
}

interface CapabilityState {
  database: Database;
  consumed: boolean;
}

export interface RevisionMutationCapability {
  readonly kind: 'revision-mutation-capability';
}

export interface ControlMetadata extends DataVersion {
  readonly schemaVersion: number;
  readonly updatedAt: string;
}

const capabilityStates = new WeakMap<object, CapabilityState>();
const MAX_EPOCH_LENGTH = 200;
const MAX_TIMESTAMP_LENGTH = 100;

export function createRevisionMutationCapability(database: Database): RevisionMutationCapability {
  const capability = Object.freeze({ kind: 'revision-mutation-capability' as const });
  capabilityStates.set(capability, { database, consumed: false });
  return capability;
}

function allRows<T>(database: Database, sql: string, params: SqlValue[] = []): T[] {
  const statement = database.prepare(sql);
  const rows: T[] = [];
  try {
    statement.bind(params);
    while (statement.step()) rows.push(statement.getAsObject() as T);
    return rows;
  } finally {
    statement.free();
  }
}

function assertSafeNonNegativeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Malformed control metadata: ${field} must be a safe nonnegative integer`);
  }
}

function assertSafePositiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`Malformed control metadata: ${field} must be a safe positive integer`);
  }
}

function assertNonemptyString(value: unknown, field: string, maxLength: number): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`Malformed control metadata: ${field} must be a nonempty string of at most ${maxLength} characters`);
  }
}

function assertIsoTimestamp(value: unknown, field: string): asserts value is string {
  assertNonemptyString(value, field, MAX_TIMESTAMP_LENGTH);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Malformed control metadata: ${field} must be an ISO timestamp`);
  }
}

function consumeCapability(database: Database, capability: RevisionMutationCapability): void {
  const state = capabilityStates.get(capability as object);
  if (!state || state.database !== database || state.consumed) {
    throw new Error('A fresh revision mutation capability for this database is required');
  }
  state.consumed = true;
}

export class RevisionStore {
  constructor(
    private readonly database: Database,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  private readRows(): ControlMetadataRow[] {
    let rows: ControlMetadataRow[];
    try {
      rows = allRows<ControlMetadataRow>(
        this.database,
        'SELECT id, data_epoch, data_revision, schema_version, updated_at FROM control_metadata'
      );
    } catch (error) {
      throw new Error('Control metadata table is missing or unreadable', { cause: error });
    }
    return rows;
  }

  readOptionalMetadata(): ControlMetadata | null {
    const rows = this.readRows();
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new Error(`Malformed control metadata: expected one row, found ${rows.length}`);

    const row = rows[0];
    if (row.id !== 1) throw new Error('Malformed control metadata: singleton id must be 1');
    assertNonemptyString(row.data_epoch, 'data_epoch', MAX_EPOCH_LENGTH);
    assertSafeNonNegativeInteger(row.data_revision, 'data_revision');
    assertSafePositiveInteger(row.schema_version, 'schema_version');
    assertIsoTimestamp(row.updated_at, 'updated_at');
    return Object.freeze({
      dataEpoch: row.data_epoch,
      dataRevision: row.data_revision,
      schemaVersion: row.schema_version,
      updatedAt: row.updated_at
    });
  }

  readMetadata(): ControlMetadata {
    const metadata = this.readOptionalMetadata();
    if (!metadata) throw new Error('Malformed control metadata: expected one row, found 0');
    return metadata;
  }

  readCurrentVersion(): DataVersion {
    const metadata = this.readMetadata();
    return Object.freeze({ dataEpoch: metadata.dataEpoch, dataRevision: metadata.dataRevision });
  }

  assertCurrentVersion(expected: DataVersion): DataVersion {
    assertNonemptyString(expected.dataEpoch, 'expected.dataEpoch', MAX_EPOCH_LENGTH);
    assertSafeNonNegativeInteger(expected.dataRevision, 'expected.dataRevision');
    const currentVersion = this.readCurrentVersion();
    if (expected.dataEpoch !== currentVersion.dataEpoch) {
      throw new AgentError('DATA_EPOCH_MISMATCH', { currentVersion, safeToReplan: true });
    }
    if (expected.dataRevision !== currentVersion.dataRevision) {
      throw new AgentError('DATA_REVISION_CONFLICT', { currentVersion, safeToReplan: true });
    }
    return currentVersion;
  }

  assertCurrentEpoch(expected: Pick<DataVersion, 'dataEpoch'>): DataVersion {
    assertNonemptyString(expected.dataEpoch, 'expected.dataEpoch', MAX_EPOCH_LENGTH);
    const currentVersion = this.readCurrentVersion();
    if (expected.dataEpoch !== currentVersion.dataEpoch) {
      throw new AgentError('DATA_EPOCH_MISMATCH', { currentVersion, safeToReplan: true });
    }
    return currentVersion;
  }

  initializeMissing(
    capability: RevisionMutationCapability,
    metadata: { dataEpoch: string; schemaVersion: number; updatedAt: string }
  ): { changed: boolean; metadata: ControlMetadata } {
    consumeCapability(this.database, capability);
    const existing = this.readOptionalMetadata();
    if (existing) return { changed: false, metadata: existing };
    assertNonemptyString(metadata.dataEpoch, 'data_epoch', MAX_EPOCH_LENGTH);
    assertSafePositiveInteger(metadata.schemaVersion, 'schema_version');
    assertIsoTimestamp(metadata.updatedAt, 'updated_at');
    this.database.run(
      'INSERT INTO control_metadata (id, data_epoch, data_revision, schema_version, updated_at) VALUES (1, ?, 0, ?, ?)',
      [metadata.dataEpoch, metadata.schemaVersion, metadata.updatedAt]
    );
    if (this.database.getRowsModified() !== 1) {
      throw new Error('Control metadata initialization did not create exactly one row');
    }
    return { changed: true, metadata: this.readMetadata() };
  }

  increment(capability: RevisionMutationCapability, expected: DataVersion): DataVersion {
    consumeCapability(this.database, capability);
    const currentVersion = this.assertCurrentVersion(expected);
    if (currentVersion.dataRevision === Number.MAX_SAFE_INTEGER) {
      throw new Error('Data revision overflow requires an epoch reset');
    }
    const updatedAt = this.now();
    assertIsoTimestamp(updatedAt, 'updated_at');
    this.database.run(
      'UPDATE control_metadata SET data_revision = data_revision + 1, updated_at = ? WHERE id = 1',
      [updatedAt]
    );
    if (this.database.getRowsModified() !== 1) {
      throw new Error('Data revision increment did not update exactly one row');
    }
    const nextVersion = this.readCurrentVersion();
    if (
      nextVersion.dataEpoch !== currentVersion.dataEpoch ||
      nextVersion.dataRevision !== currentVersion.dataRevision + 1
    ) {
      throw new Error('Data revision increment produced an unexpected version');
    }
    return nextVersion;
  }

  resetDatabaseIdentity(capability: RevisionMutationCapability, dataEpoch: string): DataVersion {
    consumeCapability(this.database, capability);
    assertNonemptyString(dataEpoch, 'data_epoch', MAX_EPOCH_LENGTH);
    const currentVersion = this.readCurrentVersion();
    if (dataEpoch === currentVersion.dataEpoch) {
      throw new Error('Database identity reset requires a new data epoch');
    }
    const updatedAt = this.now();
    assertIsoTimestamp(updatedAt, 'updated_at');
    this.database.run(
      'UPDATE control_metadata SET data_epoch = ?, data_revision = 0, updated_at = ? WHERE id = 1',
      [dataEpoch, updatedAt]
    );
    if (this.database.getRowsModified() !== 1) {
      throw new Error('Cannot reset database identity without valid control metadata');
    }
    return this.readCurrentVersion();
  }
}

import { randomUUID } from 'node:crypto';
import type { Database } from 'sql.js';
import {
  controlMetadataSchemaSql,
  controlMetadataSchemaVersion
} from '../database/schema';
import {
  createRevisionMutationCapability,
  RevisionStore,
  type ControlMetadata
} from './revisionStore';

export interface DatabaseBootstrapDependencies {
  createEpoch?: () => string;
  now?: () => string;
}

export interface DatabaseBootstrapResult {
  readonly changed: boolean;
  readonly metadata: ControlMetadata;
}

export function bootstrapControlMetadata(
  database: Database,
  dependencies: DatabaseBootstrapDependencies = {}
): DatabaseBootstrapResult {
  const createEpoch = dependencies.createEpoch ?? randomUUID;
  const now = dependencies.now ?? (() => new Date().toISOString());
  database.exec(controlMetadataSchemaSql);
  const store = new RevisionStore(database, now);
  const existing = store.readOptionalMetadata();
  if (existing) {
    if (existing.schemaVersion !== controlMetadataSchemaVersion) {
      throw new Error(
        `Unsupported control metadata schema version: expected ${controlMetadataSchemaVersion}, found ${existing.schemaVersion}`
      );
    }
    return { changed: false, metadata: existing };
  }
  return store.initializeMissing(createRevisionMutationCapability(database), {
    dataEpoch: createEpoch(),
    schemaVersion: controlMetadataSchemaVersion,
    updatedAt: now()
  });
}

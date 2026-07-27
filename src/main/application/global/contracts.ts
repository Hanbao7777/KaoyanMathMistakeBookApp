import { AgentError } from '../../../shared/agent/errors';

export type GlobalCommand =
  | { readonly type: 'backups.create'; readonly payload: { readonly kind: 'manual' } }
  | { readonly type: 'exports.create'; readonly payload: { readonly specification: ExportSpecification } }
  | { readonly type: 'backups.materialize'; readonly payload: { readonly assetId: string } }
  | { readonly type: 'exports.materialize'; readonly payload: { readonly assetId: string } }
  | { readonly type: 'backups.delete'; readonly payload: { readonly backupId: string } }
  | { readonly type: 'database.restore'; readonly payload: { readonly backupId: string } }
  | { readonly type: 'database.replace_from_import'; readonly payload: { readonly importAssetId: string } }
  | { readonly type: 'database.clear_all'; readonly payload: { readonly deleteManagedImages: boolean } }
  | { readonly type: 'imports.delete_batch'; readonly payload: { readonly batchId: string; readonly deleteManagedAssets: boolean } }
  | { readonly type: 'data_root.migrate'; readonly payload: { readonly rootSelectionId: string } };

export type GlobalQuery =
  | { readonly type: 'backups.list'; readonly payload: { readonly pageSize: number; readonly cursor?: string } }
  | { readonly type: 'exports.get'; readonly payload: { readonly exportId: string } };

export interface ExportSpecification {
  readonly scope: 'all' | 'questions';
  readonly questionIds?: readonly number[];
  readonly mode: 'full' | 'practice';
}

export const globalCommandTypes = Object.freeze([
  'backups.create', 'exports.create', 'backups.delete', 'database.restore',
  'database.replace_from_import', 'database.clear_all', 'imports.delete_batch', 'data_root.migrate',
  'backups.materialize', 'exports.materialize'
] as const);
export const globalInternalJobCommandTypes = Object.freeze(['backups.materialize', 'exports.materialize'] as const);
export const globalQueryTypes = Object.freeze(['backups.list', 'exports.get'] as const);

function fail(field: string): never { throw new AgentError('VALIDATION_ERROR', { field }); }
function record(value: unknown, field: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field); return value as Record<string, unknown>; }
function exact(value: unknown, keys: readonly string[], field: string): Record<string, unknown> { const result = record(value, field); for (const key of Object.keys(result)) if (!keys.includes(key)) fail(`${field}.${key}`); return result; }
function required(value: Record<string, unknown>, keys: readonly string[], field: string): void { for (const key of keys) if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${field}.${key}`); }
function opaqueId(value: unknown, field: string): void { if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,199}$/.test(value)) fail(field); }
function cursor(value: unknown, field: string): void { if (typeof value !== 'string' || value.length < 1 || value.length > 4_096) fail(field); }

function exportSpecification(value: unknown, field: string): void {
  const specification = exact(value, ['scope', 'questionIds', 'mode'], field);
  required(specification, ['scope', 'mode'], field);
  if (specification.scope !== 'all' && specification.scope !== 'questions') fail(`${field}.scope`);
  if (specification.mode !== 'full' && specification.mode !== 'practice') fail(`${field}.mode`);
  if (specification.scope === 'questions') {
    if (!Array.isArray(specification.questionIds) || specification.questionIds.length < 1 || specification.questionIds.length > 50) fail(`${field}.questionIds`);
    const ids = specification.questionIds as readonly unknown[];
    if (ids.some((id) => !Number.isSafeInteger(id) || (id as number) < 1) || new Set(ids).size !== ids.length) fail(`${field}.questionIds`);
  } else if (specification.questionIds !== undefined) fail(`${field}.questionIds`);
}

export function validateGlobalCommand(value: unknown): asserts value is GlobalCommand {
  const command = exact(value, ['type', 'payload'], 'command'); required(command, ['type', 'payload'], 'command');
  const payload = record(command.payload, 'command.payload');
  switch (command.type) {
    case 'backups.create': exact(payload, ['kind'], 'command.payload'); required(payload, ['kind'], 'command.payload'); if (payload.kind !== 'manual') fail('command.payload.kind'); return;
    case 'exports.create': exact(payload, ['specification'], 'command.payload'); required(payload, ['specification'], 'command.payload'); exportSpecification(payload.specification, 'command.payload.specification'); return;
    case 'backups.materialize':
    case 'exports.materialize': exact(payload, ['assetId'], 'command.payload'); required(payload, ['assetId'], 'command.payload'); opaqueId(payload.assetId, 'command.payload.assetId'); return;
    case 'backups.delete':
    case 'database.restore': exact(payload, ['backupId'], 'command.payload'); required(payload, ['backupId'], 'command.payload'); opaqueId(payload.backupId, 'command.payload.backupId'); return;
    case 'database.replace_from_import': exact(payload, ['importAssetId'], 'command.payload'); required(payload, ['importAssetId'], 'command.payload'); opaqueId(payload.importAssetId, 'command.payload.importAssetId'); return;
    case 'database.clear_all': exact(payload, ['deleteManagedImages'], 'command.payload'); required(payload, ['deleteManagedImages'], 'command.payload'); if (typeof payload.deleteManagedImages !== 'boolean') fail('command.payload.deleteManagedImages'); return;
    case 'imports.delete_batch': exact(payload, ['batchId', 'deleteManagedAssets'], 'command.payload'); required(payload, ['batchId', 'deleteManagedAssets'], 'command.payload'); opaqueId(payload.batchId, 'command.payload.batchId'); if (typeof payload.deleteManagedAssets !== 'boolean') fail('command.payload.deleteManagedAssets'); return;
    case 'data_root.migrate': exact(payload, ['rootSelectionId'], 'command.payload'); required(payload, ['rootSelectionId'], 'command.payload'); opaqueId(payload.rootSelectionId, 'command.payload.rootSelectionId'); return;
    default: fail('command.type');
  }
}

export function validateGlobalQuery(value: unknown): asserts value is GlobalQuery {
  const query = exact(value, ['type', 'payload'], 'query'); required(query, ['type', 'payload'], 'query');
  const payload = record(query.payload, 'query.payload');
  if (query.type === 'backups.list') { exact(payload, ['pageSize', 'cursor'], 'query.payload'); required(payload, ['pageSize'], 'query.payload'); if (!Number.isSafeInteger(payload.pageSize) || (payload.pageSize as number) < 1 || (payload.pageSize as number) > 100) fail('query.payload.pageSize'); if (payload.cursor !== undefined) cursor(payload.cursor, 'query.payload.cursor'); return; }
  if (query.type === 'exports.get') { exact(payload, ['exportId'], 'query.payload'); required(payload, ['exportId'], 'query.payload'); opaqueId(payload.exportId, 'query.payload.exportId'); return; }
  fail('query.type');
}

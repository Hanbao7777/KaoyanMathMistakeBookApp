import { randomUUID } from 'node:crypto';
import { AgentError } from '../../../shared/agent/errors';
import { agentApiVersion } from '../../../shared/agent/versions';
import type { ManagedBackup, ManagedExport, ManagedGlobalJob } from '../../../shared/api';
import type { AgentGateway, AgentPrincipal, JsonObject } from '../../../shared/agent/v1/gatewayContracts';
import { operationCatalogIdentity } from '../../../shared/agent/v1/operationCatalog';
import type { ExportSpecification, GlobalCommand, GlobalQuery } from '../../application/global';

const RENDERER_BACKUP_PAGE_SIZE = 100;

function rejected(error: { code: ConstructorParameters<typeof AgentError>[0]; details?: ConstructorParameters<typeof AgentError>[1] }): AgentError {
  return new AgentError(error.code, error.details);
}

export function createGlobalRendererAdapter(dependencies: {
  readonly gateway: AgentGateway;
  readonly principal: () => AgentPrincipal;
  readonly currentVersion: () => { readonly dataEpoch: string; readonly dataRevision: number };
}) {
  const execute = async <T>(command: GlobalCommand): Promise<T> => {
    const outcome = await dependencies.gateway.execute({ apiVersion: agentApiVersion, kind: 'agent-command', operation: command.type,
      payload: command.payload as unknown as JsonObject, requestId: randomUUID(), expectedVersion: dependencies.currentVersion(), catalog: operationCatalogIdentity }, dependencies.principal());
    if (outcome.kind === 'completed' || outcome.kind === 'replayed') return outcome.result.value as T;
    if (outcome.kind === 'rejected') throw rejected(outcome.error);
    throw new AgentError('APPROVAL_REQUIRED');
  };
  const query = async <T>(operation: GlobalQuery['type'], payload: JsonObject): Promise<T> => {
    const outcome = await dependencies.gateway.query({ apiVersion: agentApiVersion, kind: 'agent-query', operation, payload, requestId: randomUUID(), catalog: operationCatalogIdentity }, dependencies.principal());
    if (outcome.kind === 'rejected') throw rejected(outcome.error);
    return outcome.result.value as T;
  };
  return Object.freeze({
    createBackup: () => execute<ManagedGlobalJob>({ type: 'backups.create', payload: { kind: 'manual' } }),
    listBackups: async (): Promise<readonly ManagedBackup[]> => (await query<{ readonly items: readonly ManagedBackup[] }>('backups.list', { pageSize: RENDERER_BACKUP_PAGE_SIZE })).items,
    createExport: (specification: ExportSpecification) => execute<ManagedGlobalJob>({ type: 'exports.create', payload: { specification } }),
    getExport: (assetId: string) => query<ManagedExport>('exports.get', { exportId: assetId })
  });
}

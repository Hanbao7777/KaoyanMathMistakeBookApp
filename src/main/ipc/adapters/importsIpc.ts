import { randomUUID } from 'node:crypto';
import { AgentError } from '../../../shared/agent/errors';
import { agentApiVersion } from '../../../shared/agent/versions';
import type { ImportsCommand, ImportsQuery } from '../../../shared/imports/v1';
import type { AgentGateway, AgentPrincipal, JsonObject } from '../../../shared/agent/v1/gatewayContracts';
import { operationCatalogIdentity } from '../../../shared/agent/v1/operationCatalog';
import { createRendererExecutionContext } from '../../application/executionContext';
import type { ImportsApplication } from '../../application/imports';

export function createImportsRendererAdapter(dependencies: { gateway: AgentGateway; principal: () => AgentPrincipal; application: ImportsApplication; currentVersion: () => { dataEpoch: string; dataRevision: number } }) {
  const query = async <T>(operation: ImportsQuery['type'], payload: JsonObject): Promise<T> => { const outcome = await dependencies.gateway.query({ apiVersion: agentApiVersion, kind: 'agent-query', operation, payload, requestId: randomUUID(), catalog: operationCatalogIdentity }, dependencies.principal()); if (outcome.kind === 'rejected') throw new AgentError(outcome.error.code, outcome.error.details); return outcome.result.value as T; };
  const execute = async <T>(command: ImportsCommand): Promise<T> => { const outcome = await dependencies.gateway.execute({ apiVersion: agentApiVersion, kind: 'agent-command', operation: command.type, payload: command.payload as unknown as JsonObject, requestId: randomUUID(), expectedVersion: dependencies.currentVersion(), catalog: operationCatalogIdentity }, dependencies.principal()); if (outcome.kind === 'completed' || outcome.kind === 'replayed') return outcome.result.value as T; if (outcome.kind === 'rejected') throw new AgentError(outcome.error.code, outcome.error.details); throw new AgentError('APPROVAL_REQUIRED'); };
  return Object.freeze({
    createDraft: (payload: Extract<ImportsCommand, { type: 'imports.create_draft' }>['payload']) => execute({ type: 'imports.create_draft', payload }),
    addDraftImage: (payload: Extract<ImportsCommand, { type: 'imports.add_draft_image' }>['payload']) => execute({ type: 'imports.add_draft_image', payload }),
    validateDraft: (draftId: string) => execute({ type: 'imports.validate_draft', payload: { draftId } }),
    previewDraft: (draftId: string) => query('imports.preview_draft', { draftId }),
    applyDraft: (draftId: string, previewHash: string) => execute({ type: 'imports.apply_draft', payload: { draftId, previewHash } }),
    get: (draftId: string) => query('imports.get', { draftId }),
    cancel: (draftId: string) => execute({ type: 'imports.cancel', payload: { draftId } }),
    stageSelectedImages: (filePaths: readonly string[], proof?: { readonly kind: 'main_process_selection' }) => dependencies.application.stageSelectedImages(filePaths, createRendererExecutionContext({ expectedVersion: dependencies.currentVersion() }), proof)
  });
}

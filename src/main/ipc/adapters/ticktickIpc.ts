import { randomUUID } from 'node:crypto';
import { AgentError } from '../../../shared/agent/errors';
import { agentApiVersion } from '../../../shared/agent/versions';
import type { DataVersion } from '../../../shared/agent/v1/contracts';
import type { JsonObject } from '../../../shared/agent/v1/gatewayContracts';
import { operationCatalogIdentity } from '../../../shared/agent/v1/operationCatalog';
import type {
  TickTickFocusSessionInput,
  TickTickTaskFilters,
  TickTickTaskInput
} from '../../../shared/types';
import type { TickTickCommand, TickTickQuery, TickTickTaskPatch } from '../../application/ticktick';
import { getAgentControlPlane, getDatabaseCoordinator } from '../../services/databaseService';

const RENDERER_REQUEST_BINDING_LIMIT = 1_000;
const rendererRequestBindings = new Map<string, DataVersion>();

function gatewayError(error: { code: ConstructorParameters<typeof AgentError>[0]; details?: ConstructorParameters<typeof AgentError>[1] }): AgentError {
  return new AgentError(error.code, error.details);
}

async function executeWrite<T>(command: TickTickCommand, requestId: string = randomUUID()): Promise<T> {
  const [controlPlane, coordinator] = await Promise.all([getAgentControlPlane(), getDatabaseCoordinator()]);
  let binding = rendererRequestBindings.get(requestId);
  if (!binding) {
    binding = coordinator.currentVersion();
    rendererRequestBindings.set(requestId, binding);
    if (rendererRequestBindings.size > RENDERER_REQUEST_BINDING_LIMIT) {
      rendererRequestBindings.delete(rendererRequestBindings.keys().next().value!);
    }
  }
  const outcome = await controlPlane.gateway.execute({
    apiVersion: agentApiVersion,
    kind: 'agent-command',
    operation: command.type,
    payload: command.payload as unknown as JsonObject,
    requestId,
    expectedVersion: binding,
    catalog: operationCatalogIdentity
  }, controlPlane.renderer.principal());
  if (outcome.kind === 'completed' || outcome.kind === 'replayed') return outcome.result.value as T;
  if (outcome.kind === 'rejected') throw gatewayError(outcome.error);
  throw new AgentError('APPROVAL_REQUIRED');
}

async function executeQuery<T>(query: TickTickQuery): Promise<T> {
  const controlPlane = await getAgentControlPlane();
  const outcome = await controlPlane.gateway.query({
    apiVersion: agentApiVersion,
    kind: 'agent-query',
    operation: query.type,
    payload: query.payload as unknown as JsonObject,
    requestId: randomUUID(),
    catalog: operationCatalogIdentity
  }, controlPlane.renderer.principal());
  if (outcome.kind === 'rejected') throw gatewayError(outcome.error);
  return outcome.result.value as T;
}

export function listTickTickTasksFromRenderer(filters: TickTickTaskFilters = {}) {
  return executeQuery({ type: 'tasks.list', payload: { filters } });
}

export function getTickTickTaskFromRenderer(taskId: string) {
  return executeQuery({ type: 'tasks.get', payload: { taskId } });
}

export function createTickTickTaskFromRenderer(input: TickTickTaskInput, requestId?: string) {
  return executeWrite({ type: 'tasks.create', payload: { input } }, requestId);
}

export function updateTickTickTaskFromRenderer(taskId: string, input: TickTickTaskPatch, requestId?: string) {
  return executeWrite({ type: 'tasks.update', payload: { taskId, input } }, requestId);
}

export function completeTickTickTaskFromRenderer(taskId: string, requestId?: string) {
  return executeWrite({ type: 'tasks.complete', payload: { taskId } }, requestId);
}

export function uncompleteTickTickTaskFromRenderer(taskId: string, requestId?: string) {
  return executeWrite({ type: 'tasks.uncomplete', payload: { taskId } }, requestId);
}

export function deleteTickTickTaskFromRenderer(taskId: string, requestId?: string) {
  return executeWrite<boolean>({ type: 'tasks.delete', payload: { taskId } }, requestId);
}

export function listTickTickFocusSessionsFromRenderer(filters: { date?: string; taskId?: string } = {}) {
  return executeQuery({ type: 'focus.sessions.list', payload: { filters } });
}

export function createTickTickFocusSessionFromRenderer(input: TickTickFocusSessionInput, requestId?: string) {
  return executeWrite({ type: 'focus.sessions.create', payload: { input } }, requestId);
}

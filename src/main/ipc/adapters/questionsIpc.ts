import { randomUUID } from 'node:crypto';
import { AgentError } from '../../../shared/agent/errors';
import { agentApiVersion } from '../../../shared/agent/versions';
import type { DataVersion, QuestionCommand, QuestionQuery } from '../../../shared/agent/v1/contracts';
import type { JsonObject } from '../../../shared/agent/v1/gatewayContracts';
import { operationCatalogIdentity } from '../../../shared/agent/v1/operationCatalog';
import { getAgentControlPlane, getDatabaseCoordinator } from '../../services/databaseService';
import type {
  MasteryLevel,
  QuestionFilters,
  QuestionInput,
  ReviewInput,
  ReviewSubmitResult,
  ReviewSubmitInput,
  ReviewResult
} from '../../../shared/types';

const RENDERER_QUERY_LIMIT = 500;
const RENDERER_REQUEST_BINDING_LIMIT = 1_000;
const rendererRequestBindings = new Map<string, DataVersion>();

function reviewResult(result: ReviewResult): 'correct' | 'wrong' | 'no_idea' {
  if (result === '做对了') return 'correct';
  if (result === '做错了') return 'wrong';
  return 'no_idea';
}

function gatewayError(error: { code: ConstructorParameters<typeof AgentError>[0]; details?: ConstructorParameters<typeof AgentError>[1] }): AgentError {
  return new AgentError(error.code, error.details);
}

async function executeWrite<T>(command: QuestionCommand, requestId: string = randomUUID()): Promise<T> {
  const [controlPlane, coordinator] = await Promise.all([getAgentControlPlane(), getDatabaseCoordinator()]);
  const payload = command.payload as unknown as JsonObject;
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
    payload,
    requestId,
    expectedVersion: binding,
    catalog: operationCatalogIdentity
  }, controlPlane.renderer.principal());
  if (outcome.kind === 'completed' || outcome.kind === 'replayed') return outcome.result.value as T;
  if (outcome.kind === 'rejected') throw gatewayError(outcome.error);
  throw new AgentError('APPROVAL_REQUIRED');
}

async function executeQuery<T>(query: QuestionQuery): Promise<T> {
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

export async function createQuestionFromRenderer(input: QuestionInput, requestId?: string) {
  return executeWrite({ type: 'questions.create', payload: { input } }, requestId);
}

export async function updateQuestionFromRenderer(questionId: number, input: QuestionInput, requestId?: string) {
  return executeWrite({ type: 'questions.update', payload: { questionId, input } }, requestId);
}

export async function deleteQuestionFromRenderer(questionId: number, deleteImages: boolean, requestId?: string) {
  return executeWrite<boolean>({ type: 'questions.delete', payload: { questionId, deleteImages } }, requestId);
}

export async function markMasteryFromRenderer(questionId: number, mastery: MasteryLevel, requestId?: string) {
  return executeWrite({ type: 'questions.mark_mastery', payload: { questionId, mastery } }, requestId);
}

export async function removeImageFromRenderer(imageId: number, deleteFile: boolean, requestId?: string) {
  return executeWrite<boolean>({ type: 'questions.remove_image', payload: { imageId, deleteFile } }, requestId);
}

export async function addReviewFromRenderer(input: ReviewInput, requestId?: string) {
  const result = await executeWrite<ReviewSubmitResult>({
    type: 'questions.submit_review',
    payload: { questionId: input.questionId, result: reviewResult(input.result), note: input.note }
  }, requestId);
  return (result as { question: unknown }).question;
}

export async function submitReviewResultFromRenderer(input: ReviewSubmitInput, requestId?: string) {
  return executeWrite({ type: 'questions.submit_review', payload: input }, requestId);
}

export async function undoReviewResultFromRenderer(questionId: number, reviewLogId: number, requestId?: string) {
  return executeWrite({ type: 'questions.undo_review', payload: { questionId, reviewLogId } }, requestId);
}

export async function listQuestionsFromRenderer(filters: QuestionFilters = {}) {
  return executeQuery({ type: 'questions.list', payload: { filters, limit: RENDERER_QUERY_LIMIT } });
}

export async function getQuestionFromRenderer(questionId: number) {
  return executeQuery({ type: 'questions.get', payload: { questionId } });
}

export async function listReviewLogsFromRenderer(questionId: number) {
  return executeQuery({ type: 'questions.review_logs', payload: { questionId, limit: RENDERER_QUERY_LIMIT } });
}

export async function getReviewBucketsFromRenderer() {
  return executeQuery({ type: 'questions.review_buckets', payload: {} });
}

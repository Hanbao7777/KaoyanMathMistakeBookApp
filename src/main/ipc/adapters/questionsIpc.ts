import { createRendererExecutionContext } from '../../application/executionContext';
import type { QuestionsApplication } from '../../application/questions';
import type { DataVersion, QuestionCommand, QuestionQuery } from '../../../shared/agent/v1/contracts';
import { getDatabaseCoordinator, getQuestionsApplication } from '../../services/databaseService';
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

function reviewResult(result: ReviewResult): 'correct' | 'wrong' | 'no_idea' {
  if (result === '做对了') return 'correct';
  if (result === '做错了') return 'wrong';
  return 'no_idea';
}

async function applicationAndVersion(): Promise<{ application: QuestionsApplication; version: DataVersion }> {
  const application = await getQuestionsApplication();
  const coordinator = await getDatabaseCoordinator();
  return { application, version: coordinator.currentVersion() };
}

async function executeWrite<T>(command: QuestionCommand): Promise<T> {
  const { application, version } = await applicationAndVersion();
  const context = createRendererExecutionContext({ expectedVersion: version });
  const result = await application.execute(command, context);
  return result.value as T;
}

function executeQuery<T>(application: QuestionsApplication, query: QuestionQuery): T {
  return application.query(query, createRendererExecutionContext()).value as T;
}

export async function createQuestionFromRenderer(input: QuestionInput) {
  return executeWrite({ type: 'questions.create', payload: { input } });
}

export async function updateQuestionFromRenderer(questionId: number, input: QuestionInput) {
  return executeWrite({ type: 'questions.update', payload: { questionId, input } });
}

export async function deleteQuestionFromRenderer(questionId: number, deleteImages: boolean) {
  return executeWrite<boolean>({ type: 'questions.delete', payload: { questionId, deleteImages } });
}

export async function markMasteryFromRenderer(questionId: number, mastery: MasteryLevel) {
  return executeWrite({ type: 'questions.mark_mastery', payload: { questionId, mastery } });
}

export async function removeImageFromRenderer(imageId: number, deleteFile: boolean) {
  return executeWrite<boolean>({ type: 'questions.remove_image', payload: { imageId, deleteFile } });
}

export async function addReviewFromRenderer(input: ReviewInput) {
  const result = await executeWrite<ReviewSubmitResult>({
    type: 'questions.submit_review',
    payload: { questionId: input.questionId, result: reviewResult(input.result), note: input.note }
  });
  return (result as { question: unknown }).question;
}

export async function submitReviewResultFromRenderer(input: ReviewSubmitInput) {
  return executeWrite({ type: 'questions.submit_review', payload: input });
}

export async function listQuestionsFromRenderer(filters: QuestionFilters = {}) {
  const application = await getQuestionsApplication();
  return executeQuery(application, { type: 'questions.list', payload: { filters, limit: RENDERER_QUERY_LIMIT } });
}

export async function getQuestionFromRenderer(questionId: number) {
  const application = await getQuestionsApplication();
  return executeQuery(application, { type: 'questions.get', payload: { questionId } });
}

export async function listReviewLogsFromRenderer(questionId: number) {
  const application = await getQuestionsApplication();
  return executeQuery(application, { type: 'questions.review_logs', payload: { questionId, limit: RENDERER_QUERY_LIMIT } });
}

export async function getReviewBucketsFromRenderer() {
  const application = await getQuestionsApplication();
  return executeQuery(application, { type: 'questions.review_buckets', payload: {} });
}

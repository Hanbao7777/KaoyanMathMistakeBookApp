import { AgentError } from '../errors';
import { agentApiVersion } from '../versions';
import type {
  AppCommand,
  AppQuery,
  CommandEnvelope,
  DataVersion,
  DomainEvent,
  ExecutionContext,
  QueryEnvelope
} from './contracts';
import { validateImportsCommand, validateImportsQuery } from '../../imports/v1';

type JsonObject = Record<string, unknown>;
type Assertion = (value: unknown, path: string) => void;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BATCH_SIZE = 500;
const MAX_QUERY_LIMIT = 500;

function fail(path: string): never {
  throw new AgentError('VALIDATION_ERROR', { field: path });
}

function object(value: unknown, path: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path);
  return value as JsonObject;
}

function exact(value: unknown, keys: readonly string[], path: string): JsonObject {
  const result = object(value, path);
  for (const key of Object.keys(result)) if (!keys.includes(key)) fail(`${path}.${key}`);
  return result;
}

function required(value: JsonObject, keys: readonly string[], path: string): void {
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${path}.${key}`);
}

function string(value: unknown, path: string, max = 10_000): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) fail(path);
}

function optionalString(value: unknown, path: string, max = 10_000): void {
  if (value !== undefined) string(value, path, max);
}

function boolean(value: unknown, path: string): void {
  if (typeof value !== 'boolean') fail(path);
}

function id(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail(path);
}

function safeNonNegative(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(path);
}

function boundedPositive(value: unknown, path: string, max: number): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) fail(path);
}

function oneOf(value: unknown, values: readonly string[], path: string): void {
  if (typeof value !== 'string' || !values.includes(value)) fail(path);
}

function isoTimestamp(value: unknown, path: string): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) fail(path);
}

function uuid(value: unknown, path: string): void {
  if (typeof value !== 'string' || !UUID.test(value)) fail(path);
}

function array(value: unknown, path: string, item: Assertion, max = MAX_BATCH_SIZE): void {
  if (!Array.isArray(value) || value.length > max) fail(path);
  value.forEach((entry, index) => item(entry, `${path}[${index}]`));
}

function stringArray(value: unknown, path: string, max = 100): void {
  array(value, path, (entry, entryPath) => string(entry, entryPath, 500), max);
  if (new Set(value as string[]).size !== (value as string[]).length) fail(path);
}

function questionInput(value: unknown, path: string): void {
  const keys = [
    'title', 'content', 'wrong_thinking', 'wrong_solution', 'correct_solution', 'answer', 'subject', 'category',
    'question_type', 'error_reason', 'source', 'difficulty', 'mastery_level', 'note', 'tags',
    'questionImageSources', 'solutionImageSources', 'import_batch_id'
  ];
  const result = exact(value, keys, path);
  required(result, keys.slice(0, 6).concat(keys.slice(7, 17)), path);
  for (const key of ['title', 'content', 'wrong_thinking', 'wrong_solution', 'correct_solution', 'answer', 'category', 'question_type', 'error_reason', 'source', 'note']) {
    if (typeof result[key] !== 'string' || (result[key] as string).length > 50_000) fail(`${path}.${key}`);
  }
  optionalString(result.subject, `${path}.subject`, 100);
  oneOf(result.difficulty, ['简单', '中等', '困难', '压轴'], `${path}.difficulty`);
  oneOf(result.mastery_level, ['未掌握', '较弱', '一般', '较好', '已掌握'], `${path}.mastery_level`);
  stringArray(result.tags, `${path}.tags`);
  stringArray(result.questionImageSources, `${path}.questionImageSources`);
  stringArray(result.solutionImageSources, `${path}.solutionImageSources`);
  optionalString(result.import_batch_id, `${path}.import_batch_id`, 200);
}

function questionFilters(value: unknown, path: string): void {
  const keys = ['search', 'subject', 'category', 'questionType', 'errorReason', 'masteryLevel', 'difficulty', 'source', 'tag', 'sortBy', 'sortOrder', 'weakOnly'];
  const result = exact(value, keys, path);
  for (const key of keys.slice(0, 9)) {
    if (result[key] !== '') optionalString(result[key], `${path}.${key}`, 500);
  }
  if (result.sortBy !== undefined) oneOf(result.sortBy, ['created_at', 'last_reviewed_at', 'review_count'], `${path}.sortBy`);
  if (result.sortOrder !== undefined) oneOf(result.sortOrder, ['asc', 'desc'], `${path}.sortOrder`);
  if (result.weakOnly !== undefined) boolean(result.weakOnly, `${path}.weakOnly`);
}

export function validateDataVersion(value: unknown, path = 'dataVersion'): asserts value is DataVersion {
  const result = exact(value, ['dataEpoch', 'dataRevision'], path);
  required(result, ['dataEpoch', 'dataRevision'], path);
  string(result.dataEpoch, `${path}.dataEpoch`, 200);
  safeNonNegative(result.dataRevision, `${path}.dataRevision`);
}

export function validateExecutionContext(value: unknown, path = 'context'): asserts value is ExecutionContext {
  const result = exact(value, ['trust', 'requestId', 'traceId', 'source', 'actor', 'client', 'timestamp', 'expectedVersion', 'concurrency'], path);
  required(result, ['trust', 'requestId', 'traceId', 'source', 'actor', 'client', 'timestamp'], path);
  uuid(result.requestId, `${path}.requestId`);
  uuid(result.traceId, `${path}.traceId`);
  isoTimestamp(result.timestamp, `${path}.timestamp`);
  oneOf(result.source, ['renderer', 'internal', 'mcp'], `${path}.source`);
  const actor = exact(result.actor, ['actorId', 'actorType'], `${path}.actor`);
  required(actor, ['actorId', 'actorType'], `${path}.actor`);
  string(actor.actorId, `${path}.actor.actorId`, 200);
  oneOf(actor.actorType, ['user', 'agent', 'system'], `${path}.actor.actorType`);
  const client = exact(result.client, ['clientId', 'clientName'], `${path}.client`);
  required(client, ['clientId'], `${path}.client`);
  string(client.clientId, `${path}.client.clientId`, 200);
  optionalString(client.clientName, `${path}.client.clientName`, 200);
  if (result.trust === 'caller') {
    if (result.source !== 'mcp' || result.concurrency !== undefined) fail(path);
    if (result.expectedVersion !== undefined) validateDataVersion(result.expectedVersion, `${path}.expectedVersion`);
  } else if (result.trust === 'trusted') {
    oneOf(result.concurrency, ['strict', 'epoch-only', 'none'], `${path}.concurrency`);
    if (result.concurrency === 'epoch-only' && result.expectedVersion === undefined) fail(`${path}.expectedVersion`);
    if (result.concurrency === 'none' && result.expectedVersion !== undefined) fail(`${path}.expectedVersion`);
    if (result.expectedVersion !== undefined) validateDataVersion(result.expectedVersion, `${path}.expectedVersion`);
  } else fail(`${path}.trust`);
}

function validateCommandConcurrency(context: ExecutionContext): void {
  if (context.trust === 'caller' && context.expectedVersion === undefined) fail('context.expectedVersion');
  if (context.trust === 'trusted' && context.concurrency === 'strict' && context.expectedVersion === undefined) {
    fail('context.expectedVersion');
  }
}

function payload(value: unknown, keys: string[], requiredKeys: string[], path: string): JsonObject {
  const result = exact(value, keys, path);
  required(result, requiredKeys, path);
  return result;
}

export function validateQuestionCommand(value: unknown, path = 'command'): asserts value is AppCommand {
  const command = exact(value, ['type', 'payload'], path);
  required(command, ['type', 'payload'], path);
  switch (command.type) {
    case 'questions.create': {
      const p = payload(command.payload, ['input', 'externalRef'], ['input'], `${path}.payload`);
      questionInput(p.input, `${path}.payload.input`); optionalString(p.externalRef, `${path}.payload.externalRef`, 200); return;
    }
    case 'questions.update': {
      const p = payload(command.payload, ['questionId', 'input'], ['questionId', 'input'], `${path}.payload`);
      id(p.questionId, `${path}.payload.questionId`); questionInput(p.input, `${path}.payload.input`); return;
    }
    case 'questions.delete': {
      const p = payload(command.payload, ['questionId', 'deleteImages'], ['questionId', 'deleteImages'], `${path}.payload`);
      id(p.questionId, `${path}.payload.questionId`); boolean(p.deleteImages, `${path}.payload.deleteImages`); return;
    }
    case 'questions.remove_image': {
      const p = payload(command.payload, ['imageId', 'deleteFile'], ['imageId', 'deleteFile'], `${path}.payload`);
      id(p.imageId, `${path}.payload.imageId`); boolean(p.deleteFile, `${path}.payload.deleteFile`); return;
    }
    case 'questions.mark_mastery': {
      const p = payload(command.payload, ['questionId', 'mastery'], ['questionId', 'mastery'], `${path}.payload`);
      id(p.questionId, `${path}.payload.questionId`); oneOf(p.mastery, ['未掌握', '较弱', '一般', '较好', '已掌握'], `${path}.payload.mastery`); return;
    }
    case 'questions.submit_review': {
      const p = payload(command.payload, ['questionId', 'result', 'note'], ['questionId', 'result'], `${path}.payload`);
      id(p.questionId, `${path}.payload.questionId`); oneOf(p.result, ['correct', 'wrong', 'no_idea'], `${path}.payload.result`); optionalString(p.note, `${path}.payload.note`, 10_000); return;
    }
    case 'questions.undo_review': {
      const p = payload(command.payload, ['questionId', 'reviewLogId'], ['questionId', 'reviewLogId'], `${path}.payload`);
      id(p.questionId, `${path}.payload.questionId`); id(p.reviewLogId, `${path}.payload.reviewLogId`); return;
    }
    case 'questions.link_knowledge': {
      const p = payload(command.payload, ['questionId', 'knowledgeNodeIds', 'matchType'], ['questionId', 'knowledgeNodeIds', 'matchType'], `${path}.payload`);
      id(p.questionId, `${path}.payload.questionId`); stringArray(p.knowledgeNodeIds, `${path}.payload.knowledgeNodeIds`); oneOf(p.matchType, ['gpt', 'auto', 'manual'], `${path}.payload.matchType`); return;
    }
    case 'questions.migrate_categories': {
      const p = payload(command.payload, ['limit'], ['limit'], `${path}.payload`); boundedPositive(p.limit, `${path}.payload.limit`, MAX_BATCH_SIZE); return;
    }
    case 'questions.rematch_knowledge': {
      const p = payload(command.payload, ['limit', 'questionIds'], ['limit'], `${path}.payload`); boundedPositive(p.limit, `${path}.payload.limit`, MAX_BATCH_SIZE);
      if (p.questionIds !== undefined) array(p.questionIds, `${path}.payload.questionIds`, id); return;
    }
    case 'questions.bulk_upsert': {
      const p = payload(command.payload, ['items'], ['items'], `${path}.payload`);
      array(p.items, `${path}.payload.items`, (item, itemPath) => { const row = payload(item, ['input', 'externalRef'], ['input'], itemPath); questionInput(row.input, `${itemPath}.input`); optionalString(row.externalRef, `${itemPath}.externalRef`, 200); }); return;
    }
    case 'questions.import': {
      const p = payload(command.payload, ['batchId', 'items'], ['batchId', 'items'], `${path}.payload`); string(p.batchId, `${path}.payload.batchId`, 200);
      array(p.items, `${path}.payload.items`, (item, itemPath) => { const row = payload(item, ['input', 'knowledgeNodeIds'], ['input', 'knowledgeNodeIds'], itemPath); questionInput(row.input, `${itemPath}.input`); stringArray(row.knowledgeNodeIds, `${itemPath}.knowledgeNodeIds`); }); return;
    }
    case 'questions.replace_all': {
      const p = payload(command.payload, ['questions'], ['questions'], `${path}.payload`); array(p.questions, `${path}.payload.questions`, questionInput); return;
    }
    case 'questions.clear_all': {
      const p = payload(command.payload, ['deleteImages', 'maxQuestions'], ['deleteImages', 'maxQuestions'], `${path}.payload`); boolean(p.deleteImages, `${path}.payload.deleteImages`); boundedPositive(p.maxQuestions, `${path}.payload.maxQuestions`, MAX_BATCH_SIZE); return;
    }
    default: fail(`${path}.type`);
  }
}

export function validateQuestionQuery(value: unknown, path = 'query'): asserts value is AppQuery {
  const query = exact(value, ['type', 'payload'], path);
  required(query, ['type', 'payload'], path);
  switch (query.type) {
    case 'questions.list': { const p = payload(query.payload, ['filters', 'limit'], ['filters', 'limit'], `${path}.payload`); questionFilters(p.filters, `${path}.payload.filters`); boundedPositive(p.limit, `${path}.payload.limit`, MAX_QUERY_LIMIT); return; }
    case 'questions.get': { const p = payload(query.payload, ['questionId'], ['questionId'], `${path}.payload`); id(p.questionId, `${path}.payload.questionId`); return; }
    case 'questions.review_logs': { const p = payload(query.payload, ['questionId', 'limit'], ['questionId', 'limit'], `${path}.payload`); id(p.questionId, `${path}.payload.questionId`); boundedPositive(p.limit, `${path}.payload.limit`, MAX_QUERY_LIMIT); return; }
    case 'questions.review_buckets': exact(query.payload, [], `${path}.payload`); return;
    default: fail(`${path}.type`);
  }
}

function knowledgeNodeId(value: unknown, path: string): void { string(value, path, 200); }

export function validateKnowledgeCommand(value: unknown): void {
  const command = exact(value, ['type', 'payload'], 'command'); required(command, ['type', 'payload'], 'command');
  switch (command.type) {
    case 'knowledge.link_question': { const p = payload(command.payload, ['questionId', 'nodeId', 'matchType'], ['questionId', 'nodeId', 'matchType'], 'command.payload'); id(p.questionId, 'command.payload.questionId'); knowledgeNodeId(p.nodeId, 'command.payload.nodeId'); oneOf(p.matchType, ['gpt', 'auto', 'manual'], 'command.payload.matchType'); return; }
    case 'knowledge.unlink_question': { const p = payload(command.payload, ['questionId', 'nodeId'], ['questionId', 'nodeId'], 'command.payload'); id(p.questionId, 'command.payload.questionId'); knowledgeNodeId(p.nodeId, 'command.payload.nodeId'); return; }
    case 'knowledge.bind_textbook': { const p = payload(command.payload, ['nodeId', 'textbookId'], ['nodeId', 'textbookId'], 'command.payload'); knowledgeNodeId(p.nodeId, 'command.payload.nodeId'); id(p.textbookId, 'command.payload.textbookId'); return; }
    default: fail('command.type');
  }
}

export function validateKnowledgeQuery(value: unknown): void {
  const query = exact(value, ['type', 'payload'], 'query'); required(query, ['type', 'payload'], 'query');
  switch (query.type) {
    case 'knowledge.list_nodes': { const p = payload(query.payload, ['parentNodeId', 'subject', 'limit'], ['limit'], 'query.payload'); optionalString(p.parentNodeId, 'query.payload.parentNodeId', 200); optionalString(p.subject, 'query.payload.subject', 100); boundedPositive(p.limit, 'query.payload.limit', MAX_QUERY_LIMIT); return; }
    case 'knowledge.get_node': { const p = payload(query.payload, ['nodeId'], ['nodeId'], 'query.payload'); knowledgeNodeId(p.nodeId, 'query.payload.nodeId'); return; }
    case 'knowledge.list_links': { const p = payload(query.payload, ['nodeId', 'questionId', 'limit'], ['limit'], 'query.payload'); if (p.nodeId !== undefined) knowledgeNodeId(p.nodeId, 'query.payload.nodeId'); if (p.questionId !== undefined) id(p.questionId, 'query.payload.questionId'); if (p.nodeId === undefined && p.questionId === undefined) fail('query.payload'); boundedPositive(p.limit, 'query.payload.limit', MAX_QUERY_LIMIT); return; }
    case 'textbooks.list': { const p = payload(query.payload, ['subject', 'limit'], ['limit'], 'query.payload'); optionalString(p.subject, 'query.payload.subject', 100); boundedPositive(p.limit, 'query.payload.limit', MAX_QUERY_LIMIT); return; }
    case 'textbooks.get': { const p = payload(query.payload, ['textbookId'], ['textbookId'], 'query.payload'); id(p.textbookId, 'query.payload.textbookId'); return; }
    case 'analytics.get_weak_areas': { const p = payload(query.payload, ['subject', 'limit'], ['limit'], 'query.payload'); optionalString(p.subject, 'query.payload.subject', 100); boundedPositive(p.limit, 'query.payload.limit', MAX_QUERY_LIMIT); return; }
    default: fail('query.type');
  }
}

export function isCanonicalStudyDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function studyDate(value: unknown, path: string): void { if (!isCanonicalStudyDate(value)) fail(path); }
export function validateStudyCommand(value: unknown): void {
  const command = exact(value, ['type', 'payload'], 'command'); required(command, ['type', 'payload'], 'command');
  switch (command.type) {
    case 'study.create_plan_draft': { const p = payload(command.payload, ['date', 'tasks'], ['date', 'tasks'], 'command.payload'); studyDate(p.date, 'command.payload.date'); array(p.tasks, 'command.payload.tasks', (item, path) => { const row = payload(item, ['subjectId', 'title', 'estimatedMinutes', 'priority', 'note'], ['subjectId', 'title', 'estimatedMinutes'], path); string(row.subjectId, `${path}.subjectId`, 100); string(row.title, `${path}.title`, 500); boundedPositive(row.estimatedMinutes, `${path}.estimatedMinutes`, 720); if (row.priority !== undefined) oneOf(row.priority, ['高', '中', '低'], `${path}.priority`); optionalString(row.note, `${path}.note`, 2_000); }, 20); return; }
    case 'study.apply_plan_adjustment': { const p = payload(command.payload, ['taskId', 'estimatedMinutes', 'priority', 'note', 'status', 'skippedReason'], ['taskId'], 'command.payload'); string(p.taskId, 'command.payload.taskId', 200); if (p.estimatedMinutes !== undefined) boundedPositive(p.estimatedMinutes, 'command.payload.estimatedMinutes', 720); if (p.priority !== undefined) oneOf(p.priority, ['高', '中', '低'], 'command.payload.priority'); optionalString(p.note, 'command.payload.note', 2_000); if (p.status !== undefined) oneOf(p.status, ['未开始', '进行中', '部分完成', '已完成', '已跳过'], 'command.payload.status'); optionalString(p.skippedReason, 'command.payload.skippedReason', 500); return; }
    case 'study.record_manual_progress': { const p = payload(command.payload, ['date', 'subjectId', 'minutes', 'note', 'taskId', 'materialId', 'materialCurrentAmount'], ['date', 'subjectId', 'minutes'], 'command.payload'); studyDate(p.date, 'command.payload.date'); string(p.subjectId, 'command.payload.subjectId', 100); boundedPositive(p.minutes, 'command.payload.minutes', 1_440); optionalString(p.note, 'command.payload.note', 2_000); optionalString(p.taskId, 'command.payload.taskId', 200); optionalString(p.materialId, 'command.payload.materialId', 200); if (p.materialCurrentAmount !== undefined && (typeof p.materialCurrentAmount !== 'number' || !Number.isFinite(p.materialCurrentAmount) || p.materialCurrentAmount < 0 || p.materialCurrentAmount > 10_000_000 || p.materialId === undefined)) fail('command.payload.materialCurrentAmount'); return; }
    default: fail('command.type');
  }
}
export function validateStudyQuery(value: unknown): void { const query = exact(value, ['type', 'payload'], 'query'); required(query, ['type', 'payload'], 'query'); switch (query.type) { case 'study.get_today': case 'study.get_week_summary': { const p = payload(query.payload, ['date'], [], 'query.payload'); if (p.date !== undefined) studyDate(p.date, 'query.payload.date'); return; } default: fail('query.type'); } }

export function validateCommandEnvelope(value: unknown): asserts value is CommandEnvelope {
  const envelope = exact(value, ['apiVersion', 'kind', 'context', 'command'], 'envelope');
  required(envelope, ['apiVersion', 'kind', 'context', 'command'], 'envelope');
  if (envelope.apiVersion !== agentApiVersion) throw new AgentError('UNSUPPORTED_API_VERSION');
  if (envelope.kind !== 'command') fail('envelope.kind');
  const context = envelope.context;
  validateExecutionContext(context);
  validateCommandConcurrency(context);
  if (String((envelope.command as { type: string }).type).startsWith('imports.')) validateImportsCommand(envelope.command);
  else if (String((envelope.command as { type: string }).type).startsWith('study.')) validateStudyCommand(envelope.command);
  else if (String((envelope.command as { type: string }).type).startsWith('knowledge.')) validateKnowledgeCommand(envelope.command);
  else validateQuestionCommand(envelope.command);
}

export function validateQueryEnvelope(value: unknown): asserts value is QueryEnvelope {
  const envelope = exact(value, ['apiVersion', 'kind', 'context', 'query'], 'envelope');
  required(envelope, ['apiVersion', 'kind', 'context', 'query'], 'envelope');
  if (envelope.apiVersion !== agentApiVersion) throw new AgentError('UNSUPPORTED_API_VERSION');
  if (envelope.kind !== 'query') fail('envelope.kind');
  validateExecutionContext(envelope.context);
  if (String((envelope.query as { type: string }).type).startsWith('imports.')) validateImportsQuery(envelope.query);
  else if (String((envelope.query as { type: string }).type).startsWith('study.')) validateStudyQuery(envelope.query);
  else if (['knowledge.', 'textbooks.', 'analytics.'].some((prefix) => String((envelope.query as { type: string }).type).startsWith(prefix))) validateKnowledgeQuery(envelope.query);
  else validateQuestionQuery(envelope.query);
}

export function validateDomainEvent(value: unknown): asserts value is DomainEvent {
  const event = exact(value, ['apiVersion', 'eventId', 'type', 'occurredAt', 'requestId', 'traceId', 'source', 'versionBefore', 'versionAfter', 'payload'], 'event');
  required(event, ['apiVersion', 'eventId', 'type', 'occurredAt', 'requestId', 'traceId', 'source', 'versionBefore', 'versionAfter', 'payload'], 'event');
  if (event.apiVersion !== agentApiVersion) throw new AgentError('UNSUPPORTED_API_VERSION');
  uuid(event.eventId, 'event.eventId'); string(event.type, 'event.type', 200); isoTimestamp(event.occurredAt, 'event.occurredAt');
  uuid(event.requestId, 'event.requestId'); uuid(event.traceId, 'event.traceId'); oneOf(event.source, ['renderer', 'internal', 'mcp'], 'event.source');
  validateDataVersion(event.versionBefore, 'event.versionBefore'); validateDataVersion(event.versionAfter, 'event.versionAfter');
  if (event.versionBefore.dataEpoch === event.versionAfter.dataEpoch) {
    if (
      event.versionBefore.dataRevision === Number.MAX_SAFE_INTEGER ||
      event.versionAfter.dataRevision !== event.versionBefore.dataRevision + 1
    ) fail('event.versionAfter');
  } else if (event.versionAfter.dataRevision !== 0) fail('event.versionAfter');
  object(event.payload, 'event.payload');
}

export function isCommandEnvelope(value: unknown): value is CommandEnvelope {
  try { validateCommandEnvelope(value); return true; } catch { return false; }
}

export function isQueryEnvelope(value: unknown): value is QueryEnvelope {
  try { validateQueryEnvelope(value); return true; } catch { return false; }
}

import { AgentError } from '../../../shared/agent/errors';
import type {
  TickTickFocusSession,
  TickTickFocusSessionInput,
  TickTickTask,
  TickTickTaskFilters,
  TickTickTaskInput
} from '../../../shared/types';

export type TickTickTaskPatch = Partial<TickTickTaskInput> & {
  readonly is_completed?: number;
  readonly actual_minutes?: number;
  readonly pomodoro_sessions?: number;
  readonly sort_order?: number;
};

export type TickTickCommand =
  | { readonly type: 'tasks.create'; readonly payload: { readonly input: TickTickTaskInput } }
  | { readonly type: 'tasks.update'; readonly payload: { readonly taskId: string; readonly input: TickTickTaskPatch } }
  | { readonly type: 'tasks.complete'; readonly payload: { readonly taskId: string } }
  | { readonly type: 'tasks.uncomplete'; readonly payload: { readonly taskId: string } }
  | { readonly type: 'tasks.delete'; readonly payload: { readonly taskId: string } }
  | { readonly type: 'focus.sessions.create'; readonly payload: { readonly input: TickTickFocusSessionInput } };

export type TickTickQuery =
  | { readonly type: 'tasks.list'; readonly payload: { readonly filters: TickTickTaskFilters } }
  | { readonly type: 'tasks.get'; readonly payload: { readonly taskId: string } }
  | { readonly type: 'focus.sessions.list'; readonly payload: { readonly filters: { readonly date?: string; readonly taskId?: string } } };

export interface TickTickCommandValues {
  readonly 'tasks.create': TickTickTask;
  readonly 'tasks.update': TickTickTask | null;
  readonly 'tasks.complete': TickTickTask | null;
  readonly 'tasks.uncomplete': TickTickTask | null;
  readonly 'tasks.delete': boolean;
  readonly 'focus.sessions.create': TickTickFocusSession;
}

export interface TickTickQueryValues {
  readonly 'tasks.list': TickTickTask[];
  readonly 'tasks.get': TickTickTask | null;
  readonly 'focus.sessions.list': TickTickFocusSession[];
}

export const tickTickCommandTypes = Object.freeze([
  'tasks.create', 'tasks.update', 'tasks.complete', 'tasks.uncomplete', 'tasks.delete', 'focus.sessions.create'
] as const);

export const tickTickQueryTypes = Object.freeze(['tasks.list', 'tasks.get', 'focus.sessions.list'] as const);

function fail(field: string): never {
  throw new AgentError('VALIDATION_ERROR', { field });
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field);
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  const result = record(value, field);
  for (const key of Object.keys(result)) if (!keys.includes(key)) fail(`${field}.${key}`);
  return result;
}

function required(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${field}.${key}`);
}

function text(value: unknown, field: string, allowEmpty = false): void {
  if (typeof value !== 'string' || value.length > 10_000 || (!allowEmpty && value.length === 0)) fail(field);
}

function optionalText(value: unknown, field: string, nullable = false): void {
  if (value !== undefined && !(nullable && value === null)) text(value, field, true);
}

function integer(value: unknown, field: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(field);
}

function timestamp(value: unknown, field: string): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) fail(field);
}

function taskInput(value: unknown, field: string, partial: boolean): void {
  const keys = ['list_id', 'title', 'note', 'due_date', 'due_time', 'priority', 'parent_id', 'tags', 'recurrence_rule', 'estimated_minutes', 'source'];
  const result = exact(value, partial ? [...keys, 'is_completed', 'actual_minutes', 'pomodoro_sessions', 'sort_order'] : keys, field);
  if (!partial) required(result, ['list_id', 'title'], field);
  optionalText(result.list_id, `${field}.list_id`);
  optionalText(result.title, `${field}.title`);
  optionalText(result.note, `${field}.note`);
  optionalText(result.due_date, `${field}.due_date`, true);
  optionalText(result.due_time, `${field}.due_time`, true);
  if (result.priority !== undefined && !['none', '低', '中', '高'].includes(String(result.priority))) fail(`${field}.priority`);
  optionalText(result.parent_id, `${field}.parent_id`, true);
  if (result.tags !== undefined && (!Array.isArray(result.tags) || result.tags.some((tag) => typeof tag !== 'string'))) fail(`${field}.tags`);
  optionalText(result.recurrence_rule, `${field}.recurrence_rule`, true);
  if (result.source !== undefined && !['manual', 'auto_review', 'ai_plan'].includes(String(result.source))) fail(`${field}.source`);
  for (const key of ['estimated_minutes', 'actual_minutes', 'pomodoro_sessions', 'sort_order']) {
    if (result[key] !== undefined) integer(result[key], `${field}.${key}`);
  }
  if (result.is_completed !== undefined && result.is_completed !== 0 && result.is_completed !== 1) fail(`${field}.is_completed`);
}

function taskFilters(value: unknown, field: string): void {
  const result = exact(value, ['listId', 'dueDate', 'dueDateBefore', 'includeCompleted', 'includeNoDate', 'search', 'tag', 'priority'], field);
  for (const key of ['listId', 'dueDate', 'dueDateBefore', 'search', 'tag']) optionalText(result[key], `${field}.${key}`);
  for (const key of ['includeCompleted', 'includeNoDate']) if (result[key] !== undefined && typeof result[key] !== 'boolean') fail(`${field}.${key}`);
  if (result.priority !== undefined && !['none', '低', '中', '高'].includes(String(result.priority))) fail(`${field}.priority`);
}

export function validateTickTickCommand(value: unknown): asserts value is TickTickCommand {
  const command = exact(value, ['type', 'payload'], 'command');
  required(command, ['type', 'payload'], 'command');
  const payload = record(command.payload, 'command.payload');
  switch (command.type) {
    case 'tasks.create': required(payload, ['input'], 'command.payload'); exact(payload, ['input'], 'command.payload'); taskInput(payload.input, 'command.payload.input', false); return;
    case 'tasks.update': required(payload, ['taskId', 'input'], 'command.payload'); exact(payload, ['taskId', 'input'], 'command.payload'); text(payload.taskId, 'command.payload.taskId'); taskInput(payload.input, 'command.payload.input', true); return;
    case 'tasks.complete':
    case 'tasks.uncomplete':
    case 'tasks.delete': required(payload, ['taskId'], 'command.payload'); exact(payload, ['taskId'], 'command.payload'); text(payload.taskId, 'command.payload.taskId'); return;
    case 'focus.sessions.create': {
      required(payload, ['input'], 'command.payload'); exact(payload, ['input'], 'command.payload');
      const input = exact(payload.input, ['task_id', 'start_time', 'end_time', 'duration_minutes', 'session_type', 'completed', 'white_noise'], 'command.payload.input');
      required(input, ['start_time', 'duration_minutes'], 'command.payload.input');
      optionalText(input.task_id, 'command.payload.input.task_id', true); timestamp(input.start_time, 'command.payload.input.start_time');
      if (input.end_time !== undefined && input.end_time !== null) timestamp(input.end_time, 'command.payload.input.end_time');
      integer(input.duration_minutes, 'command.payload.input.duration_minutes');
      if (input.session_type !== undefined && !['focus', 'short_break', 'long_break'].includes(String(input.session_type))) fail('command.payload.input.session_type');
      if (input.completed !== undefined && input.completed !== 0 && input.completed !== 1) fail('command.payload.input.completed');
      if (input.white_noise !== undefined && input.white_noise !== null && !['rain', 'stream', 'cafe', 'white', 'forest', 'none'].includes(String(input.white_noise))) fail('command.payload.input.white_noise');
      return;
    }
    default: fail('command.type');
  }
}

export function validateTickTickQuery(value: unknown): asserts value is TickTickQuery {
  const query = exact(value, ['type', 'payload'], 'query');
  required(query, ['type', 'payload'], 'query');
  const payload = record(query.payload, 'query.payload');
  switch (query.type) {
    case 'tasks.list': required(payload, ['filters'], 'query.payload'); exact(payload, ['filters'], 'query.payload'); taskFilters(payload.filters, 'query.payload.filters'); return;
    case 'tasks.get': required(payload, ['taskId'], 'query.payload'); exact(payload, ['taskId'], 'query.payload'); text(payload.taskId, 'query.payload.taskId'); return;
    case 'focus.sessions.list': {
      required(payload, ['filters'], 'query.payload'); exact(payload, ['filters'], 'query.payload');
      const filters = exact(payload.filters, ['date', 'taskId'], 'query.payload.filters');
      optionalText(filters.date, 'query.payload.filters.date'); optionalText(filters.taskId, 'query.payload.filters.taskId'); return;
    }
    default: fail('query.type');
  }
}

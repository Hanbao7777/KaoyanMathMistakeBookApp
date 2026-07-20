import { AgentError } from '../agent/errors';

export const importDraftSchemaVersion = 1 as const;
export const importDraftStates = ['collecting', 'validated', 'applied', 'cancelled'] as const;
export type ImportDraftState = (typeof importDraftStates)[number];
export type ImportDraftSource = 'external_multimodal' | 'app_ocr_deepseek' | 'structured_file' | 'question_bank';
export type ImportNetworkDisclosure = 'none' | 'deepseek_text_only';
export type ImportImageRole = 'question' | 'solution';

export interface ImportDraftQuestion {
  readonly itemId: string;
  readonly title: string;
  readonly content: string;
  readonly wrongThinking: string;
  readonly correctSolution: string;
  readonly answer: string;
  readonly subject: '高等数学' | '线性代数' | '概率论' | '其他';
  readonly category: string;
  readonly questionType: string;
  readonly errorReason: string;
  readonly difficulty: '简单' | '中等' | '困难' | '压轴';
  readonly masteryLevel: '未掌握' | '较弱' | '一般' | '较好' | '已掌握';
  readonly source: string;
  readonly tags: readonly string[];
  readonly knowledgePoints: readonly string[];
  readonly images: readonly { readonly assetId: string; readonly role: ImportImageRole }[];
}

export interface ImportDraftIssue { readonly itemId: string; readonly field: string; readonly code: string; readonly message: string; }
export interface ImportDraftChange { readonly itemId: string; readonly action: 'create' | 'skip_duplicate'; readonly contentHash: string; readonly imageCount: number; }
export interface ImportDraftValidation { readonly valid: boolean; readonly issues: readonly ImportDraftIssue[]; readonly changes: readonly ImportDraftChange[]; readonly validationHash: string; readonly previewHash: string; }
export interface ImportDraft {
  readonly schemaVersion: typeof importDraftSchemaVersion;
  readonly draftId: string;
  readonly ownerClientId: string;
  readonly state: ImportDraftState;
  readonly provenance: { readonly source: ImportDraftSource; readonly networkDisclosure: ImportNetworkDisclosure; readonly createdBy: 'renderer' | 'mcp' | 'internal' };
  readonly items: readonly ImportDraftQuestion[];
  readonly validation?: ImportDraftValidation;
  readonly appliedQuestionIds: readonly number[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ImportsCreateDraftCommand { readonly type: 'imports.create_draft'; readonly payload: { readonly source: ImportDraftSource; readonly networkDisclosure: ImportNetworkDisclosure; readonly items: readonly Omit<ImportDraftQuestion, 'images'>[] }; }
export interface ImportsAddDraftImageCommand { readonly type: 'imports.add_draft_image'; readonly payload: { readonly draftId: string; readonly itemId: string; readonly assetId: string; readonly role: ImportImageRole }; }
export interface ImportsValidateDraftCommand { readonly type: 'imports.validate_draft'; readonly payload: { readonly draftId: string }; }
export interface ImportsApplyDraftCommand { readonly type: 'imports.apply_draft'; readonly payload: { readonly draftId: string; readonly previewHash: string }; }
export interface ImportsCancelCommand { readonly type: 'imports.cancel'; readonly payload: { readonly draftId: string }; }
export type ImportsCommand = ImportsCreateDraftCommand | ImportsAddDraftImageCommand | ImportsValidateDraftCommand | ImportsApplyDraftCommand | ImportsCancelCommand;
export interface ImportsGetQuery { readonly type: 'imports.get'; readonly payload: { readonly draftId: string }; }
export interface ImportsPreviewDraftQuery { readonly type: 'imports.preview_draft'; readonly payload: { readonly draftId: string }; }
export type ImportsQuery = ImportsGetQuery | ImportsPreviewDraftQuery;
export interface ImportsCommandValues {
  'imports.create_draft': ImportDraft;
  'imports.add_draft_image': ImportDraft;
  'imports.validate_draft': ImportDraftValidation;
  'imports.apply_draft': { readonly draftId: string; readonly createdQuestionIds: readonly number[]; readonly skippedItemIds: readonly string[]; readonly previewHash: string };
  'imports.cancel': { readonly draftId: string; readonly cancelled: true };
}
export interface ImportsQueryValues { 'imports.get': ImportDraft; 'imports.preview_draft': ImportDraftValidation; }

type RecordValue = Record<string, unknown>;
function fail(field: string): never { throw new AgentError('VALIDATION_ERROR', { field }); }
function object(value: unknown, field: string): RecordValue { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field); return value as RecordValue; }
function exact(value: unknown, keys: readonly string[], required: readonly string[], field: string): RecordValue { const result = object(value, field); for (const key of Object.keys(result)) if (!keys.includes(key)) fail(`${field}.${key}`); for (const key of required) if (!Object.prototype.hasOwnProperty.call(result, key)) fail(`${field}.${key}`); return result; }
function text(value: unknown, field: string, maximum: number, allowEmpty = false): asserts value is string { if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && value.trim().length === 0) || value !== value.normalize('NFC')) fail(field); }
function safeId(value: unknown, field: string): asserts value is string { text(value, field, 200); if (!/^[A-Za-z0-9_-]+$/.test(value)) fail(field); }
function oneOf(value: unknown, allowed: readonly string[], field: string): void { if (typeof value !== 'string' || !allowed.includes(value)) fail(field); }
function strings(value: unknown, field: string, maximum: number): void { if (!Array.isArray(value) || value.length > maximum) fail(field); value.forEach((entry, index) => text(entry, `${field}[${index}]`, 500)); if (new Set(value).size !== value.length) fail(field); }

function draftItem(value: unknown, field: string): void {
  const keys = ['itemId', 'title', 'content', 'wrongThinking', 'correctSolution', 'answer', 'subject', 'category', 'questionType', 'errorReason', 'difficulty', 'masteryLevel', 'source', 'tags', 'knowledgePoints'];
  const item = exact(value, keys, keys, field);
  safeId(item.itemId, `${field}.itemId`);
  text(item.title, `${field}.title`, 500);
  for (const key of ['content', 'wrongThinking', 'correctSolution', 'answer'] as const) text(item[key], `${field}.${key}`, 50_000, true);
  for (const key of ['category', 'questionType', 'errorReason', 'source'] as const) text(item[key], `${field}.${key}`, 500);
  oneOf(item.subject, ['高等数学', '线性代数', '概率论', '其他'], `${field}.subject`);
  oneOf(item.difficulty, ['简单', '中等', '困难', '压轴'], `${field}.difficulty`);
  oneOf(item.masteryLevel, ['未掌握', '较弱', '一般', '较好', '已掌握'], `${field}.masteryLevel`);
  strings(item.tags, `${field}.tags`, 50); strings(item.knowledgePoints, `${field}.knowledgePoints`, 50);
}

export function validateImportsCommand(value: unknown): asserts value is ImportsCommand {
  const command = exact(value, ['type', 'payload'], ['type', 'payload'], 'command');
  switch (command.type) {
    case 'imports.create_draft': { const p = exact(command.payload, ['source', 'networkDisclosure', 'items'], ['source', 'networkDisclosure', 'items'], 'command.payload'); oneOf(p.source, ['external_multimodal', 'app_ocr_deepseek', 'structured_file', 'question_bank'], 'command.payload.source'); oneOf(p.networkDisclosure, ['none', 'deepseek_text_only'], 'command.payload.networkDisclosure'); if (!Array.isArray(p.items) || p.items.length < 1 || p.items.length > 50) fail('command.payload.items'); p.items.forEach((item, index) => draftItem(item, `command.payload.items[${index}]`)); const ids = p.items.map((item) => (item as { itemId: string }).itemId); if (new Set(ids).size !== ids.length) fail('command.payload.items'); return; }
    case 'imports.add_draft_image': { const p = exact(command.payload, ['draftId', 'itemId', 'assetId', 'role'], ['draftId', 'itemId', 'assetId', 'role'], 'command.payload'); safeId(p.draftId, 'command.payload.draftId'); safeId(p.itemId, 'command.payload.itemId'); safeId(p.assetId, 'command.payload.assetId'); oneOf(p.role, ['question', 'solution'], 'command.payload.role'); return; }
    case 'imports.validate_draft': case 'imports.cancel': { const p = exact(command.payload, ['draftId'], ['draftId'], 'command.payload'); safeId(p.draftId, 'command.payload.draftId'); return; }
    case 'imports.apply_draft': { const p = exact(command.payload, ['draftId', 'previewHash'], ['draftId', 'previewHash'], 'command.payload'); safeId(p.draftId, 'command.payload.draftId'); text(p.previewHash, 'command.payload.previewHash', 80); if (!/^sha256-v1:[a-f0-9]{64}$/.test(p.previewHash as string)) fail('command.payload.previewHash'); return; }
    default: fail('command.type');
  }
}

export function validateImportsQuery(value: unknown): asserts value is ImportsQuery {
  const query = exact(value, ['type', 'payload'], ['type', 'payload'], 'query');
  if (query.type !== 'imports.get' && query.type !== 'imports.preview_draft') fail('query.type');
  const payload = exact(query.payload, ['draftId'], ['draftId'], 'query.payload'); safeId(payload.draftId, 'query.payload.draftId');
}

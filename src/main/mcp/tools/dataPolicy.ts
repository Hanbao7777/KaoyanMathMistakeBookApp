import type { AgentPrincipal } from '../../../shared/agent/v1/gatewayContracts';
import type { McpJsonValue, McpStructuredOutcome } from '../../../shared/mcp/v1/contracts';

const MAX_IMAGE_ITEMS = 100;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_KEYS = /^(?:question_images|solution_images|images|image_data|imageData)$/i;
const PATH_KEYS = /^(?:file_path|filePath|absolute_path|absolutePath)$/i;
const LONG_CONTENT_KEYS = /^(?:content|wrong_thinking|wrong_solution|correct_solution|answer)$/i;
const REDACTED = '[REDACTED]' as const;

function safeImage(value: unknown): McpJsonValue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const result: Record<string, McpJsonValue> = {};
  for (const key of ['id', 'question_id', 'image_type', 'created_at', 'mimeType', 'width', 'height', 'sizeBytes']) {
    const candidate = source[key];
    if (typeof candidate === 'string' || typeof candidate === 'number') result[key] = candidate;
  }
  if (typeof source.sizeBytes === 'number' && (!Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 0 || source.sizeBytes > MAX_IMAGE_BYTES)) return null;
  if (typeof source.width === 'number' && (!Number.isSafeInteger(source.width) || source.width < 1 || source.width > 10_000)) return null;
  if (typeof source.height === 'number' && (!Number.isSafeInteger(source.height) || source.height < 1 || source.height > 10_000)) return null;
  if (typeof source.mimeType === 'string' && !/^image\/(?:png|jpeg|webp|gif)$/.test(source.mimeType)) return null;
  return result;
}

function filterImageValue(value: unknown, allowImages: boolean): McpJsonValue {
  if (!allowImages || typeof value === 'string') return REDACTED;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_IMAGE_ITEMS).map((entry) => {
      if (typeof entry === 'string') return REDACTED;
      return safeImage(entry) ?? REDACTED;
    });
  }
  return safeImage(value) ?? REDACTED;
}

function filterValue(value: unknown, allowImages: boolean, key?: string, depth = 0): McpJsonValue {
  if (depth > 16) return '[REDACTED]';
  if (key && IMAGE_KEYS.test(key)) return filterImageValue(value, allowImages);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : '[REDACTED]';
  if (typeof value === 'string') return value.length <= 100_000 ? value : '[REDACTED]';
  if (Array.isArray(value)) return value.slice(0, 2_000).map((entry) => filterValue(entry, allowImages, undefined, depth + 1));
  const result: Record<string, McpJsonValue> = {};
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>).slice(0, 2_000)) {
    if (PATH_KEYS.test(childKey)) continue;
    result[childKey] = filterValue(child, allowImages, childKey, depth + 1);
  }
  return result;
}

export function applyPrincipalDataPolicy(outcome: McpStructuredOutcome, principal: AgentPrincipal): McpStructuredOutcome {
  if (!outcome.ok) return outcome;
  return Object.freeze({ ...outcome, data: filterValue(outcome.data, principal.scopes.includes('files.images.read')) });
}

function summarize(value: McpJsonValue, key?: string, depth = 0): McpJsonValue {
  if (depth > 16) return '[REDACTED]';
  if (typeof value === 'string' && key && LONG_CONTENT_KEYS.test(key)) return value.slice(0, 240);
  if (Array.isArray(value)) return value.map((entry) => summarize(entry, undefined, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, McpJsonValue> = {};
  for (const [childKey, child] of Object.entries(value)) result[childKey] = summarize(child, childKey, depth + 1);
  return result;
}

export function applyMcpListPolicy(
  outcome: McpStructuredOutcome,
  principal: AgentPrincipal,
  maxItems: number
): McpStructuredOutcome {
  const filtered = applyPrincipalDataPolicy(outcome, principal);
  if (!filtered.ok) return filtered;
  const data = summarize(filtered.data);
  if (!Array.isArray(data) || data.length <= maxItems) return Object.freeze({ ...filtered, data });
  return Object.freeze({ ...filtered, data: data.slice(0, maxItems), page: { pageSize: maxItems, hasMore: false } });
}

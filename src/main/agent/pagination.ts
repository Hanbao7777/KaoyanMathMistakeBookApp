import { createCipheriv, createDecipheriv, createHash, createHmac } from 'node:crypto';
import { AgentError } from '../../shared/agent/errors';
import type { JsonValue, PageInfo, RedactionProfile } from '../../shared/agent/v1/gatewayContracts';
import { canonicalizeJson, hashCanonicalJson } from '../../shared/agent/v1/gatewaySchemas';

const maxCursorLength = 4096;
const sensitiveKey = /(?:credential|secret|token|authorization|password|api[_-]?key|private[_-]?key|session[_-]?(?:id|fingerprint)|file[_-]?path|absolute[_-]?path|data[_-]?root)/i;
const absolutePath = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

interface CursorPayload {
  readonly version: 1;
  readonly queryHash: string;
  readonly lastKey: string;
  readonly pageSize: number;
}

export interface PaginationRequest {
  readonly query: JsonValue;
  readonly cursor?: string;
  readonly pageSize: number;
  readonly maxPageSize: number;
}

export interface PaginatedResult<T> {
  readonly items: readonly T[];
  readonly page: PageInfo;
}

export class PaginationService {
  private readonly secret: Buffer;

  constructor(secret: Uint8Array | string) {
    const source = Buffer.from(secret);
    if (source.byteLength < 32) throw new AgentError('VALIDATION_ERROR', { field: 'cursorSecret' });
    this.secret = createHash('sha256').update(source).digest();
  }

  paginate<T>(items: readonly T[], request: PaginationRequest, keyOf: (item: T) => string): PaginatedResult<T> {
    if (!Number.isSafeInteger(request.pageSize) || request.pageSize < 1 || request.pageSize > request.maxPageSize) {
      throw new AgentError('VALIDATION_ERROR', { field: 'pageSize' });
    }
    const queryHash = hashCanonicalJson(request.query);
    const lastKey = request.cursor ? this.parseCursor(request.cursor, queryHash, request.pageSize).lastKey : undefined;
    const ordered = [...items].sort((left, right) => keyOf(left).localeCompare(keyOf(right)));
    for (let index = 1; index < ordered.length; index += 1) {
      if (keyOf(ordered[index - 1]) === keyOf(ordered[index])) throw new AgentError('CURSOR_INVALID');
    }
    const start = lastKey === undefined ? 0 : ordered.findIndex((item) => keyOf(item) > lastKey);
    const effectiveStart = start < 0 ? ordered.length : start;
    const pageItems = ordered.slice(effectiveStart, effectiveStart + request.pageSize);
    const hasMore = effectiveStart + pageItems.length < ordered.length;
    const nextCursor = hasMore && pageItems.length
      ? this.createCursor({ version: 1, queryHash, lastKey: keyOf(pageItems[pageItems.length - 1]), pageSize: request.pageSize })
      : undefined;
    return Object.freeze({
      items: Object.freeze(pageItems),
      page: Object.freeze({ pageSize: request.pageSize, hasMore, ...(nextCursor ? { nextCursor } : {}) })
    });
  }

  private createCursor(payload: CursorPayload): string {
    const plaintext = canonicalizeJson(payload);
    const nonce = createHmac('sha256', this.secret).update(plaintext).digest().subarray(0, 12);
    const cipher = createCipheriv('aes-256-gcm', this.secret, nonce);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `${nonce.toString('base64url')}.${encrypted.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
  }

  private parseCursor(cursor: string, queryHash: string, pageSize: number): CursorPayload {
    if (cursor.length > maxCursorLength || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) throw new AgentError('CURSOR_INVALID');
    const [nonceValue, encryptedValue, tagValue] = cursor.split('.');
    let value: unknown;
    try {
      const nonce = Buffer.from(nonceValue, 'base64url');
      const encrypted = Buffer.from(encryptedValue, 'base64url');
      const tag = Buffer.from(tagValue, 'base64url');
      if (nonce.length !== 12 || tag.length !== 16 || encrypted.length === 0) throw new Error('invalid cursor');
      const decipher = createDecipheriv('aes-256-gcm', this.secret, nonce);
      decipher.setAuthTag(tag);
      value = JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'));
    } catch { throw new AgentError('CURSOR_INVALID'); }
    if (!value || typeof value !== 'object') throw new AgentError('CURSOR_INVALID');
    const payload = value as Partial<CursorPayload>;
    const keys = Object.keys(payload).sort();
    if (
      keys.join(',') !== 'lastKey,pageSize,queryHash,version' ||
      payload.version !== 1 || payload.queryHash !== queryHash || payload.pageSize !== pageSize ||
      typeof payload.lastKey !== 'string' || !payload.lastKey
    ) {
      throw new AgentError('CURSOR_INVALID');
    }
    return payload as CursorPayload;
  }
}

export function redactSensitiveValue(value: JsonValue, profile: RedactionProfile): JsonValue {
  const allowedFields = new Set(profile.fields);
  function redact(current: JsonValue, key?: string): JsonValue | undefined {
    if (key && sensitiveKey.test(key)) return undefined;
    if (typeof current === 'string' && absolutePath.test(current)) return undefined;
    if (current === null || typeof current !== 'object') return current;
    if (Array.isArray(current)) return current.map((entry) => redact(entry)).filter((entry): entry is JsonValue => entry !== undefined);
    const result: Record<string, JsonValue> = {};
    for (const [entryKey, entryValue] of Object.entries(current)) {
      if (allowedFields.size > 0 && key === undefined && !allowedFields.has(entryKey)) continue;
      const redacted = redact(entryValue, entryKey);
      if (redacted !== undefined) result[entryKey] = redacted;
    }
    return result;
  }
  return redact(value) ?? null;
}

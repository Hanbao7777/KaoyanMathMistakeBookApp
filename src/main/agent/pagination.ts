import { createCipheriv, createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
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

export interface PaginationWindow {
  readonly queryHash: string;
  readonly pageSize: number;
  readonly afterKey?: string;
}

export class PaginationService {
  private readonly secret: Buffer;

  constructor(secret: Uint8Array | string) {
    const source = Buffer.from(secret);
    if (source.byteLength < 32) throw new AgentError('VALIDATION_ERROR', { field: 'cursorSecret' });
    this.secret = createHash('sha256').update(source).digest();
  }

  paginate<T>(items: readonly T[], request: PaginationRequest, keyOf: (item: T) => string): PaginatedResult<T> {
    const window = this.createWindow(request);
    const ordered = [...items].sort((left, right) => keyOf(left).localeCompare(keyOf(right)));
    const windowed = window.afterKey === undefined ? ordered : ordered.filter((item) => keyOf(item) > window.afterKey!);
    return this.complete(windowed, window, keyOf);
  }

  createWindow(request: PaginationRequest): PaginationWindow {
    if (!Number.isSafeInteger(request.pageSize) || request.pageSize < 1 || request.pageSize > request.maxPageSize) {
      throw new AgentError('VALIDATION_ERROR', { field: 'pageSize' });
    }
    const queryHash = hashCanonicalJson(request.query);
    const afterKey = request.cursor ? this.parseCursor(request.cursor, queryHash, request.pageSize).lastKey : undefined;
    return Object.freeze({ queryHash, pageSize: request.pageSize, ...(afterKey ? { afterKey } : {}) });
  }

  complete<T>(items: readonly T[], window: PaginationWindow, keyOf: (item: T) => string): PaginatedResult<T> {
    const ordered = [...items].sort((left, right) => keyOf(left).localeCompare(keyOf(right)));
    for (let index = 1; index < ordered.length; index += 1) {
      if (keyOf(ordered[index - 1]) === keyOf(ordered[index])) throw new AgentError('CURSOR_INVALID');
    }
    if (window.afterKey !== undefined && ordered.some((item) => keyOf(item) <= window.afterKey!)) throw new AgentError('CURSOR_INVALID');
    const pageItems = ordered.slice(0, window.pageSize);
    const hasMore = ordered.length > window.pageSize;
    const nextCursor = hasMore && pageItems.length
      ? this.createCursor({ version: 1, queryHash: window.queryHash, lastKey: keyOf(pageItems[pageItems.length - 1]), pageSize: window.pageSize })
      : undefined;
    return Object.freeze({
      items: Object.freeze(pageItems),
      page: Object.freeze({ pageSize: window.pageSize, hasMore, ...(nextCursor ? { nextCursor } : {}) })
    });
  }

  private createCursor(payload: CursorPayload): string {
    const plaintext = canonicalizeJson(payload);
    const nonce = createHmac('sha256', this.secret).update(plaintext).digest().subarray(0, 12);
    const cipher = createCipheriv('aes-256-gcm', this.secret, nonce);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const body = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
    const signature = createHmac('sha256', this.secret).update(body).digest('hex');
    return `cursor-v1.${body}.${signature}`;
  }

  private parseCursor(cursor: string, queryHash: string, pageSize: number): CursorPayload {
    if (cursor.length > maxCursorLength || !/^cursor-v1\.[A-Za-z0-9_-]{16,384}\.[0-9a-f]{64}$/.test(cursor)) throw new AgentError('CURSOR_INVALID');
    const [, body, signature] = cursor.split('.');
    let value: unknown;
    try {
      const expectedSignature = createHmac('sha256', this.secret).update(body).digest('hex');
      if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) throw new Error('invalid cursor signature');
      const packed = Buffer.from(body, 'base64url');
      const nonce = packed.subarray(0, 12);
      const tag = packed.subarray(12, 28);
      const encrypted = packed.subarray(28);
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

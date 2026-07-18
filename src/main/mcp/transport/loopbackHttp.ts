import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { mcpProtocolVersions } from '../../../shared/mcp/v1/versions';
import type { AgentPrincipal } from '../../../shared/agent/v1/gatewayContracts';

const MAX_BODY_BYTES = 64 * 1024;
export const loopbackMcpEndpoint = '/mcp';

export interface McpSessionAdmission {
  readonly sessionId: string;
  readonly protocolVersion: string;
  readonly expiresAt: string;
}

export interface AuthenticatedLoopbackRequest {
  readonly session: McpSessionAdmission;
  readonly principal: AgentPrincipal;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly request: Readonly<Record<string, unknown>>;
  readonly tasksNegotiated: boolean;
}

export interface LoopbackHttpResponse {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface LoopbackSessionAuthenticator {
  challengeInitialize?(request: { readonly headers: Readonly<Record<string, string | undefined>>; readonly protocolVersion: string }): Promise<object | null>;
  admitInitialize(request: { readonly headers: Readonly<Record<string, string | undefined>>; readonly protocolVersion: string }): Promise<McpSessionAdmission | null>;
  validateSession(sessionId: string, protocolVersion: string): Promise<AgentPrincipal | null>;
  invalidateAll(): Promise<void> | void;
}

export interface LoopbackHttpOptions {
  readonly getPort: () => number;
  readonly instanceId: string;
  readonly authenticator: LoopbackSessionAuthenticator;
  readonly externalControlEnabled?: () => Promise<boolean> | boolean;
  readonly onExternalControlDisabled?: () => Promise<void> | void;
  readonly onAuthenticatedRequest?: (request: AuthenticatedLoopbackRequest) => Promise<LoopbackHttpResponse | null | undefined> | LoopbackHttpResponse | null | undefined;
  readonly allowedOrigins?: readonly string[];
  readonly maxRequestBytes?: number;
  readonly now?: () => Date;
  readonly initializeResult?: Readonly<Record<string, unknown>> | ((protocolVersion: string) => Readonly<Record<string, unknown>>);
}

export interface LoopbackMcpRequestHandler extends http.RequestListener {
  invalidateSessions(): void;
}

function respond(response: ServerResponse, status: number, body?: unknown, headers: Readonly<Record<string, string>> = {}): void {
  if (body === undefined) { response.writeHead(status, { ...headers, connection: 'close' }); response.end(); return; }
  const encoded = JSON.stringify(body);
  if (encoded === undefined) { response.writeHead(500, { connection: 'close' }); response.end(); return; }
  response.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(encoded)), 'cache-control': 'no-store', connection: 'close' });
  response.end(encoded);
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? undefined : value;
}

function validHost(request: IncomingMessage, port: number): boolean {
  return Number.isSafeInteger(port) && port > 0 && header(request, 'host') === `127.0.0.1:${port}`;
}

function validOrigin(request: IncomingMessage, port: number, allowedOrigins: readonly string[] = []): boolean {
  const origin = header(request, 'origin');
  return origin === undefined || origin === `http://127.0.0.1:${port}` || allowedOrigins.includes(origin);
}

async function readJson(request: IncomingMessage, maximum: number): Promise<unknown> {
  const contentLength = header(request, 'content-length');
  if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(Number(contentLength)) || Number(contentLength) > maximum)) throw new Error('request_too_large');
  const contentEncoding = header(request, 'content-encoding');
  if (contentEncoding !== undefined && contentEncoding.toLowerCase() !== 'identity') throw new Error('unsupported_content_encoding');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maximum) throw new Error('request_too_large');
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('invalid_json'); }
}

function isRequestId(value: unknown): value is string | number {
  return (typeof value === 'string' && value.length > 0 && value.length <= 256) || (typeof value === 'number' && Number.isSafeInteger(value));
}

function isJsonRpcObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isInitialize(value: unknown): value is { jsonrpc: '2.0'; id: string | number; method: 'initialize'; params: { protocolVersion: string; capabilities?: Record<string, unknown> } } {
  if (!isJsonRpcObject(value)) return false;
  const params = value.params;
  return value.jsonrpc === '2.0' && isRequestId(value.id) && value.method === 'initialize' &&
    isJsonRpcObject(params) && typeof params.protocolVersion === 'string' && params.protocolVersion.length <= 64;
}

function negotiatesTasks(params: { protocolVersion: string; capabilities?: Record<string, unknown> }): boolean {
  if (params.protocolVersion !== '2025-11-25' || !isJsonRpcObject(params.capabilities)) return false;
  return isJsonRpcObject(params.capabilities.tasks);
}

function isJsonRpcMessage(value: unknown): value is Record<string, unknown> {
  if (!isJsonRpcObject(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string' || value.method.length < 1 || value.method.length > 128) return false;
  if (value.id !== undefined && !isRequestId(value.id)) return false;
  return value.params === undefined || isJsonRpcObject(value.params);
}

function isInitializedNotification(value: Record<string, unknown>): boolean {
  return value.method === 'notifications/initialized' && value.id === undefined;
}

function isNotification(value: Record<string, unknown>): boolean {
  return value.id === undefined;
}

function errorBody(id: unknown, code: number, message: string, data?: unknown): object {
  return { jsonrpc: '2.0', ...(isRequestId(id) ? { id } : { id: null }), error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function requestHeaders(request: IncomingMessage): Readonly<Record<string, string | undefined>> {
  const values: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(request.headers)) values[name] = Array.isArray(value) ? undefined : value;
  return Object.freeze(values);
}

function canonicalExpiry(value: string, now: Date): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value && milliseconds > now.getTime() && milliseconds <= now.getTime() + 15 * 60_000;
}

function isInitializeWithoutSession(request: IncomingMessage): boolean {
  return header(request, 'mcp-session-id') === undefined && header(request, 'mcp-protocol-version') === undefined;
}

export function createLoopbackMcpRequestHandler(options: LoopbackHttpOptions): LoopbackMcpRequestHandler {
  const maximum = options.maxRequestBytes ?? MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_BODY_BYTES) throw new Error('Loopback request limit is invalid');
  const sessions = new Map<string, { readonly admission: McpSessionAdmission; initialized: boolean; readonly tasksNegotiated: boolean }>();
  const now = options.now ?? (() => new Date());

  const invalidateSessions = () => { sessions.clear(); };
  const validateSession = async (sessionId: string | undefined, protocolVersion: string | undefined): Promise<{ admission: McpSessionAdmission; principal: AgentPrincipal } | null> => {
    if (!sessionId || !protocolVersion) return null;
    const local = sessions.get(sessionId);
    if (!local || local.admission.protocolVersion !== protocolVersion || Date.parse(local.admission.expiresAt) <= now().getTime()) {
      sessions.delete(sessionId);
      return null;
    }
    try {
      const principal = await options.authenticator.validateSession(sessionId, protocolVersion);
      if (!principal) {
        sessions.delete(sessionId);
        return null;
      }
      return { admission: local.admission, principal };
    } catch {
      sessions.delete(sessionId);
      return null;
    }
  };

  const handler = (async (request: IncomingMessage, response: ServerResponse) => {
    const port = options.getPort();
    if (request.url !== loopbackMcpEndpoint || !validHost(request, port) || !validOrigin(request, port, options.allowedOrigins)) { respond(response, 404); return; }
    response.setHeader('mcp-instance-id', options.instanceId);
    if (options.externalControlEnabled && !await options.externalControlEnabled()) {
      invalidateSessions();
      await Promise.resolve(options.authenticator.invalidateAll()).catch(() => undefined);
      void Promise.resolve(options.onExternalControlDisabled?.()).catch(() => undefined);
      respond(response, 503);
      return;
    }
    if (request.method !== 'POST' && request.method !== 'GET') {
      respond(response, 405, undefined, { allow: 'GET, POST' });
      return;
    }

    const sessionId = header(request, 'mcp-session-id');
    const sessionProtocol = header(request, 'mcp-protocol-version');
    if (request.method === 'GET') {
      const session = await validateSession(sessionId, sessionProtocol);
      if (!session || !sessions.get(session.admission.sessionId)?.initialized) { respond(response, 401); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-store', connection: 'close' });
      response.end();
      return;
    }

    if (header(request, 'content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') { respond(response, 415); return; }
    let payload: unknown;
    try { payload = await readJson(request, maximum); } catch (error) {
      const message = error instanceof Error ? error.message : '';
      respond(response, message === 'request_too_large' ? 413 : message === 'unsupported_content_encoding' ? 415 : 400);
      return;
    }

    if (isInitialize(payload)) {
      if (!isInitializeWithoutSession(request)) { respond(response, 400, errorBody(payload.id, -32600, 'Initialize must not include a session header')); return; }
      const requested = payload.params.protocolVersion;
      if (!(mcpProtocolVersions as readonly string[]).includes(requested)) {
        respond(response, 400, errorBody(payload.id, -32602, 'Unsupported MCP protocol version'));
        return;
      }
      if (!header(request, 'x-kaoyan-challenge-id') && options.authenticator.challengeInitialize) {
        const challenge = await options.authenticator.challengeInitialize({ headers: requestHeaders(request), protocolVersion: requested }).catch(() => null);
        if (challenge) {
          respond(response, 401, errorBody(payload.id, -32002, 'Authentication challenge required', { challenge }));
          return;
        }
      }
      let admission: McpSessionAdmission | null = null;
      try {
        admission = await options.authenticator.admitInitialize({ headers: requestHeaders(request), protocolVersion: requested });
      } catch {
        admission = null;
      }
      if (!admission || admission.protocolVersion !== requested || !isUuid(admission.sessionId) || !canonicalExpiry(admission.expiresAt, now())) { respond(response, 401); return; }
      sessions.set(admission.sessionId, { admission: Object.freeze({ ...admission }), initialized: false, tasksNegotiated: negotiatesTasks(payload.params) });
      response.setHeader('mcp-session-id', admission.sessionId);
      response.setHeader('mcp-protocol-version', requested);
      const initializeResult = typeof options.initializeResult === 'function' ? options.initializeResult(requested) : options.initializeResult ?? { capabilities: {}, serverInfo: { name: 'kaoyan-mcp-loopback', version: '1' }, instructions: 'Use the authenticated App-owned MCP session for every request.' };
      respond(response, 200, { jsonrpc: '2.0', id: payload.id, result: { protocolVersion: requested, ...initializeResult } });
      return;
    }

    const session = await validateSession(sessionId, sessionProtocol);
    if (!session) { respond(response, 401); return; }
    if (!isJsonRpcMessage(payload)) { respond(response, 400, errorBody(null, -32600, 'Invalid JSON-RPC request')); return; }
    const localSession = sessions.get(session.admission.sessionId);
    if (!localSession) { respond(response, 401); return; }
    if (isInitializedNotification(payload)) {
      localSession.initialized = true;
      respond(response, 202);
      return;
    }
    if (!localSession.initialized) { respond(response, 409, errorBody(payload.id, -32001, 'MCP session is not initialized')); return; }
    if (payload.method === 'ping' && !options.onAuthenticatedRequest) {
      respond(response, 200, { jsonrpc: '2.0', id: payload.id ?? null, result: {} });
      return;
    }
    if (isNotification(payload)) {
      respond(response, 202);
      return;
    }
    if (!options.onAuthenticatedRequest) {
      respond(response, 501, errorBody(payload.id, -32601, 'MCP capability is not available'));
      return;
    }
    try {
      const result = await options.onAuthenticatedRequest(Object.freeze({ session: session.admission, principal: session.principal, tasksNegotiated: localSession.tasksNegotiated, headers: requestHeaders(request), request: Object.freeze({ ...payload }) }));
      if (!result) { respond(response, 501, errorBody(payload.id, -32601, 'MCP capability is not available')); return; }
      respond(response, result.status ?? 200, result.body, result.headers);
    } catch {
      respond(response, 500, errorBody(payload.id, -32603, 'MCP request failed'));
    }
  }) as unknown as LoopbackMcpRequestHandler;
  handler.invalidateSessions = invalidateSessions;
  return handler;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function createDenyAllLoopbackAuthenticator(): LoopbackSessionAuthenticator {
  return Object.freeze({
    async admitInitialize() { return null; },
    async validateSession() { return null; },
    async invalidateAll() { return undefined; }
  });
}

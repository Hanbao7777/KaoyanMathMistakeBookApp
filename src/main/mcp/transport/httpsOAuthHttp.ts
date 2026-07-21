import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentGateway } from '../../../shared/agent/v1/gatewayContracts';
import { directHttpsAuthority, directHttpsDefaultPort, oauthAuthorizationEndpointPath, oauthProtectedResourceMcpPath, oauthProtectedResourcePath, oauthRevocationEndpointPath, oauthServerMetadataPath, oauthTokenEndpointPath, type DirectHttpsAuthority } from '../../../shared/mcp/v1/oauthContracts';
import { bearerChallenge, createOAuthMetadata, metadataForPath } from '../auth/oauthMetadata';
import { LocalOAuthAuthorizationServer } from '../auth/oauthAuthorizationServer';
import type { LocalHttpsCertificate } from '../tls/localHttpsCertificate';
import { createLoopbackMcpRequestHandler, type LoopbackMcpRequestHandler, type LoopbackSessionAuthenticator } from './loopbackHttp';
import { createMcpInitializeResult, createMcpProtocolHandler } from '../protocol';

const MAX_OAUTH_BODY_BYTES = 32 * 1024;

export interface DirectHttpsOAuthHostOptions {
  readonly authority?: DirectHttpsAuthority;
  readonly appInstanceId: string;
  readonly externalControlEnabled: () => Promise<boolean> | boolean;
  readonly authenticatedReady: () => Promise<boolean> | boolean;
  readonly authenticator: LoopbackSessionAuthenticator;
  readonly certificate: LocalHttpsCertificate | (() => Promise<LocalHttpsCertificate>);
  readonly oauth: LocalOAuthAuthorizationServer;
  readonly gateway?: AgentGateway;
  readonly onAuthenticatedRequest?: Parameters<typeof createLoopbackMcpRequestHandler>[0]['onAuthenticatedRequest'];
  readonly now?: () => Date;
}

export interface DirectHttpsOAuthHostStatus {
  readonly state: 'disabled' | 'ready' | 'stopped';
  readonly authority: DirectHttpsAuthority;
  readonly resource: string;
  readonly issuer: string;
  readonly appInstanceId: string;
  readonly certificateThumbprint?: string;
  readonly reason?: string;
}

export function localHttpsServerOptions(certificate: LocalHttpsCertificate): https.ServerOptions {
  if (!certificate.pfx.length || typeof certificate.passphrase !== 'string' || certificate.passphrase.length < 32) throw new Error('Local HTTPS certificate key material is invalid');
  return { pfx: Buffer.from(certificate.pfx), passphrase: certificate.passphrase };
}

function header(request: IncomingMessage, name: string): string | undefined { const value = request.headers[name.toLowerCase()]; return Array.isArray(value) ? undefined : value; }
function jsonResponse(response: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void { const encoded = JSON.stringify(body); response.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(encoded)), 'cache-control': 'no-store', connection: 'close' }); response.end(encoded); }
function plainResponse(response: ServerResponse, status: number, body: string, headers: Readonly<Record<string, string>> = {}): void { response.writeHead(status, { ...headers, ...(body ? { 'content-type': 'text/html; charset=utf-8', 'content-length': String(Buffer.byteLength(body)) } : {}), 'cache-control': 'no-store', connection: 'close' }); response.end(body); }
function readBody(request: IncomingMessage): Promise<string> {
  const contentLength = header(request, 'content-length'); if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_OAUTH_BODY_BYTES)) return Promise.reject(new Error('request_too_large'));
  return new Promise((resolve, reject) => { const chunks: Buffer[] = []; let size = 0; request.on('data', (chunk: Buffer | string) => { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length; if (size > MAX_OAUTH_BODY_BYTES) { request.destroy(); reject(new Error('request_too_large')); return; } chunks.push(bytes); }); request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); request.on('error', reject); });
}
function responseBody(response: ServerResponse, result: { readonly status: number; readonly headers?: Readonly<Record<string, string>>; readonly body?: unknown }): void { const headers = result.headers ?? {}; if (result.body === undefined) { response.writeHead(result.status, { ...headers, connection: 'close' }); response.end(); return; } if (typeof result.body === 'string') { plainResponse(response, result.status, result.body, headers); return; } jsonResponse(response, result.status, result.body, headers); }

export class DirectHttpsOAuthHost {
  private readonly authority: DirectHttpsAuthority;
  private readonly metadata: ReturnType<typeof createOAuthMetadata>;
  private readonly instanceId: string;
  private server: https.Server | null = null;
  private handler: LoopbackMcpRequestHandler | null = null;
  private state: DirectHttpsOAuthHostStatus['state'] = 'stopped';
  private certificateThumbprint: string | undefined;
  private reason: string | undefined;
  private startPromise: Promise<DirectHttpsOAuthHostStatus> | null = null;
  constructor(private readonly options: DirectHttpsOAuthHostOptions) { this.authority = options.authority ?? directHttpsAuthority(directHttpsDefaultPort); this.metadata = createOAuthMetadata({ authority: this.authority }); this.instanceId = options.appInstanceId; }
  status(): DirectHttpsOAuthHostStatus { return Object.freeze({ state: this.state, authority: this.authority, resource: this.authority.resource, issuer: this.authority.issuer, appInstanceId: this.instanceId, ...(this.certificateThumbprint ? { certificateThumbprint: this.certificateThumbprint } : {}), ...(this.reason ? { reason: this.reason } : {}) }); }
  async start(): Promise<DirectHttpsOAuthHostStatus> { if (this.startPromise) return this.startPromise; if (this.state === 'ready') return this.status(); const promise = this.startOnce(); this.startPromise = promise; try { return await promise; } finally { if (this.startPromise === promise) this.startPromise = null; } }
  async stop(): Promise<void> { this.state = 'stopped'; this.handler?.invalidateSessions(); await Promise.resolve(this.options.authenticator.invalidateAll()).catch(() => undefined); const server = this.server; this.server = null; this.handler = null; if (server) await new Promise<void>((resolve) => { try { server.close(() => resolve()); } catch { resolve(); } }); }
  private async startOnce(): Promise<DirectHttpsOAuthHostStatus> {
    if (!await this.options.externalControlEnabled() || !await this.options.authenticatedReady()) { this.state = 'disabled'; return this.status(); }
    if (this.options.oauth.metadata.authority.authority !== this.authority.authority || this.options.oauth.metadata.authority.resource !== this.authority.resource || this.options.oauth.metadata.authority.issuer !== this.authority.issuer) { this.state = 'disabled'; this.reason = 'metadata_mismatch'; throw new Error('Direct HTTPS OAuth metadata does not match the fixed authority'); }
    let certificate: LocalHttpsCertificate;
    try { certificate = typeof this.options.certificate === 'function' ? await this.options.certificate() : this.options.certificate; if (!certificate?.pfx || typeof certificate.passphrase !== 'string' || certificate.passphrase.length < 32 || certificate.dnsNames[0] !== 'localhost' || certificate.ipAddresses[0] !== '127.0.0.1') throw new Error('Local HTTPS certificate is invalid'); this.certificateThumbprint = certificate.thumbprint; }
    catch (error) { this.state = 'disabled'; this.reason = 'certificate_unavailable'; throw error; }
    const handler = createLoopbackMcpRequestHandler({ getPort: () => this.authority.port, instanceId: this.instanceId, authenticator: this.options.authenticator, externalControlEnabled: this.options.externalControlEnabled, onExternalControlDisabled: () => this.stop(), onAuthenticatedRequest: this.options.onAuthenticatedRequest ?? (this.options.gateway ? createMcpProtocolHandler({ gateway: this.options.gateway }) : undefined), initializeResult: this.options.gateway ? createMcpInitializeResult : undefined, allowedOrigins: [this.authority.authority], allowDefaultOrigin: false, requireOrigin: true, requireAccept: true, unauthorizedHeaders: { 'www-authenticate': bearerChallenge(this.metadata) }, now: this.options.now });
    const server = https.createServer(localHttpsServerOptions(certificate), (request, response) => { void this.route(request, response, handler); }); this.server = server; this.handler = handler;
    try { await new Promise<void>((resolve, reject) => { const onError = (error: Error) => { server.off('listening', onListening); reject(error); }; const onListening = () => { server.off('error', onError); resolve(); }; server.once('error', onError); server.once('listening', onListening); server.listen({ host: '127.0.0.1', port: this.authority.port, exclusive: true }); }); const address = server.address(); if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || address.port !== this.authority.port) throw new Error('Direct HTTPS authority did not bind the fixed port'); this.state = 'ready'; this.reason = undefined; return this.status(); }
    catch (error) { this.state = 'disabled'; this.reason = 'bind_failed'; this.server = null; this.handler = null; await new Promise<void>((resolve) => { try { server.close(() => resolve()); } catch { resolve(); } }); throw error; }
  }
  private async route(request: IncomingMessage, response: ServerResponse, mcpHandler: LoopbackMcpRequestHandler): Promise<void> {
    const authorityHost = `127.0.0.1:${this.authority.port}`; if (header(request, 'host') !== authorityHost) { response.writeHead(404); response.end(); return; }
    const pathname = new URL(request.url ?? '/', this.authority.authority).pathname;
    const metadata = metadataForPath(pathname, this.metadata);
    if (metadata && request.method === 'GET') { jsonResponse(response, 200, metadata); return; }
    if (pathname === oauthAuthorizationEndpointPath && request.method === 'GET') { responseBody(response, await this.options.oauth.authorize(new URL(request.url ?? '/', this.authority.authority).searchParams)); return; }
    if ((pathname === oauthTokenEndpointPath || pathname === oauthRevocationEndpointPath) && request.method === 'POST') {
      if (header(request, 'content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') { jsonResponse(response, 415, { error: 'invalid_request' }); return; }
      try { const body = await readBody(request); responseBody(response, pathname === oauthTokenEndpointPath ? await this.options.oauth.token(body) : await this.options.oauth.revoke(body)); } catch (error) { jsonResponse(response, error instanceof Error && error.message === 'request_too_large' ? 413 : 400, { error: 'invalid_request' }); }
      return;
    }
    if (pathname === '/mcp') { await mcpHandler(request, response); return; }
    response.writeHead(404, { connection: 'close' }); response.end();
  }
}

export function createDirectHttpsOAuthHost(options: DirectHttpsOAuthHostOptions): DirectHttpsOAuthHost { return new DirectHttpsOAuthHost(options); }

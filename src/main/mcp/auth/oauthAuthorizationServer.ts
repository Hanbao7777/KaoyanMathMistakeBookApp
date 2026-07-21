import { URLSearchParams } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { AgentScope } from '../../../shared/agent/v1/gatewayContracts';
import {
  validateAuthorizationRequest,
  validateRegisteredRedirectUri,
  validateRevokeRequest,
  validateTokenRequest,
  type HttpOAuthClientRegistration,
  type OAuthAuthorizationRequest,
  type OAuthRevokeRequest,
  type OAuthTokenRequest
} from '../../../shared/mcp/v1/oauthContracts';
import { createOAuthMetadata } from './oauthMetadata';
import { OAuthTokenStore } from './oauthTokenStore';

export interface OAuthHttpResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface OAuthHttpClientPort {
  getHttpClient(clientId: string): Promise<HttpOAuthClientRegistration | null> | HttpOAuthClientRegistration | null;
  isHttpClientActive?(clientId: string): Promise<boolean> | boolean;
  currentScopes?(clientId: string): Promise<readonly AgentScope[]> | readonly AgentScope[];
}

export interface OAuthAuthorizationServerOptions {
  readonly metadata: ReturnType<typeof createOAuthMetadata>;
  readonly tokenStore: OAuthTokenStore;
  readonly clients: OAuthHttpClientPort;
  readonly appInstanceId: string;
  readonly now?: () => Date;
  readonly consent?: (request: OAuthAuthorizationRequest, client: HttpOAuthClientRegistration) => Promise<boolean> | boolean;
}

export interface PendingOAuthAuthorizationRequest {
  readonly requestId: string;
  readonly clientId: string;
  readonly product: 'codex' | 'claude_code';
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly resource: string;
  readonly createdAt: string;
}

function form(value: unknown): Record<string, string> {
  if (typeof value === 'string') return Object.fromEntries(new URLSearchParams(value).entries());
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]));
  throw new TypeError('Invalid OAuth form');
}
function errorBody(error: string, description = 'OAuth request was rejected.'): object { return Object.freeze({ error, error_description: description }); }

export class LocalOAuthAuthorizationServer {
  private readonly now: () => Date;
  private readonly pending = new Map<string, { readonly request: OAuthAuthorizationRequest; readonly client: HttpOAuthClientRegistration; readonly resolve: (approved: boolean) => void; }>();
  constructor(private readonly options: OAuthAuthorizationServerOptions) { this.now = options.now ?? (() => new Date()); }
  get metadata(): ReturnType<typeof createOAuthMetadata> { return this.options.metadata; }

  async authorize(input: string | URLSearchParams | Record<string, unknown>): Promise<OAuthHttpResponse> {
    try {
      const request = this.parseAuthorization(input); validateAuthorizationRequest(request);
      if (request.resource !== this.options.metadata.authority.resource) throw new Error('invalid_target');
      const client = await this.options.clients.getHttpClient(request.client_id);
      if (!client || client.issuer !== this.options.metadata.authority.issuer || client.resource !== request.resource || (this.options.clients.isHttpClientActive && !await this.options.clients.isHttpClientActive(client.clientId))) throw new Error('unauthorized_client');
      validateRegisteredRedirectUri(client, request.redirect_uri);
      const requestedScopes = request.scope.split(' ') as AgentScope[];
      if (requestedScopes.some((scope) => !client.allowedScopes.includes(scope))) throw new Error('invalid_scope');
      if (!await this.awaitConsent(request, client)) return { status: 403, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: '<!doctype html><title>Authorization denied</title><p>Authorization was denied by the local App.</p>' };
      const code = await this.options.tokenStore.createAuthorizationCode({ clientId: client.clientId, redirectUri: request.redirect_uri, resource: request.resource, issuer: this.options.metadata.authority.issuer, scopes: Object.freeze([...requestedScopes]), codeChallenge: request.code_challenge, ...(request.nonce ? { nonce: request.nonce } : {}), appInstanceId: this.options.appInstanceId, refreshTokensAllowed: client.refreshTokensAllowed });
      const redirect = new URL(request.redirect_uri); redirect.searchParams.set('code', code.code); redirect.searchParams.set('state', request.state);
      return { status: 302, headers: { location: redirect.toString(), 'cache-control': 'no-store' } };
    } catch (error) {
      const code = error instanceof Error && error.message === 'invalid_scope' ? 'invalid_scope' : error instanceof Error && error.message === 'invalid_target' ? 'invalid_target' : error instanceof Error && error.message === 'unauthorized_client' ? 'unauthorized_client' : 'invalid_request';
      return { status: 400, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: errorBody(code) };
    }
  }

  async token(input: string | URLSearchParams | Record<string, unknown>): Promise<OAuthHttpResponse> {
    try {
      const request = this.parseToken(input); validateTokenRequest(request);
      const client = await this.options.clients.getHttpClient(request.client_id);
      if (!client || client.issuer !== this.options.metadata.authority.issuer || client.resource !== request.resource || (this.options.clients.isHttpClientActive && !await this.options.clients.isHttpClientActive(client.clientId))) throw new Error('unauthorized_client');
      if (request.grant_type === 'authorization_code') {
        const issued = await this.options.tokenStore.redeemAuthorizationCode(request);
        return this.tokenResponse(issued.response);
      }
      const scopes = this.options.clients.currentScopes ? await this.options.clients.currentScopes(client.clientId) : client.allowedScopes;
      const issued = await this.options.tokenStore.refresh(request, { scopes, appInstanceId: this.options.appInstanceId, issuer: this.options.metadata.authority.issuer });
      return this.tokenResponse(issued.response);
    } catch (error) {
      const code = error instanceof Error && error.message === 'invalid_scope' ? 'invalid_scope' : error instanceof Error && error.message === 'unauthorized_client' ? 'unauthorized_client' : 'invalid_grant';
      return { status: 400, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: errorBody(code) };
    }
  }

  async revoke(input: string | URLSearchParams | Record<string, unknown>): Promise<OAuthHttpResponse> {
    try { const request = this.parseRevoke(input); validateRevokeRequest(request); const client = await this.options.clients.getHttpClient(request.client_id); if (!client || client.issuer !== this.options.metadata.authority.issuer) throw new Error('unauthorized_client'); await this.options.tokenStore.revoke(request.token, request.token_type_hint); return { status: 200, headers: { 'cache-control': 'no-store' } }; }
    catch { return { status: 400, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: errorBody('invalid_request') }; }
  }

  listPending(): readonly PendingOAuthAuthorizationRequest[] { return Object.freeze([...this.pending.entries()].map(([requestId, value]) => Object.freeze({ requestId, clientId: value.request.client_id, product: value.client.product, redirectUri: value.request.redirect_uri, scopes: Object.freeze(value.request.scope.split(' ')), resource: value.request.resource, createdAt: this.now().toISOString() }))); }
  approvePending(requestId: string): void { const value = this.pending.get(requestId); if (!value) throw new Error('pending_request_not_found'); this.pending.delete(requestId); value.resolve(true); }
  denyPending(requestId: string): void { const value = this.pending.get(requestId); if (!value) throw new Error('pending_request_not_found'); this.pending.delete(requestId); value.resolve(false); }

  private async awaitConsent(request: OAuthAuthorizationRequest, client: HttpOAuthClientRegistration): Promise<boolean> {
    if (this.options.consent) return this.options.consent(request, client);
    const requestId = cryptoRandomId();
    return new Promise<boolean>((resolve) => { this.pending.set(requestId, Object.freeze({ request, client, resolve })); });
  }

  private tokenResponse(response: OAuthHttpResponse['body']): OAuthHttpResponse { return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', pragma: 'no-cache' }, body: response }; }
  private parseAuthorization(input: string | URLSearchParams | Record<string, unknown>): OAuthAuthorizationRequest { const values = input instanceof URLSearchParams ? Object.fromEntries(input.entries()) : form(input); return values as unknown as OAuthAuthorizationRequest; }
  private parseToken(input: string | URLSearchParams | Record<string, unknown>): OAuthTokenRequest { const values = input instanceof URLSearchParams ? Object.fromEntries(input.entries()) : form(input); return values as unknown as OAuthTokenRequest; }
  private parseRevoke(input: string | URLSearchParams | Record<string, unknown>): OAuthRevokeRequest { const values = input instanceof URLSearchParams ? Object.fromEntries(input.entries()) : form(input); return values as unknown as OAuthRevokeRequest; }
}

function cryptoRandomId(): string { return randomUUID(); }

export function parseOAuthForm(value: string): Readonly<Record<string, string>> { return Object.freeze(Object.fromEntries(new URLSearchParams(value).entries())); }

import { URLSearchParams } from 'node:url';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AgentScope } from '../../../shared/agent/v1/gatewayContracts';
import { validateAuthorizationRequest, validateRegisteredRedirectUri, validateRevokeRequest, validateTokenRequest, type HttpOAuthClientRegistration, type OAuthAuthorizationRequest, type OAuthRevokeRequest, type OAuthTokenRequest } from '../../../shared/mcp/v1/oauthContracts';
import { createOAuthMetadata } from './oauthMetadata';
import { OAuthTokenStore, type OAuthStoredCode } from './oauthTokenStore';

export interface OAuthHttpResponse { readonly status: number; readonly headers?: Readonly<Record<string, string>>; readonly body?: unknown; }
export interface OAuthHttpClientPort { getHttpClient(clientId: string): Promise<HttpOAuthClientRegistration | null> | HttpOAuthClientRegistration | null; isHttpClientActive?(clientId: string): Promise<boolean> | boolean; currentScopes?(clientId: string): Promise<readonly AgentScope[]> | readonly AgentScope[]; }
export interface OAuthAuthorizationServerOptions { readonly metadata: ReturnType<typeof createOAuthMetadata>; readonly tokenStore: OAuthTokenStore; readonly clients: OAuthHttpClientPort; readonly appInstanceId: string; readonly now?: () => Date; readonly randomUUID?: () => string; readonly randomBytes?: (size: number) => Buffer; /** Test-only synchronous consent seam; production does not provide it. */ readonly consent?: (request: OAuthAuthorizationRequest, client: HttpOAuthClientRegistration) => Promise<boolean> | boolean; }
export interface PendingOAuthAuthorizationRequest { readonly requestId: string; readonly clientId: string; readonly product: 'codex' | 'claude_code'; readonly clientDisplayName: string; readonly scopes: readonly string[]; readonly resource: string; readonly redirectDisplay: string; readonly createdAt: string; readonly expiresAt: string; }
export interface OAuthConsentObserver { pending(value: PendingOAuthAuthorizationRequest): Promise<void>; decided(requestId: string, decision: 'approve' | 'deny', codeHash?: string, record?: OAuthStoredCode): Promise<void>; invalidated(requestId: string, reason?: 'invalidated' | 'expired'): Promise<void>; }

type PendingState = 'pending' | 'approved' | 'denied' | 'expired' | 'invalidated' | 'consumed';
interface Pending { readonly request: OAuthAuthorizationRequest; readonly client: HttpOAuthClientRegistration; readonly capabilityHash: string; readonly createdAt: string; state: PendingState; readonly expiresAt: number; code?: string; }
const cookiePrefix = 'kaoyan_oauth_continue_';
const maxLifetimeMs = 5 * 60_000;
const noStore = Object.freeze({ 'cache-control': 'no-store' });

function form(value: unknown): Record<string, string> { if (typeof value === 'string') return Object.fromEntries(new URLSearchParams(value).entries()); if (value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)])); throw new TypeError('Invalid OAuth form'); }
function errorBody(error: string, description = 'OAuth request was rejected.'): object { return Object.freeze({ error, error_description: description }); }
function capabilityHash(value: string): string { return createHash('sha256').update(value).digest('base64url'); }
function cookieName(requestId: string): string { return `${cookiePrefix}${requestId.replace(/-/g, '')}`; }
function cookie(requestId: string, value: string): string { return `${cookieName(requestId)}=${value}; Path=/oauth/authorize/; Secure; HttpOnly; SameSite=Strict`; }
function clearCookie(requestId: string): string { return `${cookieName(requestId)}=; Path=/oauth/authorize/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`; }
function findCookie(header: string | undefined, requestId: string): string | undefined { const name = cookieName(requestId); return header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1); }

export class LocalOAuthAuthorizationServer {
  private readonly now: () => Date;
  private metadataValue: ReturnType<typeof createOAuthMetadata>;
  private readonly pending = new Map<string, Pending>();
  private readonly deciding = new Set<string>();
  private observer: OAuthConsentObserver | undefined;
  private readonly uuid: () => string;
  private readonly bytes: (size: number) => Buffer;
  constructor(private readonly options: OAuthAuthorizationServerOptions) { this.now = options.now ?? (() => new Date()); this.uuid = options.randomUUID ?? randomUUID; this.bytes = options.randomBytes ?? randomBytes; this.metadataValue = options.metadata; }
  get metadata(): ReturnType<typeof createOAuthMetadata> { return this.metadataValue; }
  setConsentObserver(observer: OAuthConsentObserver | undefined): void { this.observer = observer; }
  setMetadata(metadata: ReturnType<typeof createOAuthMetadata>): void { if (metadata.authority.authority !== this.metadata.authority.authority || metadata.authority.resource !== this.metadata.authority.resource || metadata.authority.issuer !== this.metadata.authority.issuer) this.invalidatePending(); this.metadataValue = metadata; }

  async authorize(input: string | URLSearchParams | Record<string, unknown>): Promise<OAuthHttpResponse> {
    try {
      const request = this.parseAuthorization(input); validateAuthorizationRequest(request);
      if (request.resource !== this.metadata.authority.resource) throw new Error('invalid_target');
      const client = await this.options.clients.getHttpClient(request.client_id);
      if (!client || client.issuer !== this.metadata.authority.issuer || client.resource !== request.resource || (this.options.clients.isHttpClientActive && !await this.options.clients.isHttpClientActive(client.clientId))) throw new Error('unauthorized_client');
      validateRegisteredRedirectUri(client, request.redirect_uri);
      const scopes = request.scope.split(' ') as AgentScope[];
      if (scopes.some((scope) => !client.allowedScopes.includes(scope))) throw new Error('invalid_scope');
      if (this.options.consent) {
        if (!await this.options.consent(request, client)) return { status: 403, headers: { ...noStore, 'content-type': 'text/html; charset=utf-8' }, body: '<!doctype html><title>Authorization denied</title>' };
        const code = await this.options.tokenStore.createAuthorizationCode({ clientId: client.clientId, redirectUri: request.redirect_uri, resource: request.resource, issuer: this.metadata.authority.issuer, scopes: Object.freeze(scopes), codeChallenge: request.code_challenge, ...(request.nonce ? { nonce: request.nonce } : {}), appInstanceId: this.options.appInstanceId, refreshTokensAllowed: client.refreshTokensAllowed });
        const redirect = new URL(request.redirect_uri); redirect.searchParams.set('code', code.code); redirect.searchParams.set('state', request.state);
        return { status: 302, headers: { ...noStore, location: redirect.toString() } };
      }
      const requestId = this.uuid(); const capability = this.bytes(32).toString('base64url');
      const pending = { request, client, capabilityHash: capabilityHash(capability), createdAt: this.now().toISOString(), state: 'pending' as const, expiresAt: this.now().getTime() + maxLifetimeMs };
      this.pending.set(requestId, pending);
      try { await this.observer?.pending(Object.freeze({ requestId, clientId: client.clientId, product: client.product, clientDisplayName: client.product === 'codex' ? 'Codex CLI' : 'Claude Code', scopes: Object.freeze(request.scope.split(' ')), resource: request.resource, redirectDisplay: new URL(request.redirect_uri).origin + new URL(request.redirect_uri).pathname, createdAt: pending.createdAt, expiresAt: new Date(pending.expiresAt).toISOString() })); } catch (error) { this.pending.delete(requestId); throw error; }
      return { status: 202, headers: { ...noStore, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'", 'set-cookie': cookie(requestId, capability) }, body: this.waitingPage(requestId) };
    } catch (error) {
      const code = error instanceof Error && ['invalid_scope', 'invalid_target', 'unauthorized_client'].includes(error.message) ? error.message : 'invalid_request';
      return { status: 400, headers: { ...noStore, 'content-type': 'application/json; charset=utf-8' }, body: errorBody(code) };
    }
  }

  listPending(): readonly PendingOAuthAuthorizationRequest[] { this.expire(); return Object.freeze([...this.pending.entries()].filter(([, value]) => value.state === 'pending').map(([requestId, value]) => Object.freeze({ requestId, clientId: value.client.clientId, product: value.client.product, clientDisplayName: value.client.product === 'codex' ? 'Codex CLI' : 'Claude Code', scopes: Object.freeze(value.request.scope.split(' ')), resource: value.request.resource, redirectDisplay: new URL(value.request.redirect_uri).origin + new URL(value.request.redirect_uri).pathname, createdAt: value.createdAt, expiresAt: new Date(value.expiresAt).toISOString() }))); }
  async decidePending(requestId: string, decision: 'approve' | 'deny'): Promise<void> {
    if (decision !== 'approve' && decision !== 'deny') throw new Error('invalid_decision');
    const value = this.pending.get(requestId);
    if (!value || value.state !== 'pending' || value.expiresAt <= this.now().getTime() || this.deciding.has(requestId)) throw new Error('pending_request_not_found');
    this.deciding.add(requestId);
    try {
      const client = await this.options.clients.getHttpClient(value.client.clientId);
      const currentScopes = this.options.clients.currentScopes ? await this.options.clients.currentScopes(value.client.clientId) : client?.allowedScopes;
      const requestedScopes = value.request.scope.split(' ') as AgentScope[];
      if (!client || client.resource !== value.request.resource || client.issuer !== this.metadata.authority.issuer || !currentScopes || requestedScopes.some((scope) => !client.allowedScopes.includes(scope) || !currentScopes.includes(scope)) || (this.options.clients.isHttpClientActive && !await this.options.clients.isHttpClientActive(client.clientId))) {
        value.state = 'invalidated'; await this.observer?.invalidated(requestId); throw new Error('pending_request_invalidated');
      }
      validateRegisteredRedirectUri(client, value.request.redirect_uri);
      if (decision === 'deny') { await this.observer?.decided(requestId, decision); value.state = 'denied'; return; }
      const issued = await this.options.tokenStore.createAuthorizationCode({ clientId: client.clientId, redirectUri: value.request.redirect_uri, resource: value.request.resource, issuer: this.metadata.authority.issuer, scopes: Object.freeze(requestedScopes), codeChallenge: value.request.code_challenge, ...(value.request.nonce ? { nonce: value.request.nonce } : {}), appInstanceId: this.options.appInstanceId, refreshTokensAllowed: client.refreshTokensAllowed }, { persist: !this.observer });
      try { await this.observer?.decided(requestId, decision, issued.codeHash, issued.record); } catch (error) { await this.options.tokenStore.discardAuthorizationCode(issued.code).catch(() => undefined); throw error; }
      value.code = issued.code; value.state = 'approved';
    } finally { this.deciding.delete(requestId); }
  }
  invalidatePending(): void { for (const [requestId, value] of this.pending) if (value.state === 'pending' || value.state === 'approved') { value.state = 'invalidated'; void this.observer?.invalidated(requestId, 'invalidated').catch(() => undefined); } }
  status(requestId: string, capability: string | undefined): OAuthHttpResponse { const value = this.authorizeCapability(requestId, capability); if (!value) return { status: 404, headers: noStore }; this.expireOne(value); const state = value.state === 'approved' ? 'ready' : value.state; return { status: 200, headers: { ...noStore, 'content-type': 'application/json; charset=utf-8' }, body: Object.freeze({ status: state === 'pending' || state === 'ready' || state === 'denied' || state === 'expired' || state === 'invalidated' ? state : 'invalidated' }) }; }
  continue(requestId: string, capability: string | undefined): OAuthHttpResponse { const value = this.authorizeCapability(requestId, capability); if (!value) return { status: 404, headers: noStore }; this.expireOne(value); if (value.state === 'consumed') return { status: 410, headers: { ...noStore, 'set-cookie': clearCookie(requestId) } }; if (value.state !== 'approved' && value.state !== 'denied') return { status: 409, headers: noStore }; value.state = 'consumed'; const redirect = new URL(value.request.redirect_uri); if (value.code) redirect.searchParams.set('code', value.code); else redirect.searchParams.set('error', 'access_denied'); redirect.searchParams.set('state', value.request.state); return { status: 302, headers: { ...noStore, location: redirect.toString(), 'set-cookie': clearCookie(requestId) } }; }

  async token(input: string | URLSearchParams | Record<string, unknown>): Promise<OAuthHttpResponse> { try { const request = this.parseToken(input); validateTokenRequest(request); const client = await this.options.clients.getHttpClient(request.client_id); if (!client || client.issuer !== this.metadata.authority.issuer || client.resource !== request.resource || (this.options.clients.isHttpClientActive && !await this.options.clients.isHttpClientActive(client.clientId))) throw new Error('unauthorized_client'); if (request.grant_type === 'authorization_code') return this.tokenResponse((await this.options.tokenStore.redeemAuthorizationCode(request)).response); const scopes = this.options.clients.currentScopes ? await this.options.clients.currentScopes(client.clientId) : client.allowedScopes; return this.tokenResponse((await this.options.tokenStore.refresh(request, { scopes, appInstanceId: this.options.appInstanceId, issuer: this.metadata.authority.issuer })).response); } catch (error) { const code = error instanceof Error && ['invalid_scope', 'unauthorized_client'].includes(error.message) ? error.message : 'invalid_grant'; return { status: 400, headers: { ...noStore, 'content-type': 'application/json; charset=utf-8' }, body: errorBody(code) }; } }
  async revoke(input: string | URLSearchParams | Record<string, unknown>): Promise<OAuthHttpResponse> { try { const request = this.parseRevoke(input); validateRevokeRequest(request); const client = await this.options.clients.getHttpClient(request.client_id); if (!client || client.issuer !== this.metadata.authority.issuer) throw new Error('unauthorized_client'); await this.options.tokenStore.revoke(request.token, request.token_type_hint); return { status: 200, headers: noStore }; } catch { return { status: 400, headers: { ...noStore, 'content-type': 'application/json; charset=utf-8' }, body: errorBody('invalid_request') }; } }
  private authorizeCapability(requestId: string, capability: string | undefined): Pending | undefined { const value = this.pending.get(requestId); if (!value || !capability) return undefined; const actual = Buffer.from(capabilityHash(capability)); const expected = Buffer.from(value.capabilityHash); return actual.length === expected.length && timingSafeEqual(actual, expected) ? value : undefined; }
  private expire(): void { for (const value of this.pending.values()) this.expireOne(value); }
  private expireOne(value: Pending): void { if ((value.state === 'pending' || value.state === 'approved') && value.expiresAt <= this.now().getTime()) { value.state = 'expired'; const requestId = [...this.pending.entries()].find(([, candidate]) => candidate === value)?.[0]; if (requestId) void this.observer?.invalidated(requestId, 'expired').catch(() => undefined); } }
  private waitingPage(requestId: string): string { const base = `/oauth/authorize`; return `<!doctype html><meta charset="utf-8"><title>Awaiting approval</title><p>Awaiting approval in the local App.</p><script>const id=${JSON.stringify(requestId)};let n=0;const p=async()=>{if(++n>300)return;const r=await fetch('${base}/status/'+id,{credentials:'same-origin',cache:'no-store'});if(!r.ok)return;const j=await r.json();if(j.status==='ready'||j.status==='denied')location.assign('${base}/continue/'+id);else if(j.status==='pending')setTimeout(p,1000)};setTimeout(p,1000)</script>`; }
  private tokenResponse(body: OAuthHttpResponse['body']): OAuthHttpResponse { return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', ...noStore, pragma: 'no-cache' }, body }; }
  private parseAuthorization(input: string | URLSearchParams | Record<string, unknown>): OAuthAuthorizationRequest { return (input instanceof URLSearchParams ? Object.fromEntries(input.entries()) : form(input)) as unknown as OAuthAuthorizationRequest; }
  private parseToken(input: string | URLSearchParams | Record<string, unknown>): OAuthTokenRequest { return (input instanceof URLSearchParams ? Object.fromEntries(input.entries()) : form(input)) as unknown as OAuthTokenRequest; }
  private parseRevoke(input: string | URLSearchParams | Record<string, unknown>): OAuthRevokeRequest { return (input instanceof URLSearchParams ? Object.fromEntries(input.entries()) : form(input)) as unknown as OAuthRevokeRequest; }
}
export function oauthCapabilityFromCookie(header: string | undefined, requestId: string): string | undefined { return findCookie(header, requestId); }
export function parseOAuthForm(value: string): Readonly<Record<string, string>> { return Object.freeze(Object.fromEntries(new URLSearchParams(value).entries())); }

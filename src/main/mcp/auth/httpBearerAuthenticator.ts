import { randomUUID } from 'node:crypto';
import type { AgentPrincipal, AgentScope, TrustProfile } from '../../../shared/agent/v1/gatewayContracts';
import { mcpProtocolVersions } from '../../../shared/mcp/v1/versions';
import type { McpSessionAdmission, LoopbackSessionAuthenticator } from '../transport/loopbackHttp';
import type { DirectHttpsAuthority } from '../../../shared/mcp/v1/oauthContracts';
import { OAuthTokenStore } from './oauthTokenStore';
import type { OAuthTokenClaims } from '../../../shared/mcp/v1/oauthContracts';
import { httpPrincipalFromOAuthClaims } from '../../agent/clientAuthenticator';

export interface HttpOAuthClientPort {
  getHttpClient(clientId: string): Promise<{ readonly clientId: string; readonly subjectId: string; readonly displayName: string; readonly scopes: readonly AgentScope[]; readonly trust: TrustProfile } | null> | { readonly clientId: string; readonly subjectId: string; readonly displayName: string; readonly scopes: readonly AgentScope[]; readonly trust: TrustProfile } | null;
}

interface SessionBinding { readonly tokenId: string; readonly clientId: string; readonly protocolVersion: string; readonly expiresAt: string; }
function bearer(headers: Readonly<Record<string, string | undefined>>): string | null { const value = headers.authorization ?? headers.Authorization; if (!value || !/^Bearer [A-Za-z0-9_-]{32,2048}$/.test(value)) return null; return value.slice(7); }
function canonicalFuture(value: string, now: Date): boolean { const parsed = Date.parse(value); return Number.isFinite(parsed) && new Date(parsed).toISOString() === value && parsed > now.getTime(); }
function scopeAllowed(token: readonly AgentScope[], current: readonly AgentScope[]): boolean { return token.every((scope) => current.includes(scope)); }

export interface HttpBearerAuthenticatorOptions {
  readonly tokenStore: OAuthTokenStore;
  readonly clients: HttpOAuthClientPort;
  readonly authority: DirectHttpsAuthority;
  readonly appInstanceId: string;
  readonly now?: () => Date;
  readonly randomUUID?: () => string;
}

export class HttpBearerAuthenticator implements LoopbackSessionAuthenticator {
  private readonly sessions = new Map<string, SessionBinding>();
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private authority: DirectHttpsAuthority;
  private appInstanceId: string;
  constructor(private readonly options: HttpBearerAuthenticatorOptions) { this.now = options.now ?? (() => new Date()); this.uuid = options.randomUUID ?? randomUUID; this.authority = options.authority; this.appInstanceId = options.appInstanceId; }
  setAuthority(authority: DirectHttpsAuthority, appInstanceId = this.appInstanceId): void { this.authority = authority; this.appInstanceId = appInstanceId; void this.invalidateAll(); }
  async admitInitialize(request: { readonly headers: Readonly<Record<string, string | undefined>>; readonly protocolVersion: string }): Promise<McpSessionAdmission | null> {
    if (!(mcpProtocolVersions as readonly string[]).includes(request.protocolVersion)) return null;
    const raw = bearer(request.headers); if (!raw) return null;
    try {
      const claims = this.options.tokenStore.validateAccessToken(raw, { resource: this.authority.resource, issuer: this.authority.issuer, appInstanceId: this.appInstanceId });
      const client = await this.options.clients.getHttpClient(claims.clientId); if (!client || !scopeAllowed(claims.scopes, client.scopes)) return null;
      const sessionId = this.uuid(); const expiresAt = claims.expiresAt; this.sessions.set(sessionId, Object.freeze({ tokenId: claims.tokenId, clientId: claims.clientId, protocolVersion: request.protocolVersion, expiresAt })); return Object.freeze({ sessionId, protocolVersion: request.protocolVersion, expiresAt });
    } catch { return null; }
  }
  async validateSession(sessionId: string, protocolVersion: string, headers?: Readonly<Record<string, string | undefined>>): Promise<AgentPrincipal | null> {
    const binding = this.sessions.get(sessionId); if (!binding || binding.protocolVersion !== protocolVersion || !canonicalFuture(binding.expiresAt, this.now())) { this.sessions.delete(sessionId); return null; }
    const raw = headers ? bearer(headers) : null; if (!raw) { this.sessions.delete(sessionId); return null; }
    try {
      const claims = this.options.tokenStore.validateAccessToken(raw, { resource: this.authority.resource, issuer: this.authority.issuer, appInstanceId: this.appInstanceId, clientId: binding.clientId });
      if (claims.tokenId !== binding.tokenId) throw new Error('token_session_mismatch');
      const client = await this.options.clients.getHttpClient(claims.clientId); if (!client || !scopeAllowed(claims.scopes, client.scopes)) throw new Error('client_revoked');
      return httpPrincipalFromOAuthClaims(claims, client, sessionId, this.now().toISOString());
    } catch { this.sessions.delete(sessionId); return null; }
  }
  async invalidateAll(): Promise<void> { this.sessions.clear(); }
  sessionCount(): number { return this.sessions.size; }
  claimsForSession(sessionId: string): OAuthTokenClaims | null { const binding = this.sessions.get(sessionId); if (!binding) return null; try { return this.options.tokenStore.validateAccessTokenId(binding.tokenId, { resource: this.authority.resource, issuer: this.authority.issuer, appInstanceId: this.appInstanceId, clientId: binding.clientId }); } catch { return null; } }
}

export function createHttpBearerAuthenticator(options: HttpBearerAuthenticatorOptions): HttpBearerAuthenticator { return new HttpBearerAuthenticator(options); }

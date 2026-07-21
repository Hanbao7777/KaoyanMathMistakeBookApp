import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AgentScope } from '../../../shared/agent/v1/gatewayContracts';
import type { OAuthAuthorizationCodeRequest, OAuthRefreshTokenRequest, OAuthTokenClaims, OAuthTokenResponse } from '../../../shared/mcp/v1/oauthContracts';

export interface OAuthTokenStoreOptions {
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Buffer;
  readonly randomUUID?: () => string;
  readonly accessTokenTtlMs?: number;
  readonly refreshTokenTtlMs?: number;
  readonly codeTtlMs?: number;
  readonly persist?: (snapshot: OAuthTokenStoreSnapshot) => Promise<void> | void;
  readonly load?: () => Promise<OAuthTokenStoreSnapshot | undefined> | OAuthTokenStoreSnapshot | undefined;
}

export interface OAuthAuthorizationCodeInput {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly issuer: string;
  readonly scopes: readonly AgentScope[];
  readonly codeChallenge: string;
  readonly nonce?: string;
  readonly appInstanceId: string;
  readonly refreshTokensAllowed: boolean;
}

export interface OAuthAuthorizationCodeResult {
  readonly code: string;
  readonly expiresAt: string;
}

export interface OAuthIssuedTokens {
  readonly response: OAuthTokenResponse;
  readonly claims: OAuthTokenClaims;
}

export interface OAuthTokenStoreSnapshot {
  readonly version: 1;
  readonly codes: readonly OAuthStoredCode[];
  readonly accessTokens: readonly OAuthStoredAccessToken[];
  readonly refreshFamilies: readonly OAuthStoredRefreshFamily[];
  readonly refreshTokens: readonly OAuthStoredRefreshToken[];
  readonly revokedTokenIds: readonly string[];
}

interface OAuthStoredCode {
  readonly codeHash: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly issuer: string;
  readonly scopes: readonly AgentScope[];
  readonly codeChallenge: string;
  readonly nonceHash?: string;
  readonly appInstanceId: string;
  readonly expiresAt: string;
  readonly used: boolean;
  readonly refreshTokensAllowed: boolean;
}
interface OAuthStoredAccessToken {
  readonly tokenHash: string;
  readonly tokenId: string;
  readonly clientId: string;
  readonly scopes: readonly AgentScope[];
  readonly resource: string;
  readonly issuer: string;
  readonly appInstanceId: string;
  readonly expiresAt: string;
  readonly familyId?: string;
  readonly revoked: boolean;
}
interface OAuthStoredRefreshFamily {
  readonly familyId: string;
  readonly clientId: string;
  readonly resource: string;
  readonly issuer: string;
  readonly appInstanceId: string;
  readonly expiresAt: string;
  readonly scopes: readonly AgentScope[];
  readonly revoked: boolean;
  readonly currentTokenHash: string;
}
interface OAuthStoredRefreshToken {
  readonly tokenHash: string;
  readonly familyId: string;
  readonly used: boolean;
}

function canonicalTimestamp(value: Date): string { return value.toISOString(); }
function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function tokenHash(value: string): string { return `sha256-v1:${digest(value)}`; }
function nonceHash(value: string): string { return tokenHash(value); }
function compare(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8'); const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
function pkce(verifier: string): string { return createHash('sha256').update(verifier, 'utf8').digest('base64url'); }
function subset(requested: readonly AgentScope[], granted: readonly AgentScope[]): boolean { return requested.every((scope) => granted.includes(scope)); }
function scopeText(scopes: readonly AgentScope[]): string { return [...scopes].sort().join(' '); }
function cloneSnapshot(snapshot: OAuthTokenStoreSnapshot): OAuthTokenStoreSnapshot { return Object.freeze({ version: 1, codes: Object.freeze(snapshot.codes.map((value) => Object.freeze({ ...value, scopes: Object.freeze([...value.scopes]) }))), accessTokens: Object.freeze(snapshot.accessTokens.map((value) => Object.freeze({ ...value, scopes: Object.freeze([...value.scopes]) }))), refreshFamilies: Object.freeze(snapshot.refreshFamilies.map((value) => Object.freeze({ ...value, scopes: Object.freeze([...value.scopes]) }))), refreshTokens: Object.freeze(snapshot.refreshTokens.map((value) => Object.freeze({ ...value }))), revokedTokenIds: Object.freeze([...snapshot.revokedTokenIds]) }); }

export class OAuthTokenStore {
  private readonly now: () => Date;
  private readonly bytes: (size: number) => Buffer;
  private readonly uuid: () => string;
  private readonly accessTokenTtlMs: number;
  private readonly refreshTokenTtlMs: number;
  private readonly codeTtlMs: number;
  private readonly persist?: OAuthTokenStoreOptions['persist'];
  private readonly codes = new Map<string, OAuthStoredCode>();
  private readonly accessTokens = new Map<string, OAuthStoredAccessToken>();
  private readonly accessTokenIds = new Map<string, string>();
  private readonly refreshFamilies = new Map<string, OAuthStoredRefreshFamily>();
  private readonly refreshTokens = new Map<string, OAuthStoredRefreshToken>();
  private readonly revokedTokenIds = new Set<string>();

  constructor(options: OAuthTokenStoreOptions = {}) {
    this.now = options.now ?? (() => new Date()); this.bytes = options.randomBytes ?? randomBytes; this.uuid = options.randomUUID ?? randomUUID;
    this.accessTokenTtlMs = options.accessTokenTtlMs ?? 5 * 60_000; this.refreshTokenTtlMs = options.refreshTokenTtlMs ?? 30 * 24 * 60 * 60_000; this.codeTtlMs = options.codeTtlMs ?? 60_000; this.persist = options.persist;
    if (![this.accessTokenTtlMs, this.refreshTokenTtlMs, this.codeTtlMs].every((value) => Number.isSafeInteger(value) && value > 0)) throw new TypeError('Invalid OAuth token TTL');
    const loaded = options.load?.();
    if (loaded && !(loaded instanceof Promise)) this.restore(loaded);
    else if (loaded instanceof Promise) void loaded.then((snapshot) => { if (snapshot) this.restore(snapshot); });
  }

  async createAuthorizationCode(input: OAuthAuthorizationCodeInput): Promise<OAuthAuthorizationCodeResult> {
    const now = this.now(); const code = this.bytes(32).toString('base64url'); const expiresAt = canonicalTimestamp(new Date(now.getTime() + this.codeTtlMs));
    const record: OAuthStoredCode = Object.freeze({ codeHash: tokenHash(code), clientId: input.clientId, redirectUri: input.redirectUri, resource: input.resource, issuer: input.issuer, scopes: Object.freeze([...input.scopes]), codeChallenge: input.codeChallenge, ...(input.nonce ? { nonceHash: nonceHash(input.nonce) } : {}), appInstanceId: input.appInstanceId, expiresAt, used: false, refreshTokensAllowed: input.refreshTokensAllowed });
    this.codes.set(record.codeHash, record); await this.flush(); return Object.freeze({ code, expiresAt });
  }

  async redeemAuthorizationCode(input: OAuthAuthorizationCodeRequest): Promise<OAuthIssuedTokens> {
    const hash = tokenHash(input.code); const record = this.codes.get(hash); const now = this.now();
    if (!record || record.used || Date.parse(record.expiresAt) <= now.getTime() || record.clientId !== input.client_id || record.redirectUri !== input.redirect_uri || record.resource !== input.resource || !compare(record.codeChallenge, pkce(input.code_verifier))) throw new Error('invalid_grant');
    this.codes.set(hash, Object.freeze({ ...record, used: true }));
    const result = await this.issue(record.clientId, record.scopes, record.resource, record.issuer, record.appInstanceId, record.refreshTokensAllowed);
    await this.flush(); return result;
  }

  async refresh(input: OAuthRefreshTokenRequest, currentClient: { readonly scopes: readonly AgentScope[]; readonly appInstanceId: string; readonly issuer: string }): Promise<OAuthIssuedTokens> {
    const hash = tokenHash(input.refresh_token); const stored = this.refreshTokens.get(hash); const family = stored ? this.refreshFamilies.get(stored.familyId) : undefined; const now = this.now();
    if (!stored || !family || family.revoked || stored.used || family.clientId !== input.client_id || family.resource !== input.resource || family.issuer !== currentClient.issuer || Date.parse(family.expiresAt) <= now.getTime()) {
      if (family && !family.revoked && stored?.used) await this.revokeFamily(family.familyId);
      throw new Error('invalid_grant');
    }
    const requestedScopes = input.scope ? input.scope.split(' ') as AgentScope[] : family.scopes;
    if (!subset(requestedScopes, family.scopes) || !subset(requestedScopes, currentClient.scopes)) throw new Error('invalid_scope');
    this.refreshTokens.set(hash, Object.freeze({ ...stored, used: true }));
    const result = await this.issue(family.clientId, Object.freeze([...requestedScopes]), family.resource, family.issuer, currentClient.appInstanceId, true, family.familyId);
    await this.flush(); return result;
  }

  validateAccessToken(rawToken: string, expected: { readonly resource: string; readonly issuer: string; readonly appInstanceId: string; readonly clientId?: string }): OAuthTokenClaims {
    const record = this.accessTokens.get(tokenHash(rawToken)); return this.validateAccessTokenRecord(record, expected);
  }

  validateAccessTokenId(tokenId: string, expected: { readonly resource: string; readonly issuer: string; readonly appInstanceId: string; readonly clientId?: string }): OAuthTokenClaims {
    const hash = this.accessTokenIds.get(tokenId); return this.validateAccessTokenRecord(hash ? this.accessTokens.get(hash) : undefined, expected);
  }

  async revoke(rawToken: string, hint?: 'access_token' | 'refresh_token'): Promise<void> {
    const hash = tokenHash(rawToken); const access = this.accessTokens.get(hash); const refresh = this.refreshTokens.get(hash);
    if (hint !== 'refresh_token' && access) { this.accessTokens.set(hash, Object.freeze({ ...access, revoked: true })); this.revokedTokenIds.add(access.tokenId); }
    if (hint !== 'access_token' && refresh) await this.revokeFamily(refresh.familyId);
    await this.flush();
  }

  async revokeFamily(familyId: string): Promise<void> {
    const family = this.refreshFamilies.get(familyId); if (!family) return;
    this.refreshFamilies.set(familyId, Object.freeze({ ...family, revoked: true }));
    for (const [hash, access] of this.accessTokens) if (access.familyId === familyId) { this.accessTokens.set(hash, Object.freeze({ ...access, revoked: true })); this.revokedTokenIds.add(access.tokenId); }
  }

  async revokeClient(clientId: string): Promise<void> {
    for (const [hash, access] of this.accessTokens) if (access.clientId === clientId) { this.accessTokens.set(hash, Object.freeze({ ...access, revoked: true })); this.revokedTokenIds.add(access.tokenId); }
    for (const family of this.refreshFamilies.values()) if (family.clientId === clientId) await this.revokeFamily(family.familyId);
    await this.flush();
  }

  snapshot(): OAuthTokenStoreSnapshot {
    return cloneSnapshot({ version: 1, codes: [...this.codes.values()], accessTokens: [...this.accessTokens.values()], refreshFamilies: [...this.refreshFamilies.values()], refreshTokens: [...this.refreshTokens.values()], revokedTokenIds: [...this.revokedTokenIds] });
  }

  private async issue(clientId: string, scopes: readonly AgentScope[], resource: string, issuer: string, appInstanceId: string, refreshAllowed: boolean, familyId?: string): Promise<OAuthIssuedTokens> {
    const now = this.now(); const accessToken = this.bytes(32).toString('base64url'); const tokenId = this.uuid(); const expiresAt = canonicalTimestamp(new Date(now.getTime() + this.accessTokenTtlMs));
    let effectiveFamilyId = familyId; let refreshToken: string | undefined;
    if (refreshAllowed) {
      effectiveFamilyId ??= this.uuid(); refreshToken = this.bytes(48).toString('base64url');
      const refreshHash = tokenHash(refreshToken); const previous = this.refreshFamilies.get(effectiveFamilyId);
      const family: OAuthStoredRefreshFamily = Object.freeze({ familyId: effectiveFamilyId, clientId, resource, issuer, appInstanceId, expiresAt: canonicalTimestamp(new Date(now.getTime() + this.refreshTokenTtlMs)), scopes: Object.freeze([...scopes]), revoked: false, currentTokenHash: refreshHash });
      this.refreshFamilies.set(effectiveFamilyId, family); this.refreshTokens.set(refreshHash, Object.freeze({ tokenHash: refreshHash, familyId: effectiveFamilyId, used: false }));
      if (previous && previous.currentTokenHash !== refreshHash) this.refreshTokens.set(previous.currentTokenHash, Object.freeze({ tokenHash: previous.currentTokenHash, familyId: effectiveFamilyId, used: true }));
    }
    const access: OAuthStoredAccessToken = Object.freeze({ tokenHash: tokenHash(accessToken), tokenId, clientId, scopes: Object.freeze([...scopes]), resource, issuer, appInstanceId, expiresAt, ...(effectiveFamilyId ? { familyId: effectiveFamilyId } : {}), revoked: false });
    this.accessTokens.set(access.tokenHash, access); this.accessTokenIds.set(tokenId, access.tokenHash);
    return Object.freeze({ response: Object.freeze({ token_type: 'Bearer', access_token: accessToken, expires_in: Math.max(1, Math.floor(this.accessTokenTtlMs / 1000)), scope: scopeText(scopes), ...(refreshToken ? { refresh_token: refreshToken } : {}) }), claims: Object.freeze({ tokenId, clientId, scopes: Object.freeze([...scopes]), resource, issuer, appInstanceId, expiresAt, ...(effectiveFamilyId ? { familyId: effectiveFamilyId } : {}) }) });
  }

  private validateAccessTokenRecord(record: OAuthStoredAccessToken | undefined, expected: { readonly resource: string; readonly issuer: string; readonly appInstanceId: string; readonly clientId?: string }): OAuthTokenClaims {
    if (!record || record.revoked || this.revokedTokenIds.has(record.tokenId) || record.resource !== expected.resource || record.issuer !== expected.issuer || record.appInstanceId !== expected.appInstanceId || (expected.clientId !== undefined && record.clientId !== expected.clientId) || Date.parse(record.expiresAt) <= this.now().getTime()) throw new Error('invalid_token');
    return Object.freeze({ tokenId: record.tokenId, clientId: record.clientId, scopes: Object.freeze([...record.scopes]), resource: record.resource, issuer: record.issuer, appInstanceId: record.appInstanceId, expiresAt: record.expiresAt, ...(record.familyId ? { familyId: record.familyId } : {}) });
  }

  private restore(snapshot: OAuthTokenStoreSnapshot): void {
    if (!snapshot || snapshot.version !== 1) throw new TypeError('Invalid OAuth token snapshot');
    this.codes.clear(); this.accessTokens.clear(); this.accessTokenIds.clear(); this.refreshFamilies.clear(); this.refreshTokens.clear(); this.revokedTokenIds.clear();
    for (const value of snapshot.codes) this.codes.set(value.codeHash, Object.freeze({ ...value, scopes: Object.freeze([...value.scopes]) }));
    for (const value of snapshot.accessTokens) { this.accessTokens.set(value.tokenHash, Object.freeze({ ...value, scopes: Object.freeze([...value.scopes]) })); this.accessTokenIds.set(value.tokenId, value.tokenHash); }
    for (const value of snapshot.refreshFamilies) this.refreshFamilies.set(value.familyId, Object.freeze({ ...value, scopes: Object.freeze([...value.scopes]) }));
    for (const value of snapshot.refreshTokens) this.refreshTokens.set(value.tokenHash, Object.freeze({ ...value }));
    for (const value of snapshot.revokedTokenIds) this.revokedTokenIds.add(value);
  }
  private async flush(): Promise<void> { await this.persist?.(this.snapshot()); }
}

export function pkceS256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('base64url'); }

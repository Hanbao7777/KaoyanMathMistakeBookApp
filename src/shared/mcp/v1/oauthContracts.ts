import type { AgentScope, TrustProfile } from '../../agent/v1/gatewayContracts';

export const directHttpsDefaultPort = 39458 as const;
export const directHttpsResourcePath = '/mcp' as const;
export const oauthAuthorizationEndpointPath = '/authorize' as const;
export const oauthTokenEndpointPath = '/token' as const;
export const oauthRevocationEndpointPath = '/revoke' as const;
export const oauthServerMetadataPath = '/.well-known/oauth-authorization-server' as const;
export const oauthProtectedResourcePath = '/.well-known/oauth-protected-resource' as const;
export const oauthProtectedResourceMcpPath = '/.well-known/oauth-protected-resource/mcp' as const;
export const oauthScopeValues = Object.freeze([
  'system.read', 'questions.read', 'questions.write', 'questions.archive',
  'reviews.read', 'reviews.submit', 'knowledge.read', 'knowledge.write',
  'textbooks.read', 'analytics.read', 'study.read', 'study.write',
  'imports.read', 'imports.write', 'tasks.read', 'tasks.write', 'tasks.execute',
  'focus.read', 'focus.control', 'files.images.read', 'operations.batch',
  'backups.read', 'backups.create', 'backups.delete', 'exports.create', 'exports.read',
  'database.restore', 'database.replace', 'database.clear', 'imports.delete',
  'data_root.migrate'
] as const);
export type OAuthScope = (typeof oauthScopeValues)[number] | AgentScope;

export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly bearer_methods_supported: readonly ['header'];
  readonly scopes_supported: readonly string[];
  readonly resource_signing_alg_values_supported?: readonly string[];
}

export interface AuthorizationServerMetadata {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly revocation_endpoint: string;
  readonly response_types_supported: readonly ['code'];
  readonly grant_types_supported: readonly ['authorization_code', 'refresh_token'];
  readonly code_challenge_methods_supported: readonly ['S256'];
  readonly token_endpoint_auth_methods_supported: readonly ['none'];
  readonly scopes_supported: readonly string[];
}

export interface OAuthAuthorizationRequest {
  readonly response_type: 'code';
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly scope: string;
  readonly state: string;
  readonly code_challenge: string;
  readonly code_challenge_method: 'S256';
  readonly resource: string;
  readonly nonce?: string;
}

export interface OAuthAuthorizationCodeRequest {
  readonly grant_type: 'authorization_code';
  readonly code: string;
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly code_verifier: string;
  readonly resource: string;
}

export interface OAuthRefreshTokenRequest {
  readonly grant_type: 'refresh_token';
  readonly refresh_token: string;
  readonly client_id: string;
  readonly resource: string;
  readonly scope?: string;
}

export type OAuthTokenRequest = OAuthAuthorizationCodeRequest | OAuthRefreshTokenRequest;

export interface OAuthRevokeRequest {
  readonly token: string;
  readonly token_type_hint?: 'access_token' | 'refresh_token';
  readonly client_id: string;
}

export interface HttpOAuthClientRegistration {
  readonly clientId: string;
  readonly product: 'codex' | 'claude_code';
  readonly versionEvidence: string;
  readonly redirectMode: 'codex-loopback' | 'claude-exact';
  readonly exactRedirectUri?: string;
  readonly resource: string;
  readonly issuer: string;
  readonly allowedScopes: readonly AgentScope[];
  readonly trust: TrustProfile;
  readonly refreshTokensAllowed: boolean;
  readonly metadataHash?: string;
}

export interface DirectHttpsAuthority {
  readonly port: number;
  readonly authority: string;
  readonly resource: string;
  readonly issuer: string;
}

export interface OAuthTokenResponse {
  readonly token_type: 'Bearer';
  readonly access_token: string;
  readonly expires_in: number;
  readonly scope: string;
  readonly refresh_token?: string;
}

export interface OAuthTokenClaims {
  readonly tokenId: string;
  readonly clientId: string;
  readonly scopes: readonly AgentScope[];
  readonly resource: string;
  readonly issuer: string;
  readonly appInstanceId: string;
  readonly expiresAt: string;
  readonly familyId?: string;
}

export function directHttpsAuthority(port: number): DirectHttpsAuthority {
  assertPort(port, 'port');
  const authority = `https://127.0.0.1:${port}`;
  return Object.freeze({ port, authority, resource: `${authority}${directHttpsResourcePath}`, issuer: authority });
}

export function assertPort(value: unknown, field = 'port'): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65_535) throw new TypeError(`Invalid ${field}`);
}

function assertPlainObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`Invalid ${field}`);
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  const result = assertPlainObject(value, field);
  for (const key of Object.keys(result)) if (!keys.includes(key)) throw new TypeError(`Invalid ${field}.${key}`);
  return result;
}

function text(value: unknown, field: string, max = 512): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value !== value.normalize('NFC')) throw new TypeError(`Invalid ${field}`);
}

function url(value: unknown, field: string): asserts value is string {
  text(value, field, 2_048);
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new TypeError(`Invalid ${field}`); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new TypeError(`Invalid ${field}`);
}

function nonEmptyScopes(value: unknown, field: string): readonly string[] {
  text(value, field, 4_096);
  const scopes = value.split(' ');
  if (scopes.length === 0 || scopes.some((scope) => !/^[A-Za-z0-9._:-]{1,100}$/.test(scope)) || new Set(scopes).size !== scopes.length) throw new TypeError(`Invalid ${field}`);
  return Object.freeze([...scopes]);
}

function base64Url(value: unknown, field: string, min: number, max: number): asserts value is string {
  text(value, field, max);
  if (value.length < min || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1 || Buffer.from(value, 'base64url').toString('base64url') !== value) throw new TypeError(`Invalid ${field}`);
}

export function validateProtectedResourceMetadata(value: unknown): asserts value is ProtectedResourceMetadata {
  const result = exact(value, ['resource', 'authorization_servers', 'bearer_methods_supported', 'scopes_supported', 'resource_signing_alg_values_supported'], 'metadata');
  url(result.resource, 'metadata.resource');
  if (!Array.isArray(result.authorization_servers) || result.authorization_servers.length !== 1) throw new TypeError('Invalid metadata.authorization_servers');
  url(result.authorization_servers[0], 'metadata.authorization_servers[0]');
  if (JSON.stringify(result.bearer_methods_supported) !== '["header"]') throw new TypeError('Invalid metadata.bearer_methods_supported');
  if (!Array.isArray(result.scopes_supported) || result.scopes_supported.length !== new Set(result.scopes_supported).size || result.scopes_supported.some((scope) => typeof scope !== 'string')) throw new TypeError('Invalid metadata.scopes_supported');
  if (result.resource_signing_alg_values_supported !== undefined && !Array.isArray(result.resource_signing_alg_values_supported)) throw new TypeError('Invalid metadata.resource_signing_alg_values_supported');
}

export function validateAuthorizationServerMetadata(value: unknown): asserts value is AuthorizationServerMetadata {
  const result = exact(value, ['issuer', 'authorization_endpoint', 'token_endpoint', 'revocation_endpoint', 'response_types_supported', 'grant_types_supported', 'code_challenge_methods_supported', 'token_endpoint_auth_methods_supported', 'scopes_supported'], 'metadata');
  for (const key of ['issuer', 'authorization_endpoint', 'token_endpoint', 'revocation_endpoint']) url(result[key], `metadata.${key}`);
  if (JSON.stringify(result.response_types_supported) !== '["code"]' || JSON.stringify(result.grant_types_supported) !== '["authorization_code","refresh_token"]' || JSON.stringify(result.code_challenge_methods_supported) !== '["S256"]' || JSON.stringify(result.token_endpoint_auth_methods_supported) !== '["none"]') throw new TypeError('Invalid authorization-server metadata capabilities');
  if (!Array.isArray(result.scopes_supported) || result.scopes_supported.length !== new Set(result.scopes_supported).size) throw new TypeError('Invalid metadata.scopes_supported');
}

export function validateAuthorizationRequest(value: unknown): asserts value is OAuthAuthorizationRequest {
  const result = exact(value, ['response_type', 'client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'resource', 'nonce'], 'authorization');
  for (const key of ['client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'resource']) if (!Object.hasOwn(result, key)) throw new TypeError(`Invalid authorization.${key}`);
  if (result.response_type !== 'code' || result.code_challenge_method !== 'S256') throw new TypeError('Invalid authorization response or PKCE method');
  text(result.client_id, 'authorization.client_id', 200); url(result.redirect_uri, 'authorization.redirect_uri'); nonEmptyScopes(result.scope, 'authorization.scope'); text(result.state, 'authorization.state', 512); base64Url(result.code_challenge, 'authorization.code_challenge', 43, 128); url(result.resource, 'authorization.resource');
  if (result.nonce !== undefined) base64Url(result.nonce, 'authorization.nonce', 16, 256);
}

export function validateTokenRequest(value: unknown): asserts value is OAuthTokenRequest {
  const result = assertPlainObject(value, 'token');
  if (result.grant_type === 'authorization_code') {
    const code = exact(value, ['grant_type', 'code', 'client_id', 'redirect_uri', 'code_verifier', 'resource'], 'token');
    for (const key of ['code', 'client_id', 'redirect_uri', 'code_verifier', 'resource']) if (!Object.hasOwn(code, key)) throw new TypeError(`Invalid token.${key}`);
    text(code.client_id, 'token.client_id', 200); text(code.code, 'token.code', 512); url(code.redirect_uri, 'token.redirect_uri'); base64Url(code.code_verifier, 'token.code_verifier', 43, 256); url(code.resource, 'token.resource');
    return;
  }
  if (result.grant_type === 'refresh_token') {
    const refresh = exact(value, ['grant_type', 'refresh_token', 'client_id', 'resource', 'scope'], 'token');
    for (const key of ['refresh_token', 'client_id', 'resource']) if (!Object.hasOwn(refresh, key)) throw new TypeError(`Invalid token.${key}`);
    text(refresh.refresh_token, 'token.refresh_token', 2_048); text(refresh.client_id, 'token.client_id', 200); url(refresh.resource, 'token.resource');
    if (refresh.scope !== undefined) nonEmptyScopes(refresh.scope, 'token.scope');
    return;
  }
  throw new TypeError('Invalid token.grant_type');
}

export function validateRevokeRequest(value: unknown): asserts value is OAuthRevokeRequest {
  const result = exact(value, ['token', 'token_type_hint', 'client_id'], 'revoke');
  for (const key of ['token', 'client_id']) if (!Object.hasOwn(result, key)) throw new TypeError(`Invalid revoke.${key}`);
  text(result.token, 'revoke.token', 2_048); text(result.client_id, 'revoke.client_id', 200);
  if (result.token_type_hint !== undefined && result.token_type_hint !== 'access_token' && result.token_type_hint !== 'refresh_token') throw new TypeError('Invalid revoke.token_type_hint');
}

export function validateHttpOAuthClientRegistration(value: unknown): asserts value is HttpOAuthClientRegistration {
  const result = exact(value, ['clientId', 'product', 'versionEvidence', 'redirectMode', 'exactRedirectUri', 'resource', 'issuer', 'allowedScopes', 'trust', 'refreshTokensAllowed', 'metadataHash'], 'registration');
  for (const key of ['clientId', 'product', 'versionEvidence', 'redirectMode', 'resource', 'issuer', 'allowedScopes', 'trust', 'refreshTokensAllowed']) if (!Object.hasOwn(result, key)) throw new TypeError(`Invalid registration.${key}`);
  text(result.clientId, 'registration.clientId', 200); text(result.versionEvidence, 'registration.versionEvidence', 200);
  if (result.product !== 'codex' && result.product !== 'claude_code') throw new TypeError('Invalid registration.product');
  if (result.redirectMode !== 'codex-loopback' && result.redirectMode !== 'claude-exact') throw new TypeError('Invalid registration.redirectMode');
  url(result.resource, 'registration.resource'); url(result.issuer, 'registration.issuer');
  if (!Array.isArray(result.allowedScopes) || result.allowedScopes.length === 0 || new Set(result.allowedScopes).size !== result.allowedScopes.length || result.allowedScopes.some((scope) => typeof scope !== 'string')) throw new TypeError('Invalid registration.allowedScopes');
  if (!['observer', 'collaborator', 'autonomous', 'full_control'].includes(String(result.trust)) || typeof result.refreshTokensAllowed !== 'boolean') throw new TypeError('Invalid registration access');
  if (result.redirectMode === 'claude-exact') { if (typeof result.exactRedirectUri !== 'string') throw new TypeError('Invalid registration.exactRedirectUri'); validateClaudeRedirectUri(result.exactRedirectUri); }
  if (result.metadataHash !== undefined && !/^sha256-v1:[0-9a-f]{64}$/.test(String(result.metadataHash))) throw new TypeError('Invalid registration.metadataHash');
}

export function validateCodexRedirectUri(value: unknown): asserts value is string {
  url(value, 'redirect_uri');
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port === '' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname.split('/').length !== 3 || parsed.pathname.split('/')[1] !== 'callback' || !/^[A-Za-z0-9_-]+$/.test(parsed.pathname.split('/')[2]) || decodeURIComponent(parsed.pathname) !== parsed.pathname) throw new TypeError('Invalid Codex loopback redirect URI');
  assertPort(Number(parsed.port), 'redirect_uri.port');
}

export function validateClaudeRedirectUri(value: unknown): asserts value is string {
  url(value, 'redirect_uri');
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' || parsed.hostname !== 'localhost' || parsed.port === '' || parsed.pathname !== '/callback' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new TypeError('Invalid Claude callback URI');
  assertPort(Number(parsed.port), 'redirect_uri.port');
}

export function validateRegisteredRedirectUri(registration: HttpOAuthClientRegistration, redirectUri: string): void {
  if (registration.redirectMode === 'codex-loopback') validateCodexRedirectUri(redirectUri);
  else if (redirectUri !== registration.exactRedirectUri) throw new TypeError('Redirect URI does not match the registered callback');
}

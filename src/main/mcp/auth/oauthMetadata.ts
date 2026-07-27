import {
  directHttpsAuthority,
  oauthAuthorizationEndpointPath,
  oauthProtectedResourceMcpPath,
  oauthProtectedResourcePath,
  oauthRevocationEndpointPath,
  oauthScopeValues,
  oauthServerMetadataPath,
  oauthTokenEndpointPath,
  type AuthorizationServerMetadata,
  type DirectHttpsAuthority,
  type ProtectedResourceMetadata,
  validateAuthorizationServerMetadata,
  validateProtectedResourceMetadata
} from '../../../shared/mcp/v1/oauthContracts';

export interface OAuthMetadataOptions {
  readonly authority: DirectHttpsAuthority | number;
  readonly scopes?: readonly string[];
}

export function createOAuthMetadata(options: OAuthMetadataOptions): Readonly<{
  readonly authority: DirectHttpsAuthority;
  readonly protectedResource: ProtectedResourceMetadata;
  readonly authorizationServer: AuthorizationServerMetadata;
}> {
  const authority = typeof options.authority === 'number' ? directHttpsAuthority(options.authority) : options.authority;
  const scopes = Object.freeze([...(options.scopes ?? oauthScopeValues)]);
  const protectedResource: ProtectedResourceMetadata = Object.freeze({
    resource: authority.resource,
    authorization_servers: Object.freeze([authority.issuer]),
    bearer_methods_supported: Object.freeze(['header'] as const),
    scopes_supported: scopes
  });
  const authorizationServer: AuthorizationServerMetadata = Object.freeze({
    issuer: authority.issuer,
    authorization_endpoint: `${authority.authority}${oauthAuthorizationEndpointPath}`,
    token_endpoint: `${authority.authority}${oauthTokenEndpointPath}`,
    revocation_endpoint: `${authority.authority}${oauthRevocationEndpointPath}`,
    response_types_supported: Object.freeze(['code'] as const),
    grant_types_supported: Object.freeze(['authorization_code', 'refresh_token'] as const),
    code_challenge_methods_supported: Object.freeze(['S256'] as const),
    token_endpoint_auth_methods_supported: Object.freeze(['none'] as const),
    scopes_supported: scopes
  });
  validateProtectedResourceMetadata(protectedResource);
  validateAuthorizationServerMetadata(authorizationServer);
  return Object.freeze({ authority, protectedResource, authorizationServer });
}

export function protectedResourceMetadataPaths(): readonly string[] {
  return Object.freeze([oauthProtectedResourcePath, oauthProtectedResourceMcpPath]);
}

export function metadataForPath(pathname: string, metadata: ReturnType<typeof createOAuthMetadata>): ProtectedResourceMetadata | AuthorizationServerMetadata | null {
  if (pathname === oauthServerMetadataPath) return metadata.authorizationServer;
  if (pathname === oauthProtectedResourcePath || pathname === oauthProtectedResourceMcpPath) return metadata.protectedResource;
  return null;
}

export function bearerChallenge(metadata: ReturnType<typeof createOAuthMetadata>): string {
  return `Bearer resource_metadata="${metadata.authority.authority}${oauthProtectedResourceMcpPath}"`;
}

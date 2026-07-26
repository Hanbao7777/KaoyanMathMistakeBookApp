import { createHash } from 'node:crypto';
import type {
  AgentPrincipal,
  AgentPrincipalClaims,
  AgentScope,
  ClientAuthenticator,
  RawClientCredentials
} from '../../shared/agent/v1/gatewayContracts';
import { agentApiVersion } from '../../shared/agent/versions';
import { AgentError } from '../../shared/agent/errors';
import type { ClientRegistry } from './clientRegistry';
import type { RendererIdentityAdapter } from './rendererAdapter';
import type { OAuthTokenClaims } from '../../shared/mcp/v1/oauthContracts';

const issuedPrincipals = new WeakSet<object>();
const durableJobPrincipals = new WeakSet<object>();

function issuePrincipal(claims: AgentPrincipalClaims): AgentPrincipal {
  const principal = Object.freeze({ ...claims, scopes: Object.freeze([...claims.scopes]) }) as AgentPrincipal;
  issuedPrincipals.add(principal);
  return principal;
}

export function createDurableJobPrincipal(claims: AgentPrincipalClaims): AgentPrincipal {
  if (claims.renderer || !claims.sessionId) throw new AgentError('POLICY_DENIED');
  const principal = issuePrincipal(claims);
  durableJobPrincipals.add(principal);
  return principal;
}

export function isDurableJobPrincipal(principal: AgentPrincipal): boolean {
  return durableJobPrincipals.has(principal as object);
}

export function assertIssuedAgentPrincipal(principal: AgentPrincipal): void {
  if (!principal || typeof principal !== 'object' || !issuedPrincipals.has(principal as object) || !Object.isFrozen(principal)) {
    throw new AgentError('POLICY_DENIED');
  }
}

/** Converts already-validated HTTP OAuth claims into the only Gateway identity shape. */
export function httpPrincipalFromOAuthClaims(claims: OAuthTokenClaims, client: { readonly subjectId: string; readonly displayName: string; readonly trust: import('../../shared/agent/v1/gatewayContracts').TrustProfile }, sessionId: string, authenticatedAt: string): AgentPrincipal {
  if (!claims.clientId || !sessionId || !claims.tokenId) throw new AgentError('POLICY_DENIED');
  return issuePrincipal({
    apiVersion: agentApiVersion,
    kind: 'agent-principal',
    clientId: claims.clientId,
    subjectId: client.subjectId,
    displayName: client.displayName,
    scopes: claims.scopes,
    trust: client.trust,
    credentialBinding: fingerprintCredential(claims.tokenId),
    sessionId,
    authenticatedAt,
    renderer: false
  });
}

/** Authenticates live registry bindings before issuing an opaque principal. */
export function createRegistryPrincipalAuthenticator(registry: ClientRegistry): (
  credentialFingerprint: string,
  sessionFingerprint: string
) => Promise<AgentPrincipal> {
  return async (credentialFingerprint, sessionFingerprint) => issuePrincipal(
    await registry.authenticate(credentialFingerprint, sessionFingerprint)
  );
}

export interface VerifiedCredentialBindings {
  readonly credentialFingerprint: string;
  readonly sessionFingerprint: string;
}

export interface RawCredentialVerifier {
  verify(credentials: RawClientCredentials): Promise<VerifiedCredentialBindings> | VerifiedCredentialBindings;
}

export function fingerprintCredential(value: string): string {
  return `sha256-v1:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export const migratedRendererBusinessOperations = Object.freeze([
  'questions.create',
  'questions.update',
  'questions.delete',
  'questions.remove_image',
  'questions.mark_mastery',
  'questions.submit_review',
  'questions.undo_review',
  'questions.list',
  'questions.get',
  'questions.review_logs',
  'questions.review_buckets',
  'tasks.create',
  'tasks.update',
  'tasks.complete',
  'tasks.uncomplete',
  'tasks.delete',
  'tasks.list',
  'tasks.get',
  'focus.sessions.create',
  'focus.sessions.list',
  'knowledge.list_nodes',
  'knowledge.get_node',
  'knowledge.list_links',
  'textbooks.list',
  'textbooks.get',
  'analytics.get_weak_areas',
  'knowledge.link_question',
  'knowledge.unlink_question',
  'knowledge.bind_textbook',
  'study.get_today', 'study.get_week_summary', 'study.create_plan_draft', 'study.apply_plan_adjustment', 'study.record_manual_progress',
  'imports.create_draft', 'imports.add_draft_image', 'imports.validate_draft', 'imports.preview_draft', 'imports.apply_draft', 'imports.get', 'imports.cancel',
  'ticktick.lists.list', 'ticktick.lists.create', 'ticktick.lists.update', 'ticktick.habits.list', 'ticktick.habits.create', 'ticktick.habits.update',
  'ticktick.calendar.list_events', 'ticktick.bridges.get', 'ticktick.bridges.update',
  'backups.list', 'backups.create', 'exports.create', 'exports.get'
] as const);

const migratedRendererBusinessOperationSet = new Set<string>(migratedRendererBusinessOperations);

export function isMigratedRendererBusinessOperation(operation: string): boolean {
  return migratedRendererBusinessOperationSet.has(operation);
}

const fixedRendererScopes: readonly AgentScope[] = Object.freeze([
  'approvals.manage', 'approvals.read', 'audit.export', 'audit.read', 'changesets.manage', 'changesets.read',
  'clients.manage', 'clients.read', 'control.manage', 'policy.read', 'questions.archive', 'questions.read', 'questions.write',
  'r4.manage', 'r4.read',
  'reviews.read', 'reviews.submit', 'tasks.execute', 'tasks.read', 'tasks.write', 'focus.control', 'focus.read',
  'knowledge.read', 'knowledge.write', 'textbooks.read', 'analytics.read',
  'study.read', 'study.write',
  'imports.read', 'imports.write', 'operations.batch',
  'jobs.read', 'jobs.execute', 'jobs.cancel', 'jobs.admin',
  'sessions.manage', 'sessions.read', 'system.read',
  'ticktick.lists.read', 'ticktick.lists.write', 'ticktick.habits.read', 'ticktick.habits.write', 'ticktick.calendar.read', 'ticktick.bridges.read', 'ticktick.bridges.write'
  , 'backups.read', 'backups.create', 'exports.create', 'exports.read'
]);

export interface AuthenticationAdapters {
  readonly authenticator: ClientAuthenticator;
  readonly renderer: RendererIdentityAdapter;
}

export function createAuthenticationAdapters(
  registry: ClientRegistry,
  verifier: RawCredentialVerifier,
  now: () => string = () => new Date().toISOString()
): AuthenticationAdapters {
  const authenticator: ClientAuthenticator = Object.freeze({
    async authenticate(credentials: RawClientCredentials): Promise<AgentPrincipal> {
      let bindings: VerifiedCredentialBindings;
      try {
        bindings = await verifier.verify(credentials);
      } catch {
        throw new AgentError('CLIENT_REVOKED');
      }
      const claims = await registry.authenticate(bindings.credentialFingerprint, bindings.sessionFingerprint);
      return issuePrincipal(claims);
    }
  });
  const rendererPrincipal = issuePrincipal(Object.freeze({
    apiVersion: agentApiVersion,
    kind: 'agent-principal',
    clientId: 'local-renderer-management',
    subjectId: 'local-renderer-management',
    displayName: 'Local control center',
    scopes: fixedRendererScopes,
    trust: 'full_control',
    credentialBinding: 'local-first-party-management',
    authenticatedAt: now(),
    renderer: true
  }));
  return Object.freeze({
    authenticator,
    renderer: Object.freeze({ principal: () => rendererPrincipal })
  });
}

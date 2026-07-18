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

const issuedPrincipals = new WeakSet<object>();

function issuePrincipal(claims: AgentPrincipalClaims): AgentPrincipal {
  const principal = Object.freeze({ ...claims, scopes: Object.freeze([...claims.scopes]) }) as AgentPrincipal;
  issuedPrincipals.add(principal);
  return principal;
}

export function createDurableJobPrincipal(claims: AgentPrincipalClaims): AgentPrincipal {
  if (claims.renderer || !claims.sessionId) throw new AgentError('POLICY_DENIED');
  return issuePrincipal(claims);
}

export function assertIssuedAgentPrincipal(principal: AgentPrincipal): void {
  if (!principal || typeof principal !== 'object' || !issuedPrincipals.has(principal as object) || !Object.isFrozen(principal)) {
    throw new AgentError('POLICY_DENIED');
  }
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
  'focus.sessions.list'
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
  'jobs.read', 'jobs.execute', 'jobs.cancel', 'jobs.admin',
  'sessions.manage', 'sessions.read', 'system.read'
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

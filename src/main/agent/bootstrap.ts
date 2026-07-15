import type { ClientAuthenticator } from '../../shared/agent/v1/gatewayContracts';
import { operationCatalogIdentity } from '../../shared/agent/v1/operationCatalog';
import {
  createDatabaseCoordinatorControlCapability,
  type DatabaseCoordinator
} from '../persistence/databaseCoordinator';
import { createAuthenticationAdapters, type RawCredentialVerifier } from './clientAuthenticator';
import { ClientRegistry } from './clientRegistry';
import { PaginationService } from './pagination';
import { PolicyEngine } from './policyEngine';
import type { RendererIdentityAdapter } from './rendererAdapter';

export interface AgentB3BootstrapOptions {
  readonly coordinator: DatabaseCoordinator;
  readonly appInstanceId: string;
  readonly credentialVerifier: RawCredentialVerifier;
  readonly cursorSecret: Uint8Array | string;
  readonly now?: () => string;
  readonly randomUUID?: () => string;
}

export interface AgentB3Composition {
  readonly registry: ClientRegistry;
  readonly authenticator: ClientAuthenticator;
  readonly renderer: RendererIdentityAdapter;
  readonly policy: PolicyEngine;
  readonly pagination: PaginationService;
}

export async function bootstrapAgentB3(options: AgentB3BootstrapOptions): Promise<AgentB3Composition> {
  const controlCapability = createDatabaseCoordinatorControlCapability(options.coordinator);
  const registry = new ClientRegistry({
    executeControlWrite: (request) => options.coordinator.executeControlWrite(controlCapability, request),
    appInstanceId: options.appInstanceId,
    catalog: operationCatalogIdentity,
    now: options.now,
    randomUUID: options.randomUUID
  });
  await registry.initialize();
  const authentication = createAuthenticationAdapters(registry, options.credentialVerifier, options.now);
  return Object.freeze({
    registry,
    authenticator: authentication.authenticator,
    renderer: authentication.renderer,
    policy: new PolicyEngine(options.now),
    pagination: new PaginationService(options.cursorSecret)
  });
}

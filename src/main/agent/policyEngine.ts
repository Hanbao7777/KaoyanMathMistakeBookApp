import { AgentError } from '../../shared/agent/errors';
import { agentApiVersion } from '../../shared/agent/versions';
import type {
  AgentPrincipal,
  CatalogIdentity,
  OperationDescriptor,
  OperationPolicyOverride,
  PolicyDecision,
  R4Grant,
  RiskLevel
} from '../../shared/agent/v1/gatewayContracts';
import {
  assertCatalogIdentity,
  assertR4GrantBinding,
  hashCanonicalJson,
  validateOperationPolicyOverride
} from '../../shared/agent/v1/gatewaySchemas';
import {
  operationCatalogIdentity,
  resolveOperationDescriptor
} from '../../shared/agent/v1/operationCatalog';
import { isMcpExternalBusinessOperation } from '../../shared/mcp/v1/exposureManifest';
import { assertIssuedAgentPrincipal, isMigratedRendererBusinessOperation } from './clientAuthenticator';
import type { AgentControlSettings } from './clientRegistry';

const riskOrder: readonly RiskLevel[] = ['R0', 'R1', 'R2', 'R3', 'R4'];
const canonicalTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function canonicalTimestampMs(value: string): number {
  if (!canonicalTimestamp.test(value)) throw new AgentError('POLICY_INVARIANT_VIOLATION');
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new AgentError('POLICY_INVARIANT_VIOLATION');
  }
  return milliseconds;
}

function canonicalDescriptor(supplied: OperationDescriptor): OperationDescriptor {
  let descriptor: OperationDescriptor;
  try {
    descriptor = resolveOperationDescriptor(supplied.name);
  } catch {
    throw new AgentError('POLICY_INVARIANT_VIOLATION');
  }
  if (supplied !== descriptor) throw new AgentError('POLICY_INVARIANT_VIOLATION');
  return descriptor;
}

export interface ResolvedPolicyState {
  readonly affectedEntityCount: number;
  readonly recursiveAffectedEntityCount?: number;
  readonly affectedSetHash?: string;
  readonly targetHash?: string;
  readonly managedFileCount?: number;
}

export interface PolicyEvaluation {
  readonly principal: AgentPrincipal;
  readonly descriptor: OperationDescriptor;
  readonly input: Readonly<Record<string, unknown>>;
  readonly state: ResolvedPolicyState;
  readonly settings: AgentControlSettings;
  readonly pageSize?: number;
  readonly r4Grant?: R4Grant;
  readonly localApprovedChangeSet?: true;
}

function deny(risk: RiskLevel, descriptor: OperationDescriptor, policyVersion: string, reasonCode: string): PolicyDecision {
  return Object.freeze({
    apiVersion: agentApiVersion,
    disposition: 'deny',
    risk,
    reasonCode,
    requiredScopes: descriptor.requiredScopes,
    catalog: operationCatalogIdentity,
    policyVersion
  });
}

function resolveRisk(descriptor: OperationDescriptor, input: Readonly<Record<string, unknown>>, state: ResolvedPolicyState): RiskLevel {
  let risk = descriptor.policyBounds.minimumRisk;
  switch (descriptor.riskResolver) {
    case 'question_delete':
      if (input.deleteImages === true && (state.managedFileCount ?? 0) > 0) risk = 'R4';
      else if (input.physicalDelete === true || input.deleteManagedFiles === true) risk = 'R4';
      break;
    case 'image_delete':
      if (input.deleteFile === true && (state.managedFileCount ?? 0) > 0) risk = 'R4';
      else if (input.physicalDelete === true || input.deleteManagedFiles === true) risk = 'R4';
      break;
    case 'bounded_batch':
      risk = state.affectedEntityCount > 1 ? 'R3' : descriptor.policyBounds.minimumRisk;
      break;
    case 'task_delete':
      risk = (state.recursiveAffectedEntityCount ?? state.affectedEntityCount) > 1 ? 'R3' : descriptor.policyBounds.minimumRisk;
      break;
    case 'static':
      break;
  }
  const index = riskOrder.indexOf(risk);
  if (index < riskOrder.indexOf(descriptor.policyBounds.minimumRisk) || index > riskOrder.indexOf(descriptor.policyBounds.maximumRisk)) {
    throw new AgentError('POLICY_INVARIANT_VIOLATION');
  }
  return risk;
}

function overrideFor(settings: AgentControlSettings, descriptor: OperationDescriptor): OperationPolicyOverride | undefined {
  const matches = settings.overrides.filter((override) => override.operation === descriptor.name);
  if (matches.length > 1) throw new AgentError('POLICY_INVARIANT_VIOLATION');
  const override = matches[0];
  if (override) validateOperationPolicyOverride(override, descriptor, settings.catalog);
  return override;
}

export class PolicyEngine {
  private readonly now: () => string;

  constructor(now: () => string = () => new Date().toISOString()) {
    this.now = now;
  }

  evaluate(evaluation: PolicyEvaluation): PolicyDecision {
    const { principal, input, state, settings } = evaluation;
    const nowMilliseconds = canonicalTimestampMs(this.now());
    const descriptor = canonicalDescriptor(evaluation.descriptor);
    assertIssuedAgentPrincipal(principal);
    const migratedRendererBusiness = principal.renderer && isMigratedRendererBusinessOperation(descriptor.name);
    const localManagementAction = principal.renderer && descriptor.rendererManagement;
    const localApprovedChangeSet = principal.renderer && evaluation.localApprovedChangeSet === true;
    if (!principal.renderer && descriptor.domain !== 'management' && !isMcpExternalBusinessOperation(descriptor.name)) {
      return deny(resolveRisk(descriptor, input, state), descriptor, settings.policyVersion, 'EXTERNAL_MCP_EXPOSURE_BOUNDARY');
    }
    if (principal.renderer && !migratedRendererBusiness && !localManagementAction && !localApprovedChangeSet) {
      return deny(resolveRisk(descriptor, input, state), descriptor, settings.policyVersion, 'RENDERER_MANAGEMENT_ONLY');
    }
    let catalogMatches = true;
    try {
      assertCatalogIdentity(settings.catalog, operationCatalogIdentity);
      if (descriptor.catalogVersion !== settings.catalog.version) throw new AgentError('CATALOG_VERSION_MISMATCH');
    } catch (error) {
      catalogMatches = false;
      if (!principal.renderer || migratedRendererBusiness || !descriptor.rendererManagement || !descriptor.allowedWhenExternalControlDisabled) throw error;
    }
    const override = catalogMatches ? overrideFor(settings, descriptor) : undefined;
    const resolvedRisk = resolveRisk(descriptor, input, state);
    const risk = override?.minimumRisk && riskOrder.indexOf(override.minimumRisk) > riskOrder.indexOf(resolvedRisk)
      ? override.minimumRisk
      : resolvedRisk;

    if (!Number.isSafeInteger(state.affectedEntityCount) || state.affectedEntityCount < 0) {
      throw new AgentError('POLICY_INVARIANT_VIOLATION');
    }
    const maxAffected = override?.maxAffectedEntities ?? descriptor.policyBounds.maxAffectedEntities;
    if (state.affectedEntityCount > maxAffected) return deny(risk, descriptor, settings.policyVersion, 'AFFECTED_RESOURCE_LIMIT');
    const maxPageSize = override?.maxPageSize ?? descriptor.policyBounds.maxPageSize;
    if (evaluation.pageSize !== undefined && (!Number.isSafeInteger(evaluation.pageSize) || evaluation.pageSize < 1 || evaluation.pageSize > maxPageSize)) {
      return deny(risk, descriptor, settings.policyVersion, 'PAGE_SIZE_LIMIT');
    }
    if (!principal.renderer && !settings.externalControlEnabled) {
      throw new AgentError('EXTERNAL_CONTROL_DISABLED');
    }
    if (override?.enabled === false) return deny(risk, descriptor, settings.policyVersion, 'OPERATION_DISABLED');
    if (!localApprovedChangeSet && descriptor.requiredScopes.some((scope) => !principal.scopes.includes(scope))) {
      throw new AgentError('SCOPE_DENIED');
    }

    let disposition: PolicyDecision['disposition'] = 'execute';
    let reasonCode = 'POLICY_EXECUTE';
    if (principal.trust === 'observer' && riskOrder.indexOf(risk) > 1) {
      disposition = 'deny'; reasonCode = 'TRUST_PROFILE_DENIED';
    } else if (risk === 'R4') {
      if (migratedRendererBusiness) {
        disposition = 'execute'; reasonCode = 'LOCAL_RENDERER_USER_ACTION';
      } else {
        if (!evaluation.r4Grant || !state.targetHash) throw new AgentError('R4_GRANT_REQUIRED');
        assertR4GrantBinding(evaluation.r4Grant, descriptor, {
          catalog: settings.catalog,
          operation: descriptor.name,
          payloadHash: hashCanonicalJson(input),
          targetHash: state.targetHash,
          resolvedRisk: 'R4',
          recovery: descriptor.recovery,
          maxAffectedEntities: evaluation.r4Grant.maxAffectedEntities
        });
        if (
          evaluation.r4Grant.status !== 'active' ||
          evaluation.r4Grant.clientId !== principal.clientId ||
          canonicalTimestampMs(evaluation.r4Grant.issuedAt) > nowMilliseconds ||
          canonicalTimestampMs(evaluation.r4Grant.expiresAt) <= nowMilliseconds ||
          state.affectedEntityCount > evaluation.r4Grant.maxAffectedEntities
        ) throw new AgentError('R4_GRANT_INVALID');
        disposition = 'execute'; reasonCode = 'R4_GRANT_BOUND';
      }
    } else if (!localManagementAction && !localApprovedChangeSet && (descriptor.policyBounds.requiresChangeSet || override?.requireChangeSet)) {
      disposition = 'requires_changeset'; reasonCode = 'CHANGESET_REQUIRED';
    } else if (!localManagementAction && !localApprovedChangeSet && (descriptor.policyBounds.approval === 'always' || override?.requireApproval)) {
      disposition = 'requires_approval'; reasonCode = 'APPROVAL_REQUIRED';
    } else if (principal.trust === 'collaborator' && riskOrder.indexOf(risk) >= 2) {
      disposition = 'requires_approval'; reasonCode = 'TRUST_APPROVAL_REQUIRED';
    } else if (principal.trust === 'autonomous' && risk === 'R3') {
      disposition = 'requires_changeset'; reasonCode = 'AUTONOMOUS_CHANGESET_REQUIRED';
    }

    return Object.freeze({
      apiVersion: agentApiVersion,
      disposition,
      risk,
      reasonCode,
      requiredScopes: descriptor.requiredScopes,
      catalog: operationCatalogIdentity as CatalogIdentity,
      policyVersion: settings.policyVersion
    });
  }
}

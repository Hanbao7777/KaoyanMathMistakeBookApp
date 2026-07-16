import { agentApiVersion } from '../versions';
import {
  operationNames,
  type AgentScope,
  type ApprovalRequirement,
  type CatalogIdentity,
  type OperationCatalog,
  type OperationDescriptor,
  type OperationDomain,
  type OperationKind,
  type OperationName,
  type RecoveryRequirement,
  type RiskLevel,
  type RiskResolver,
  type SideEffectKind
} from './gatewayContracts';
import {
  canonicalHashAlgorithm,
  catalogHashInput,
  hashCanonicalJson,
  validateOperationCatalog
} from './gatewaySchemas';

export const operationCatalogVersion = 'agent-catalog-v1@1' as const;

interface DescriptorDefinition {
  readonly kind: OperationKind;
  readonly domain: OperationDomain;
  readonly requiredScopes: readonly AgentScope[];
  readonly sideEffects?: readonly SideEffectKind[];
  readonly idempotency?: 'required' | 'none';
  readonly recovery?: RecoveryRequirement;
  readonly risk?: RiskLevel;
  readonly maximumRisk?: RiskLevel;
  readonly riskResolver?: RiskResolver;
  readonly maxAffectedEntities?: number;
  readonly maxPageSize?: number;
  readonly approval?: ApprovalRequirement;
  readonly requiresChangeSet?: boolean;
  readonly rendererManagement?: boolean;
}

const managementRecoveryAllowlist = new Set<OperationName>([
  'agent.status.get',
  'agent.control.set_enabled',
  'agent.clients.list',
  'agent.clients.update_access',
  'agent.clients.revoke',
  'agent.sessions.list',
  'agent.sessions.terminate',
  'agent.r4_grants.create',
  'agent.r4_grants.revoke',
  'agent.r4_grants.list',
  'agent.approvals.list',
  'agent.approvals.approve',
  'agent.approvals.reject',
  'agent.changesets.list',
  'agent.changesets.get',
  'agent.changesets.apply',
  'agent.changesets.reject',
  'agent.audit.search',
  'agent.audit.export',
  'agent.audit.verify',
  'agent.policy.get',
  'agent.catalog.get',
  'agent.privacy.get'
]);

export const disabledRendererManagementOperations = Object.freeze(
  [...managementRecoveryAllowlist].sort()
) as readonly OperationName[];

const definitions: Record<OperationName, DescriptorDefinition> = {
  'agent.control.set_enabled': managementCommand(['control.manage'], 'R2', { rendererManagement: true }),
  'agent.clients.update_access': managementCommand(['clients.manage'], 'R2', { rendererManagement: true }),
  'agent.clients.revoke': managementCommand(['clients.manage'], 'R2', { rendererManagement: true }),
  'agent.sessions.terminate': managementCommand(['sessions.manage'], 'R2', { rendererManagement: true }),
  'agent.r4_grants.create': managementCommand(['r4.manage'], 'R3', { approval: 'always', rendererManagement: true }),
  'agent.r4_grants.revoke': managementCommand(['r4.manage'], 'R2', { rendererManagement: true }),
  'agent.approvals.approve': managementCommand(['approvals.manage'], 'R2', { rendererManagement: true }),
  'agent.approvals.reject': managementCommand(['approvals.manage'], 'R2', { rendererManagement: true }),
  'agent.changesets.apply': managementCommand(['changesets.manage'], 'R3', { approval: 'policy', requiresChangeSet: true, maxAffectedEntities: 500, rendererManagement: true }),
  'agent.changesets.reject': managementCommand(['changesets.manage'], 'R2', { rendererManagement: true }),
  'agent.changesets.rollback': managementCommand(['changesets.manage'], 'R3', { approval: 'policy', recovery: 'inverse', maxAffectedEntities: 500 }),
  'agent.policy.update': managementCommand(['policy.manage'], 'R3', { approval: 'always' }),
  'agent.audit.export': managementCommand(['audit.export'], 'R1', { rendererManagement: true, maxAffectedEntities: 200 }),
  'agent.audit.cleanup': managementCommand(['audit.export', 'r4.manage'], 'R4', {
    approval: 'r4_grant', recovery: 'consistency_bundle', requiresChangeSet: true, maxAffectedEntities: 500
  }),
  'agent.status.get': managementQuery(['system.read'], true),
  'agent.clients.list': managementQuery(['clients.read'], true),
  'agent.sessions.list': managementQuery(['sessions.read'], true),
  'agent.r4_grants.list': managementQuery(['r4.read'], true),
  'agent.approvals.list': managementQuery(['approvals.read'], true),
  'agent.changesets.list': managementQuery(['changesets.read'], true),
  'agent.changesets.get': managementQuery(['changesets.read'], true),
  'agent.audit.search': managementQuery(['audit.read'], true),
  'agent.audit.verify': managementQuery(['audit.read'], true),
  'agent.policy.get': managementQuery(['policy.read'], true),
  'agent.catalog.get': managementQuery(['system.read'], true),
  'agent.privacy.get': managementQuery(['system.read'], true),
  'questions.create': businessCommand('questions', ['questions.write'], 'R2', 'inverse'),
  'questions.update': businessCommand('questions', ['questions.write'], 'R2', 'inverse'),
  'questions.delete': businessCommand('questions', ['questions.archive'], 'R2', 'quarantine', {
    maximumRisk: 'R4', riskResolver: 'question_delete', approval: 'policy'
  }),
  'questions.remove_image': businessCommand('questions', ['questions.write'], 'R2', 'quarantine', {
    maximumRisk: 'R4', riskResolver: 'image_delete', approval: 'policy'
  }),
  'questions.mark_mastery': businessCommand('questions', ['questions.write'], 'R2', 'inverse'),
  'questions.submit_review': businessCommand('questions', ['reviews.submit'], 'R2', 'inverse'),
  'questions.undo_review': businessCommand('questions', ['reviews.submit'], 'R2', 'inverse'),
  'questions.link_knowledge': businessCommand('questions', ['questions.write', 'knowledge.write'], 'R2', 'inverse'),
  'questions.migrate_categories': batchCommand('questions', ['questions.write', 'operations.batch'], 'R3'),
  'questions.rematch_knowledge': batchCommand('questions', ['questions.write', 'knowledge.write', 'operations.batch'], 'R3'),
  'questions.bulk_upsert': batchCommand('questions', ['questions.write', 'operations.batch'], 'R3'),
  'questions.import': batchCommand('questions', ['questions.write', 'operations.batch'], 'R3', 'quarantine'),
  'questions.replace_all': r4Command('questions', ['questions.archive', 'operations.batch']),
  'questions.clear_all': r4Command('questions', ['questions.archive', 'operations.batch']),
  'tasks.create': businessCommand('tasks', ['tasks.write'], 'R2', 'inverse'),
  'tasks.update': businessCommand('tasks', ['tasks.write'], 'R2', 'inverse'),
  'tasks.complete': businessCommand('tasks', ['tasks.execute'], 'R2', 'inverse'),
  'tasks.uncomplete': businessCommand('tasks', ['tasks.execute'], 'R2', 'inverse'),
  'tasks.delete': businessCommand('tasks', ['tasks.write'], 'R2', 'inverse', { maximumRisk: 'R3', riskResolver: 'task_delete', approval: 'policy' }),
  'focus.sessions.create': businessCommand('focus', ['focus.control'], 'R2', 'inverse'),
  'questions.list': businessQuery('questions', ['questions.read']),
  'questions.get': businessQuery('questions', ['questions.read']),
  'questions.review_logs': businessQuery('questions', ['questions.read', 'reviews.read']),
  'questions.review_buckets': businessQuery('questions', ['questions.read', 'reviews.read']),
  'tasks.list': businessQuery('tasks', ['tasks.read']),
  'tasks.get': businessQuery('tasks', ['tasks.read']),
  'focus.sessions.list': businessQuery('focus', ['focus.read'])
};

function managementCommand(
  requiredScopes: readonly AgentScope[],
  risk: RiskLevel,
  options: Partial<DescriptorDefinition> = {}
): DescriptorDefinition {
  return {
    kind: 'command', domain: 'management', requiredScopes, sideEffects: ['database'], idempotency: 'required',
    recovery: 'none', risk, maximumRisk: risk, approval: 'never', ...options
  };
}

function managementQuery(requiredScopes: readonly AgentScope[], rendererManagement = false): DescriptorDefinition {
  return { kind: 'query', domain: 'management', requiredScopes, risk: 'R1', rendererManagement };
}

function businessCommand(
  domain: 'questions' | 'tasks' | 'focus',
  requiredScopes: readonly AgentScope[],
  risk: RiskLevel,
  recovery: RecoveryRequirement,
  options: Partial<DescriptorDefinition> = {}
): DescriptorDefinition {
  return {
    kind: 'command', domain, requiredScopes, sideEffects: ['database'], idempotency: 'required', recovery,
    risk, maximumRisk: risk, approval: 'policy', ...options
  };
}

function batchCommand(
  domain: 'questions' | 'tasks',
  requiredScopes: readonly AgentScope[],
  risk: RiskLevel,
  recovery: RecoveryRequirement = 'inverse'
): DescriptorDefinition {
  return businessCommand(domain, requiredScopes, risk, recovery, {
    riskResolver: 'bounded_batch', maxAffectedEntities: 500, requiresChangeSet: true
  });
}

function r4Command(domain: 'questions' | 'tasks', requiredScopes: readonly AgentScope[]): DescriptorDefinition {
  return businessCommand(domain, requiredScopes, 'R4', 'consistency_bundle', {
    approval: 'r4_grant', requiresChangeSet: true, maxAffectedEntities: 500
  });
}

function businessQuery(domain: 'questions' | 'tasks' | 'focus', requiredScopes: readonly AgentScope[]): DescriptorDefinition {
  return { kind: 'query', domain, requiredScopes, risk: 'R1' };
}

function descriptor(name: OperationName, definition: DescriptorDefinition): OperationDescriptor {
  const rendererManagement = definition.rendererManagement === true;
  if (rendererManagement !== managementRecoveryAllowlist.has(name)) {
    throw new Error(`Renderer management allowlist mismatch for ${name}`);
  }
  const minimumRisk = definition.risk ?? 'R1';
  return {
    apiVersion: agentApiVersion,
    name,
    kind: definition.kind,
    domain: definition.domain,
    catalogVersion: operationCatalogVersion,
    inputSchema: `${name}.input.v1`,
    outputSchema: `${name}.output.v1`,
    requiredScopes: Object.freeze([...definition.requiredScopes].sort()),
    sideEffects: Object.freeze([...(definition.sideEffects ?? [])].sort()),
    idempotency: definition.idempotency ?? 'none',
    recovery: definition.recovery ?? 'none',
    riskResolver: definition.riskResolver ?? 'static',
    policyBounds: Object.freeze({
      minimumRisk,
      maximumRisk: definition.maximumRisk ?? minimumRisk,
      maxAffectedEntities: definition.maxAffectedEntities ?? 1,
      maxPageSize: definition.maxPageSize ?? (definition.kind === 'query' ? 200 : 1),
      approval: definition.approval ?? 'never',
      requiresChangeSet: definition.requiresChangeSet ?? false,
      requiresR4GrantWhenRiskR4: (definition.maximumRisk ?? minimumRisk) === 'R4'
    }),
    rendererManagement,
    allowedWhenExternalControlDisabled: rendererManagement
  };
}

const operations = Object.freeze(
  operationNames
    .map((name) => Object.freeze(descriptor(name, definitions[name])))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
);

const unsignedCatalog = {
  apiVersion: agentApiVersion,
  version: operationCatalogVersion,
  hashAlgorithm: canonicalHashAlgorithm,
  operations
} as const;

export const operationCatalog: OperationCatalog = Object.freeze({
  ...unsignedCatalog,
  hash: hashCanonicalJson(catalogHashInput(unsignedCatalog))
});

validateOperationCatalog(operationCatalog);

export const operationCatalogIdentity: CatalogIdentity = Object.freeze({
  version: operationCatalog.version,
  hash: operationCatalog.hash
});

const descriptorsByName = new Map(operationCatalog.operations.map((entry) => [entry.name, entry]));

export function resolveOperationDescriptor(name: OperationName): OperationDescriptor {
  const result = descriptorsByName.get(name);
  if (!result) throw new Error(`Unknown operation descriptor: ${name}`);
  return result;
}

export function isDisabledRendererManagementOperation(name: OperationName): boolean {
  return managementRecoveryAllowlist.has(name);
}

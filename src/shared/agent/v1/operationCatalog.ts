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

export const operationCatalogVersion = 'agent-catalog-v1@7' as const;

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
  readonly visibility?: 'authorized-principal' | 'owner-or-admin' | 'public';
}

const disabledRendererManagementOperationSet = new Set<OperationName>([
  'agent.status.get',
  'agent.control.set_enabled',
  'agent.clients.list',
  'agent.clients.update_access',
  'agent.clients.revoke',
  'agent.clients.register_key',
  'agent.clients.rotate_key',
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
  [...disabledRendererManagementOperationSet].sort()
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
  'agent.clients.register_key': managementCommand(['clients.manage'], 'R2', { rendererManagement: true, visibility: 'owner-or-admin' }),
  'agent.clients.rotate_key': managementCommand(['clients.manage'], 'R2', { rendererManagement: true, visibility: 'owner-or-admin' }),
  'agent.receipts.get_status': { ...managementQuery(['system.read']), visibility: 'owner-or-admin' },
  'jobs.create': managementCommand(['jobs.execute'], 'R1', { visibility: 'owner-or-admin' }),
  'jobs.cancel': managementCommand(['jobs.cancel'], 'R1', { visibility: 'owner-or-admin' }),
  'jobs.get': managementQuery(['jobs.read']),
  'jobs.list': managementQuery(['jobs.read']),
  'jobs.result': managementQuery(['jobs.read']),
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
  'knowledge.link_question': businessCommand('knowledge', ['knowledge.write'], 'R2', 'inverse', { maxAffectedEntities: 2 }),
  'knowledge.unlink_question': businessCommand('knowledge', ['knowledge.write'], 'R2', 'inverse', { maxAffectedEntities: 2 }),
  'knowledge.bind_textbook': businessCommand('knowledge', ['knowledge.write'], 'R2', 'inverse', { maxAffectedEntities: 2 }),
  'study.create_plan_draft': businessCommand('study', ['study.write'], 'R3', 'inverse', { maxAffectedEntities: 20 }),
  'study.apply_plan_adjustment': businessCommand('study', ['study.write'], 'R2', 'inverse'),
  'study.record_manual_progress': businessCommand('study', ['study.write'], 'R2', 'inverse', { maxAffectedEntities: 3 }),
  'imports.create_draft': businessCommand('imports', ['imports.write'], 'R2', 'inverse', { maxAffectedEntities: 50 }),
  'imports.add_draft_image': businessCommand('imports', ['imports.write'], 'R2', 'quarantine', { sideEffects: ['database', 'managed_files'], maxAffectedEntities: 2 }),
  'imports.validate_draft': businessCommand('imports', ['imports.write'], 'R2', 'inverse', { maxAffectedEntities: 50 }),
  'imports.apply_draft': businessCommand('imports', ['imports.write', 'questions.write', 'operations.batch'], 'R3', 'quarantine', { sideEffects: ['database', 'managed_files'], riskResolver: 'bounded_batch', maxAffectedEntities: 50 }),
  'imports.cancel': businessCommand('imports', ['imports.write'], 'R2', 'quarantine', { sideEffects: ['database', 'managed_files'], maxAffectedEntities: 50 }),
  'ticktick.lists.create': businessCommand('ticktick', ['ticktick.lists.write'], 'R2', 'inverse'),
  'ticktick.lists.update': businessCommand('ticktick', ['ticktick.lists.write'], 'R2', 'inverse'),
  'ticktick.habits.create': businessCommand('ticktick', ['ticktick.habits.write'], 'R2', 'inverse'),
  'ticktick.habits.update': businessCommand('ticktick', ['ticktick.habits.write'], 'R2', 'inverse'),
  'ticktick.bridges.update': businessCommand('ticktick', ['ticktick.bridges.write'], 'R2', 'inverse', { maxAffectedEntities: 3 }),
  'questions.list': businessQuery('questions', ['questions.read']),
  'questions.get': businessQuery('questions', ['questions.read']),
  'questions.review_logs': businessQuery('questions', ['questions.read', 'reviews.read']),
  'questions.review_buckets': businessQuery('questions', ['questions.read', 'reviews.read']),
  'tasks.list': businessQuery('tasks', ['tasks.read']),
  'tasks.get': businessQuery('tasks', ['tasks.read']),
  'focus.sessions.list': businessQuery('focus', ['focus.read']),
  'knowledge.list_nodes': businessQuery('knowledge', ['knowledge.read']),
  'knowledge.get_node': businessQuery('knowledge', ['knowledge.read']),
  'knowledge.list_links': businessQuery('knowledge', ['knowledge.read']),
  'textbooks.list': businessQuery('textbooks', ['textbooks.read']),
  'textbooks.get': businessQuery('textbooks', ['textbooks.read']),
  'analytics.get_weak_areas': businessQuery('analytics', ['analytics.read']),
  'study.get_today': businessQuery('study', ['study.read']),
  'study.get_week_summary': businessQuery('study', ['study.read'])
   , 'imports.preview_draft': businessQuery('imports', ['imports.read'])
   , 'imports.get': businessQuery('imports', ['imports.read'])
   , 'ticktick.lists.list': businessQuery('ticktick', ['ticktick.lists.read'])
   , 'ticktick.habits.list': businessQuery('ticktick', ['ticktick.habits.read'])
   , 'ticktick.calendar.list_events': businessQuery('ticktick', ['ticktick.calendar.read'])
   , 'ticktick.bridges.get': businessQuery('ticktick', ['ticktick.bridges.read'])
   , 'backups.list': businessQuery('global', ['backups.read'])
   , 'exports.get': businessQuery('global', ['exports.read'])
   , 'backups.create': businessCommand('global', ['backups.create'], 'R2', 'inverse', { sideEffects: ['database', 'managed_files'], maxAffectedEntities: 1 })
   , 'exports.create': businessCommand('global', ['exports.create'], 'R2', 'inverse', { sideEffects: ['managed_files'], maxAffectedEntities: 50 })
   , 'backups.materialize': businessCommand('global', ['backups.create'], 'R2', 'inverse', { sideEffects: ['managed_files'], maxAffectedEntities: 1 })
   , 'exports.materialize': businessCommand('global', ['exports.create'], 'R2', 'inverse', { sideEffects: ['managed_files'], maxAffectedEntities: 1 })
   , 'backups.delete': r4Command('global', ['backups.delete'])
   , 'database.restore': r4Command('global', ['database.restore'])
   , 'database.replace_from_import': r4Command('global', ['database.replace'])
   , 'database.clear_all': r4Command('global', ['database.clear'])
   , 'imports.delete_batch': r4Command('global', ['imports.delete'])
   , 'data_root.migrate': r4Command('global', ['data_root.migrate'])
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
  domain: 'questions' | 'tasks' | 'focus' | 'knowledge' | 'study' | 'imports' | 'ticktick' | 'global',
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

function r4Command(domain: 'questions' | 'tasks' | 'global', requiredScopes: readonly AgentScope[]): DescriptorDefinition {
  return businessCommand(domain, requiredScopes, 'R4', 'consistency_bundle', {
    approval: 'r4_grant', requiresChangeSet: true, maxAffectedEntities: 500,
    ...(domain === 'global' ? { riskResolver: 'global_resolved' as const } : {})
  });
}

function businessQuery(domain: 'questions' | 'tasks' | 'focus' | 'knowledge' | 'textbooks' | 'analytics' | 'study' | 'imports' | 'ticktick' | 'global', requiredScopes: readonly AgentScope[]): DescriptorDefinition {
  return { kind: 'query', domain, requiredScopes, risk: 'R1' };
}

function descriptor(name: OperationName, definition: DescriptorDefinition): OperationDescriptor {
  const rendererManagement = definition.rendererManagement === true;
  if (rendererManagement !== disabledRendererManagementOperationSet.has(name)) {
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
    allowedWhenExternalControlDisabled: rendererManagement,
    visibility: definition.visibility ?? (definition.domain === 'management' ? 'owner-or-admin' : 'authorized-principal')
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
  return disabledRendererManagementOperationSet.has(name);
}

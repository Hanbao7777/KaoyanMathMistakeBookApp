import type { SerializedAgentError } from '../errors';
import type { AgentApiVersion } from '../versions';
import type { CommandResult, DataVersion, EntityRef, QueryResult } from './contracts';

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export const agentScopes = [
  'system.read',
  'control.manage',
  'clients.read',
  'clients.manage',
  'sessions.read',
  'sessions.manage',
  'r4.read',
  'r4.manage',
  'approvals.read',
  'approvals.manage',
  'changesets.read',
  'changesets.manage',
  'policy.read',
  'policy.manage',
  'audit.read',
  'audit.export',
  'questions.read',
  'questions.write',
  'questions.archive',
  'reviews.read',
  'reviews.submit',
  'knowledge.read',
  'knowledge.write',
  'textbooks.read',
  'analytics.read',
  'operations.batch',
  'tasks.read',
  'tasks.write',
  'tasks.execute',
  'jobs.read',
  'jobs.execute',
  'jobs.cancel',
  'jobs.admin',
  'focus.read',
  'focus.control',
  'files.images.read'
] as const;

export type AgentScope = (typeof agentScopes)[number];
export const trustProfiles = ['observer', 'collaborator', 'autonomous', 'full_control'] as const;
export type TrustProfile = (typeof trustProfiles)[number];
export const riskLevels = ['R0', 'R1', 'R2', 'R3', 'R4'] as const;
export type RiskLevel = (typeof riskLevels)[number];

export interface CatalogIdentity {
  readonly version: string;
  readonly hash: string;
}

export interface AgentPrincipalClaims {
  readonly apiVersion: AgentApiVersion;
  readonly kind: 'agent-principal';
  readonly clientId: string;
  readonly subjectId: string;
  readonly displayName: string;
  readonly scopes: readonly AgentScope[];
  readonly trust: TrustProfile;
  readonly credentialBinding: string;
  readonly sessionId?: string;
  readonly authenticatedAt: string;
  readonly renderer: boolean;
}

declare const authenticatedAgentPrincipalCapability: unique symbol;

export type AgentPrincipal = AgentPrincipalClaims & {
  readonly [authenticatedAgentPrincipalCapability]: true;
};

export type RawClientCredentials = Readonly<Record<string, unknown>>;

export interface ClientAuthenticator {
  authenticate(credentials: RawClientCredentials): Promise<AgentPrincipal>;
}

export const agentGatewayMethodNames = Object.freeze(['execute', 'query'] as const);

export const workflowReferenceKinds = ['approval', 'changeset', 'r4-grant'] as const;
export type WorkflowReferenceKind = (typeof workflowReferenceKinds)[number];

export interface WorkflowReference {
  readonly kind: WorkflowReferenceKind;
  readonly id: string;
}

export interface AgentCommandEnvelope {
  readonly apiVersion: AgentApiVersion;
  readonly kind: 'agent-command';
  readonly operation: OperationName;
  readonly payload: JsonObject;
  readonly requestId: string;
  readonly expectedVersion?: DataVersion;
  readonly workflow?: WorkflowReference;
  readonly catalog: CatalogIdentity;
}

export const detailLevels = ['summary', 'standard', 'full'] as const;
export type DetailLevel = (typeof detailLevels)[number];

export interface PageRequest {
  readonly cursor?: string;
  readonly pageSize: number;
  readonly detail: DetailLevel;
  readonly fields?: readonly string[];
}

export interface AgentQueryEnvelope {
  readonly apiVersion: AgentApiVersion;
  readonly kind: 'agent-query';
  readonly operation: OperationName;
  readonly payload: JsonObject;
  readonly requestId: string;
  readonly page?: PageRequest;
  readonly catalog: CatalogIdentity;
}

export interface PageInfo {
  readonly nextCursor?: string;
  readonly pageSize: number;
  readonly hasMore: boolean;
}

export interface WorkflowOutcomeReference {
  readonly kind: 'approval' | 'changeset';
  readonly id: string;
  readonly expiresAt: string;
}

export type AgentExecuteOutcome =
  | { readonly kind: 'completed'; readonly result: CommandResult }
  | { readonly kind: 'replayed'; readonly result: CommandResult; readonly receiptId: string }
  | { readonly kind: 'pending_approval'; readonly workflow: WorkflowOutcomeReference }
  | { readonly kind: 'pending_changeset'; readonly workflow: WorkflowOutcomeReference }
  | { readonly kind: 'rejected'; readonly error: SerializedAgentError };

export type AgentQueryOutcome =
  | { readonly kind: 'completed'; readonly result: QueryResult; readonly page?: PageInfo }
  | { readonly kind: 'rejected'; readonly error: SerializedAgentError };

export interface AgentGateway {
  execute(envelope: AgentCommandEnvelope, principal: AgentPrincipal): Promise<AgentExecuteOutcome>;
  query(envelope: AgentQueryEnvelope, principal: AgentPrincipal): Promise<AgentQueryOutcome>;
}

export const receiptStatuses = ['admitted', 'completed', 'failed', 'indeterminate', 'interrupted_precommit'] as const;
export type ReceiptStatus = (typeof receiptStatuses)[number];
export const terminalReceiptStatuses = ['completed', 'failed', 'indeterminate', 'interrupted_precommit'] as const;
export type TerminalReceiptStatus = (typeof terminalReceiptStatuses)[number];

export interface ExecutionReceipt {
  readonly apiVersion: AgentApiVersion;
  readonly receiptId: string;
  readonly clientId: string;
  readonly requestId: string;
  readonly operation: OperationName;
  readonly payloadHash: string;
  readonly affectedSetHash?: string;
  readonly catalog: CatalogIdentity;
  readonly baseVersion?: DataVersion;
  readonly status: ReceiptStatus;
  readonly dataVersion?: DataVersion;
  readonly outcomeHash?: string;
  readonly error?: SerializedAgentError;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const auditKinds = [
  'authentication',
  'pairing',
  'admission',
  'denial',
  'query',
  'success',
  'failure',
  'indeterminate',
  'reconciliation',
  'grant_reserved',
  'grant_released',
  'grant_consumed',
  'client_revoked',
  'session_terminated',
  'policy_changed',
  'catalog_changed',
  'control_changed',
  'segment_closed',
  'segment_opened'
] as const;
export type AuditKind = (typeof auditKinds)[number];

export interface AuditCursor {
  readonly apiVersion: AgentApiVersion;
  readonly kind: 'audit-cursor';
  readonly value: string;
}

export interface RedactionProfile {
  readonly apiVersion: AgentApiVersion;
  readonly kind: 'redaction-profile';
  readonly detail: DetailLevel;
  readonly includeUserContent: boolean;
  readonly includeAffectedEntities: boolean;
  readonly fields: readonly string[];
}

export interface AuditRecord {
  readonly apiVersion: AgentApiVersion;
  readonly auditId: string;
  readonly segmentId: string;
  readonly sequence: number;
  readonly kind: AuditKind;
  readonly occurredAt: string;
  readonly clientId: string;
  readonly requestId?: string;
  readonly operation?: OperationName;
  readonly risk?: RiskLevel;
  readonly catalog: CatalogIdentity;
  readonly receiptId?: string;
  readonly summary: JsonObject;
  readonly affectedEntities: readonly EntityRef[];
  readonly previousHash?: string;
  readonly recordHash: string;
}

export const r4GrantStatuses = ['active', 'reserved', 'consumed', 'revoked', 'expired'] as const;
export type R4GrantStatus = (typeof r4GrantStatuses)[number];

export interface R4Grant {
  readonly apiVersion: AgentApiVersion;
  readonly grantId: string;
  readonly clientId: string;
  readonly operation: OperationName;
  readonly payloadHash: string;
  readonly targetHash: string;
  readonly catalog: CatalogIdentity;
  readonly recovery: RecoveryRequirement;
  readonly maxAffectedEntities: number;
  readonly maxUses: 1;
  readonly status: R4GrantStatus;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly consumedAt?: string;
  readonly revokedAt?: string;
}

export interface R4GrantCreateInput {
  readonly clientId: string;
  readonly operation: OperationName;
  readonly payloadHash: string;
  readonly targetHash: string;
  readonly maxAffectedEntities: number;
  readonly expiresAt: string;
}

export interface R4GrantBinding {
  readonly catalog: CatalogIdentity;
  readonly operation: OperationName;
  readonly payloadHash: string;
  readonly targetHash: string;
  readonly resolvedRisk: 'R4';
  readonly recovery: RecoveryRequirement;
  readonly maxAffectedEntities: number;
}

export interface R4Reservation {
  readonly apiVersion: AgentApiVersion;
  readonly reservationId: string;
  readonly grantId: string;
  readonly clientId: string;
  readonly requestId: string;
  readonly operation: OperationName;
  readonly payloadHash: string;
  readonly affectedSetHash: string;
  readonly baseVersion: DataVersion;
  readonly catalog: CatalogIdentity;
  readonly reservedAt: string;
  readonly expiresAt: string;
}

export const approvalStatuses = ['pending', 'approved', 'rejected', 'consumed', 'revoked', 'expired'] as const;
export type ApprovalStatus = (typeof approvalStatuses)[number];
export const approvalSources = ['user', 'policy'] as const;
export type ApprovalSource = (typeof approvalSources)[number];

export interface ApprovalRecord {
  readonly apiVersion: AgentApiVersion;
  readonly approvalId: string;
  readonly nonce: string;
  readonly clientId: string;
  readonly credentialBinding: string;
  readonly operation: OperationName;
  readonly payloadHash: string;
  readonly affectedSetHash: string;
  readonly baseVersion: DataVersion;
  readonly catalog: CatalogIdentity;
  readonly policyVersion: string;
  readonly risk: RiskLevel;
  readonly requiredScopes: readonly AgentScope[];
  readonly recovery: RecoveryRequirement;
  readonly source?: ApprovalSource;
  readonly status: ApprovalStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly consumedAt?: string;
  readonly revokedAt?: string;
}

export const changeSetStatuses = [
  'draft',
  'waiting_approval',
  'approved',
  'applied',
  'rejected',
  'expired',
  'rolled_back'
] as const;
export type ChangeSetStatus = (typeof changeSetStatuses)[number];

export interface PlannedOperation {
  readonly operation: OperationName;
  readonly payload: JsonObject;
  readonly payloadHash: string;
  readonly affectedEntities: readonly EntityRef[];
}

export interface ChangeSet {
  readonly apiVersion: AgentApiVersion;
  readonly changeSetId: string;
  readonly clientId: string;
  readonly status: ChangeSetStatus;
  readonly catalog: CatalogIdentity;
  readonly baseVersion: DataVersion;
  readonly risk: 'R2' | 'R3' | 'R4';
  readonly summary: string;
  readonly operations: readonly PlannedOperation[];
  readonly affectedSetHash: string;
  readonly recovery: RecoveryRequirement;
  readonly recoveryAssetId?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly appliedAt?: string;
}

export const policyDispositions = ['execute', 'requires_approval', 'requires_changeset', 'deny'] as const;
export type PolicyDisposition = (typeof policyDispositions)[number];

export interface PolicyDecision {
  readonly apiVersion: AgentApiVersion;
  readonly disposition: PolicyDisposition;
  readonly risk: RiskLevel;
  readonly reasonCode: string;
  readonly requiredScopes: readonly AgentScope[];
  readonly catalog: CatalogIdentity;
  readonly policyVersion: string;
}

export const sideEffectKinds = ['database', 'managed_files', 'external_process', 'network', 'ui'] as const;
export type SideEffectKind = (typeof sideEffectKinds)[number];
export const idempotencyRequirements = ['required', 'none'] as const;
export type IdempotencyRequirement = (typeof idempotencyRequirements)[number];
export const recoveryRequirements = ['inverse', 'quarantine', 'consistency_bundle', 'none'] as const;
export type RecoveryRequirement = (typeof recoveryRequirements)[number];
export const approvalRequirements = ['never', 'policy', 'always', 'r4_grant'] as const;
export type ApprovalRequirement = (typeof approvalRequirements)[number];
export const operationKinds = ['command', 'query'] as const;
export type OperationKind = (typeof operationKinds)[number];
export const operationDomains = ['management', 'questions', 'tasks', 'focus', 'knowledge', 'textbooks', 'analytics'] as const;
export type OperationDomain = (typeof operationDomains)[number];
export const riskResolvers = ['static', 'question_delete', 'image_delete', 'bounded_batch', 'task_delete'] as const;
export type RiskResolver = (typeof riskResolvers)[number];

export interface DescriptorPolicyBounds {
  readonly minimumRisk: RiskLevel;
  readonly maximumRisk: RiskLevel;
  readonly maxAffectedEntities: number;
  readonly maxPageSize: number;
  readonly approval: ApprovalRequirement;
  readonly requiresChangeSet: boolean;
  readonly requiresR4GrantWhenRiskR4: boolean;
}

export interface OperationDescriptor {
  readonly apiVersion: AgentApiVersion;
  readonly name: OperationName;
  readonly kind: OperationKind;
  readonly domain: OperationDomain;
  readonly catalogVersion: string;
  readonly inputSchema: string;
  readonly outputSchema: string;
  readonly requiredScopes: readonly AgentScope[];
  readonly sideEffects: readonly SideEffectKind[];
  readonly idempotency: IdempotencyRequirement;
  readonly recovery: RecoveryRequirement;
  readonly riskResolver: RiskResolver;
  readonly policyBounds: DescriptorPolicyBounds;
  readonly rendererManagement: boolean;
  readonly allowedWhenExternalControlDisabled: boolean;
  readonly visibility: 'authorized-principal' | 'owner-or-admin' | 'public';
}

export interface OperationPolicyOverride {
  readonly apiVersion: AgentApiVersion;
  readonly operation: OperationName;
  readonly catalog: CatalogIdentity;
  readonly enabled?: boolean;
  readonly minimumRisk?: RiskLevel;
  readonly maxAffectedEntities?: number;
  readonly maxPageSize?: number;
  readonly requireApproval?: boolean;
  readonly requireChangeSet?: boolean;
}

export interface OperationCatalog {
  readonly apiVersion: AgentApiVersion;
  readonly version: string;
  readonly hashAlgorithm: 'sha256-v1';
  readonly hash: string;
  readonly operations: readonly OperationDescriptor[];
}

export const gatewayWorkflowCommandTypes = [
  'agent.control.set_enabled',
  'agent.clients.update_access',
  'agent.clients.revoke',
  'agent.sessions.terminate',
  'agent.r4_grants.create',
  'agent.r4_grants.revoke',
  'agent.approvals.approve',
  'agent.approvals.reject',
  'agent.changesets.apply',
  'agent.changesets.reject',
  'agent.changesets.rollback',
  'agent.policy.update',
  'agent.audit.export',
  'agent.audit.cleanup'
] as const;

export const gatewayWorkflowQueryTypes = [
  'agent.status.get',
  'agent.clients.list',
  'agent.sessions.list',
  'agent.r4_grants.list',
  'agent.approvals.list',
  'agent.changesets.list',
  'agent.changesets.get',
  'agent.audit.search',
  'agent.audit.verify',
  'agent.policy.get',
  'agent.catalog.get',
  'agent.privacy.get'
] as const;

export const gatewayManagementCommandTypes = [
  'agent.clients.register_key',
  'agent.clients.rotate_key',
  'jobs.create',
  'jobs.cancel'
] as const;

export const gatewayManagementQueryTypes = [
  'agent.receipts.get_status',
  'jobs.get',
  'jobs.list',
  'jobs.result'
] as const;

export const gatewayBusinessCommandTypes = [
  'questions.create',
  'questions.update',
  'questions.delete',
  'questions.remove_image',
  'questions.mark_mastery',
  'questions.submit_review',
  'questions.undo_review',
  'questions.link_knowledge',
  'questions.migrate_categories',
  'questions.rematch_knowledge',
  'questions.bulk_upsert',
  'questions.import',
  'questions.replace_all',
  'questions.clear_all',
  'tasks.create',
  'tasks.update',
  'tasks.complete',
  'tasks.uncomplete',
  'tasks.delete',
  'focus.sessions.create',
  'knowledge.link_question',
  'knowledge.unlink_question',
  'knowledge.bind_textbook'
] as const;

export const gatewayBusinessQueryTypes = [
  'questions.list',
  'questions.get',
  'questions.review_logs',
  'questions.review_buckets',
  'tasks.list',
  'tasks.get',
  'focus.sessions.list',
  'knowledge.list_nodes',
  'knowledge.get_node',
  'knowledge.list_links',
  'textbooks.list',
  'textbooks.get',
  'analytics.get_weak_areas'
] as const;

export const operationNames = [
  ...gatewayWorkflowCommandTypes,
  ...gatewayManagementCommandTypes,
  ...gatewayWorkflowQueryTypes,
  ...gatewayManagementQueryTypes,
  ...gatewayBusinessCommandTypes,
  ...gatewayBusinessQueryTypes
] as const;
export type OperationName = (typeof operationNames)[number];

export type GatewayWorkflowCommand =
  | { readonly type: 'agent.control.set_enabled'; readonly payload: { readonly enabled: boolean } }
  | { readonly type: 'agent.clients.update_access'; readonly payload: { readonly clientId: string; readonly scopes: readonly AgentScope[]; readonly trust: TrustProfile } }
  | { readonly type: 'agent.clients.revoke'; readonly payload: { readonly clientId: string } }
  | { readonly type: 'agent.sessions.terminate'; readonly payload: { readonly sessionId: string } }
  | { readonly type: 'agent.r4_grants.create'; readonly payload: { readonly grant: R4GrantCreateInput } }
  | { readonly type: 'agent.r4_grants.revoke'; readonly payload: { readonly grantId: string } }
  | { readonly type: 'agent.approvals.approve'; readonly payload: { readonly approvalId: string } }
  | { readonly type: 'agent.approvals.reject'; readonly payload: { readonly approvalId: string; readonly reasonCode: string } }
  | { readonly type: 'agent.changesets.apply'; readonly payload: { readonly changeSetId: string } }
  | { readonly type: 'agent.changesets.reject'; readonly payload: { readonly changeSetId: string; readonly reasonCode: string } }
  | { readonly type: 'agent.changesets.rollback'; readonly payload: { readonly changeSetId: string } }
  | { readonly type: 'agent.policy.update'; readonly payload: { readonly policyVersion: string; readonly overrides: readonly OperationPolicyOverride[] } }
  | { readonly type: 'agent.audit.export'; readonly payload: { readonly cursor?: AuditCursor; readonly redaction: RedactionProfile; readonly pageSize: number } }
  | { readonly type: 'agent.audit.cleanup'; readonly payload: { readonly before: string; readonly grantId: string } };

export type GatewayWorkflowQuery =
  | { readonly type: 'agent.status.get'; readonly payload: Record<string, never> }
  | { readonly type: 'agent.clients.list'; readonly payload: { readonly cursor?: string; readonly pageSize: number } }
  | { readonly type: 'agent.sessions.list'; readonly payload: { readonly clientId?: string; readonly cursor?: string; readonly pageSize: number } }
  | { readonly type: 'agent.r4_grants.list'; readonly payload: { readonly clientId?: string; readonly status?: R4GrantStatus; readonly cursor?: string; readonly pageSize: number } }
  | { readonly type: 'agent.approvals.list'; readonly payload: { readonly status?: ApprovalStatus; readonly cursor?: string; readonly pageSize: number } }
  | { readonly type: 'agent.changesets.list'; readonly payload: { readonly status?: ChangeSetStatus; readonly cursor?: string; readonly pageSize: number } }
  | { readonly type: 'agent.changesets.get'; readonly payload: { readonly changeSetId: string } }
  | { readonly type: 'agent.audit.search'; readonly payload: { readonly cursor?: AuditCursor; readonly kinds?: readonly AuditKind[]; readonly clientId?: string; readonly pageSize: number; readonly redaction: RedactionProfile } }
  | { readonly type: 'agent.audit.verify'; readonly payload: { readonly segmentId?: string } }
  | { readonly type: 'agent.policy.get'; readonly payload: Record<string, never> }
  | { readonly type: 'agent.catalog.get'; readonly payload: Record<string, never> }
  | { readonly type: 'agent.privacy.get'; readonly payload: Record<string, never> };

export interface PublicKeyBindingInput {
  readonly clientId: string;
  readonly publicKeyFormat: 'spki-der-base64url';
  readonly publicKey: string;
  readonly publicKeyFingerprint: string;
  readonly signatureAlgorithm: 'rsa-pss-sha256';
  readonly expectedRegistryGeneration: number;
}

export interface GatewayRegisterKeyCommand {
  readonly type: 'agent.clients.register_key';
  readonly payload: PublicKeyBindingInput;
}

export interface GatewayRotateKeyCommand {
  readonly type: 'agent.clients.rotate_key';
  readonly payload: PublicKeyBindingInput;
}

export type GatewayJobCommand =
  | { readonly type: 'jobs.create'; readonly payload: import('./jobs').JobCreateInput }
  | { readonly type: 'jobs.cancel'; readonly payload: import('./jobs').JobCancelInput };

export type GatewayManagementCommand = GatewayRegisterKeyCommand | GatewayRotateKeyCommand | GatewayJobCommand;

export interface GatewayReceiptStatusQuery {
  readonly type: 'agent.receipts.get_status';
  readonly payload: { readonly clientId: string; readonly requestId: string };
}

export type GatewayJobQuery =
  | { readonly type: 'jobs.get'; readonly payload: import('./jobs').JobGetInput }
  | { readonly type: 'jobs.list'; readonly payload: import('./jobs').JobListInput }
  | { readonly type: 'jobs.result'; readonly payload: import('./jobs').JobResultInput };

export type GatewayManagementQuery = GatewayReceiptStatusQuery | GatewayJobQuery;

export interface SafeClientKeyBindingResult {
  readonly apiVersion: AgentApiVersion;
  readonly kind: 'client-key-binding';
  readonly clientId: string;
  readonly publicKeyFormat: 'spki-der-base64url';
  readonly publicKeyFingerprint: string;
  readonly signatureAlgorithm: 'rsa-pss-sha256';
  readonly keyGeneration: number;
  readonly registryGeneration: number;
  readonly status: 'registered' | 'rotated';
}

export type SafeReceiptTerminal =
  | { readonly kind: 'command-result'; readonly result: CommandResult }
  | { readonly kind: 'serialized-agent-error'; readonly error: SerializedAgentError };

export interface SafeReceiptStatusResult {
  readonly apiVersion: AgentApiVersion;
  readonly kind: 'receipt-status';
  readonly clientId: string;
  readonly requestId: string;
  readonly status: ReceiptStatus;
  readonly receipt: ExecutionReceipt;
  readonly terminal?: SafeReceiptTerminal;
}

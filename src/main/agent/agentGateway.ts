import { randomUUID } from 'node:crypto';
import { AgentError, serializeAgentError, type SerializedAgentError } from '../../shared/agent/errors';
import { agentApiVersion } from '../../shared/agent/versions';
import type { CommandResult, DataVersion, EntityRef, QueryResult, TrustedExecutionContext } from '../../shared/agent/v1/contracts';
import {
  type AgentCommandEnvelope,
  type AgentExecuteOutcome,
  type AgentGateway as AgentGatewayContract,
  type AgentPrincipal,
  type AgentQueryEnvelope,
  type AgentQueryOutcome,
  type ApprovalRecord,
  type ChangeSet,
  type JsonObject,
  type OperationDescriptor,
  type PageInfo,
  type PolicyDecision,
  type R4Grant,
  type WorkflowOutcomeReference,
  type WorkflowReference
} from '../../shared/agent/v1/gatewayContracts';
import {
  assertCatalogIdentity,
  validateAgentCommandEnvelope,
  validateAgentQueryEnvelope
} from '../../shared/agent/v1/gatewaySchemas';
import { operationCatalogIdentity, resolveOperationDescriptor } from '../../shared/agent/v1/operationCatalog';
import type { AgentControlSettings } from './clientRegistry';
import type { AdmissionResult, IdempotencyAdmissionRequest, PreparedExecutionReceipt } from './idempotencyStore';
import type { ResolvedPolicyState } from './policyEngine';
import type { ChangeSetApplyBinding, WorkflowBinding } from './workflows';

export interface GatewayResolvedState extends ResolvedPolicyState {
  readonly affectedEntities: readonly EntityRef[];
  readonly dataVersion?: DataVersion;
}

export interface GatewayAuthorization {
  readonly settings: AgentControlSettings;
}

export interface GatewayWorkflowBinding {
  readonly principal: AgentPrincipal;
  readonly envelope: AgentCommandEnvelope;
  readonly descriptor: OperationDescriptor;
  readonly decision: PolicyDecision;
  readonly state: GatewayResolvedState;
}

export interface GatewayCommandPlan {
  readonly descriptor: OperationDescriptor;
  readonly payload: JsonObject;
  readonly state: GatewayResolvedState;
  readonly dispatch: 'business' | 'management';
  readonly operation: AgentCommandEnvelope['operation'];
  readonly expectedVersion?: DataVersion;
  readonly changeSetApply?: ChangeSetApplyBinding;
  readonly changeSetAlreadyApplied?: boolean;
  readonly localApprovedChangeSet?: true;
}

export interface GatewayApprovalAuthority {
  readonly approvalId: string;
  readonly binding: WorkflowBinding;
}

export interface GatewayWorkflowPort {
  getR4Grant(reference: WorkflowReference | undefined): Promise<R4Grant | undefined>;
  authorizeApproval(reference: WorkflowReference, binding: GatewayWorkflowBinding): Promise<GatewayApprovalAuthority>;
  authorizeChangeSet(reference: WorkflowReference, binding: GatewayWorkflowBinding): Promise<ChangeSetApplyBinding>;
  createApproval(binding: GatewayWorkflowBinding): Promise<ApprovalRecord>;
  createChangeSet(binding: GatewayWorkflowBinding): Promise<ChangeSet>;
  queryManagement(envelope: AgentQueryEnvelope, principal: AgentPrincipal): Promise<QueryResult>;
}

export interface GatewayAuditPort {
  denial(input: {
    readonly principal: AgentPrincipal;
    readonly envelope: AgentCommandEnvelope | AgentQueryEnvelope;
    readonly descriptor?: OperationDescriptor;
    readonly decision?: PolicyDecision;
    readonly error: SerializedAgentError;
  }): Promise<void>;
  query(input: {
    readonly principal: AgentPrincipal;
    readonly envelope: AgentQueryEnvelope;
    readonly descriptor: OperationDescriptor;
    readonly decision: PolicyDecision;
    readonly result?: QueryResult;
    readonly error?: SerializedAgentError;
  }): Promise<void>;
}

export interface AgentGatewayDependencies {
  authorize(principal: AgentPrincipal): Promise<GatewayAuthorization>;
  resolveState(
    envelope: AgentCommandEnvelope | AgentQueryEnvelope,
    descriptor: OperationDescriptor,
    principal: AgentPrincipal
  ): Promise<GatewayResolvedState>;
  resolveCommand(
    envelope: AgentCommandEnvelope,
    descriptor: OperationDescriptor,
    principal: AgentPrincipal
  ): Promise<GatewayCommandPlan>;
  evaluatePolicy(input: {
    readonly principal: AgentPrincipal;
    readonly descriptor: OperationDescriptor;
    readonly payload: JsonObject;
    readonly state: GatewayResolvedState;
    readonly settings: AgentControlSettings;
    readonly pageSize?: number;
    readonly r4Grant?: R4Grant;
    readonly localApprovedChangeSet?: true;
  }): PolicyDecision;
  validateCommand(envelope: AgentCommandEnvelope, descriptor: OperationDescriptor): void;
  validateQuery(envelope: AgentQueryEnvelope, descriptor: OperationDescriptor): void;
  admit(request: IdempotencyAdmissionRequest): Promise<AdmissionResult>;
  dispatchCommand(
    plan: GatewayCommandPlan,
    context: TrustedExecutionContext,
    prepared: PreparedExecutionReceipt,
    approval?: GatewayApprovalAuthority,
    changeSet?: ChangeSetApplyBinding
  ): Promise<CommandResult>;
  dispatchManagement(
    envelope: AgentCommandEnvelope,
    principal: AgentPrincipal,
    decision: PolicyDecision,
    prepared: PreparedExecutionReceipt
  ): Promise<CommandResult>;
  dispatchQuery(envelope: AgentQueryEnvelope, context: TrustedExecutionContext): Promise<QueryResult>;
  terminalizeKnownFailure(prepared: PreparedExecutionReceipt, error: unknown): Promise<void>;
  readonly workflows: GatewayWorkflowPort;
  readonly audit: GatewayAuditPort;
  readonly now?: () => string;
  readonly randomUUID?: () => string;
}

interface GatewayRuntime {
  readonly dependencies: AgentGatewayDependencies;
  readonly now: () => string;
  readonly randomUUID: () => string;
}

function rejected(error: unknown): AgentExecuteOutcome & AgentQueryOutcome {
  return Object.freeze({ kind: 'rejected' as const, error: serializeAgentError(error) });
}

function trustedContext(
  runtime: GatewayRuntime,
  principal: AgentPrincipal,
  requestId: string,
  expectedVersion?: DataVersion
): TrustedExecutionContext {
  return Object.freeze({
    trust: 'trusted' as const,
    requestId,
    traceId: runtime.randomUUID().toLowerCase(),
    source: principal.renderer ? 'renderer' as const : 'mcp' as const,
    actor: Object.freeze({ actorId: principal.subjectId, actorType: principal.renderer ? 'user' as const : 'agent' as const }),
    client: Object.freeze({ clientId: principal.clientId, clientName: principal.displayName }),
    timestamp: new Date(runtime.now()).toISOString(),
    concurrency: expectedVersion ? 'strict' as const : 'none' as const,
    ...(expectedVersion ? { expectedVersion: Object.freeze({ ...expectedVersion }) } : {})
  });
}

function workflowReference(record: ApprovalRecord | ChangeSet): WorkflowOutcomeReference {
  if ('approvalId' in record) {
    return Object.freeze({ kind: 'approval' as const, id: record.approvalId, expiresAt: record.expiresAt });
  }
  return Object.freeze({ kind: 'changeset' as const, id: record.changeSetId, expiresAt: record.expiresAt });
}

function effectiveWorkflowReference(envelope: AgentCommandEnvelope): WorkflowReference | undefined {
  if (envelope.operation !== 'agent.audit.cleanup') return envelope.workflow;
  const grantId = envelope.payload.grantId;
  if (typeof grantId !== 'string') throw new AgentError('R4_GRANT_INVALID');
  if (envelope.workflow && (envelope.workflow.kind !== 'r4-grant' || envelope.workflow.id !== grantId)) {
    throw new AgentError('R4_GRANT_INVALID');
  }
  return Object.freeze({ kind: 'r4-grant' as const, id: grantId });
}

function replayOutcome(admission: Extract<AdmissionResult, { kind: 'replayed' }>): AgentExecuteOutcome {
  if (admission.receipt.status === 'completed' && 'changed' in admission.outcome) {
    return Object.freeze({
      kind: 'replayed' as const,
      result: admission.outcome as CommandResult,
      receiptId: admission.receipt.receiptId
    });
  }
  return Object.freeze({ kind: 'rejected' as const, error: admission.outcome as SerializedAgentError });
}

async function auditDenial(
  runtime: GatewayRuntime,
  principal: AgentPrincipal,
  envelope: AgentCommandEnvelope | AgentQueryEnvelope,
  error: unknown,
  descriptor?: OperationDescriptor,
  decision?: PolicyDecision
): Promise<AgentExecuteOutcome & AgentQueryOutcome> {
  const serialized = serializeAgentError(error);
  try {
    await runtime.dependencies.audit.denial({ principal, envelope, descriptor, decision, error: serialized });
  } catch {
    return rejected(new AgentError('AUDIT_UNAVAILABLE'));
  }
  return Object.freeze({ kind: 'rejected' as const, error: serialized });
}

function canAuditAuthorizationFailure(error: unknown): boolean {
  return error instanceof AgentError && ![
    'POLICY_DENIED',
    'RECOVERY_FENCE',
    'MAINTENANCE_FENCE',
    'PERSISTENCE_INDETERMINATE',
    'AUDIT_INTEGRITY_FAILURE',
    'AUDIT_UNAVAILABLE'
  ].includes(error.code);
}

async function authorizeWorkflow(
  runtime: GatewayRuntime,
  reference: WorkflowReference | undefined,
  binding: GatewayWorkflowBinding
): Promise<{ readonly outcome?: AgentExecuteOutcome; readonly approval?: GatewayApprovalAuthority; readonly changeSet?: ChangeSetApplyBinding }> {
  if (binding.decision.disposition === 'deny') {
    return Object.freeze({ outcome: await auditDenial(runtime, binding.principal, binding.envelope, new AgentError('POLICY_DENIED'), binding.descriptor, binding.decision) });
  }
  if (binding.decision.disposition === 'requires_approval') {
    if (reference?.kind === 'approval') {
      return Object.freeze({ approval: await runtime.dependencies.workflows.authorizeApproval(reference, binding) });
    }
    const approval = await runtime.dependencies.workflows.createApproval(binding);
    return Object.freeze({ outcome: Object.freeze({ kind: 'pending_approval' as const, workflow: workflowReference(approval) }) });
  }
  if (binding.decision.disposition === 'requires_changeset') {
    if (reference?.kind === 'changeset') {
      return Object.freeze({ changeSet: await runtime.dependencies.workflows.authorizeChangeSet(reference, binding) });
    }
    const changeSet = await runtime.dependencies.workflows.createChangeSet(binding);
    return Object.freeze({ outcome: Object.freeze({ kind: 'pending_changeset' as const, workflow: workflowReference(changeSet) }) });
  }
  if (reference && reference.kind !== 'r4-grant') throw new AgentError('APPROVAL_INVALID');
  return Object.freeze({});
}

async function executeGateway(
  runtime: GatewayRuntime,
  envelope: AgentCommandEnvelope,
  principal: AgentPrincipal
): Promise<AgentExecuteOutcome> {
  let authorization: GatewayAuthorization;
  try {
    authorization = await runtime.dependencies.authorize(principal);
  } catch (error) {
    return canAuditAuthorizationFailure(error)
      ? auditDenial(runtime, principal, envelope, error)
      : rejected(error);
  }

  let descriptor: OperationDescriptor | undefined;
  try {
    validateAgentCommandEnvelope(envelope);
    assertCatalogIdentity(envelope.catalog, operationCatalogIdentity);
    descriptor = resolveOperationDescriptor(envelope.operation);
    if (descriptor.kind !== 'command') throw new AgentError('VALIDATION_ERROR', { field: 'envelope.operation' });
    runtime.dependencies.validateCommand(envelope, descriptor);
  } catch (error) {
    return auditDenial(runtime, principal, envelope, error, descriptor);
  }

  let plan: GatewayCommandPlan;
  let decision: PolicyDecision;
  let workflowReference: WorkflowReference | undefined;
  try {
    plan = await runtime.dependencies.resolveCommand(envelope, descriptor, principal);
    workflowReference = effectiveWorkflowReference(envelope);
    const r4Grant = await runtime.dependencies.workflows.getR4Grant(workflowReference);
    decision = runtime.dependencies.evaluatePolicy({
      principal,
      descriptor: plan.descriptor,
      payload: plan.payload,
      state: plan.state,
      settings: authorization.settings,
      ...(plan.localApprovedChangeSet ? { localApprovedChangeSet: true as const } : {}),
      ...(r4Grant ? { r4Grant } : {})
    });
  } catch (error) {
    return auditDenial(runtime, principal, envelope, error, descriptor);
  }

  const binding = Object.freeze({ principal, envelope, descriptor: plan.descriptor, decision, state: plan.state });
  let approval: GatewayApprovalAuthority | undefined;
  let changeSet: ChangeSetApplyBinding | undefined;
  try {
    if (plan.changeSetApply && decision.disposition === 'requires_changeset') {
      if (workflowReference && workflowReference.kind !== 'r4-grant') throw new AgentError('APPROVAL_INVALID');
    } else {
      const workflow = await authorizeWorkflow(runtime, workflowReference, binding);
      if (workflow.outcome) return workflow.outcome;
      approval = workflow.approval;
      changeSet = workflow.changeSet;
    }
  } catch (error) {
    return auditDenial(runtime, principal, envelope, error, plan.descriptor, decision);
  }

  let admission: AdmissionResult;
  try {
    admission = await runtime.dependencies.admit({
      clientId: principal.clientId,
      requestId: envelope.requestId,
      operation: descriptor.name,
      payload: envelope.payload,
      affectedEntities: plan.state.affectedEntities,
      baseVersion: plan.expectedVersion,
      catalog: operationCatalogIdentity,
      risk: decision.risk,
      policyVersion: decision.policyVersion,
      ...(decision.risk === 'R4' && workflowReference?.kind === 'r4-grant'
        ? {
            r4: {
              grantId: workflowReference.id,
              targetHash: plan.state.targetHash!,
              recovery: plan.descriptor.recovery,
              maxAffectedEntities: plan.descriptor.policyBounds.maxAffectedEntities,
              expiresAt: new Date(Date.parse(runtime.now()) + 5 * 60_000).toISOString()
            }
          }
        : {})
    });
  } catch (error) {
    return rejected(error);
  }
  if (admission.kind === 'replayed') return replayOutcome(admission);
  if (admission.kind === 'pending') return rejected(new AgentError('RECOVERY_FENCE'));
  if (plan.changeSetAlreadyApplied) {
    const error = new AgentError('APPROVAL_INVALID');
    try {
      await runtime.dependencies.terminalizeKnownFailure(admission.prepared, error);
    } catch (terminalError) {
      return rejected(terminalError);
    }
    return rejected(error);
  }

  const context = trustedContext(runtime, principal, envelope.requestId, plan.expectedVersion);
  try {
    const result = plan.dispatch === 'management'
      ? await runtime.dependencies.dispatchManagement(envelope, principal, decision, admission.prepared)
      : await runtime.dependencies.dispatchCommand(plan, context, admission.prepared, approval, changeSet);
    return Object.freeze({ kind: 'completed' as const, result });
  } catch (error) {
    if (error instanceof AgentError && (error.code === 'PERSISTENCE_INDETERMINATE' || error.code === 'RECOVERY_FENCE')) {
      return rejected(error);
    }
    try {
      await runtime.dependencies.terminalizeKnownFailure(admission.prepared, error);
    } catch (terminalError) {
      return rejected(terminalError);
    }
    return rejected(error);
  }
}

async function queryGateway(
  runtime: GatewayRuntime,
  envelope: AgentQueryEnvelope,
  principal: AgentPrincipal
): Promise<AgentQueryOutcome> {
  let authorization: GatewayAuthorization;
  try {
    authorization = await runtime.dependencies.authorize(principal);
  } catch (error) {
    return canAuditAuthorizationFailure(error)
      ? auditDenial(runtime, principal, envelope, error)
      : rejected(error);
  }

  let descriptor: OperationDescriptor | undefined;
  try {
    validateAgentQueryEnvelope(envelope);
    assertCatalogIdentity(envelope.catalog, operationCatalogIdentity);
    descriptor = resolveOperationDescriptor(envelope.operation);
    if (descriptor.kind !== 'query') throw new AgentError('VALIDATION_ERROR', { field: 'envelope.operation' });
    runtime.dependencies.validateQuery(envelope, descriptor);
  } catch (error) {
    return auditDenial(runtime, principal, envelope, error, descriptor);
  }

  let decision: PolicyDecision;
  try {
    const state = await runtime.dependencies.resolveState(envelope, descriptor, principal);
    decision = runtime.dependencies.evaluatePolicy({
      principal,
      descriptor,
      payload: envelope.payload,
      state,
      settings: authorization.settings,
      pageSize: envelope.page?.pageSize ?? ('pageSize' in envelope.payload ? Number(envelope.payload.pageSize) : undefined)
    });
    if (decision.disposition !== 'execute') {
      return auditDenial(runtime, principal, envelope, new AgentError('POLICY_DENIED'), descriptor, decision);
    }
  } catch (error) {
    return auditDenial(runtime, principal, envelope, error, descriptor);
  }

  const context = trustedContext(runtime, principal, envelope.requestId);
  let result: QueryResult;
  try {
    result = descriptor.domain === 'management'
      ? await runtime.dependencies.workflows.queryManagement(envelope, principal)
      : await runtime.dependencies.dispatchQuery(envelope, context);
  } catch (error) {
    const serialized = serializeAgentError(error);
    try {
      await runtime.dependencies.audit.query({ principal, envelope, descriptor, decision, error: serialized });
    } catch {
      return rejected(new AgentError('AUDIT_UNAVAILABLE'));
    }
    return Object.freeze({ kind: 'rejected' as const, error: serialized });
  }

  try {
    await runtime.dependencies.audit.query({ principal, envelope, descriptor, decision, result });
  } catch {
    return rejected(new AgentError('AUDIT_UNAVAILABLE'));
  }
  const candidatePage = result.value && typeof result.value === 'object' && 'page' in (result.value as object)
    ? (result.value as { readonly page?: PageInfo }).page
    : undefined;
  return Object.freeze({ kind: 'completed' as const, result, ...(candidatePage ? { page: candidatePage } : {}) });
}

export class AgentGateway implements AgentGatewayContract {
  readonly #runtime: GatewayRuntime;

  constructor(dependencies: AgentGatewayDependencies) {
    this.#runtime = Object.freeze({
      dependencies,
      now: dependencies.now ?? (() => new Date().toISOString()),
      randomUUID: dependencies.randomUUID ?? randomUUID
    });
    Object.freeze(this);
  }

  execute(envelope: AgentCommandEnvelope, principal: AgentPrincipal): Promise<AgentExecuteOutcome> {
    return executeGateway(this.#runtime, envelope, principal);
  }

  query(envelope: AgentQueryEnvelope, principal: AgentPrincipal): Promise<AgentQueryOutcome> {
    return queryGateway(this.#runtime, envelope, principal);
  }
}

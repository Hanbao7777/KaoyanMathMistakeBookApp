import { randomUUID as nodeRandomUUID } from 'node:crypto';
import type { Database } from 'sql.js';
import { AgentError } from '../../shared/agent/errors';
import { agentApiVersion } from '../../shared/agent/versions';
import type { AppCommand, AppQuery, CommandResult, EntityRef, QueryResult, TrustedExecutionContext } from '../../shared/agent/v1/contracts';
import {
  gatewayBusinessCommandTypes,
  gatewayBusinessQueryTypes,
  type AgentCommandEnvelope,
  type AgentPrincipal,
  type AgentQueryEnvelope,
  type ChangeSet,
  type ClientAuthenticator,
  type GatewayWorkflowCommand,
  type GatewayWorkflowQuery,
  type GatewayManagementCommand,
  type JsonObject,
  type JsonValue,
  type OperationDescriptor,
  type OperationName,
  type OperationPolicyOverride,
  type PolicyDecision,
  type RawClientCredentials,
  type R4Grant,
  type WorkflowReference
} from '../../shared/agent/v1/gatewayContracts';
import {
  assertCatalogIdentity,
  hashCanonicalJson,
  validateR4Grant,
  validateGatewayManagementCommand,
  validateGatewayManagementQuery,
  validateGatewayWorkflowCommand,
  validateGatewayWorkflowQuery
} from '../../shared/agent/v1/gatewaySchemas';
import { operationCatalog, operationCatalogIdentity, resolveOperationDescriptor } from '../../shared/agent/v1/operationCatalog';
import { validateCommandEnvelope, validateQueryEnvelope } from '../../shared/agent/v1/schemas';
import {
  createCommandBusExecutionReceiptCapability,
  type CommandBus
} from '../application/commandBus';
import type { QueryBus } from '../application/queryBus';
import {
  isTickTickCommandOperation,
  isTickTickQueryOperation,
  validateTickTickCommand,
  validateTickTickQuery,
  type TickTickApplication,
  type TickTickCommand,
  type TickTickQuery
} from '../application/ticktick';
import {
  createDatabaseCoordinatorControlCapability,
  type DatabaseMutationResult,
  type DatabaseMutationScope,
  type DatabaseCoordinator
} from '../persistence/databaseCoordinator';
import { AgentGateway, type GatewayCommandPlan, type GatewayResolvedState, type GatewayWorkflowBinding } from './agentGateway';
import { AuditLedger } from './auditLedger';
import {
  assertIssuedAgentPrincipal,
  createAuthenticationAdapters,
  createRegistryPrincipalAuthenticator,
  type RawCredentialVerifier,
  type VerifiedCredentialBindings
} from './clientAuthenticator';
import { ClientRegistry } from './clientRegistry';
import { ExecutionReceipts } from './executionReceipts';
import { IdempotencyStore, type ReceiptRecoveryEvidence } from './idempotencyStore';
import { PaginationService, redactSensitiveValue } from './pagination';
import { PolicyEngine } from './policyEngine';
import type { RendererIdentityAdapter } from './rendererAdapter';
import { StdioPublicKeyAuthenticator } from '../mcp/auth/stdioAuthenticator';
import { WorkflowStore, type ChangeSetApplyBinding, type WorkflowBinding } from './workflows';

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

export interface AgentGatewayBootstrapOptions extends AgentB3BootstrapOptions {
  readonly commandBus: CommandBus;
  readonly queryBus: QueryBus;
  readonly selectedCandidateEvidence: true;
  readonly onRecoveryStage?: (stage: 'audit_verified' | 'receipts_reconciled') => void;
  readonly resolveState?: (
    envelope: AgentCommandEnvelope | AgentQueryEnvelope,
    descriptor: OperationDescriptor,
    principal: AgentPrincipal
  ) => Promise<GatewayResolvedState> | GatewayResolvedState;
  readonly executeBusinessCommand?: (
    command: AppCommand,
    context: TrustedExecutionContext,
    dispatch: () => Promise<CommandResult>
  ) => Promise<CommandResult>;
  readonly tickTickApplication?: TickTickApplication;
}

export interface AgentGatewayComposition {
  readonly gateway: AgentGateway;
  readonly authenticator: ClientAuthenticator;
  readonly renderer: RendererIdentityAdapter;
  readonly stdioAuthenticator: StdioPublicKeyAuthenticator;
  readonly externalControlEnabled: () => Promise<boolean>;
}

function normalizedAffectedEntities(payload: JsonObject): readonly EntityRef[] {
  const references: EntityRef[] = [];
  const candidates: readonly [string, string][] = [
    ['questionId', 'question'], ['imageId', 'question_image'], ['reviewLogId', 'review_log'],
    ['taskId', 'task'], ['sessionId', 'focus_session']
  ];
  for (const [field, entityType] of candidates) {
    const value = payload[field];
    if (typeof value === 'string' || typeof value === 'number') references.push({ entityType, entityId: String(value) });
  }
  const questionIds = payload.questionIds;
  if (Array.isArray(questionIds)) {
    for (const questionId of questionIds) if (typeof questionId === 'number') references.push({ entityType: 'question', entityId: String(questionId) });
  }
  if (references.length === 0) references.push({ entityType: 'operation', entityId: 'bounded-target' });
  const unique = new Map(references.map((reference) => [`${reference.entityType}\0${reference.entityId}`, Object.freeze(reference)]));
  return Object.freeze([...unique.values()].sort((left, right) => `${left.entityType}\0${left.entityId}`.localeCompare(`${right.entityType}\0${right.entityId}`)));
}

function immutableQuery(value: unknown, version: { readonly dataEpoch: string; readonly dataRevision: number }): QueryResult {
  return Object.freeze({ value, dataVersion: Object.freeze({ ...version }) });
}

function controlValue<T extends object>(mutation: DatabaseMutationResult<unknown>, value: T): DatabaseMutationResult<T> {
  return { changed: mutation.changed, value: Object.freeze(value) };
}

function workflowBinding(binding: GatewayWorkflowBinding): WorkflowBinding {
  const baseVersion = binding.envelope.expectedVersion ?? binding.state.dataVersion;
  if (!baseVersion) throw new AgentError('APPROVAL_INVALID');
  if (
    !binding.state.dataVersion ||
    binding.state.dataVersion.dataEpoch !== baseVersion.dataEpoch ||
    binding.state.dataVersion.dataRevision !== baseVersion.dataRevision
  ) throw new AgentError('APPROVAL_INVALID');
  return Object.freeze({
    clientId: binding.principal.clientId,
    operation: binding.descriptor.name,
    payloadHash: hashCanonicalJson(binding.envelope.payload),
    affectedSetHash: hashCanonicalJson(binding.state.affectedEntities),
    baseVersion,
    catalog: operationCatalogIdentity
  });
}

function assertApproval(record: Awaited<ReturnType<WorkflowStore['getApproval']>>, binding: GatewayWorkflowBinding): asserts record {
  const requiredScopes = [...binding.descriptor.requiredScopes].sort();
  const approvedScopes = record ? [...record.requiredScopes].sort() : [];
  if (
    !record || record.status !== 'approved' || record.clientId !== binding.principal.clientId ||
    record.credentialBinding !== binding.principal.credentialBinding || record.operation !== binding.descriptor.name ||
    record.policyVersion !== binding.decision.policyVersion || record.risk !== binding.decision.risk ||
    approvedScopes.length !== requiredScopes.length ||
    approvedScopes.some((scope, index) => scope !== requiredScopes[index]) ||
    record.requiredScopes.some((scope) => !binding.principal.scopes.includes(scope))
  ) throw new AgentError('APPROVAL_INVALID');
}

async function fenceCoordinator(coordinator: DatabaseCoordinator): Promise<void> {
  if (coordinator.state === 'needs_recovery') return;
  const lease = await coordinator.beginMaintenance();
  coordinator.finishMaintenance(lease, 'needs_recovery');
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

export async function bootstrapAgentGateway(options: AgentGatewayBootstrapOptions): Promise<AgentGatewayComposition> {
  const controlCapability = createDatabaseCoordinatorControlCapability(options.coordinator);
  const executeControlWrite = <T>(request: import('../persistence/databaseCoordinator').DatabaseControlWriteRequest<T>) =>
    options.coordinator.executeControlWrite(controlCapability, request);
  const now = options.now ?? (() => new Date().toISOString());
  const uuid = options.randomUUID ?? nodeRandomUUID;
  const audit = new AuditLedger({ executeControlWrite, catalog: operationCatalogIdentity, now, randomUUID: uuid });
  const workflows = new WorkflowStore({ executeControlWrite, audit, now, randomUUID: uuid });
  const idempotency = new IdempotencyStore({ executeControlWrite, audit, workflows, now, randomUUID: uuid });

  try {
    if (options.selectedCandidateEvidence !== true) throw new AgentError('RECOVERY_FENCE');
    const verification = await audit.verify();
    options.onRecoveryStage?.('audit_verified');
    const recoveryEvidence: ReceiptRecoveryEvidence = Object.freeze({ selectedCandidate: true, ledgerVerified: verification.valid });
    await idempotency.reconcileInterruptedPrecommit(recoveryEvidence);
    options.onRecoveryStage?.('receipts_reconciled');
  } catch (error) {
    await fenceCoordinator(options.coordinator);
    throw error;
  }

  const registry = new ClientRegistry({
    executeControlWrite,
    appInstanceId: options.appInstanceId,
    catalog: operationCatalogIdentity,
    now,
    randomUUID: uuid
  });
  try {
    await registry.initialize();
  } catch (error) {
    await fenceCoordinator(options.coordinator);
    throw error;
  }
  const pendingBindings = new WeakMap<object, VerifiedCredentialBindings>();
  const liveBindings = new WeakMap<object, VerifiedCredentialBindings>();
  const authentication = createAuthenticationAdapters(registry, Object.freeze({
    async verify(credentials: RawClientCredentials) {
      const bindings = await options.credentialVerifier.verify(credentials);
      pendingBindings.set(credentials, bindings);
      return bindings;
    }
  }), now);
  const authenticator: ClientAuthenticator = Object.freeze({
    async authenticate(credentials: RawClientCredentials) {
      try {
        const principal = await authentication.authenticator.authenticate(credentials);
        const bindings = pendingBindings.get(credentials);
        if (!bindings) throw new AgentError('CLIENT_REVOKED');
        liveBindings.set(principal, bindings);
        return principal;
      } finally {
        pendingBindings.delete(credentials);
      }
    }
  });
  const policy = new PolicyEngine(now);
  const pagination = new PaginationService(options.cursorSecret);
  const receipts = new ExecutionReceipts({ audit, workflows, now });
  const receiptCapability = createCommandBusExecutionReceiptCapability(options.commandBus);

  const authorize = async (principal: AgentPrincipal) => {
    assertIssuedAgentPrincipal(principal);
    if (principal.renderer) return Object.freeze({ settings: await registry.getSettings() });
    const bindings = liveBindings.get(principal);
    if (!bindings) throw new AgentError('CLIENT_REVOKED');
    const live = await registry.authenticate(bindings.credentialFingerprint, bindings.sessionFingerprint);
    if (
      live.clientId !== principal.clientId || live.subjectId !== principal.subjectId || live.displayName !== principal.displayName ||
      live.credentialBinding !== principal.credentialBinding || live.trust !== principal.trust ||
      live.scopes.length !== principal.scopes.length || live.scopes.some((scope, index) => scope !== principal.scopes[index])
    ) throw new AgentError('CLIENT_REVOKED');
    return Object.freeze({ settings: await registry.getSettings() });
  };

  const fallbackResolveState = (envelope: AgentCommandEnvelope | AgentQueryEnvelope) => {
    const affectedEntities = normalizedAffectedEntities(envelope.payload);
    return Object.freeze({
      affectedEntityCount: affectedEntities.length,
      affectedEntities,
      affectedSetHash: hashCanonicalJson(affectedEntities),
      targetHash: hashCanonicalJson({ operation: envelope.operation, affectedEntities }),
      dataVersion: Object.freeze({ ...options.coordinator.currentVersion() })
    });
  };
  const businessStateBindings = new Map<string, { payloadHash: string; state: GatewayResolvedState }>();
  const resolveState = (
    envelope: AgentCommandEnvelope | AgentQueryEnvelope,
    descriptor: OperationDescriptor,
    principal: AgentPrincipal
  ) => {
    if (descriptor.domain === 'management' || !options.resolveState) return fallbackResolveState(envelope);
    if (envelope.kind === 'agent-query') return options.resolveState(envelope, descriptor, principal);
    const key = `${principal.clientId}\0${envelope.requestId}`;
    const payloadHash = hashCanonicalJson(envelope.payload);
    const existing = businessStateBindings.get(key);
    if (existing?.payloadHash === payloadHash) return existing.state;
    const resolved = options.resolveState(envelope, descriptor, principal);
    if (resolved instanceof Promise) {
      return resolved.then((state) => {
        businessStateBindings.set(key, { payloadHash, state });
        if (businessStateBindings.size > 1_000) businessStateBindings.delete(businessStateBindings.keys().next().value!);
        return state;
      });
    }
    businessStateBindings.set(key, { payloadHash, state: resolved });
    if (businessStateBindings.size > 1_000) businessStateBindings.delete(businessStateBindings.keys().next().value!);
    return resolved;
  };

  const validateBusinessCommand = (envelope: AgentCommandEnvelope) => {
    if (!(gatewayBusinessCommandTypes as readonly string[]).includes(envelope.operation)) throw new AgentError('VALIDATION_ERROR');
    if (isTickTickCommandOperation(envelope.operation)) {
      if (!options.tickTickApplication) throw new AgentError('HANDLER_NOT_FOUND');
      validateTickTickCommand({ type: envelope.operation, payload: envelope.payload });
      return;
    }
    validateCommandEnvelope({
      apiVersion: agentApiVersion,
      kind: 'command',
      context: {
        trust: 'trusted', requestId: envelope.requestId, traceId: uuid(), source: 'internal',
        actor: { actorId: 'gateway-validation', actorType: 'system' }, client: { clientId: 'gateway-validation' },
        timestamp: now(), concurrency: 'none'
      },
      command: { type: envelope.operation, payload: envelope.payload } as AppCommand
    });
  };
  const validateBusinessQuery = (envelope: AgentQueryEnvelope) => {
    if (!(gatewayBusinessQueryTypes as readonly string[]).includes(envelope.operation)) throw new AgentError('VALIDATION_ERROR');
    if (isTickTickQueryOperation(envelope.operation)) {
      if (!options.tickTickApplication) throw new AgentError('HANDLER_NOT_FOUND');
      validateTickTickQuery({ type: envelope.operation, payload: envelope.payload });
      return;
    }
    validateQueryEnvelope({
      apiVersion: agentApiVersion,
      kind: 'query',
      context: {
        trust: 'trusted', requestId: envelope.requestId, traceId: uuid(), source: 'internal',
        actor: { actorId: 'gateway-validation', actorType: 'system' }, client: { clientId: 'gateway-validation' },
        timestamp: now(), concurrency: 'none'
      },
      query: { type: envelope.operation, payload: envelope.payload } as AppQuery
    });
  };

  const resolveCommand = async (
    envelope: AgentCommandEnvelope,
    descriptor: OperationDescriptor,
    principal: AgentPrincipal
  ): Promise<GatewayCommandPlan> => {
    if (envelope.operation !== 'agent.changesets.apply') {
      const state = await resolveState(envelope, descriptor, principal);
      const expectedVersion = envelope.expectedVersion ?? (descriptor.policyBounds.maximumRisk === 'R4' ? state.dataVersion : undefined);
      return Object.freeze({
        descriptor,
        payload: envelope.payload,
        state,
        dispatch: descriptor.domain === 'management' ? 'management' as const : 'business' as const,
        operation: envelope.operation,
        ...(expectedVersion ? { expectedVersion } : {})
      });
    }
    if (descriptor.requiredScopes.some((scope) => !principal.scopes.includes(scope))) throw new AgentError('SCOPE_DENIED');
    const changeSetId = String(envelope.payload.changeSetId);
    const changeSet = await workflows.getChangeSet(changeSetId);
    if (
      !changeSet || !['approved', 'applied'].includes(changeSet.status) || (!principal.renderer && changeSet.clientId !== principal.clientId) ||
      changeSet.catalog.version !== operationCatalogIdentity.version || changeSet.catalog.hash !== operationCatalogIdentity.hash ||
      changeSet.operations.length !== 1
    ) throw new AgentError('APPROVAL_INVALID');
    const operation = changeSet.operations[0];
    if (
      operation.payloadHash !== hashCanonicalJson(operation.payload) ||
      changeSet.affectedSetHash !== hashCanonicalJson(operation.affectedEntities)
    ) throw new AgentError('APPROVAL_INVALID');
    const plannedDescriptor = resolveOperationDescriptor(operation.operation);
    if (plannedDescriptor.kind !== 'command' || plannedDescriptor.domain === 'management') throw new AgentError('APPROVAL_INVALID');
    if (principal.renderer) {
      const owner = await registry.getActiveClientSummary(changeSet.clientId);
      if (plannedDescriptor.requiredScopes.some((scope) => !owner.scopes.includes(scope))) throw new AgentError('SCOPE_DENIED');
      if (owner.trust === 'observer') throw new AgentError('POLICY_DENIED');
    }
    const plannedEnvelope: AgentCommandEnvelope = Object.freeze({
      ...envelope,
      operation: operation.operation,
      payload: operation.payload,
      expectedVersion: changeSet.baseVersion,
      workflow: undefined
    });
    validateBusinessCommand(plannedEnvelope);
    const state = await resolveState(plannedEnvelope, plannedDescriptor, principal);
    if (state.affectedSetHash !== changeSet.affectedSetHash || !state.dataVersion) throw new AgentError('APPROVAL_INVALID');
    if (
      changeSet.status === 'approved' &&
      (state.dataVersion.dataEpoch !== changeSet.baseVersion.dataEpoch || state.dataVersion.dataRevision !== changeSet.baseVersion.dataRevision)
    ) throw new AgentError('APPROVAL_INVALID');
    const applyBinding: ChangeSetApplyBinding = Object.freeze({
      changeSetId,
      clientId: changeSet.clientId,
      operation: operation.operation,
      payloadHash: operation.payloadHash,
      affectedSetHash: changeSet.affectedSetHash,
      baseVersion: changeSet.baseVersion,
      catalog: changeSet.catalog
    });
    return Object.freeze({
      descriptor: plannedDescriptor,
      payload: operation.payload,
      state,
      dispatch: 'business' as const,
      operation: operation.operation,
      expectedVersion: changeSet.baseVersion,
      changeSetApply: applyBinding,
      ...(principal.renderer ? { localApprovedChangeSet: true as const } : {}),
      ...(changeSet.status === 'applied' ? { changeSetAlreadyApplied: true } : {})
    });
  };

  const managementMutation = (
    database: Database,
    scope: DatabaseMutationScope,
    command: GatewayWorkflowCommand | GatewayManagementCommand,
    principal: AgentPrincipal,
    decision: PolicyDecision
  ): DatabaseMutationResult<unknown> => {
    switch (command.type) {
      case 'agent.clients.register_key': return registry.registerPublicKeyInTransaction(database, scope, command.payload, false);
      case 'agent.clients.rotate_key': return registry.registerPublicKeyInTransaction(database, scope, command.payload, true);
      case 'agent.control.set_enabled': return controlValue(registry.setExternalControlEnabledInTransaction(database, scope, command.payload.enabled), { enabled: command.payload.enabled });
      case 'agent.clients.update_access': return controlValue(registry.updateClientAccessInTransaction(database, scope, command.payload.clientId, command.payload.scopes, command.payload.trust), { clientId: command.payload.clientId, scopes: command.payload.scopes, trust: command.payload.trust });
      case 'agent.clients.revoke': return controlValue(registry.revokeClientInTransaction(database, scope, command.payload.clientId), { clientId: command.payload.clientId, revoked: true });
      case 'agent.sessions.terminate': return controlValue(registry.terminateSessionInTransaction(database, scope, command.payload.sessionId), { sessionId: command.payload.sessionId, terminated: true });
      case 'agent.r4_grants.create': {
        const request = command.payload.grant;
        if (!principal.renderer && request.clientId !== principal.clientId) throw new AgentError('SCOPE_DENIED');
        const targetDescriptor = resolveOperationDescriptor(request.operation);
        const issuedAt = now();
        if (
          targetDescriptor.policyBounds.maximumRisk !== 'R4' || !targetDescriptor.policyBounds.requiresR4GrantWhenRiskR4 ||
          targetDescriptor.policyBounds.maxAffectedEntities !== request.maxAffectedEntities ||
          Date.parse(request.expiresAt) <= Date.parse(issuedAt)
        ) throw new AgentError('R4_GRANT_INVALID');
        const target = registry.getActiveClientSummaryInTransaction(database, scope, request.clientId);
        if (target.trust === 'observer' || targetDescriptor.requiredScopes.some((scope) => !target.scopes.includes(scope))) throw new AgentError('SCOPE_DENIED');
        const grant = Object.freeze({
          apiVersion: agentApiVersion,
          grantId: uuid().toLowerCase(),
          clientId: request.clientId,
          operation: request.operation,
          payloadHash: request.payloadHash,
          targetHash: request.targetHash,
          catalog: operationCatalogIdentity,
          recovery: targetDescriptor.recovery,
          maxAffectedEntities: request.maxAffectedEntities,
          maxUses: 1 as const,
          status: 'active' as const,
          issuedAt,
          expiresAt: request.expiresAt
        });
        validateR4Grant(grant);
        return workflows.createR4GrantInTransaction(database, scope, grant);
      }
      case 'agent.r4_grants.revoke': return controlValue(workflows.revokeR4GrantInTransaction(database, scope, command.payload.grantId, principal.clientId, principal.renderer), { grantId: command.payload.grantId, revoked: true });
      case 'agent.approvals.approve': return workflows.decideApprovalInTransaction(database, scope, command.payload.approvalId, 'approved', principal.renderer ? 'user' : 'policy');
      case 'agent.approvals.reject': return workflows.decideApprovalInTransaction(database, scope, command.payload.approvalId, 'rejected', principal.renderer ? 'user' : 'policy');
      case 'agent.changesets.reject': return workflows.transitionChangeSetInTransaction(database, scope, command.payload.changeSetId, 'rejected');
      case 'agent.changesets.rollback': throw new AgentError('HANDLER_NOT_FOUND');
      case 'agent.changesets.apply': throw new AgentError('APPROVAL_INVALID');
      case 'agent.policy.update': return controlValue(
        registry.updatePolicyInTransaction(database, scope, command.payload.policyVersion, command.payload.overrides as readonly OperationPolicyOverride[]),
        { policyVersion: command.payload.policyVersion }
      );
      case 'agent.audit.cleanup': return controlValue(audit.rotateAndApplyRetentionInTransaction(database, scope, {
          before: command.payload.before,
          clientId: principal.clientId,
          operation: command.type,
          risk: decision.risk,
          policyVersion: decision.policyVersion,
          summary: Object.freeze({ action: 'audit_cleanup' })
        }), { before: command.payload.before });
      case 'agent.audit.export': {
        const visibility = principal.renderer ? undefined : principal.clientId;
        const window = pagination.createWindow({
          query: { operation: command.type, clientId: visibility ?? null, redaction: { ...command.payload.redaction } },
          cursor: command.payload.cursor?.value,
          pageSize: command.payload.pageSize,
          maxPageSize: 200
        });
        const afterSequence = window.afterKey === undefined ? undefined : Number(window.afterKey);
        if (afterSequence !== undefined && (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) throw new AgentError('CURSOR_INVALID');
        const exported = audit.exportVerifiedPageInTransaction(database, scope, afterSequence, window.pageSize + 1, visibility);
        const page = pagination.complete(exported.records, window, (record) => String(record.sequence).padStart(20, '0'));
        const records = page.items.map((record) => redactSensitiveValue(record as unknown as JsonValue, command.payload.redaction));
        return {
          changed: false,
          value: Object.freeze({ valid: exported.valid, segments: exported.segments, events: exported.events, headHash: exported.headHash, records: Object.freeze(records), page: page.page })
        };
      }
    }
  };

  const gateway = new AgentGateway({
    authorize,
    resolveState: async (envelope, descriptor, principal) => resolveState(envelope, descriptor, principal),
    resolveCommand,
    evaluatePolicy: (input) => policy.evaluate({
      principal: input.principal,
      descriptor: input.descriptor,
      input: input.payload,
      state: input.state,
      settings: input.settings,
      pageSize: input.pageSize,
      r4Grant: input.r4Grant,
      localApprovedChangeSet: input.localApprovedChangeSet
    }),
    validateCommand(envelope, descriptor) {
      if (descriptor.domain === 'management') {
        if ((['agent.clients.register_key', 'agent.clients.rotate_key'] as readonly string[]).includes(envelope.operation)) {
          validateGatewayManagementCommand({ type: envelope.operation as GatewayManagementCommand['type'], payload: envelope.payload });
        } else validateGatewayWorkflowCommand({ type: envelope.operation as GatewayWorkflowCommand['type'], payload: envelope.payload });
      }
      else validateBusinessCommand(envelope);
    },
    validateQuery(envelope, descriptor) {
      if (descriptor.domain === 'management') {
        if (envelope.operation === 'agent.receipts.get_status') {
          validateGatewayManagementQuery({ type: envelope.operation, payload: envelope.payload });
        } else validateGatewayWorkflowQuery({ type: envelope.operation as GatewayWorkflowQuery['type'], payload: envelope.payload });
      }
      else validateBusinessQuery(envelope);
    },
    admit: (request) => idempotency.admit(request),
    dispatchCommand(plan, context, prepared, approval, changeSet) {
      const terminalHook = receipts.createTerminalHook(prepared, {
        ...(approval ? { approval } : {}),
        ...(plan.changeSetApply || changeSet ? { changeSet: plan.changeSetApply ?? changeSet } : {})
      });
      if (isTickTickCommandOperation(plan.operation)) {
        if (!options.tickTickApplication) throw new AgentError('HANDLER_NOT_FOUND');
        return options.tickTickApplication.execute(
          { type: plan.operation, payload: plan.payload } as TickTickCommand,
          context,
          terminalHook
        );
      }
      const command = { type: plan.operation, payload: plan.payload } as AppCommand;
      const dispatch = () => options.commandBus.executeWithExecutionReceipt(
        receiptCapability,
        { apiVersion: agentApiVersion, kind: 'command', context, command },
        terminalHook
      );
      return options.executeBusinessCommand ? options.executeBusinessCommand(command, context, dispatch) : dispatch();
    },
    async dispatchManagement(envelope, principal, decision, prepared) {
      const command = { type: envelope.operation, payload: envelope.payload } as GatewayWorkflowCommand | GatewayManagementCommand;
      const result = await executeControlWrite({
        requestId: `agent-control-command-${envelope.requestId}`,
        execute: (database, scope) => {
          const mutation = managementMutation(database, scope, command, principal, decision);
          const value = receipts.finalizeControlSuccessInTransaction(database, scope, prepared, mutation);
          return { changed: true, value };
        }
      });
      return result.value;
    },
    dispatchQuery(envelope, context) {
      if (isTickTickQueryOperation(envelope.operation)) {
        if (!options.tickTickApplication) throw new AgentError('HANDLER_NOT_FOUND');
        return Promise.resolve(options.tickTickApplication.query(
          { type: envelope.operation, payload: envelope.payload } as TickTickQuery,
          context
        ));
      }
      return Promise.resolve(options.queryBus.execute({
        apiVersion: agentApiVersion,
        kind: 'query',
        context,
        query: { type: envelope.operation, payload: envelope.payload } as AppQuery
      }));
    },
    terminalizeKnownFailure: async (prepared, error) => { await idempotency.terminalizeKnownFailure(prepared, error); },
    workflows: {
      async getR4Grant(reference: WorkflowReference | undefined): Promise<R4Grant | undefined> {
        return reference?.kind === 'r4-grant' ? workflows.getR4Grant(reference.id) : undefined;
      },
      async authorizeApproval(reference, binding) {
        const approval = await workflows.getApproval(reference.id);
        assertApproval(approval, binding);
        return Object.freeze({ approvalId: reference.id, binding: workflowBinding(binding) });
      },
      async authorizeChangeSet(reference, binding) {
        const changeSet = await workflows.getChangeSet(reference.id);
        const expected = workflowBinding(binding);
        if (
          !changeSet || changeSet.status !== 'approved' || changeSet.clientId !== expected.clientId || changeSet.operations.length !== 1 ||
          changeSet.operations[0].operation !== expected.operation || changeSet.operations[0].payloadHash !== expected.payloadHash ||
          changeSet.affectedSetHash !== expected.affectedSetHash
        ) throw new AgentError('APPROVAL_INVALID');
        return Object.freeze({ ...expected, changeSetId: reference.id });
      },
      createApproval(binding) {
        const baseVersion = binding.envelope.expectedVersion ?? binding.state.dataVersion;
        if (!baseVersion) throw new AgentError('APPROVAL_INVALID');
        const createdAt = now();
        return workflows.createApproval(Object.freeze({
          apiVersion: agentApiVersion,
          approvalId: uuid().toLowerCase(),
          nonce: uuid().toLowerCase(),
          clientId: binding.principal.clientId,
          credentialBinding: binding.principal.credentialBinding,
          operation: binding.descriptor.name,
          payloadHash: hashCanonicalJson(binding.envelope.payload),
          affectedSetHash: hashCanonicalJson(binding.state.affectedEntities),
          baseVersion,
          catalog: operationCatalogIdentity,
          policyVersion: binding.decision.policyVersion,
          risk: binding.decision.risk,
          requiredScopes: binding.descriptor.requiredScopes,
          recovery: binding.descriptor.recovery,
          status: 'pending',
          createdAt,
          expiresAt: new Date(Date.parse(createdAt) + 15 * 60_000).toISOString()
        }));
      },
      createChangeSet(binding) {
        const baseVersion = binding.envelope.expectedVersion ?? binding.state.dataVersion;
        if (!baseVersion || binding.decision.risk === 'R0' || binding.decision.risk === 'R1') {
          throw new AgentError('APPROVAL_INVALID');
        }
        const createdAt = now();
        return workflows.createChangeSet(Object.freeze({
          apiVersion: agentApiVersion,
          changeSetId: uuid().toLowerCase(),
          clientId: binding.principal.clientId,
          status: 'draft',
          catalog: operationCatalogIdentity,
          baseVersion,
          risk: binding.decision.risk,
          summary: `Planned ${binding.descriptor.name}`,
          operations: Object.freeze([Object.freeze({
            operation: binding.descriptor.name,
            payload: binding.envelope.payload,
            payloadHash: hashCanonicalJson(binding.envelope.payload),
            affectedEntities: binding.state.affectedEntities
          })]),
          affectedSetHash: hashCanonicalJson(binding.state.affectedEntities),
          recovery: binding.descriptor.recovery,
          createdAt,
          expiresAt: new Date(Date.parse(createdAt) + 30 * 60_000).toISOString()
        }));
      },
      async queryManagement(envelope, principal) {
        const query = { type: envelope.operation, payload: envelope.payload } as GatewayWorkflowQuery | import('../../shared/agent/v1/gatewayContracts').GatewayManagementQuery;
        let value: unknown;
        switch (query.type) {
          case 'agent.status.get': value = Object.freeze({ settings: await registry.getSettings(), runtimeState: options.coordinator.state }); break;
          case 'agent.clients.list': {
            const visibility = principal.renderer ? undefined : principal.clientId;
            const window = pagination.createWindow({ query: { operation: query.type, clientId: visibility ?? null }, cursor: query.payload.cursor, pageSize: query.payload.pageSize, maxPageSize: 200 });
            const items = await registry.listClientsWindow({ clientId: visibility, afterClientId: window.afterKey, limit: window.pageSize + 1 });
            value = pagination.complete(items, window, (item) => item.clientId);
            break;
          }
          case 'agent.sessions.list': {
            const visibility = principal.renderer ? query.payload.clientId : principal.clientId;
            const window = pagination.createWindow({ query: { operation: query.type, clientId: visibility ?? null }, cursor: query.payload.cursor, pageSize: query.payload.pageSize, maxPageSize: 200 });
            const items = await registry.listSessionsWindow({ clientId: visibility, afterKey: window.afterKey, limit: window.pageSize + 1 });
            value = pagination.complete(items, window, (item) => `${item.clientId}\0${item.sessionId}`);
            break;
          }
          case 'agent.r4_grants.list': {
            const visibility = principal.renderer ? query.payload.clientId : principal.clientId;
            const window = pagination.createWindow({ query: { operation: query.type, clientId: visibility ?? null, status: query.payload.status ?? null }, cursor: query.payload.cursor, pageSize: query.payload.pageSize, maxPageSize: 200 });
            const items = await workflows.listR4Grants({ clientId: visibility, status: query.payload.status, afterKey: window.afterKey, limit: window.pageSize + 1 });
            value = pagination.complete(items, window, (item) => `${item.issuedAt}\0${item.grantId}`);
            break;
          }
          case 'agent.approvals.list': {
            const visibility = principal.renderer ? undefined : principal.clientId;
            const window = pagination.createWindow({ query: { operation: query.type, clientId: visibility ?? null, status: query.payload.status ?? null }, cursor: query.payload.cursor, pageSize: query.payload.pageSize, maxPageSize: 200 });
            const items = await workflows.listApprovals({ clientId: visibility, status: query.payload.status, afterKey: window.afterKey, limit: window.pageSize + 1 });
            value = pagination.complete(items, window, (item) => `${item.createdAt}\0${item.approvalId}`);
            break;
          }
          case 'agent.changesets.list': {
            const visibility = principal.renderer ? undefined : principal.clientId;
            const window = pagination.createWindow({ query: { operation: query.type, clientId: visibility ?? null, status: query.payload.status ?? null }, cursor: query.payload.cursor, pageSize: query.payload.pageSize, maxPageSize: 200 });
            const items = await workflows.listChangeSets({ clientId: visibility, status: query.payload.status, afterKey: window.afterKey, limit: window.pageSize + 1 });
            value = pagination.complete(items, window, (item) => `${item.createdAt}\0${item.changeSetId}`);
            break;
          }
          case 'agent.changesets.get': {
            const changeSet = await workflows.getChangeSet(query.payload.changeSetId);
            if (changeSet && !principal.renderer && changeSet.clientId !== principal.clientId) throw new AgentError('SCOPE_DENIED');
            value = changeSet;
            break;
          }
          case 'agent.audit.search': {
            const visibility = principal.renderer ? query.payload.clientId : principal.clientId;
            const window = pagination.createWindow({
              query: { operation: query.type, clientId: visibility ?? null, kinds: query.payload.kinds ?? [], redaction: { ...query.payload.redaction } },
              cursor: query.payload.cursor?.value,
              pageSize: query.payload.pageSize,
              maxPageSize: 200
            });
            const afterSequence = window.afterKey === undefined ? undefined : Number(window.afterKey);
            if (afterSequence !== undefined && (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) throw new AgentError('CURSOR_INVALID');
            const searched = await audit.searchWindow({ afterSequence, pageSize: window.pageSize + 1, clientId: visibility, kinds: query.payload.kinds });
            const page = pagination.complete(searched.records, window, (record) => String(record.sequence).padStart(20, '0'));
            value = Object.freeze({
              items: Object.freeze(page.items.map((record) => redactSensitiveValue(record as unknown as JsonValue, query.payload.redaction))),
              page: page.page
            });
            break;
          }
          case 'agent.audit.verify': value = await audit.verify(); break;
          case 'agent.policy.get': value = await registry.getSettings(); break;
          case 'agent.catalog.get': value = operationCatalog; break;
          case 'agent.privacy.get': value = Object.freeze({ revision: (await registry.getSettings()).privacyRevision, externalModelDataDisclosureRequired: true }); break;
          case 'agent.receipts.get_status': {
            if (!principal.renderer && query.payload.clientId !== principal.clientId) throw new AgentError('SCOPE_DENIED');
            const found = await idempotency.get(query.payload.clientId, query.payload.requestId);
            if (!found) throw new AgentError('HANDLER_NOT_FOUND');
            value = Object.freeze({ apiVersion: agentApiVersion, kind: 'receipt-status', clientId: query.payload.clientId,
              requestId: query.payload.requestId, status: found.receipt.status, receipt: found.receipt,
              ...(found.outcome ? { terminal: 'changed' in found.outcome ? { kind: 'command-result', result: found.outcome } : { kind: 'serialized-agent-error', error: found.outcome } } : {}) });
            break;
          }
        }
        return immutableQuery(value ?? null, options.coordinator.currentVersion());
      }
    },
    audit: {
      async denial(input) {
        await audit.recordDenial({
          clientId: input.principal.clientId,
          requestId: input.envelope.requestId,
          operation: input.descriptor?.name,
          risk: input.decision?.risk,
          policyVersion: input.decision?.policyVersion,
          summary: Object.freeze({ action: 'gateway_denied', errorCode: input.error.code })
        });
      },
      async query(input) {
        await audit.recordQuery({
          clientId: input.principal.clientId,
          requestId: input.envelope.requestId,
          operation: input.descriptor.name,
          risk: input.decision.risk,
          policyVersion: input.decision.policyVersion,
          summary: Object.freeze({
            action: input.error ? 'query_failed' : 'query_completed',
            ...(input.error ? { errorCode: input.error.code } : { resultHash: hashCanonicalJson(input.result!) })
          })
        });
      }
    },
    now,
    randomUUID: uuid
  });

  const stdioAuthenticator = new StdioPublicKeyAuthenticator({
    registry,
    authenticatePrincipal: createRegistryPrincipalAuthenticator(registry),
    appInstanceId: options.appInstanceId,
    now: () => new Date(now()),
    randomUUID: uuid
  });
  return Object.freeze({ gateway, authenticator, renderer: authentication.renderer, stdioAuthenticator, externalControlEnabled: async () => (await registry.getSettings()).externalControlEnabled });
}

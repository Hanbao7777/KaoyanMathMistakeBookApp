import { randomUUID } from 'node:crypto';
import { AgentError } from '../../../shared/agent/errors';
import { agentApiVersion } from '../../../shared/agent/versions';
import type {
  AgentControlApi,
  AgentControlApprovalSummary,
  AgentControlAuditSummary,
  AgentControlChangeSetSummary,
  AgentControlClientSummary,
  AgentControlMutationAcknowledgement,
  AgentControlPage,
  AgentControlPrivacyDisclosure,
  AgentControlR4GrantSummary,
  AgentControlSessionSummary,
  AgentControlStatus,
  AgentControlVerification
} from '../../../shared/api';
import type {
  AgentQueryOutcome,
  AgentScope,
  ApprovalRecord,
  AuditRecord,
  ChangeSet,
  GatewayWorkflowCommand,
  GatewayWorkflowQuery,
  R4Grant,
  TrustProfile
} from '../../../shared/agent/v1/gatewayContracts';
import { operationCatalogIdentity } from '../../../shared/agent/v1/operationCatalog';
import { getAgentControlPlane } from '../../services/databaseService';
import { PairingService, loadPackagedLauncherArtifact } from '../../mcp/pairing/pairingService';
import { validatePairingRequest, validatePairingStatus, validatePairingTargetRequest, type PairingRequest, type PairingStatus, type PairingTargetRequest } from '../../../shared/mcp/v1/pairingContracts';
import path from 'node:path';
import { app } from 'electron';

const MAX_PAGE_SIZE = 100;
const SAFE_REDACTION = Object.freeze({
  apiVersion: agentApiVersion,
  kind: 'redaction-profile' as const,
  detail: 'standard' as const,
  includeUserContent: false,
  includeAffectedEntities: true,
  fields: Object.freeze([])
});

type ControlPlane = Awaited<ReturnType<typeof getAgentControlPlane>>;
type PageValue<T> = { readonly items: readonly T[]; readonly page: AgentControlPage<T>['page'] };
type AuditVerificationValue = { readonly valid: boolean; readonly segments: number; readonly events: number; readonly headHash?: string };
type ControlSettings = { readonly externalControlEnabled: boolean; readonly policyVersion: string; readonly privacyRevision: number };
type DirectHttpsStatus = { readonly port: number; readonly authority: string; readonly resource: string; readonly issuer: string; readonly appInstanceId: string; readonly enabled: boolean; readonly state?: 'disabled' | 'ready' | 'stopped'; readonly reason?: string; readonly certificateThumbprint?: string; readonly rootCaThumbprint?: string };

let externalControlLifecycle: ((enabled: boolean) => Promise<void> | void) | undefined;
let directHttpsStatus: (() => Omit<DirectHttpsStatus, 'enabled'> | undefined) | undefined;

export function configureExternalControlLifecycle(handler?: (enabled: boolean) => Promise<void> | void): void {
  externalControlLifecycle = handler;
}

export function configureDirectHttpsStatus(handler?: () => Omit<DirectHttpsStatus, 'enabled'> | undefined): void {
  directHttpsStatus = handler;
}

function pageSize(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) throw new AgentError('VALIDATION_ERROR', { field: 'pageSize' });
  return value;
}

function rejected(outcome: { readonly error: { readonly code: ConstructorParameters<typeof AgentError>[0]; readonly details?: ConstructorParameters<typeof AgentError>[1] } }): AgentError {
  return new AgentError(outcome.error.code, outcome.error.details);
}

function mapPage<TInput, TOutput>(value: PageValue<TInput>, mapper: (item: TInput) => TOutput): AgentControlPage<TOutput> {
  return Object.freeze({ items: Object.freeze(value.items.map(mapper)), page: Object.freeze({ ...value.page }) });
}

function mapClient(value: { readonly clientId: string; readonly subjectId: string; readonly displayName: string; readonly scopes: readonly AgentScope[]; readonly trust: TrustProfile; readonly revokedAt?: string; readonly lastActiveAt?: string }): AgentControlClientSummary {
  return Object.freeze({ ...value, scopes: Object.freeze([...value.scopes]) });
}

function mapSession(value: AgentControlSessionSummary): AgentControlSessionSummary {
  return Object.freeze({ ...value });
}

function mapR4Grant(value: R4Grant): AgentControlR4GrantSummary {
  return Object.freeze({
    grantId: value.grantId,
    clientId: value.clientId,
    operation: value.operation,
    recovery: value.recovery,
    maxAffectedEntities: value.maxAffectedEntities,
    status: value.status,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    ...(value.consumedAt ? { consumedAt: value.consumedAt } : {}),
    ...(value.revokedAt ? { revokedAt: value.revokedAt } : {})
  });
}

function mapApproval(value: ApprovalRecord): AgentControlApprovalSummary {
  return Object.freeze({
    approvalId: value.approvalId,
    clientId: value.clientId,
    operation: value.operation,
    status: value.status,
    risk: value.risk,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt
  });
}

function mapChangeSet(value: ChangeSet): AgentControlChangeSetSummary {
  return Object.freeze({
    changeSetId: value.changeSetId,
    clientId: value.clientId,
    status: value.status,
    summary: value.summary,
    risk: value.risk,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt
  });
}

function mapAudit(value: AuditRecord): AgentControlAuditSummary {
  return Object.freeze({
    sequence: value.sequence,
    clientId: value.clientId,
    kind: value.kind,
    occurredAt: value.occurredAt,
    ...(value.operation ? { operation: value.operation } : {}),
    ...(value.risk ? { risk: value.risk } : {})
  });
}

function mapStatus(value: { readonly settings: ControlSettings; readonly runtimeState: string; readonly directHttps?: DirectHttpsStatus | null }): AgentControlStatus {
  const runtimeDirectHttps = directHttpsStatus?.();
  const directHttps = value.directHttps ? Object.freeze({ ...value.directHttps, ...(runtimeDirectHttps ?? {}) }) : undefined;
  return Object.freeze({
    settings: Object.freeze({
      externalControlEnabled: value.settings.externalControlEnabled,
      policyVersion: value.settings.policyVersion,
      privacyRevision: value.settings.privacyRevision
    }),
    runtimeState: value.runtimeState,
    ...(directHttps ? { directHttps } : {})
  }) as AgentControlStatus;
}

function mapAcknowledgement(value: { readonly clientId?: string; readonly sessionId?: string; readonly grantId?: string; readonly approvalId?: string; readonly changeSetId?: string; readonly enabled?: boolean; readonly revoked?: boolean; readonly terminated?: boolean }): AgentControlMutationAcknowledgement {
  return Object.freeze({
    ...(value.clientId ? { clientId: value.clientId } : {}),
    ...(value.sessionId ? { sessionId: value.sessionId } : {}),
    ...(value.grantId ? { grantId: value.grantId } : {}),
    ...(value.approvalId ? { approvalId: value.approvalId } : {}),
    ...(value.changeSetId ? { changeSetId: value.changeSetId } : {}),
    ...(value.enabled !== undefined ? { enabled: value.enabled } : {}),
    ...(value.revoked !== undefined ? { revoked: value.revoked } : {}),
    ...(value.terminated !== undefined ? { terminated: value.terminated } : {})
  });
}

function mapVerification(value: AuditVerificationValue): AgentControlVerification {
  return Object.freeze({ ...value });
}

export function createAgentControlCenterIpc(loadControlPlane: () => Promise<ControlPlane> = getAgentControlPlane, loadPairingService?: () => Promise<PairingService>): AgentControlApi {
  let pairingService: Promise<PairingService> | undefined;
  const pairing = () => pairingService ??= (loadPairingService ? loadPairingService() : (async () => {
    const controlPlane = await loadControlPlane();
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) throw new Error('LOCALAPPDATA is unavailable');
    const userData = app.getPath('userData');
    const injectedResources = !app.isPackaged ? process.env.KAOYAN_MCP_DEV_RESOURCES_PATH : undefined;
    const resourcesPath = injectedResources ?? process.resourcesPath;
    return new PairingService({ gateway: controlPlane.gateway, principal: () => controlPlane.renderer.principal(),
      launcherArtifact: loadPackagedLauncherArtifact(resourcesPath), localAppData,
      discoveryRoot: userData, journalRoot: path.join(userData, 'mcp-journal') });
  })());
  async function pairingResult(result: Promise<PairingStatus>): Promise<PairingStatus> { const value = await result; validatePairingStatus(value, 'pairingResult'); return value; }
  async function execute(command: GatewayWorkflowCommand): Promise<unknown> {
    const controlPlane = await loadControlPlane();
    const outcome = await controlPlane.gateway.execute({
      apiVersion: agentApiVersion,
      kind: 'agent-command',
      operation: command.type,
      payload: command.payload as never,
      requestId: randomUUID(),
      catalog: operationCatalogIdentity
    }, controlPlane.renderer.principal());
    if (outcome.kind === 'completed' || outcome.kind === 'replayed') return outcome.result.value;
    if (outcome.kind === 'rejected') throw rejected(outcome);
    throw new AgentError('APPROVAL_REQUIRED');
  }

  async function query(request: GatewayWorkflowQuery): Promise<unknown> {
    const controlPlane = await loadControlPlane();
    const outcome: AgentQueryOutcome = await controlPlane.gateway.query({
      apiVersion: agentApiVersion,
      kind: 'agent-query',
      operation: request.type,
      payload: request.payload as never,
      requestId: randomUUID(),
      catalog: operationCatalogIdentity
    }, controlPlane.renderer.principal());
    if (outcome.kind === 'rejected') throw rejected(outcome);
    return outcome.result.value;
  }

  return Object.freeze({
    async getStatus() { return mapStatus(await query({ type: 'agent.status.get', payload: {} }) as { readonly settings: ControlSettings; readonly runtimeState: string; readonly directHttps?: DirectHttpsStatus | null }); },
    async setExternalControlEnabled(enabled: boolean) {
      const result = (await execute({ type: 'agent.control.set_enabled', payload: { enabled } }) as { readonly enabled: boolean }).enabled;
      await externalControlLifecycle?.(result);
      return Object.freeze({ enabled: result });
    },
    async listClients(request = {}) { return mapPage(await query({ type: 'agent.clients.list', payload: { ...(request.cursor ? { cursor: request.cursor } : {}), pageSize: pageSize(request.pageSize) } }) as PageValue<AgentControlClientSummary>, mapClient); },
    async updateClientAccess(clientId: string, scopes: readonly AgentScope[], trust: TrustProfile) { return mapAcknowledgement(await execute({ type: 'agent.clients.update_access', payload: { clientId, scopes, trust } }) as AgentControlMutationAcknowledgement); },
    async revokeClient(clientId: string) { return mapAcknowledgement(await execute({ type: 'agent.clients.revoke', payload: { clientId } }) as AgentControlMutationAcknowledgement); },
    async listSessions(request = {}) { return mapPage(await query({ type: 'agent.sessions.list', payload: { ...(request.clientId ? { clientId: request.clientId } : {}), ...(request.cursor ? { cursor: request.cursor } : {}), pageSize: pageSize(request.pageSize) } }) as PageValue<AgentControlSessionSummary>, mapSession); },
    async terminateSession(sessionId: string) { return mapAcknowledgement(await execute({ type: 'agent.sessions.terminate', payload: { sessionId } }) as AgentControlMutationAcknowledgement); },
    async listR4Grants(request = {}) { return mapPage(await query({ type: 'agent.r4_grants.list', payload: { ...(request.clientId ? { clientId: request.clientId } : {}), ...(request.status ? { status: request.status } : {}), ...(request.cursor ? { cursor: request.cursor } : {}), pageSize: pageSize(request.pageSize) } }) as PageValue<R4Grant>, mapR4Grant); },
    async createR4Grant(grant) { return mapR4Grant(await execute({ type: 'agent.r4_grants.create', payload: { grant } }) as R4Grant); },
    async revokeR4Grant(grantId: string) { return mapAcknowledgement(await execute({ type: 'agent.r4_grants.revoke', payload: { grantId } }) as AgentControlMutationAcknowledgement); },
    async listApprovals(request = {}) { return mapPage(await query({ type: 'agent.approvals.list', payload: { ...(request.status ? { status: request.status } : {}), ...(request.cursor ? { cursor: request.cursor } : {}), pageSize: pageSize(request.pageSize) } }) as PageValue<ApprovalRecord>, mapApproval); },
    async approve(approvalId: string) { return mapAcknowledgement(await execute({ type: 'agent.approvals.approve', payload: { approvalId } }) as AgentControlMutationAcknowledgement); },
    async rejectApproval(approvalId: string, reasonCode: string) { return mapAcknowledgement(await execute({ type: 'agent.approvals.reject', payload: { approvalId, reasonCode } }) as AgentControlMutationAcknowledgement); },
    async listChangeSets(request = {}) { return mapPage(await query({ type: 'agent.changesets.list', payload: { ...(request.status ? { status: request.status } : {}), ...(request.cursor ? { cursor: request.cursor } : {}), pageSize: pageSize(request.pageSize) } }) as PageValue<ChangeSet>, mapChangeSet); },
    async getChangeSet(changeSetId: string) { const value = await query({ type: 'agent.changesets.get', payload: { changeSetId } }) as ChangeSet | null; return value ? mapChangeSet(value) : null; },
    async applyChangeSet(changeSetId: string) { return mapAcknowledgement(await execute({ type: 'agent.changesets.apply', payload: { changeSetId } }) as AgentControlMutationAcknowledgement); },
    async rejectChangeSet(changeSetId: string, reasonCode: string) { return mapAcknowledgement(await execute({ type: 'agent.changesets.reject', payload: { changeSetId, reasonCode } }) as AgentControlMutationAcknowledgement); },
    async searchAudit(request = {}) { return mapPage(await query({ type: 'agent.audit.search', payload: { ...(request.clientId ? { clientId: request.clientId } : {}), ...(request.kinds ? { kinds: request.kinds } : {}), ...(request.cursor ? { cursor: { apiVersion: agentApiVersion, kind: 'audit-cursor', value: request.cursor } } : {}), pageSize: pageSize(request.pageSize), redaction: SAFE_REDACTION } }) as PageValue<AuditRecord>, mapAudit); },
    async exportAudit(request = {}) { return mapVerification(await execute({ type: 'agent.audit.export', payload: { ...(request.cursor ? { cursor: { apiVersion: agentApiVersion, kind: 'audit-cursor', value: request.cursor } } : {}), pageSize: pageSize(request.pageSize), redaction: SAFE_REDACTION } }) as AuditVerificationValue); },
    async verifyAudit(segmentId?: string) { return mapVerification(await query({ type: 'agent.audit.verify', payload: segmentId ? { segmentId } : {} }) as AuditVerificationValue); },
    async getPolicy() { const value = await query({ type: 'agent.policy.get', payload: {} }) as ControlSettings; return Object.freeze({ policyVersion: value.policyVersion, externalControlEnabled: value.externalControlEnabled }); },
    async getCatalog() { const value = await query({ type: 'agent.catalog.get', payload: {} }) as { readonly version: string; readonly hash: string }; return Object.freeze({ version: value.version, hash: value.hash }); },
    async getPrivacyDisclosure() { const value = await query({ type: 'agent.privacy.get', payload: {} }) as AgentControlPrivacyDisclosure; return Object.freeze({ ...value }); },
    async connectClient(request: PairingRequest) { validatePairingRequest(request, 'connectClient'); return pairingResult((await pairing()).connect(request)); },
    async getClientConnection(request: PairingTargetRequest) { validatePairingTargetRequest(request, 'getClientConnection'); return pairingResult((await pairing()).health(request)); },
    async repairClientConnection(request: PairingTargetRequest) { validatePairingTargetRequest(request, 'repairClientConnection'); return pairingResult((await pairing()).repair(request)); },
    async rotateClientKey(request: PairingTargetRequest) { validatePairingTargetRequest(request, 'rotateClientKey'); return pairingResult((await pairing()).rotate(request)); },
    async disconnectClientConnection(request: PairingTargetRequest) { validatePairingTargetRequest(request, 'disconnectClientConnection'); return pairingResult((await pairing()).disconnect(request)); }
  } satisfies AgentControlApi);
}

export const agentControlCenterIpc = createAgentControlCenterIpc();

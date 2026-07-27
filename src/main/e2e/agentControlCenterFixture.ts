import fs from 'node:fs';
import { createInternalExecutionContext } from '../application/executionContext';
import { AuditLedger } from '../agent/auditLedger';
import { fingerprintCredential } from '../agent/clientAuthenticator';
import { ClientRegistry } from '../agent/clientRegistry';
import { WorkflowStore } from '../agent/workflows';
import { createDatabaseCoordinatorControlCapability, type DatabaseControlWriteRequest } from '../persistence/databaseCoordinator';
import { getDatabaseCoordinator, getQuestionsApplication, getReadOnlyDatabase } from '../services/databaseService';
import { hashCanonicalJson } from '../../shared/agent/v1/gatewaySchemas';
import { operationCatalogIdentity } from '../../shared/agent/v1/operationCatalog';
import type { ApprovalRecord, ChangeSet, R4Grant } from '../../shared/agent/v1/gatewayContracts';

const FIXTURE_VERSION = 1;
const MAX_FIXTURE_BYTES = 1_024;
const primaryClientId = 'b9-e2e-codex';
const revokeClientId = 'b9-e2e-claude';
const sessionId = '00000000-0000-4000-8000-000000000103';
const approvalApproveId = '00000000-0000-4000-8000-000000000201';
const approvalRejectId = '00000000-0000-4000-8000-000000000202';
const changeSetApplyId = '00000000-0000-4000-8000-000000000301';
const changeSetRejectId = '00000000-0000-4000-8000-000000000302';
const grantId = '00000000-0000-4000-8000-000000000401';
const createdAt = '2099-01-01T00:00:00.000Z';
const expiresAt = '2099-01-01T00:10:00.000Z';
const questionTitle = 'B9 deterministic control-center question';

function fingerprint(value: string): string {
  return fingerprintCredential(value);
}

function fixtureDocument(filePath: string): void {
  const bytes = fs.readFileSync(filePath);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_FIXTURE_BYTES) throw new Error('Invalid agent-control E2E fixture');
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid agent-control E2E fixture'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || (value as { version?: unknown }).version !== FIXTURE_VERSION) {
    throw new Error('Invalid agent-control E2E fixture');
  }
}

function assertImmutableRecord<T extends object>(actual: T, expected: Partial<T>, label: string): void {
  for (const [key, value] of Object.entries(expected)) {
    if (JSON.stringify(actual[key as keyof T]) !== JSON.stringify(value)) throw new Error(`Existing ${label} does not match the deterministic fixture`);
  }
}

async function ensureQuestion(): Promise<number> {
  const database = await getReadOnlyDatabase();
  const existing = database.select<{ id: number; title: string }>('SELECT id, title FROM questions WHERE title = ?', [questionTitle]);
  if (existing.length > 1) throw new Error('Deterministic E2E question is duplicated');
  if (existing[0]) return existing[0].id;
  const questions = await getQuestionsApplication();
  const result = await questions.execute({
    type: 'questions.create',
    payload: {
      input: {
        title: questionTitle,
        content: 'Bounded fixture content',
        wrong_thinking: 'Fixture misconception',
        wrong_solution: '',
        correct_solution: 'Fixture correction',
        answer: '1',
        subject: '高等数学',
        category: '函数、极限、连续',
        question_type: '解答题',
        error_reason: '概念不清',
        source: 'B9 E2E fixture',
        difficulty: '中等',
        mastery_level: '一般',
        note: '',
        tags: ['b9-e2e'],
        questionImageSources: [],
        solutionImageSources: []
      }
    }
  }, createInternalExecutionContext({ requestId: '00000000-0000-4000-8000-000000000104', concurrency: 'none' }));
  const questionId = (result.value as { id?: unknown }).id;
  if (!Number.isSafeInteger(questionId) || Number(questionId) < 1) throw new Error('Deterministic E2E question was not created');
  return Number(questionId);
}

export async function applyAgentControlCenterFixture(filePath: string): Promise<void> {
  fixtureDocument(filePath);
  const coordinator = await getDatabaseCoordinator();
  const capability = createDatabaseCoordinatorControlCapability(coordinator);
  const executeControlWrite = <T>(request: DatabaseControlWriteRequest<T>) => coordinator.executeControlWrite(capability, request);
  const registry = new ClientRegistry({
    executeControlWrite,
    appInstanceId: 'e2e-agent-control',
    catalog: operationCatalogIdentity,
    now: () => createdAt,
    randomUUID: () => sessionId
  });

  const expectedClients = [
    {
      clientId: primaryClientId,
      subjectId: primaryClientId,
      displayName: 'E2E Codex',
      credentialFingerprint: fingerprint(primaryClientId),
      scopes: ['questions.write', 'questions.archive', 'operations.batch', 'audit.read'] as const,
      trust: 'full_control' as const
    },
    {
      clientId: revokeClientId,
      subjectId: revokeClientId,
      displayName: 'E2E Claude',
      credentialFingerprint: fingerprint(revokeClientId),
      scopes: ['questions.archive', 'operations.batch', 'audit.read'] as const,
      trust: 'full_control' as const
    }
  ];
  const existingClients = await registry.listClientsWindow({ limit: 100 });
  for (const expected of expectedClients) {
    const existing = existingClients.find((client) => client.clientId === expected.clientId);
    if (!existing) await registry.registerClient(expected);
    else assertImmutableRecord(existing, { clientId: expected.clientId, subjectId: expected.subjectId, displayName: expected.displayName }, 'E2E client');
  }

  const existingSessions = await registry.listSessionsWindow({ clientId: primaryClientId, limit: 100 });
  const fixtureSession = existingSessions.find((session) => session.sessionId === sessionId);
  if (!fixtureSession) {
    await registry.createSession(primaryClientId, fingerprint(primaryClientId), fingerprint('b9-session'), expiresAt);
  } else {
    assertImmutableRecord(fixtureSession, { sessionId, clientId: primaryClientId, appInstanceId: 'e2e-agent-control' }, 'E2E session');
  }

  const questionId = await ensureQuestion();
  const fixtureDatabase = await getReadOnlyDatabase();
  const auditEventCount = fixtureDatabase.select<{ count: number }>('SELECT COUNT(*) AS count FROM agent_audit_events')[0]?.count ?? 0;
  const hasAuditSegment = (fixtureDatabase.select<{ count: number }>('SELECT COUNT(*) AS count FROM agent_audit_segments')[0]?.count ?? 0) > 0;
  let uuidSequence = hasAuditSegment ? 501 + auditEventCount : 500;
  const deterministicUuid = () => `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, '0')}`;
  const audit = new AuditLedger({ executeControlWrite, catalog: operationCatalogIdentity, now: () => createdAt, randomUUID: deterministicUuid });
  const workflows = new WorkflowStore({ executeControlWrite, audit, now: () => createdAt, randomUUID: deterministicUuid });
  const version = coordinator.currentVersion();
  const payload = { questionId, mastery: '较好' };
  const affectedEntities = [{ entityType: 'question', entityId: String(questionId) }] as const;
  const payloadHash = hashCanonicalJson(payload);
  const affectedSetHash = hashCanonicalJson(affectedEntities);

  const approvalBase = {
    apiVersion: 1 as const,
    clientId: primaryClientId,
    operation: 'questions.mark_mastery' as const,
    payloadHash,
    affectedSetHash,
    baseVersion: version,
    catalog: operationCatalogIdentity,
    policyVersion: 'agent.policy.v1',
    risk: 'R2' as const,
    requiredScopes: ['questions.write'] as const,
    recovery: 'inverse' as const,
    status: 'pending' as const,
    createdAt,
    expiresAt
  };
  for (const approvalId of [approvalApproveId, approvalRejectId]) {
    const expected: ApprovalRecord = Object.freeze({ ...approvalBase, approvalId, nonce: approvalId, credentialBinding: fingerprint(approvalId) });
    const existing = await workflows.getApproval(approvalId);
    if (!existing) await workflows.createApproval(expected);
    else assertImmutableRecord(existing, { approvalId, clientId: primaryClientId, operation: expected.operation, payloadHash, affectedSetHash, catalog: operationCatalogIdentity }, 'E2E approval');
  }

  for (const [changeSetId, status, summary] of [
    [changeSetApplyId, 'approved', 'E2E apply change set'],
    [changeSetRejectId, 'draft', 'E2E reject change set']
  ] as const) {
    const expected: ChangeSet = Object.freeze({
      apiVersion: 1,
      changeSetId,
      clientId: primaryClientId,
      status,
      catalog: operationCatalogIdentity,
      baseVersion: version,
      risk: 'R2',
      summary,
      operations: Object.freeze([{ operation: 'questions.mark_mastery' as const, payload, payloadHash, affectedEntities: Object.freeze(affectedEntities) }]),
      affectedSetHash,
      recovery: 'inverse',
      createdAt,
      expiresAt
    });
    const existing = await workflows.getChangeSet(changeSetId);
    if (!existing) await workflows.createChangeSet(expected);
    else assertImmutableRecord(existing, { changeSetId, clientId: primaryClientId, catalog: operationCatalogIdentity, summary, affectedSetHash }, 'E2E change set');
  }

  const expectedGrant: R4Grant = Object.freeze({
    apiVersion: 1,
    grantId,
    clientId: revokeClientId,
    operation: 'questions.replace_all',
    payloadHash: hashCanonicalJson({ questions: [] }),
    targetHash: hashCanonicalJson({ operation: 'questions.replace_all', target: 'bounded-e2e-root' }),
    catalog: operationCatalogIdentity,
    recovery: 'consistency_bundle',
    maxAffectedEntities: 500,
    maxUses: 1,
    status: 'active',
    issuedAt: createdAt,
    expiresAt
  });
  const existingGrant = await workflows.getR4Grant(grantId);
  if (!existingGrant) await workflows.createR4Grant(expectedGrant);
  else assertImmutableRecord(existingGrant, {
    grantId,
    clientId: revokeClientId,
    operation: expectedGrant.operation,
    payloadHash: expectedGrant.payloadHash,
    targetHash: expectedGrant.targetHash,
    catalog: operationCatalogIdentity,
    recovery: expectedGrant.recovery,
    maxAffectedEntities: expectedGrant.maxAffectedEntities,
    maxUses: 1
  }, 'E2E R4 grant');
}

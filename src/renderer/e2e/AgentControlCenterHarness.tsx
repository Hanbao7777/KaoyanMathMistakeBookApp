import { useEffect, useState } from 'react';

type HarnessResult = { readonly ok: boolean; readonly assertions: readonly string[]; readonly error?: string };
type HarnessWindow = Window & { agentControlE2e?: { report(result: HarnessResult): Promise<void> } };

const primaryClientId = 'b9-e2e-codex';
const revokeClientId = 'b9-e2e-claude';
const sessionId = '00000000-0000-4000-8000-000000000103';
const approvalApproveId = '00000000-0000-4000-8000-000000000201';
const approvalRejectId = '00000000-0000-4000-8000-000000000202';
const changeSetApplyId = '00000000-0000-4000-8000-000000000301';
const changeSetRejectId = '00000000-0000-4000-8000-000000000302';
const grantId = '00000000-0000-4000-8000-000000000401';

function assert(condition: unknown, label: string, assertions: string[]): asserts condition {
  if (!condition) throw new Error(label);
  assertions.push(label);
}

export function AgentControlCenterHarness() {
  const [message, setMessage] = useState('Running isolated agent-control checks...');

  useEffect(() => {
    const bridge = (window as HarnessWindow).agentControlE2e;
    if (!bridge) {
      setMessage('Harness unavailable outside the guarded Electron process.');
      return;
    }

    void (async () => {
      const assertions: string[] = [];
      try {
        const control = window.api.agentControl;
        const initialStatus = await control.getStatus();
        if (!initialStatus.settings.externalControlEnabled) {
          assert(initialStatus.runtimeState.length > 0, 'initial runtime status is visible', assertions);
          await control.setExternalControlEnabled(true);
          assert((await control.getStatus()).settings.externalControlEnabled, 'external control enables through typed preload', assertions);

          const clients = await control.listClients({ pageSize: 100 });
          const primaryClient = clients.items.find((client) => client.clientId === primaryClientId);
          const revokeClient = clients.items.find((client) => client.clientId === revokeClientId);
          assert(primaryClient?.displayName === 'E2E Codex', 'deterministic primary client is visible', assertions);
          assert(revokeClient?.displayName === 'E2E Claude', 'deterministic revoke client is visible', assertions);

          const grants = await control.listR4Grants({ clientId: revokeClientId, pageSize: 100 });
          const grant = grants.items.find((item) => item.grantId === grantId);
          assert(grant?.operation === 'questions.replace_all' && grant.maxAffectedEntities === 500 && Boolean(grant.expiresAt), 'operation-bound R4 details and expiry are visible', assertions);
          const createdGrantExpiry = new Date(Date.now() + 5 * 60 * 1000).toISOString();
          const createdGrant = await control.createR4Grant({
            clientId: revokeClientId,
            operation: 'questions.replace_all',
            payloadHash: `sha256-v1:${'a'.repeat(64)}`,
            targetHash: `sha256-v1:${'b'.repeat(64)}`,
            maxAffectedEntities: 500,
            expiresAt: createdGrantExpiry
          });
          assert(createdGrant.grantId !== grantId && createdGrant.grantId.length > 0, 'R4 creation returns a server-owned grant ID', assertions);
          assert(createdGrant.clientId === revokeClientId && createdGrant.operation === 'questions.replace_all' && createdGrant.maxAffectedEntities === 500 && createdGrant.expiresAt === createdGrantExpiry, 'R4 creation preserves target operation impact and expiry', assertions);
          assert((await control.listR4Grants({ clientId: revokeClientId, pageSize: 100 })).items.some((item) => item.grantId === createdGrant.grantId && item.status === 'active'), 'created R4 grant appears in the typed list', assertions);
          await control.revokeR4Grant(createdGrant.grantId);
          assert((await control.listR4Grants({ clientId: revokeClientId, pageSize: 100 })).items.find((item) => item.grantId === createdGrant.grantId)?.status === 'revoked', 'created R4 grant revocation is immediate', assertions);
          await control.revokeR4Grant(grantId);
          assert((await control.listR4Grants({ clientId: revokeClientId, pageSize: 100 })).items.find((item) => item.grantId === grantId)?.status === 'revoked', 'fixture R4 grant revocation is immediate', assertions);

          const approvals = await control.listApprovals({ pageSize: 100 });
          assert(approvals.items.find((item) => item.approvalId === approvalApproveId)?.status === 'pending', 'approve fixture is pending', assertions);
          assert(approvals.items.find((item) => item.approvalId === approvalRejectId)?.status === 'pending', 'reject fixture is pending', assertions);
          await control.approve(approvalApproveId);
          await control.rejectApproval(approvalRejectId, 'e2e_rejected');
          const decidedApprovals = await control.listApprovals({ pageSize: 100 });
          assert(decidedApprovals.items.find((item) => item.approvalId === approvalApproveId)?.status === 'approved', 'approval decision persists', assertions);
          assert(decidedApprovals.items.find((item) => item.approvalId === approvalRejectId)?.status === 'rejected', 'approval rejection persists', assertions);

          const changeSets = await control.listChangeSets({ pageSize: 100 });
          assert(changeSets.items.find((item) => item.changeSetId === changeSetApplyId)?.status === 'approved', 'apply change set is visible', assertions);
          assert(changeSets.items.find((item) => item.changeSetId === changeSetRejectId)?.status === 'draft', 'reject change set is visible', assertions);
          await control.applyChangeSet(changeSetApplyId);
          await control.rejectChangeSet(changeSetRejectId, 'e2e_rejected');
          const decidedChangeSets = await control.listChangeSets({ pageSize: 100 });
          assert(decidedChangeSets.items.find((item) => item.changeSetId === changeSetApplyId)?.status === 'applied', 'change set applies through the Gateway', assertions);
          assert(decidedChangeSets.items.find((item) => item.changeSetId === changeSetRejectId)?.status === 'rejected', 'change set rejection persists', assertions);

          await control.updateClientAccess(primaryClientId, ['audit.read'], 'observer');
          const updatedClient = (await control.listClients({ pageSize: 100 })).items.find((client) => client.clientId === primaryClientId);
          assert(updatedClient?.trust === 'observer' && updatedClient.scopes.length === 1 && updatedClient.scopes[0] === 'audit.read', 'client scope and trust update immediately', assertions);

          const sessions = await control.listSessions({ clientId: primaryClientId, pageSize: 100 });
          assert(sessions.items.some((session) => session.sessionId === sessionId), 'deterministic session is visible', assertions);
          await control.terminateSession(sessionId);
          assert(Boolean((await control.listSessions({ clientId: primaryClientId, pageSize: 100 })).items.find((session) => session.sessionId === sessionId)?.terminatedAt), 'session termination is immediate', assertions);

          await control.revokeClient(revokeClientId);
          assert(Boolean((await control.listClients({ pageSize: 100 })).items.find((client) => client.clientId === revokeClientId)?.revokedAt), 'client revocation is immediate', assertions);

          const filteredAudit = await control.searchAudit({ clientId: primaryClientId, pageSize: 100 });
          assert(filteredAudit.items.length > 0 && filteredAudit.items.every((event) => event.clientId === primaryClientId), 'audit search applies the client filter', assertions);
          assert((await control.exportAudit({ pageSize: 100 })).valid, 'audit export returns verified metadata', assertions);
          assert((await control.verifyAudit()).valid, 'audit ledger verifies after mutations', assertions);
          const catalog = await control.getCatalog();
          const policy = await control.getPolicy();
          assert(Boolean(catalog.version) && Boolean(catalog.hash) && Boolean(policy.policyVersion), 'catalog and policy versions are visible', assertions);
          assert((await control.getPrivacyDisclosure()).externalModelDataDisclosureRequired, 'external-model privacy disclosure is required', assertions);
          assertions.push('initial flow completed');
        } else {
          const clients = await control.listClients({ pageSize: 100 });
          const primaryClient = clients.items.find((client) => client.clientId === primaryClientId);
          const revokedClient = clients.items.find((client) => client.clientId === revokeClientId);
          assert(primaryClient?.trust === 'observer' && primaryClient.scopes.length === 1 && primaryClient.scopes[0] === 'audit.read', 'restart preserves client access changes', assertions);
          assert(Boolean(revokedClient?.revokedAt), 'restart preserves client revocation', assertions);
          assert(Boolean((await control.listSessions({ clientId: primaryClientId, pageSize: 100 })).items.find((session) => session.sessionId === sessionId)?.terminatedAt), 'restart preserves session termination', assertions);
          const restartGrants = (await control.listR4Grants({ clientId: revokeClientId, pageSize: 100 })).items;
          assert(restartGrants.find((grant) => grant.grantId === grantId)?.status === 'revoked', 'restart preserves fixture R4 revocation', assertions);
          assert(restartGrants.some((grant) => grant.grantId !== grantId && grant.operation === 'questions.replace_all' && grant.maxAffectedEntities === 500 && grant.status === 'revoked'), 'restart preserves created R4 grant and revocation', assertions);
          const approvals = await control.listApprovals({ pageSize: 100 });
          assert(approvals.items.find((item) => item.approvalId === approvalApproveId)?.status === 'approved' && approvals.items.find((item) => item.approvalId === approvalRejectId)?.status === 'rejected', 'restart preserves approval decisions', assertions);
          const changeSets = await control.listChangeSets({ pageSize: 100 });
          assert(changeSets.items.find((item) => item.changeSetId === changeSetApplyId)?.status === 'applied' && changeSets.items.find((item) => item.changeSetId === changeSetRejectId)?.status === 'rejected', 'restart preserves change set decisions', assertions);
          assert((await control.verifyAudit()).valid, 'restart verifies the durable audit ledger', assertions);
          assert((await control.searchAudit({ pageSize: 100 })).items.length > 0, 'restart reads durable audit history', assertions);
          assertions.push('restart flow completed');
        }
        await bridge.report({ ok: true, assertions });
        setMessage('Harness completed.');
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        try { await bridge.report({ ok: false, assertions, error: detail }); } catch { /* The main process may already be exiting. */ }
        setMessage(`Harness failed: ${detail}`);
      }
    })();
  }, []);

  return <main className="agent-control-harness">{message}</main>;
}

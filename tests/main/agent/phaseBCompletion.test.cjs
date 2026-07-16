const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const environment = require('../helpers/controlPlaneTestEnv.cjs');

function testSource(relativePath) {
  return fs.readFileSync(path.join(environment.projectRoot, relativePath), 'utf8');
}

function requiresEvidence(relativePath, assertions) {
  const source = testSource(relativePath);
  for (const assertion of assertions) assert.match(source, assertion, `${relativePath} is missing completion evidence: ${assertion}`);
}

test.after(() => environment.cleanupControlPlaneRoot());

test('completion matrix maps principal, R4, catalog, idempotency, and audit runtime evidence', () => {
  requiresEvidence('tests/main/agent/clientAuthenticator.test.cjs', [
    /forged/, /revoke|disabled/, /renderer adapter returns one fixed first-party identity/
  ]);
  requiresEvidence('tests/main/agent/agentGateway.test.cjs', [
    /terminating a session through the Gateway revokes its issued principal immediately/,
    /database restart verifies audit then reconciles orphan admission before Gateway readiness/
  ]);
  requiresEvidence('tests/main/agent/policyEngine.test.cjs', [
    /persisted policy can tighten but cannot weaken descriptor invariants/,
    /R4 rejects wildcard, permanent, payload-mismatched, and descriptor-mismatched authority/
  ]);
  requiresEvidence('tests/main/agent/r4GrantReservation.test.cjs', [
    /two concurrent R4 admissions produce exactly one reservation and executor path/,
    /known precommit failure releases, while indeterminate publication remains reserved/
  ]);
  requiresEvidence('tests/main/agent/idempotency.test.cjs', [
    /admits once, conflicts on changed bindings, and replays the exact terminal result/
  ]);
  requiresEvidence('tests/main/agent/receiptRecovery.test.cjs', [
    /lost response after durable publication replays the selected terminal candidate without re-execution/,
    /restart reconciliation terminalizes only orphan admissions and is idempotent/
  ]);
  requiresEvidence('tests/main/agent/auditLedger.test.cjs', [
    /detects mutation, deletion, and sequence reorder/,
    /rotation closes and anchors a successor while protected records retain at least one year/
  ]);
});

test('completion matrix maps migration, control-center, isolation, and recovery evidence', () => {
  requiresEvidence('tests/main/agent/questionsGatewayParity.test.cjs', [
    /Renderer and external Gateway preserve question, review, image, retry, version, and audit parity/,
    /image finalization failure fences Gateway and remains recoverable evidence after restart/
  ]);
  requiresEvidence('tests/main/agent/questionsGatewayGate.test.cjs', [/no fallback/]);
  requiresEvidence('tests/main/agent/tickTickGatewayParity.test.cjs', [
    /Renderer and external Gateway preserve task and focus shapes, replay, version, and audit parity/,
    /bridge completion rolls back atomically/
  ]);
  requiresEvidence('tests/main/agent/tickTickGatewayGate.test.cjs', [/one authenticated Gateway path/]);
  requiresEvidence('tests/electron/agentControlCenter.e2e.cjs', [
    /real Electron completes the typed control-center flow and preserves durable state on restart/,
    /restart preserves created R4 grant and revocation/,
    /restart verifies the durable audit ledger/
  ]);
  requiresEvidence('tests/main/agent/testEnv.test.cjs', [
    /provides unique Phase B roots confined to an OS temporary directory/,
    /rejects paths that escape the Phase B root or overlap real data/
  ]);
});

test('B10 completion evidence itself runs only inside the isolated Phase B root', () => {
  const paths = environment.prepareAgentTestEnvironment();
  const isolated = [paths.dataRoot, paths.userDataRoot, paths.recoveryRoot, paths.agentDatabaseRoot, paths.ledgerRoot, paths.resultRoot];
  assert.equal(new Set(isolated.map((value) => path.resolve(value).toLowerCase())).size, isolated.length);
  for (const target of isolated) {
    assert.equal(environment.assertOwnedPath(target), path.resolve(target));
    assert.equal(target.toLowerCase().includes(environment.realDataRoot.toLowerCase()), false);
  }
});

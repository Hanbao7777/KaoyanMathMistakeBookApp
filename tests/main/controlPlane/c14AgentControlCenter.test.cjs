const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../..');
const ipcSource = fs.readFileSync(path.join(root, 'src/main/ipc/adapters/agentControlCenterIpc.ts'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'src/main/main.ts'), 'utf8');
const databaseServiceSource = fs.readFileSync(path.join(root, 'src/main/services/databaseService.ts'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src/renderer/pages/AgentControlCenterPage.tsx'), 'utf8');

test('C14 control center publishes only non-secret authority and certificate identifiers', () => {
  assert.match(ipcSource, /directHttps/);
  assert.match(rendererSource, /Direct HTTPS OAuth/);
  assert.match(rendererSource, /rootCaThumbprint/);
  assert.doesNotMatch(rendererSource, /access_token|refresh_token|code_verifier|privateKey|client_secret/i);
  assert.doesNotMatch(ipcSource, /authorization_code|code_verifier|refresh_token|access_token/i);
});

test('C14 external-control toggle captures the checked value before async confirmation', () => {
  assert.match(rendererSource, /const enabled = event\.currentTarget\.checked;/);
  assert.match(rendererSource, /setExternalControlEnabled\(enabled\)/);
  assert.doesNotMatch(rendererSource, /setExternalControlEnabled\(event\.(?:currentTarget|target)\.checked\)/);
});

test('C14 authorized-client controls exclude revoked audit records', () => {
  assert.match(rendererSource, /const activeClients = nextClients\.items\.filter\(\(client\) => !client\.revokedAt\);/);
  assert.match(rendererSource, /setClients\(activeClients\)/);
  assert.match(rendererSource, /activeClients\.map\(\(client\) => \[client\.clientId,/);
});

test('C14 production stdio authentication and discovery share one canonical instance UUID', () => {
  assert.match(databaseServiceSource, /const defaultAgentInstanceId = randomUUID\(\);/);
  assert.match(mainSource, /const appInstanceId = controlPlane\.httpOAuthAuthority\.appInstanceId;/);
  assert.match(mainSource, /new McpLoopbackHost\(\{[\s\S]*?instanceId: appInstanceId,/);
});

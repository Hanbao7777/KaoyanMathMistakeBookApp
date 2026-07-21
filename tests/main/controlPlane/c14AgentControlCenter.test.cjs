const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../..');
const ipcSource = fs.readFileSync(path.join(root, 'src/main/ipc/adapters/agentControlCenterIpc.ts'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src/renderer/pages/AgentControlCenterPage.tsx'), 'utf8');

test('C14 control center publishes only non-secret authority and certificate identifiers', () => {
  assert.match(ipcSource, /directHttps/);
  assert.match(rendererSource, /Direct HTTPS OAuth/);
  assert.match(rendererSource, /rootCaThumbprint/);
  assert.doesNotMatch(rendererSource, /access_token|refresh_token|code_verifier|privateKey|client_secret/i);
  assert.doesNotMatch(ipcSource, /authorization_code|code_verifier|refresh_token|access_token/i);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');

test('C10 Renderer IPC exposes only Gateway-backed study adapters for the exact five operations', () => {
  const adapter = fs.readFileSync(path.join(root, 'src/main/ipc/adapters/studyIpc.ts'), 'utf8');
  const register = fs.readFileSync(path.join(root, 'src/main/ipc/registerIpc.ts'), 'utf8');
  assert.doesNotMatch(adapter, /studySupervisorService|databaseService|databaseCoordinator|getDatabase\(|\.run\(|\.exec\(|\.prepare\(/);
  for (const channel of ['study:getToday', 'study:getWeekSummary', 'study:createPlanDraft', 'study:applyPlanAdjustment', 'study:recordManualProgress']) {
    assert.match(register, new RegExp(`handle\\('${channel}'`));
  }
});

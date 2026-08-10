const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../..');
const agent = require(path.join(root, 'dist/main/shared/agent/index.js'));
const schemas = require(path.join(root, 'dist/main/shared/agent/v1/schemas.js'));
const exposure = require(path.join(root, 'dist/main/shared/mcp/v1/exposureManifest.js'));

test('C10 catalog and schemas expose exactly five bounded study operations', () => {
  assert.deepEqual(exposure.mcpExternalBusinessOperations.filter((name) => name.startsWith('study.')).sort(), [
    'study.apply_plan_adjustment', 'study.create_plan_draft', 'study.get_today', 'study.get_week_summary', 'study.record_manual_progress'
  ]);
  assert.equal(agent.resolveOperationDescriptor('study.create_plan_draft').policyBounds.maxAffectedEntities, 20);
  assert.equal(agent.resolveOperationDescriptor('study.create_plan_draft').policyBounds.minimumRisk, 'R3');
  assert.doesNotThrow(() => schemas.validateStudyCommand({ type: 'study.create_plan_draft', payload: { date: '2026-07-18', tasks: [] } }));
  assert.throws(() => schemas.validateStudyCommand({ type: 'study.create_plan_draft', payload: { date: '2026-02-30', tasks: [] } }), /invalid/i);
  assert.throws(() => schemas.validateStudyCommand({ type: 'study.create_plan_draft', payload: { date: '2026-07-18', tasks: Array.from({ length: 21 }, () => ({ subjectId: 'math', title: 'x', estimatedMinutes: 1 })) } }), /invalid/i);
  assert.throws(() => schemas.validateStudyCommand({ type: 'study.record_manual_progress', payload: { date: '2026-07-18', subjectId: 'math', minutes: 1, materialCurrentAmount: 2 } }), /invalid/i);
});

test('C10 inventory and application/Renderer boundaries contain no direct legacy bypass', () => {
  const inventory = fs.readFileSync(path.join(root, 'docs/archive/completed/tasks/2026-07-18-agent-control-plane-c10-write-entry-inventory.md'), 'utf8');
  const application = fs.readFileSync(path.join(root, 'src/main/application/study/commands.ts'), 'utf8');
  const adapter = fs.readFileSync(path.join(root, 'src/main/ipc/adapters/studyIpc.ts'), 'utf8');
  assert.match(inventory, /initializeStudySupervisor|rolloverStudyTasks|createStudySession|saveDailyReview/);
  assert.doesNotMatch(adapter, /studySupervisorService|databaseCoordinator|getDatabase\(|\.run\(|\.exec\(|\.prepare\(/);
  assert.doesNotMatch(application, /studySupervisorService|databaseService|runSql|allSql/);
});

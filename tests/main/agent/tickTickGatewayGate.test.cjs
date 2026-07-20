const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '../../..');
const adapter = fs.readFileSync(path.join(projectRoot, 'src/main/ipc/adapters/ticktickIpc.ts'), 'utf8');
const register = fs.readFileSync(path.join(projectRoot, 'src/main/ipc/registerIpc.ts'), 'utf8');
const authentication = fs.readFileSync(path.join(projectRoot, 'src/main/agent/clientAuthenticator.ts'), 'utf8');

const b6Operations = [
  'questions.create', 'questions.update', 'questions.delete', 'questions.remove_image',
  'questions.mark_mastery', 'questions.submit_review', 'questions.list', 'questions.get',
  'questions.review_logs', 'questions.review_buckets'
];
const b7Operations = [
  'tasks.create', 'tasks.update', 'tasks.complete', 'tasks.uncomplete', 'tasks.delete',
  'tasks.list', 'tasks.get', 'focus.sessions.create', 'focus.sessions.list'
];
const c9Operations = [
  'knowledge.list_nodes', 'knowledge.get_node', 'knowledge.list_links',
  'textbooks.list', 'textbooks.get', 'analytics.get_weak_areas',
  'knowledge.link_question', 'knowledge.unlink_question', 'knowledge.bind_textbook'
];
const c10Operations = [
  'study.get_today', 'study.get_week_summary', 'study.create_plan_draft', 'study.apply_plan_adjustment', 'study.record_manual_progress'
];
const c11Operations = [
  'imports.create_draft', 'imports.add_draft_image', 'imports.validate_draft', 'imports.preview_draft', 'imports.apply_draft', 'imports.get', 'imports.cancel'
];

test('migrated Renderer task and focus channels have one authenticated Gateway path', () => {
  for (const channel of [
    'ticktick:tasks:list', 'ticktick:tasks:get', 'ticktick:tasks:create', 'ticktick:tasks:update',
    'ticktick:tasks:delete', 'ticktick:tasks:complete', 'ticktick:tasks:uncomplete',
    'ticktick:focus:list', 'ticktick:focus:create'
  ]) assert.match(register, new RegExp(`handle\\('${channel}'[^\\n]*FromRenderer`));
  assert.match(adapter, /getAgentControlPlane/);
  assert.match(adapter, /controlPlane\.renderer\.principal\(\)/);
  assert.match(adapter, /controlPlane\.gateway\.execute\(/);
  assert.match(adapter, /controlPlane\.gateway\.query\(/);
  for (const forbidden of [
    'CommandBus', 'QueryBus', 'getTickTickApplication', 'getDatabase(', 'getReadOnlyDatabase',
    'persistDatabase', 'ticktickService', 'bridgeService', 'application.execute', 'application.query',
    'createRendererExecutionContext', 'runSql', 'transaction'
  ]) assert.equal(adapter.includes(forbidden), false, `Forbidden Renderer bypass surface: ${forbidden}`);
});

test('Renderer business allowlist exactly equals accepted B6, B7, C9, and C10 adapter operations', () => {
  const block = authentication.match(/migratedRendererBusinessOperations = Object\.freeze\(\[([\s\S]*?)\]\s+as const\)/);
  assert.ok(block);
  const allowlist = [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(allowlist, [...b6Operations, ...b7Operations, ...c9Operations, ...c10Operations, ...c11Operations]);
  for (const operation of b7Operations) assert.equal(adapter.includes(`type: '${operation}'`), true, operation);
  for (const operation of ['ticktick:lists:create', 'ticktick:settings:save', 'ticktick:habits:create', 'ticktick:bridge:create']) {
    assert.equal(allowlist.includes(operation), false, operation);
  }
});

test('unmigrated TickTick IPC remains on fixed legacy handlers and is not generically forwarded', () => {
  assert.doesNotMatch(adapter, /event\.sender|clientId\s*[:=]|scopes\s*[:=]|trust\s*[:=]|operation\s*:\s*operation/i);
  for (const channel of ['ticktick:lists:create', 'ticktick:settings:save', 'ticktick:habits:create', 'ticktick:bridge:create']) {
    assert.doesNotMatch(register, new RegExp(`handle\\('${channel}'[^\\n]*FromRenderer`));
  }
});

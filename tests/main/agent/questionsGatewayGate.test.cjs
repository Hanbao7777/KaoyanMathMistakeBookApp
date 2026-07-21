const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '../../..');
const adapterPath = path.join(projectRoot, 'src/main/ipc/adapters/questionsIpc.ts');
const registerPath = path.join(projectRoot, 'src/main/ipc/registerIpc.ts');
const authenticationPath = path.join(projectRoot, 'src/main/agent/clientAuthenticator.ts');
const catalogPath = path.join(projectRoot, 'src/shared/agent/v1/operationCatalog.ts');
const manifestPath = path.join(projectRoot, 'src/shared/mcp/v1/exposureManifest.ts');
const adapter = fs.readFileSync(adapterPath, 'utf8');
const register = fs.readFileSync(registerPath, 'utf8');
const authentication = fs.readFileSync(authenticationPath, 'utf8');
const catalog = fs.readFileSync(catalogPath, 'utf8');
const manifest = fs.readFileSync(manifestPath, 'utf8');

const rendererOperations = [
  'questions.create', 'questions.update', 'questions.delete', 'questions.remove_image',
  'questions.mark_mastery', 'questions.submit_review', 'questions.list', 'questions.get',
  'questions.review_logs', 'questions.review_buckets',
  'tasks.create', 'tasks.update', 'tasks.complete', 'tasks.uncomplete', 'tasks.delete',
  'tasks.list', 'tasks.get', 'focus.sessions.create', 'focus.sessions.list',
  'knowledge.list_nodes', 'knowledge.get_node', 'knowledge.list_links', 'textbooks.list', 'textbooks.get', 'analytics.get_weak_areas',
  'knowledge.link_question', 'knowledge.unlink_question', 'knowledge.bind_textbook',
  'study.get_today', 'study.get_week_summary', 'study.create_plan_draft', 'study.apply_plan_adjustment', 'study.record_manual_progress',
  'imports.create_draft', 'imports.add_draft_image', 'imports.validate_draft', 'imports.preview_draft', 'imports.apply_draft', 'imports.get', 'imports.cancel',
  'ticktick.lists.list', 'ticktick.lists.create', 'ticktick.lists.update', 'ticktick.habits.list', 'ticktick.habits.create', 'ticktick.habits.update',
  'ticktick.calendar.list_events', 'ticktick.bridges.get', 'ticktick.bridges.update'
];

test('migrated Renderer question writes have one authenticated Gateway path and no fallback', () => {
  for (const channel of ['questions:create', 'questions:update', 'questions:delete', 'questions:markMastery', 'images:remove', 'reviews:add', 'reviews:submitResult']) {
    assert.match(register, new RegExp(`handle\\('${channel}'[^\\n]*FromRenderer`));
  }
  assert.match(adapter, /getAgentControlPlane/);
  assert.match(adapter, /controlPlane\.renderer\.principal\(\)/);
  assert.match(adapter, /controlPlane\.gateway\.execute\(/);
  assert.match(adapter, /controlPlane\.gateway\.query\(/);
  for (const forbidden of [
    'CommandBus', 'QueryBus', 'getQuestionsApplication', 'getDatabase(', 'getReadOnlyDatabase',
    'persistDatabase', 'executeLegacyQuestionCommand', 'application.execute', 'application.query',
    'createRendererExecutionContext', 'executeWrite({ requestId', 'runSql', 'transaction'
  ]) {
    assert.equal(adapter.includes(forbidden), false, `Forbidden Renderer bypass surface: ${forbidden}`);
  }
});

test('fixed Renderer adapter exposes no generic operation or caller identity forwarding', () => {
  assert.doesNotMatch(adapter, /event\.sender|clientId\s*[:=]|scopes\s*[:=]|trust\s*[:=]|allowlist/i);
  assert.doesNotMatch(register, /questions:[^']+'[^\n]*getQuestionsApplication/);
});

test('versioned external MCP manifest preserves C6 parity and adds only the reviewed C9 slice', () => {
  const block = authentication.match(/migratedRendererBusinessOperations = Object\.freeze\(\[([\s\S]*?)\]\s+as const\)/);
  assert.ok(block, 'Missing migrated Renderer operation allowlist');
  const rendererAllowlist = [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const externalBlock = manifest.match(/businessOperations: Object\.freeze\(\[([\s\S]*?)\]\s+as const\)/);
  assert.ok(externalBlock, 'Missing immutable versioned MCP business manifest');
  const externalAllowlist = [...externalBlock[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(rendererAllowlist, [...rendererOperations, 'backups.list', 'backups.create', 'exports.create', 'exports.get']);
  assert.deepEqual(externalAllowlist, [...rendererOperations, 'backups.list', 'backups.create', 'exports.create', 'exports.get', 'backups.delete', 'database.restore', 'database.replace_from_import', 'database.clear_all', 'imports.delete_batch', 'data_root.migrate']);
  for (const operation of rendererOperations.slice(0, 10)) assert.equal(adapter.includes(`type: '${operation}'`), true, operation);
  for (const operation of ['questions.undo_review', 'questions.link_knowledge', 'questions.migrate_categories', 'questions.rematch_knowledge']) {
    assert.doesNotMatch(adapter, new RegExp(`type: '${operation.replace('.', '\\.')}'`));
  }
});

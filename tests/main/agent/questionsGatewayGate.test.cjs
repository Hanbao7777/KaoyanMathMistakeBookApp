const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '../../..');
const adapterPath = path.join(projectRoot, 'src/main/ipc/adapters/questionsIpc.ts');
const registerPath = path.join(projectRoot, 'src/main/ipc/registerIpc.ts');
const authenticationPath = path.join(projectRoot, 'src/main/agent/clientAuthenticator.ts');
const adapter = fs.readFileSync(adapterPath, 'utf8');
const register = fs.readFileSync(registerPath, 'utf8');
const authentication = fs.readFileSync(authenticationPath, 'utf8');

const rendererOperations = [
  'questions.create', 'questions.update', 'questions.delete', 'questions.remove_image',
  'questions.mark_mastery', 'questions.submit_review', 'questions.list', 'questions.get',
  'questions.review_logs', 'questions.review_buckets'
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

test('Renderer business allowlist exactly matches the B6 adapter operation set', () => {
  const block = authentication.match(/migratedRendererBusinessOperations = Object\.freeze\(\[([\s\S]*?)\]\s+as const\)/);
  assert.ok(block, 'Missing migrated Renderer operation allowlist');
  const allowlist = [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(allowlist, rendererOperations);
  for (const operation of rendererOperations) assert.equal(adapter.includes(`type: '${operation}'`), true, operation);
  for (const operation of ['questions.undo_review', 'questions.link_knowledge', 'questions.migrate_categories', 'questions.rematch_knowledge']) {
    assert.doesNotMatch(adapter, new RegExp(`type: '${operation.replace('.', '\\.')}'`));
  }
});

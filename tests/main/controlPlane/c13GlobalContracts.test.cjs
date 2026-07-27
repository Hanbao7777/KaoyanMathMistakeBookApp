const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const agent = require(`${environment.projectRoot}/dist/main/shared/agent/index.js`);
const mcp = require(`${environment.projectRoot}/dist/main/shared/mcp/v1/index.js`);
const global = environment.requireMain('application/global/index.js');

const c13Operations = Object.freeze([
  'backups.list', 'backups.create', 'exports.create', 'exports.get', 'backups.delete',
  'database.restore', 'database.replace_from_import', 'database.clear_all',
  'imports.delete_batch', 'data_root.migrate'
]);
const r4Operations = new Set(c13Operations.slice(4));

test('C13 Phase 1 exposes exactly ten bounded global operations with least-privilege descriptors', () => {
  const exposed = mcp.mcpExternalBusinessOperations.filter((operation) => c13Operations.includes(operation));
  assert.deepEqual(exposed, c13Operations);
  assert.equal(mcp.mcpExternalBusinessOperations.length, 59);
  assert.equal(mcp.mcpExternalBusinessOperations.includes('backups.materialize'), false);
  assert.equal(mcp.mcpExternalBusinessOperations.includes('exports.materialize'), false);
  assert.equal(agent.resolveOperationDescriptor('backups.materialize').domain, 'global');
  assert.equal(agent.resolveOperationDescriptor('exports.materialize').domain, 'global');
  for (const operation of c13Operations) {
    const descriptor = agent.resolveOperationDescriptor(operation);
    assert.equal(descriptor.domain, 'global');
    assert.equal(descriptor.requiredScopes.length, 1);
    if (r4Operations.has(operation)) {
      assert.equal(descriptor.policyBounds.minimumRisk, 'R4');
      assert.equal(descriptor.policyBounds.approval, 'r4_grant');
      assert.equal(descriptor.recovery, 'consistency_bundle');
      assert.equal(descriptor.riskResolver, 'global_resolved');
    }
  }
});

test('C13 global validators accept only bounded opaque identifiers and export specifications', () => {
  assert.doesNotThrow(() => global.validateGlobalCommand({ type: 'exports.create', payload: { specification: { scope: 'questions', questionIds: [1, 2], mode: 'full' } } }));
  assert.doesNotThrow(() => global.validateGlobalCommand({ type: 'data_root.migrate', payload: { rootSelectionId: 'selection-1' } }));
  assert.doesNotThrow(() => global.validateGlobalQuery({ type: 'backups.list', payload: { pageSize: 50 } }));
  for (const value of [
    { type: 'database.restore', payload: { backupPath: 'C:\\private\\mistakes.db' } },
    { type: 'data_root.migrate', payload: { root: 'D:\\another-root' } },
    { type: 'exports.create', payload: { specification: { scope: 'all', mode: 'full', outputPath: 'C:\\export.pdf' } } },
    { type: 'database.replace_from_import', payload: { importAssetId: '../database' } },
    { type: 'backups.list', payload: { pageSize: 101 } }
  ]) {
    const validate = value.type === 'backups.list' ? global.validateGlobalQuery : global.validateGlobalCommand;
    assert.throws(() => validate(value), (error) => error.code === 'VALIDATION_ERROR');
  }
});

test('C13 keeps R4 grant and approval decisions local to the Renderer adapter', () => {
  const source = fs.readFileSync(path.join(environment.projectRoot, 'src/main/agent/bootstrap.ts'), 'utf8');
  assert.match(source, /case 'agent\.r4_grants\.create': \{\s*\/\/[^\n]*\n[\s\S]*?if \(!principal\.renderer\) throw new AgentError\('SCOPE_DENIED'\)/);
  assert.match(source, /case 'agent\.approvals\.approve': \{\s*if \(!principal\.renderer\) throw new AgentError\('SCOPE_DENIED'\)/);
  assert.match(source, /case 'agent\.approvals\.reject': \{\s*if \(!principal\.renderer\) throw new AgentError\('SCOPE_DENIED'\)/);
});

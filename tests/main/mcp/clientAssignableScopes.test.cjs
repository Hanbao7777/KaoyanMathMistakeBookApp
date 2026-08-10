const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../..');

test('external client scope picker covers every exposed MCP business operation', () => {
  const { mcpClientScopeGroups } = require(path.join(root, 'dist/main/shared/mcp/v1/clientScopes.js'));
  const { mcpExternalBusinessOperations } = require(path.join(root, 'dist/main/shared/mcp/v1/exposureManifest.js'));
  const { resolveOperationDescriptor } = require(path.join(root, 'dist/main/shared/agent/v1/operationCatalog.js'));

  const visibleScopes = mcpClientScopeGroups.flatMap((group) => group.scopes);
  assert.equal(new Set(visibleScopes).size, visibleScopes.length, 'scope picker contains duplicate scopes');

  for (const operation of mcpExternalBusinessOperations) {
    for (const scope of resolveOperationDescriptor(operation).requiredScopes) {
      assert.ok(visibleScopes.includes(scope), `${operation} requires hidden scope ${scope}`);
    }
  }

  for (const scope of ['knowledge.read', 'knowledge.write', 'files.images.read']) {
    assert.ok(visibleScopes.includes(scope), `daily import scope ${scope} is hidden`);
  }
});

test('external client scope picker excludes control-plane administration scopes', () => {
  const { mcpClientScopeGroups } = require(path.join(root, 'dist/main/shared/mcp/v1/clientScopes.js'));
  const visibleScopes = new Set(mcpClientScopeGroups.flatMap((group) => group.scopes));

  for (const scope of [
    'control.manage', 'clients.read', 'clients.manage', 'sessions.read', 'sessions.manage',
    'r4.read', 'r4.manage', 'approvals.read', 'approvals.manage', 'changesets.read',
    'changesets.manage', 'policy.read', 'policy.manage', 'audit.export', 'jobs.admin'
  ]) {
    assert.equal(visibleScopes.has(scope), false, `control-plane scope ${scope} must stay hidden`);
  }
});

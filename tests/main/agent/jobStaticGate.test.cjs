const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../..');

test('C8 JobExecutor has no coordinator capability, writer queue, service, or persistence bypass', () => {
  const executor = fs.readFileSync(path.join(root, 'src/main/agent/jobExecutor.ts'), 'utf8');
  assert.doesNotMatch(executor, /DatabaseCoordinator|createDatabaseCoordinator|executeControlWrite|queueTail|\.run\(|\.exec\(|getDatabase|services\//);
  assert.match(executor, /gateway\.execute|gateway\.query/);
  assert.equal((executor.match(/leaseNext\(/g) ?? []).length, 1);
  assert.match(executor, /hasQueued\(\)/);
  const store = fs.readFileSync(path.join(root, 'src/main/agent/jobStore.ts'), 'utf8');
  assert.match(store, /executeControlWrite/);
  assert.doesNotMatch(store, /createDatabaseCoordinator/);
  assert.match(store, /job\.status === 'running' && job\.progress < 25/);
  assert.match(store, /cancellation_requested_at = COALESCE/);
  assert.match(store, /job\.status === 'failed' && row\.result_ref === null/);
});

test('C8 MCP job files do not import services, persistence, or database handles', () => {
  for (const file of ['projection.ts', 'service.ts']) {
    const source = fs.readFileSync(path.join(root, 'src/main/mcp/jobs', file), 'utf8');
    assert.doesNotMatch(source, /services|persistence|databaseService|sql\.js/);
  }
});

test('C8 Tasks retain creating-session isolation and deferred-cancel projection', () => {
  const service = fs.readFileSync(path.join(root, 'src/main/mcp/jobs/service.ts'), 'utf8');
  assert.match(service, /creatingSessionId !== principal\.sessionId/);
  assert.match(service, /sessionId: principal\.sessionId/);
  assert.doesNotMatch(service, /job\.status !== 'cancelled'/);
});

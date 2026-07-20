const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const test = require('node:test');
const { cleanupControlPlaneRoot, databaseService, projectRoot, resetControlPlaneEnvironment } = require('../helpers/controlPlaneTestEnv.cjs');

test.after(() => cleanupControlPlaneRoot());
test.beforeEach(resetControlPlaneEnvironment);

test('C9 inventory and external manifest keep the exact bounded slice', () => {
  const inventory = fs.readFileSync(path.join(projectRoot, 'docs/tasks/2026-07-18-agent-control-plane-c9-write-entry-inventory.md'), 'utf8');
  const manifest = require(path.join(projectRoot, 'dist/main/shared/mcp/v1/exposureManifest.js'));
  const expected = ['knowledge.list_nodes', 'knowledge.get_node', 'knowledge.list_links', 'textbooks.list', 'textbooks.get', 'analytics.get_weak_areas', 'knowledge.link_question', 'knowledge.unlink_question', 'knowledge.bind_textbook'];
  for (const operation of expected) assert.ok(manifest.mcpExternalBusinessOperations.includes(operation));
  assert.equal(manifest.mcpExternalBusinessOperations.length, 33);
  for (const forbidden of ['import', 'seed', 'rematch', 'sql', 'pdf']) assert.doesNotMatch(JSON.stringify(manifest.mcpExternalBusinessOperations), new RegExp(forbidden, 'i'));
  assert.match(inventory, /Exact external set/);
});

test('knowledge application writes are revision-neutral on no-op and textbook reads redact paths', async () => {
  const coordinator = await databaseService.getDatabaseCoordinator();
  const application = await databaseService.getKnowledgeApplication();
  const now = new Date().toISOString();
  await coordinator.executeWrite({ requestId: 'c9-seed', concurrency: 'none', execute(database) {
    database.run(`INSERT INTO questions (id, title, content, answer, wrong_solution, correct_solution, subject, category, question_type, difficulty, source, error_reason, wrong_thinking, mastery_level, review_count, correct_count, wrong_count, no_idea_count, created_at, updated_at) VALUES (9001, 'Q', '', '', '', '', '高等数学', 'C', 'T', '简单', '', '', '', '较弱', 0, 0, 1, 0, ?, ?)`, [now, now]);
    database.run(`INSERT INTO textbooks (id, title, subject, edition, file_name, file_path, note, created_at, updated_at) VALUES (9001, 'Book', '高等数学', '1', 'book.pdf', 'C:\\private\\book.pdf', '', ?, ?)`, [now, now]);
    database.run(`INSERT INTO knowledge_points (node_id, title, subject, category, level, sort_order, summary, core_formulas, common_question_types, common_error_reasons, tags, created_at, updated_at) VALUES ('c9-node', 'Node', '高等数学', 'C', 1, 1, '', '[]', '[]', '[]', '[]', ?, ?)`, [now, now]);
    return { changed: true, value: null };
  }});
  const context = (version) => ({ trust: 'trusted', source: 'renderer', requestId: crypto.randomUUID(), traceId: crypto.randomUUID(), actor: { actorId: 'test', actorType: 'user' }, client: { clientId: 'renderer' }, timestamp: new Date().toISOString(), concurrency: 'strict', expectedVersion: version });
  const crypto = require('node:crypto');
  const before = coordinator.currentVersion();
  const linked = await application.execute({ type: 'knowledge.link_question', payload: { questionId: 9001, nodeId: 'c9-node', matchType: 'manual' } }, context(before));
  assert.equal(linked.changed, true);
  const replay = await application.execute({ type: 'knowledge.link_question', payload: { questionId: 9001, nodeId: 'c9-node', matchType: 'manual' } }, context(coordinator.currentVersion()));
  assert.equal(replay.changed, false);
  const books = application.query({ type: 'textbooks.list', payload: { limit: 10 } }, context(coordinator.currentVersion()));
  assert.equal(Object.hasOwn(books.value[0], 'file_path'), false);
  assert.equal(JSON.stringify(books.value).includes('C:\\private'), false);
});

test('C9 Renderer adapter and authenticated Gateway preserve bounded write/query semantics', async () => {
  const crypto = require('node:crypto');
  const coordinator = await databaseService.getDatabaseCoordinator();
  const application = await databaseService.getKnowledgeApplication();
  const controlPlane = await databaseService.getAgentControlPlane();
  const now = new Date().toISOString();
  await coordinator.executeWrite({ requestId: 'c9-gateway-seed', concurrency: 'none', execute(database) {
    database.run(`INSERT INTO questions (id, title, content, answer, wrong_solution, correct_solution, subject, category, question_type, difficulty, source, error_reason, wrong_thinking, mastery_level, review_count, correct_count, wrong_count, no_idea_count, created_at, updated_at) VALUES (9101, 'Q', '', '', '', '', '高等数学', 'C', 'T', '简单', '', '', '', '较弱', 0, 0, 1, 0, ?, ?)`, [now, now]);
    database.run(`INSERT INTO textbooks (id, title, subject, edition, file_name, file_path, note, created_at, updated_at) VALUES (9101, 'Book', '高等数学', '1', 'book.pdf', 'C:\\private\\book.pdf', '', ?, ?)`, [now, now]);
    database.run(`INSERT INTO knowledge_points (node_id, title, subject, category, level, sort_order, summary, core_formulas, common_question_types, common_error_reasons, tags, created_at, updated_at) VALUES ('c9-gateway-node', 'Node', '高等数学', 'C', 1, 1, '', '[]', '[]', '[]', '[]', ?, ?)`, [now, now]);
    return { changed: true, value: null };
  }});
  const agent = require(path.join(projectRoot, 'dist/main/shared/agent/index.js'));
  const requestId = crypto.randomUUID();
  const version = coordinator.currentVersion();
  const envelope = { apiVersion: 1, kind: 'agent-command', operation: 'knowledge.link_question', payload: { questionId: 9101, nodeId: 'c9-gateway-node', matchType: 'manual' }, requestId, expectedVersion: version, catalog: agent.operationCatalogIdentity };
  const first = await controlPlane.gateway.execute(envelope, controlPlane.renderer.principal());
  const replay = await controlPlane.gateway.execute(envelope, controlPlane.renderer.principal());
  assert.equal(first.kind, 'completed'); assert.equal(replay.kind, 'replayed');
  assert.equal(coordinator.currentVersion().dataRevision, version.dataRevision + 1);
  const listed = await controlPlane.gateway.query({ apiVersion: 1, kind: 'agent-query', operation: 'textbooks.list', payload: { limit: 10 }, requestId: crypto.randomUUID(), catalog: agent.operationCatalogIdentity }, controlPlane.renderer.principal());
  assert.equal(listed.kind, 'completed');
  assert.equal(JSON.stringify(listed.result.value).includes('file_path'), false);
  assert.equal(JSON.stringify(listed.result.value).includes('C:\\private'), false);
  const stale = await controlPlane.gateway.execute({ ...envelope, requestId: crypto.randomUUID(), payload: { nodeId: 'c9-gateway-node', textbookId: 9101 } , operation: 'knowledge.bind_textbook' }, controlPlane.renderer.principal());
  assert.equal(stale.kind, 'rejected');
  assert.equal(stale.error.code, 'DATA_REVISION_CONFLICT');
  const audit = (await databaseService.getDatabase()).exec("SELECT operation FROM agent_audit_events WHERE operation = 'knowledge.link_question'")[0].values;
  assert.equal(audit.length, 2);
});

test('C9 adapter is Gateway-only and exact Renderer IPC channels are registered', () => {
  const adapter = fs.readFileSync(path.join(projectRoot, 'src/main/ipc/adapters/knowledgeIpc.ts'), 'utf8');
  const ipc = fs.readFileSync(path.join(projectRoot, 'src/main/ipc/registerIpc.ts'), 'utf8');
  assert.doesNotMatch(adapter, /services\/|databaseCoordinator|getDatabase\(|\.run\(|\.exec\(|\.prepare\(/);
  for (const channel of ['knowledge:listNodes', 'knowledge:getNode', 'knowledge:listLinks', 'textbooks:list', 'textbooks:get', 'analytics:getWeakAreas', 'knowledge:linkQuestion', 'knowledge:unlinkQuestion', 'knowledge:bindTextbook']) assert.match(ipc, new RegExp(`handle\\('${channel}'`));
});

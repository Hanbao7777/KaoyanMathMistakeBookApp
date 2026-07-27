const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const test = require('node:test');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const bootstrap = environment.requireMain('agent/bootstrap.js');
const authentication = environment.requireMain('agent/clientAuthenticator.js');
const agent = require(path.join(environment.projectRoot, 'dist/main/shared/agent/index.js'));

test.after(() => environment.cleanupControlPlaneRoot());
test.beforeEach(environment.resetControlPlaneEnvironment);

async function compose() {
  const coordinator = await environment.databaseService.getDatabaseCoordinator();
  const questions = await environment.databaseService.getQuestionsApplication();
  const tickTick = await environment.databaseService.getTickTickApplication();
  const knowledge = await environment.databaseService.getKnowledgeApplication();
  const verifier = { verify(raw) { return { credentialFingerprint: authentication.fingerprintCredential(raw.credential), sessionFingerprint: authentication.fingerprintCredential(raw.session) }; } };
  const options = { coordinator, commandBus: questions.gateway.commandBus, queryBus: questions.gateway.queryBus, selectedCandidateEvidence: true, appInstanceId: 'c9-external', credentialVerifier: verifier, cursorSecret: 'c9'.repeat(16), jobResultRoot: environment.resultRoot,
    resolveState: (envelope, descriptor) => descriptor.domain === 'questions' ? questions.gateway.resolveState(envelope, descriptor) : ['knowledge', 'textbooks', 'analytics'].includes(descriptor.domain) ? knowledge.resolveState(envelope, descriptor) : tickTick.resolveState(envelope, descriptor),
    executeBusinessCommand: (command, context, dispatch) => command.type.startsWith('questions.') ? questions.gateway.execute(command, context, dispatch) : dispatch(), tickTickApplication: tickTick, knowledgeApplication: knowledge };
  const composition = await bootstrap.bootstrapAgentGateway(options);
  const b3 = await bootstrap.bootstrapAgentB3({ coordinator, appInstanceId: 'c9-external', credentialVerifier: verifier, cursorSecret: 'c9'.repeat(16) });
  const credential = authentication.fingerprintCredential('c9-credential'); const session = authentication.fingerprintCredential('c9-session');
  await b3.registry.registerClient({ clientId: 'c9-client', subjectId: 'c9-subject', displayName: 'C9 Client', credentialFingerprint: credential, scopes: ['analytics.read', 'knowledge.read', 'knowledge.write', 'textbooks.read'], trust: 'full_control' });
  await b3.registry.setExternalControlEnabled(true);
  await b3.registry.createSession('c9-client', credential, session, new Date(Date.now() + 60 * 60_000).toISOString());
  return {
    coordinator,
    gateway: composition.gateway,
    authenticator: composition.authenticator,
    registry: b3.registry,
    principal: await composition.authenticator.authenticate({ credential: 'c9-credential', session: 'c9-session' })
  };
}

test('C9 external Gateway enforces scope, receipts, revisions, audit, restart, and affected bindings', async () => {
  const { coordinator, gateway, authenticator, registry, principal } = await compose(); const now = new Date().toISOString();
  await coordinator.executeWrite({ requestId: 'c9-external-seed', concurrency: 'none', execute(database) {
    database.run(`INSERT INTO questions (id,title,content,answer,wrong_solution,correct_solution,subject,category,question_type,difficulty,source,error_reason,wrong_thinking,mastery_level,review_count,correct_count,wrong_count,no_idea_count,created_at,updated_at) VALUES (9201,'Q','','','','','高等数学','C','T','简单','','','','较弱',0,0,1,0,?,?)`, [now, now]);
    database.run(`INSERT INTO textbooks (id,title,subject,edition,file_name,file_path,note,created_at,updated_at) VALUES (9201,'Book','高等数学','1','book.pdf','C:\\private\\book.pdf','',?,?)`, [now, now]);
    database.run(`INSERT INTO knowledge_points (node_id,title,subject,category,level,sort_order,summary,core_formulas,common_question_types,common_error_reasons,tags,created_at,updated_at) VALUES ('c9-external-node','Node','高等数学','C',1,1,'','[]','[]','[]','[]',?,?)`, [now, now]); return { changed: true, value: null };
  }});
  const version = coordinator.currentVersion(); const requestId = crypto.randomUUID();
  const envelope = { apiVersion: 1, kind: 'agent-command', operation: 'knowledge.link_question', payload: { questionId: 9201, nodeId: 'c9-external-node', matchType: 'manual' }, requestId, expectedVersion: version, catalog: agent.operationCatalogIdentity };
  const first = await gateway.execute(envelope, principal); const replay = await gateway.execute(envelope, principal);
  assert.equal(first.kind, 'completed'); assert.equal(replay.kind, 'replayed'); assert.deepEqual(first.result.dataVersion, replay.result.dataVersion);
  assert.deepEqual(first.result.events[0].payload, { questionId: 9201, nodeId: 'c9-external-node' });
  const stale = await gateway.execute({ ...envelope, requestId: crypto.randomUUID(), operation: 'knowledge.bind_textbook', payload: { nodeId: 'c9-external-node', textbookId: 9201 } }, principal);
  assert.equal(stale.kind, 'rejected'); assert.equal(stale.error.code, 'DATA_REVISION_CONFLICT');
  const readonlyCredential = authentication.fingerprintCredential('c9-readonly-credential');
  const readonlySession = authentication.fingerprintCredential('c9-readonly-session');
  await registry.registerClient({ clientId: 'c9-readonly', subjectId: 'c9-readonly-subject', displayName: 'C9 Readonly', credentialFingerprint: readonlyCredential, scopes: ['knowledge.read'], trust: 'observer' });
  await registry.createSession('c9-readonly', readonlyCredential, readonlySession, new Date(Date.now() + 60 * 60_000).toISOString());
  const readonly = await authenticator.authenticate({ credential: 'c9-readonly-credential', session: 'c9-readonly-session' });
  const denied = await gateway.execute({ ...envelope, requestId: crypto.randomUUID(), expectedVersion: coordinator.currentVersion() }, readonly);
  assert.equal(denied.kind, 'rejected'); assert.equal(denied.error.code, 'SCOPE_DENIED');
  const query = await gateway.query({ apiVersion: 1, kind: 'agent-query', operation: 'textbooks.get', payload: { textbookId: 9201 }, requestId: crypto.randomUUID(), catalog: agent.operationCatalogIdentity }, principal);
  assert.equal(query.kind, 'completed'); assert.equal(JSON.stringify(query.result.value).includes('file_path'), false); assert.equal(JSON.stringify(query.result.value).includes('C:\\private'), false);
  assert.equal(coordinator.currentVersion().dataRevision, version.dataRevision + 1);
  const database = await environment.databaseService.getDatabase();
  assert.equal(database.exec("SELECT COUNT(*) FROM agent_audit_events WHERE operation = 'knowledge.link_question'")[0].values[0][0], 3);
  const receipt = database.exec('SELECT affected_set_hash, status FROM agent_idempotency WHERE client_id = ? AND request_id = ?', ['c9-client', requestId])[0].values[0];
  assert.equal(receipt[0], agent.hashCanonicalJson([
    { entityType: 'knowledge_point', entityId: 'c9-external-node' },
    { entityType: 'question', entityId: '9201' }
  ]));
  assert.equal(receipt[1], 'completed');

  environment.databaseService.resetDatabaseConnection();
  await environment.databaseService.initializeDatabase({ agent: { appInstanceId: 'c9-restarted', cursorSecret: 'r'.repeat(32) } });
  const reopened = await environment.databaseService.getDatabase();
  assert.deepEqual(reopened.exec('SELECT status FROM agent_idempotency WHERE client_id = ? AND request_id = ?', ['c9-client', requestId])[0].values[0], ['completed']);
});

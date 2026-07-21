const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const bootstrap = environment.requireMain('agent/bootstrap.js');
const authentication = environment.requireMain('agent/clientAuthenticator.js');
const { JobExecutor } = environment.requireMain('agent/jobExecutor.js');
const pathService = environment.requireMain('services/pathService.js');
const agent = require(path.join(environment.projectRoot, 'dist/main/shared/agent/index.js'));

const initialNow = '2026-07-18T00:00:00.000Z';
let currentNow = initialNow;
let executorErrors = [];

async function reset(options = {}) {
  executorErrors = [];
  currentNow = initialNow;
  await environment.databaseService.shutdownDatabase().catch(() => undefined);
  environment.databaseService.resetDatabaseConnection();
  fs.rmSync(environment.assertOwnedPath(environment.dataRoot), { recursive: true, force: true });
  fs.rmSync(environment.assertOwnedPath(environment.userDataRoot), { recursive: true, force: true });
  fs.mkdirSync(environment.assertOwnedPath(environment.recoveryRoot), { recursive: true });
  pathService.setDataRoot(environment.dataRoot);
  await environment.databaseService.initializeDatabase({
    now: () => currentNow,
    agent: {
      appInstanceId: 'c8-job-instance',
      jobResultRoot: environment.resultRoot,
      credentialVerifier: {
        verify(raw) {
          return { credentialFingerprint: authentication.fingerprintCredential(raw.credential), sessionFingerprint: authentication.fingerprintCredential(raw.session) };
        }
      },
      jobExecutorOnError(error) { executorErrors.push(error); },
      ...options
    }
  });
}

async function client(clientId = 'c8-client', sessionText = 'c8-session', options = {}) {
  const coordinator = await environment.databaseService.getDatabaseCoordinator();
  const registry = await bootstrap.bootstrapAgentB3({
    coordinator, appInstanceId: 'c8-job-instance', credentialVerifier: { verify() { throw new Error('unused'); } },
    cursorSecret: crypto.randomBytes(32), now: () => currentNow, randomUUID: crypto.randomUUID
  });
  const credential = authentication.fingerprintCredential(`${clientId}-credential`);
  const session = authentication.fingerprintCredential(sessionText);
  await registry.registry.registerClient({
    clientId, subjectId: `${clientId}-subject`, displayName: clientId, credentialFingerprint: credential,
    scopes: options.scopes ?? ['jobs.cancel', 'jobs.execute', 'jobs.read', 'questions.read', 'reviews.read'],
    trust: options.trust ?? 'full_control'
  });
  await registry.registry.setExternalControlEnabled(true);
  await registry.registry.createSession(clientId, credential, session, '2026-07-18T01:00:00.000Z');
  const plane = await environment.databaseService.getAgentControlPlane();
  const principal = await plane.authenticator.authenticate({ credential: `${clientId}-credential`, session: sessionText });
  return { plane, principal, registry: registry.registry };
}

function questionInput(title) {
  return {
    title, content: 'content', wrong_thinking: 'wrong', wrong_solution: '', correct_solution: 'correct', answer: '1',
    subject: '高等数学', category: '函数、极限、连续', question_type: '解答题', error_reason: '概念不清',
    source: 'c8-jobs', difficulty: '中等', mastery_level: '一般', note: '', tags: ['c8'],
    questionImageSources: [], solutionImageSources: []
  };
}

async function additionalSession(registry, clientId, sessionText) {
  const credential = authentication.fingerprintCredential(`${clientId}-credential`);
  await registry.createSession(clientId, credential, authentication.fingerprintCredential(sessionText), '2026-07-18T01:00:00.000Z');
  const plane = await environment.databaseService.getAgentControlPlane();
  return plane.authenticator.authenticate({ credential: `${clientId}-credential`, session: sessionText });
}

function createJob(plane, principal, requestId = crypto.randomUUID(), ttlMs = undefined) {
  return plane.gateway.execute({
    apiVersion: 1, kind: 'agent-command', operation: 'jobs.create', requestId, catalog: agent.operationCatalogIdentity,
    payload: { target: { operation: 'questions.review_buckets', kind: 'query', payload: {} }, ...(ttlMs ? { ttlMs } : {}) }
  }, principal);
}

async function waitForJob(plane, principal, jobId, expected) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const outcome = await plane.gateway.query({ apiVersion: 1, kind: 'agent-query', operation: 'jobs.get', payload: { jobId }, requestId: crypto.randomUUID(), catalog: agent.operationCatalogIdentity }, principal);
    assert.equal(outcome.kind, 'completed', JSON.stringify(outcome));
    if (expected.includes(outcome.result.value.status)) return outcome.result.value;
    if (['failed', 'cancelled', 'interrupted'].includes(outcome.result.value.status)) throw new Error(`${JSON.stringify(outcome.result.value)} ${executorErrors.map((error) => error?.stack ?? error).join('\n')}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Job ${jobId} did not reach ${expected.join(',')}`);
}

test.beforeEach(() => reset());
test.after(async () => { await environment.databaseService.shutdownDatabase().catch(() => undefined); environment.cleanupControlPlaneRoot(); });

test('durable jobs execute through Gateway, publish verified results, and isolate owners', async () => {
  const { plane, principal } = await client();
  const direct = await plane.gateway.query({ apiVersion: 1, kind: 'agent-query', operation: 'questions.review_buckets', payload: {}, requestId: crypto.randomUUID(), catalog: agent.operationCatalogIdentity }, principal);
  assert.equal(direct.kind, 'completed', JSON.stringify(direct));
  const created = await createJob(plane, principal);
  assert.equal(created.kind, 'completed');
  const job = created.result.value;
  assert.equal(job.status, 'queued');
  assert.notEqual(job.gatewayRequestId, created.result.value.jobId);
  const terminal = await waitForJob(plane, principal, job.jobId, ['completed']);
  assert.equal(terminal.progress, 100);
  const result = await plane.gateway.query({ apiVersion: 1, kind: 'agent-query', operation: 'jobs.result', payload: { jobId: job.jobId }, requestId: crypto.randomUUID(), catalog: agent.operationCatalogIdentity }, principal);
  assert.equal(result.kind, 'completed');
  assert.equal(result.result.value.result.kind, 'completed');
  const other = await client('c8-other', 'other-session');
  const denied = await plane.gateway.query({ apiVersion: 1, kind: 'agent-query', operation: 'jobs.get', payload: { jobId: job.jobId }, requestId: crypto.randomUUID(), catalog: agent.operationCatalogIdentity }, other.principal);
  assert.equal(denied.kind, 'rejected');
  assert.equal(denied.error.code, 'SCOPE_DENIED');
});

test('approval decisions atomically resume or reject waiting jobs', async () => {
  const { plane, principal } = await client('c8-approval', 'approval-session', {
    trust: 'collaborator',
    scopes: ['jobs.cancel', 'jobs.execute', 'jobs.read', 'questions.read', 'questions.write']
  });
  const coordinator = await environment.databaseService.getDatabaseCoordinator();
  const create = (title) => plane.gateway.execute({
    apiVersion: 1, kind: 'agent-command', operation: 'jobs.create', requestId: crypto.randomUUID(), catalog: agent.operationCatalogIdentity,
    payload: { target: { operation: 'questions.create', kind: 'command', payload: { input: questionInput(title) }, expectedVersion: coordinator.currentVersion() } }
  }, principal);
  const first = await create('approval-resume');
  const waiting = await waitForJob(plane, principal, first.result.value.jobId, ['waiting_approval']);
  assert.equal(waiting.status, 'waiting_approval');
  const renderer = plane.renderer.principal();
  const approvals = await plane.gateway.query({
    apiVersion: 1, kind: 'agent-query', operation: 'agent.approvals.list', payload: { status: 'pending', pageSize: 20 },
    requestId: crypto.randomUUID(), catalog: agent.operationCatalogIdentity
  }, renderer);
  assert.equal(approvals.kind, 'completed');
  const approval = approvals.result.value.items.find((item) => item.clientId === principal.clientId);
  assert.ok(approval);
  const approved = await plane.gateway.execute({
    apiVersion: 1, kind: 'agent-command', operation: 'agent.approvals.approve', payload: { approvalId: approval.approvalId },
    requestId: crypto.randomUUID(), catalog: agent.operationCatalogIdentity
  }, renderer);
  assert.equal(approved.kind, 'completed', JSON.stringify(approved));
  assert.equal((await waitForJob(plane, principal, first.result.value.jobId, ['completed'])).status, 'completed');

  const second = await create('approval-reject');
  await waitForJob(plane, principal, second.result.value.jobId, ['waiting_approval']);
  const pending = await plane.gateway.query({
    apiVersion: 1, kind: 'agent-query', operation: 'agent.approvals.list', payload: { status: 'pending', pageSize: 20 },
    requestId: crypto.randomUUID(), catalog: agent.operationCatalogIdentity
  }, renderer);
  const rejection = pending.result.value.items.find((item) => item.clientId === principal.clientId);
  assert.ok(rejection);
  const rejected = await plane.gateway.execute({
    apiVersion: 1, kind: 'agent-command', operation: 'agent.approvals.reject', payload: { approvalId: rejection.approvalId, reasonCode: 'user_rejected' },
    requestId: crypto.randomUUID(), catalog: agent.operationCatalogIdentity
  }, renderer);
  assert.equal(rejected.kind, 'completed', JSON.stringify(rejected));
  const database = await environment.databaseService.getDatabase();
  assert.deepEqual(database.exec('SELECT status, error_code FROM agent_jobs WHERE job_id = ?', [second.result.value.jobId])[0].values[0], ['failed', 'APPROVAL_INVALID']);
});

test('applying a job-owned change set resumes the original idempotent job', async () => {
  const { plane, principal, registry } = await client('c8-changeset', 'changeset-session', {
    scopes: ['jobs.cancel', 'jobs.execute', 'jobs.read', 'questions.read', 'questions.write']
  });
  await registry.updatePolicy('c8-changeset-policy', [{
    apiVersion: 1, operation: 'questions.create', catalog: agent.operationCatalogIdentity, requireChangeSet: true
  }]);
  const coordinator = await environment.databaseService.getDatabaseCoordinator();
  const created = await plane.gateway.execute({
    apiVersion: 1, kind: 'agent-command', operation: 'jobs.create', requestId: crypto.randomUUID(), catalog: agent.operationCatalogIdentity,
    payload: { target: { operation: 'questions.create', kind: 'command', payload: { input: questionInput('changeset-resume') }, expectedVersion: coordinator.currentVersion() } }
  }, principal);
  await waitForJob(plane, principal, created.result.value.jobId, ['waiting_approval']);
  const renderer = plane.renderer.principal();
  const listed = await plane.gateway.query({
    apiVersion: 1, kind: 'agent-query', operation: 'agent.changesets.list', payload: { status: 'draft', pageSize: 20 },
    requestId: crypto.randomUUID(), catalog: agent.operationCatalogIdentity
  }, renderer);
  assert.equal(listed.kind, 'completed');
  const changeSet = listed.result.value.items.find((item) => item.clientId === principal.clientId);
  assert.ok(changeSet);
  const applied = await plane.gateway.execute({
    apiVersion: 1, kind: 'agent-command', operation: 'agent.changesets.apply', payload: { changeSetId: changeSet.changeSetId },
    requestId: crypto.randomUUID(), catalog: agent.operationCatalogIdentity
  }, renderer);
  assert.equal(applied.kind, 'completed', JSON.stringify(applied));
  assert.equal((await waitForJob(plane, principal, created.result.value.jobId, ['completed'])).status, 'completed');
  const stored = await plane.gateway.query({
    apiVersion: 1, kind: 'agent-query', operation: 'agent.changesets.get', payload: { changeSetId: changeSet.changeSetId },
    requestId: crypto.randomUUID(), catalog: agent.operationCatalogIdentity
  }, renderer);
  assert.equal(stored.result.value.status, 'applied');
});

test('restart terminalizes an expired waiting workflow instead of leaving input required forever', async () => {
  const { plane, principal } = await client('c8-expired-approval', 'expired-approval-session', {
    trust: 'collaborator',
    scopes: ['jobs.cancel', 'jobs.execute', 'jobs.read', 'questions.read', 'questions.write']
  });
  const coordinator = await environment.databaseService.getDatabaseCoordinator();
  const created = await plane.gateway.execute({
    apiVersion: 1, kind: 'agent-command', operation: 'jobs.create', requestId: crypto.randomUUID(), catalog: agent.operationCatalogIdentity,
    payload: { target: { operation: 'questions.create', kind: 'command', payload: { input: questionInput('expired-approval') }, expectedVersion: coordinator.currentVersion() } }
  }, principal);
  await waitForJob(plane, principal, created.result.value.jobId, ['waiting_approval']);
  plane.jobExecutor.stop();
  currentNow = '2026-07-18T00:16:00.000Z';
  environment.databaseService.resetDatabaseConnection();
  await environment.databaseService.initializeDatabase({ now: () => currentNow, agent: {
    appInstanceId: 'c8-job-instance', jobResultRoot: environment.resultRoot,
    credentialVerifier: { verify() { throw new Error('unused after restart'); } }
  } });
  const database = await environment.databaseService.getDatabase();
  assert.deepEqual(database.exec('SELECT status, error_code FROM agent_jobs WHERE job_id = ?', [created.result.value.jobId])[0].values[0], ['failed', 'APPROVAL_INVALID']);
});

test('cancellation acts before dispatch and terminal rows remain immutable', async () => {
  const { plane, principal } = await client();
  plane.jobExecutor.stop();
  const created = await createJob(plane, principal);
  const jobId = created.result.value.jobId;
  const cancelled = await plane.gateway.execute({ apiVersion: 1, kind: 'agent-command', operation: 'jobs.cancel', payload: { jobId }, requestId: crypto.randomUUID(), catalog: agent.operationCatalogIdentity }, principal);
  assert.equal(cancelled.kind, 'completed');
  assert.equal(cancelled.result.value.status, 'cancelled');
  let database = await environment.databaseService.getDatabase();
  assert.throws(() => database.run("UPDATE agent_jobs SET progress = 99 WHERE job_id = ?", [jobId]), /immutable/);
  await createJob(plane, principal);
  database = await environment.databaseService.getDatabase();
  assert.throws(() => database.run("DELETE FROM agent_jobs WHERE status = 'queued'"), /cannot be deleted/);
});

test('post-dispatch cancellation records durable intent and enforces creating-session isolation', async () => {
  const { plane, principal, registry } = await client();
  plane.jobExecutor.stop();
  const created = await createJob(plane, principal);
  const jobId = created.result.value.jobId;
  const lease = await plane.jobs.leaseNext();
  assert.equal(await plane.jobs.beginDispatch(jobId, lease.leaseToken), true);
  const otherSession = await additionalSession(registry, 'c8-client', 'c8-second-session');
  const denied = await plane.gateway.execute({ apiVersion: 1, kind: 'agent-command', operation: 'jobs.cancel', payload: { jobId }, requestId: crypto.randomUUID(), catalog: agent.operationCatalogIdentity }, otherSession);
  assert.equal(denied.kind, 'rejected');
  assert.equal(denied.error.code, 'SCOPE_DENIED');
  const accepted = await plane.gateway.execute({ apiVersion: 1, kind: 'agent-command', operation: 'jobs.cancel', payload: { jobId }, requestId: crypto.randomUUID(), catalog: agent.operationCatalogIdentity }, principal);
  assert.equal(accepted.kind, 'completed');
  assert.equal(accepted.result.value.status, 'running');
  assert.equal(accepted.result.value.progress, 25);
  assert.equal(typeof accepted.result.value.cancellationRequestedAt, 'string');
});

test('unexpected executor failure yields a stable bounded failed result and preserves FIFO', async () => {
  const leases = ['first', 'second'].map((name, index) => ({
    job: { ...({ apiVersion: 1, jobId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, gatewayRequestId: crypto.randomUUID() }), operation: 'questions.review_buckets' },
    leaseToken: crypto.randomUUID(), target: { operation: 'questions.review_buckets', kind: 'query', payload: { name } }, principalClaims: {}
  }));
  let leaseAttempt = 0;
  const gatewayOrder = [];
  const terminals = [];
  const store = {
    async leaseNext() { leaseAttempt += 1; if (leaseAttempt === 1) throw new Error('transient lease failure'); return leases[leaseAttempt - 2] ?? null; },
    async hasQueued() { return leaseAttempt === 1; },
    async beginDispatch() { return true; }, async bindEvidence() {},
    async terminalize(jobId, _token, status, outcome) { terminals.push({ jobId, status, outcome }); }
  };
  const executor = new JobExecutor({ store, resolvePrincipal: async () => ({}), gateway: {
    async execute() { throw new Error('unexpected'); },
    async query(envelope) { gatewayOrder.push(envelope.payload.name); if (envelope.payload.name === 'first') throw new Error('unexpected executor failure'); return { kind: 'completed', result: { value: {}, dataVersion: { dataEpoch: 'epoch', dataRevision: 1 } } }; }
  } });
  executor.start();
  for (let attempt = 0; attempt < 100 && terminals.length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  executor.stop();
  assert.deepEqual(gatewayOrder, ['first', 'second']);
  assert.deepEqual(terminals.map(({ status }) => status), ['failed', 'completed']);
  assert.equal(leaseAttempt, 4);

  const { plane, principal: owner } = await client('c8-failed-result', 'failed-result-session');
  plane.jobExecutor.stop();
  const created = await createJob(plane, owner);
  const lease = await plane.jobs.leaseNext();
  await plane.jobs.terminalize(created.result.value.jobId, lease.leaseToken, 'failed', undefined, new Error('unexpected'));
  const result = await plane.gateway.query({ apiVersion: 1, kind: 'agent-query', operation: 'jobs.result', payload: { jobId: created.result.value.jobId }, requestId: crypto.randomUUID(), catalog: agent.operationCatalogIdentity }, owner);
  assert.equal(result.kind, 'completed');
  assert.equal(result.result.value.result.kind, 'rejected');
  assert.equal(result.result.value.result.error.code, 'INTERNAL_ERROR');
  assert.ok(result.result.value.resultSize < 1_000);
});

test('stopAndDrain settles executor errors and remains idempotent while stopped and idle', async () => {
  let leaseReached;
  let releaseLease;
  const leaseStarted = new Promise((resolve) => { leaseReached = resolve; });
  const leaseGate = new Promise((resolve) => { releaseLease = resolve; });
  const failure = new Error('lease failure during drain');
  const errors = [];
  let leaseAttempts = 0;
  const executor = new JobExecutor({
    store: {
      async leaseNext() {
        leaseAttempts += 1;
        leaseReached();
        await leaseGate;
        throw failure;
      },
      async hasQueued() { return true; }
    },
    resolvePrincipal: async () => ({}),
    gateway: { async execute() { throw new Error('unreachable'); }, async query() { throw new Error('unreachable'); } },
    onError(error) { errors.push(error); }
  });

  executor.start();
  await leaseStarted;
  const drained = executor.stopAndDrain();
  executor.kick();
  releaseLease();
  await drained;
  await executor.stopAndDrain();

  assert.equal(executor.isIdle(), true);
  assert.equal(executor.isStopped(), true);
  assert.equal(leaseAttempts, 1);
  assert.deepEqual(errors, [failure]);
});

test('maintenance rejection suspends the drain until explicit resume', async () => {
  const lease = {
    job: { apiVersion: 1, jobId: '00000000-0000-4000-8000-000000000091', gatewayRequestId: crypto.randomUUID(), operation: 'questions.review_buckets' },
    leaseToken: crypto.randomUUID(), target: { operation: 'questions.review_buckets', kind: 'query', payload: {} }, principalClaims: {}
  };
  let queued = true;
  let leaseAttempts = 0;
  let dispatchAttempts = 0;
  let queryAttempts = 0;
  let requeues = 0;
  const terminals = [];
  const executor = new JobExecutor({
    store: {
      async leaseNext() {
        if (!queued) return null;
        queued = false;
        leaseAttempts += 1;
        return lease;
      },
      async hasQueued() { return queued; },
      async beginDispatch() { dispatchAttempts += 1; return true; },
      async bindEvidence() {},
      async requeueAtSafeCheckpoint() { requeues += 1; queued = true; },
      async terminalize(_jobId, _token, status) { terminals.push(status); }
    },
    resolvePrincipal: async () => ({}),
    gateway: {
      async execute() { throw new Error('unreachable'); },
      async query() {
        queryAttempts += 1;
        return queryAttempts === 1
          ? { kind: 'rejected', error: { code: 'MAINTENANCE_FENCE', message: 'maintenance', retryable: true } }
          : { kind: 'completed', result: { value: {}, dataVersion: { dataEpoch: 'epoch', dataRevision: 1 } } };
      }
    }
  });

  executor.start();
  await executor.whenIdle();
  assert.deepEqual({ leaseAttempts, dispatchAttempts, queryAttempts, requeues, terminals }, {
    leaseAttempts: 1, dispatchAttempts: 1, queryAttempts: 1, requeues: 1, terminals: []
  });
  assert.equal(executor.isIdle(), true);

  await executor.resume();
  await executor.whenIdle();
  assert.deepEqual({ leaseAttempts, dispatchAttempts, queryAttempts, requeues, terminals }, {
    leaseAttempts: 2, dispatchAttempts: 2, queryAttempts: 2, requeues: 1, terminals: ['completed']
  });
});

test('transient maintenance fence from a newly admitted write retries once without a poller', async () => {
  const lease = {
    job: { apiVersion: 1, jobId: '00000000-0000-4000-8000-000000000092', gatewayRequestId: crypto.randomUUID(), operation: 'questions.review_buckets' },
    leaseToken: crypto.randomUUID(), target: { operation: 'questions.review_buckets', kind: 'query', payload: {} }, principalClaims: {}
  };
  let queued = true;
  let fenceWaitReached;
  let releaseFenceWait;
  const fenceWaitStarted = new Promise((resolve) => { fenceWaitReached = resolve; });
  const fenceWaitGate = new Promise((resolve) => { releaseFenceWait = resolve; });
  let leaseAttempts = 0;
  let queryAttempts = 0;
  let requeues = 0;
  let writeActivityVersion = 0;
  const terminals = [];
  const executor = new JobExecutor({
    store: {
      async leaseNext() {
        if (!queued) return null;
        queued = false;
        leaseAttempts += 1;
        return lease;
      },
      async hasQueued() { return queued; },
      async beginDispatch() { return true; },
      async bindEvidence() {},
      async requeueAtSafeCheckpoint() { requeues += 1; queued = true; },
      async terminalize(_jobId, _token, status) { terminals.push(status); }
    },
    resolvePrincipal: async () => ({}),
    gateway: {
      async execute() { throw new Error('unreachable'); },
      async query() {
        queryAttempts += 1;
        if (queryAttempts === 1) writeActivityVersion += 1;
        return queryAttempts === 1
          ? { kind: 'rejected', error: { code: 'MAINTENANCE_FENCE', message: 'transient', retryable: true } }
          : { kind: 'completed', result: { value: {}, dataVersion: { dataEpoch: 'epoch', dataRevision: 1 } } };
      }
    },
    isMaintenanceActive: () => false,
    pendingWrites: () => 0,
    writeActivityVersion: () => writeActivityVersion,
    async waitForTransientFence() {
      fenceWaitReached();
      await fenceWaitGate;
    }
  });

  executor.start();
  await fenceWaitStarted;
  assert.deepEqual({ leaseAttempts, queryAttempts, requeues, terminals }, {
    leaseAttempts: 1, queryAttempts: 1, requeues: 1, terminals: []
  });
  releaseFenceWait();
  await executor.whenIdle();
  assert.deepEqual({ leaseAttempts, queryAttempts, requeues, terminals }, {
    leaseAttempts: 2, queryAttempts: 2, requeues: 1, terminals: ['completed']
  });
});

test('transient maintenance fence from an already pending write retries once without a poller', async () => {
  const lease = {
    job: { apiVersion: 1, jobId: '00000000-0000-4000-8000-000000000093', gatewayRequestId: crypto.randomUUID(), operation: 'questions.review_buckets' },
    leaseToken: crypto.randomUUID(), target: { operation: 'questions.review_buckets', kind: 'query', payload: {} }, principalClaims: {}
  };
  let queued = true;
  let releaseFenceWait;
  const fenceWaitGate = new Promise((resolve) => { releaseFenceWait = resolve; });
  let leaseAttempts = 0;
  let queryAttempts = 0;
  let requeues = 0;
  let pendingWrites = 1;
  let fenceWaitCalls = 0;
  const terminals = [];
  const executor = new JobExecutor({
    store: {
      async leaseNext() {
        if (!queued) return null;
        queued = false;
        leaseAttempts += 1;
        return lease;
      },
      async hasQueued() { return queued; },
      async beginDispatch() { return true; },
      async bindEvidence() {},
      async requeueAtSafeCheckpoint() { requeues += 1; queued = true; },
      async terminalize(_jobId, _token, status) { terminals.push(status); }
    },
    resolvePrincipal: async () => ({}),
    gateway: {
      async execute() { throw new Error('unreachable'); },
      async query() {
        queryAttempts += 1;
        if (queryAttempts === 1) pendingWrites = 0;
        return queryAttempts === 1
          ? { kind: 'rejected', error: { code: 'MAINTENANCE_FENCE', message: 'transient', retryable: true } }
          : { kind: 'completed', result: { value: {}, dataVersion: { dataEpoch: 'epoch', dataRevision: 1 } } };
      }
    },
    isMaintenanceActive: () => false,
    pendingWrites: () => pendingWrites,
    writeActivityVersion: () => 1,
    async waitForTransientFence() {
      fenceWaitCalls += 1;
      await fenceWaitGate;
    }
  });

  executor.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual({ leaseAttempts, queryAttempts, requeues, fenceWaitCalls, terminals }, {
    leaseAttempts: 1, queryAttempts: 1, requeues: 1, fenceWaitCalls: 1, terminals: []
  });
  assert.equal(executor.isIdle(), false);
  releaseFenceWait();
  await executor.whenIdle();
  assert.deepEqual({ leaseAttempts, queryAttempts, requeues, fenceWaitCalls, terminals }, {
    leaseAttempts: 2, queryAttempts: 2, requeues: 1, fenceWaitCalls: 1, terminals: ['completed']
  });
});

test('database shutdown drains the executor terminal callback before closing sql.js', async () => {
  let terminalCallbackReached;
  let releaseTerminalCallback;
  const terminalCallbackStarted = new Promise((resolve) => { terminalCallbackReached = resolve; });
  const terminalCallbackGate = new Promise((resolve) => { releaseTerminalCallback = resolve; });
  let gated = false;
  await reset({
    async jobExecutorOnTerminalized() {
      if (gated) return;
      gated = true;
      terminalCallbackReached();
      await terminalCallbackGate;
    }
  });
  const { plane, principal } = await client('c8-lifecycle', 'lifecycle-session');
  const created = await createJob(plane, principal);
  await terminalCallbackStarted;

  const database = await environment.databaseService.getDatabase();
  const status = database.exec('SELECT status FROM agent_jobs WHERE job_id = ?', [created.result.value.jobId])[0].values[0][0];
  const coordinator = await environment.databaseService.getDatabaseCoordinator();
  assert.equal(status, 'completed');
  assert.equal(coordinator.pendingWrites, 0);
  const close = database.close.bind(database);
  let closeCalled = false;
  database.close = () => {
    closeCalled = true;
    close();
  };
  const resetPromise = environment.databaseService.shutdownDatabase()
    .then(() => environment.databaseService.resetDatabaseConnection());

  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closeCalled, false, 'database closed while the executor terminal callback was active');
    assert.equal(plane.jobExecutor.isIdle(), false);
    releaseTerminalCallback();
    await resetPromise;
    assert.equal(plane.jobExecutor.isIdle(), true);
    assert.equal(closeCalled, true);
  } finally {
    releaseTerminalCallback();
    await resetPromise.catch(() => undefined);
  }
});

test('rejected synchronous reset preserves executor state while coordinator writes are pending', async () => {
  const { plane } = await client('c8-reset-pending', 'reset-pending-session');
  await plane.jobExecutor.whenIdle();
  const coordinator = await environment.databaseService.getDatabaseCoordinator();
  let writeReached;
  let releaseWrite;
  const writeStarted = new Promise((resolve) => { writeReached = resolve; });
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const writePromise = coordinator.executeWrite({
    requestId: 'c8-reset-pending-write',
    concurrency: 'none',
    async execute() {
      writeReached();
      await writeGate;
      return { changed: false, value: undefined };
    }
  });
  await writeStarted;

  try {
    assert.equal(coordinator.pendingWrites, 1);
    assert.throws(() => environment.databaseService.resetDatabaseConnection(), /coordinator writes are pending/);
    assert.equal(plane.jobExecutor.isStopped(), false);
  } finally {
    releaseWrite();
    await writePromise;
  }
});

test('rejected synchronous reset preserves an active executor state', async () => {
  let terminalCallbackReached;
  let releaseTerminalCallback;
  const terminalCallbackStarted = new Promise((resolve) => { terminalCallbackReached = resolve; });
  const terminalCallbackGate = new Promise((resolve) => { releaseTerminalCallback = resolve; });
  await reset({
    async jobExecutorOnTerminalized() {
      terminalCallbackReached();
      await terminalCallbackGate;
    }
  });
  const { plane, principal } = await client('c8-reset-active', 'reset-active-session');
  await createJob(plane, principal);
  await terminalCallbackStarted;

  try {
    const coordinator = await environment.databaseService.getDatabaseCoordinator();
    assert.equal(coordinator.pendingWrites, 0);
    assert.equal(plane.jobExecutor.isIdle(), false);
    assert.equal(plane.jobExecutor.isStopped(), false);
    assert.throws(
      () => environment.databaseService.resetDatabaseConnection(),
      /Cannot synchronously reset the database while JobExecutor is active/
    );
    assert.equal(plane.jobExecutor.isStopped(), false);
  } finally {
    releaseTerminalCallback();
    await plane.jobExecutor.whenIdle();
  }
});

test('restart reconciles a result published before its terminal row and interrupts evidence-free leases', async () => {
  await reset({ jobStoreHook(stage) { if (stage === 'before_terminal_write') throw new Error('fault-after-result-publish'); } });
  const { plane, principal } = await client();
  const first = await createJob(plane, principal);
  const firstId = first.result.value.jobId;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const database = await environment.databaseService.getDatabase();
    const row = database.exec('SELECT status FROM agent_jobs WHERE job_id = ?', [firstId]);
    if (row[0]?.values[0]?.[0] === 'running' && fs.existsSync(path.join(environment.resultRoot, `${firstId}.result.json`))) break;
    if (attempt === 99) throw new Error('Fault-injected job did not retain its published result while running');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  plane.jobExecutor.stop();
  const second = await createJob(plane, principal);
  const lease = await plane.jobs.leaseNext();
  assert.equal(lease.job.jobId, second.result.value.jobId);
  environment.databaseService.resetDatabaseConnection();
  await environment.databaseService.initializeDatabase({ now: () => currentNow, agent: { appInstanceId: 'c8-job-instance', jobResultRoot: environment.resultRoot,
    credentialVerifier: { verify() { throw new Error('unused after restart'); } } } });
  const database = await environment.databaseService.getDatabase();
  const rows = database.exec('SELECT job_id, status FROM agent_jobs ORDER BY job_id')[0].values;
  const statuses = new Map(rows);
  assert.equal(statuses.get(firstId), 'completed');
  assert.equal(statuses.get(second.result.value.jobId), 'interrupted');
});

test('restart trusts only durably bound results across every publication boundary', async () => {
  const outcome = { kind: 'completed', result: { value: { due: 0 }, dataVersion: { dataEpoch: 'epoch', dataRevision: 1 } } };
  const stages = [
    ['after_result_binding', 'interrupted'],
    ['before_result_temp', 'interrupted'],
    ['after_result_write', 'interrupted'],
    ['after_result_flush', 'interrupted'],
    ['after_result_rename', 'completed'],
    ['after_result_directory_flush', 'completed'],
    ['before_terminal_write', 'completed']
  ];
  for (const [faultStage, expectedStatus] of stages) {
    await reset({ jobStoreHook(stage) { if (stage === faultStage) throw new Error(`fault-${faultStage}`); } });
    const { plane, principal } = await client(`c8-${faultStage}`, `${faultStage}-session`);
    plane.jobExecutor.stop();
    const created = await createJob(plane, principal);
    const lease = await plane.jobs.leaseNext();
    await assert.rejects(plane.jobs.terminalize(created.result.value.jobId, lease.leaseToken, 'completed', outcome), new RegExp(`fault-${faultStage}`));
    environment.databaseService.resetDatabaseConnection();
    await environment.databaseService.initializeDatabase({ now: () => currentNow, agent: { appInstanceId: 'c8-job-instance', jobResultRoot: environment.resultRoot,
      credentialVerifier: { verify() { throw new Error('unused after restart'); } } } });
    const database = await environment.databaseService.getDatabase();
    const row = database.exec('SELECT status, result_ref FROM agent_jobs WHERE job_id = ?', [created.result.value.jobId])[0].values[0];
    assert.equal(row[0], expectedStatus, faultStage);
    assert.equal(row[1] !== null, expectedStatus === 'completed', faultStage);
  }
});

test('restart removes an unbound forged result and never credits it as completed', async () => {
  const { plane, principal } = await client('c8-forged-result', 'forged-result-session');
  plane.jobExecutor.stop();
  const created = await createJob(plane, principal);
  await plane.jobs.leaseNext();
  const resultPath = path.join(environment.resultRoot, `${created.result.value.jobId}.result.json`);
  const temporaryPath = path.join(environment.resultRoot, `.${created.result.value.jobId}.${'a'.repeat(32)}.tmp`);
  fs.mkdirSync(environment.resultRoot, { recursive: true });
  fs.writeFileSync(resultPath, '{}');
  fs.writeFileSync(temporaryPath, 'partial');
  environment.databaseService.resetDatabaseConnection();
  await environment.databaseService.initializeDatabase({ now: () => currentNow, agent: { appInstanceId: 'c8-job-instance', jobResultRoot: environment.resultRoot,
    credentialVerifier: { verify() { throw new Error('unused after restart'); } } } });
  const database = await environment.databaseService.getDatabase();
  assert.equal(database.exec('SELECT status FROM agent_jobs WHERE job_id = ?', [created.result.value.jobId])[0].values[0][0], 'interrupted');
  assert.equal(fs.existsSync(resultPath), false);
  assert.equal(fs.existsSync(temporaryPath), false);
});

test('result hash and size verification rejects tampering', async () => {
  const { plane, principal } = await client();
  const created = await createJob(plane, principal);
  const job = await waitForJob(plane, principal, created.result.value.jobId, ['completed']);
  fs.writeFileSync(path.join(environment.resultRoot, `${job.jobId}.result.json`), '{}');
  const outcome = await plane.gateway.query({ apiVersion: 1, kind: 'agent-query', operation: 'jobs.result', payload: { jobId: job.jobId }, requestId: crypto.randomUUID(), catalog: agent.operationCatalogIdentity }, principal);
  assert.equal(outcome.kind, 'rejected');
  assert.equal(outcome.error.code, 'RECOVERY_FENCE');
});

test('retention deletes only expired terminal rows and their managed results', async () => {
  const { plane, principal } = await client();
  const created = await createJob(plane, principal, crypto.randomUUID(), 1_000);
  const job = await waitForJob(plane, principal, created.result.value.jobId, ['completed']);
  const resultPath = path.join(environment.resultRoot, `${job.jobId}.result.json`);
  assert.equal(fs.existsSync(resultPath), true);
  currentNow = '2026-07-18T00:00:01.001Z';
  assert.equal(await plane.jobs.purgeExpired(), 1);
  assert.equal(fs.existsSync(resultPath), false);
  const database = await environment.databaseService.getDatabase();
  assert.deepEqual(database.exec('SELECT job_id FROM agent_jobs WHERE job_id = ?', [job.jobId]), []);
});

test('protected retention ignores a shorter caller TTL and enforces the 30-day minimum', async () => {
  const { plane, principal } = await client('c8-protected', 'protected-session');
  const created = await plane.gateway.execute({ apiVersion: 1, kind: 'agent-command', operation: 'jobs.create', requestId: crypto.randomUUID(), catalog: agent.operationCatalogIdentity,
    payload: { target: { operation: 'questions.review_buckets', kind: 'query', payload: {} }, retentionClass: 'protected_30d', ttlMs: 1_000 } }, principal);
  const job = await waitForJob(plane, principal, created.result.value.jobId, ['completed']);
  assert.equal(job.retainUntil, '2026-08-17T00:00:00.000Z');
  currentNow = '2026-07-18T00:00:01.001Z';
  assert.equal(await plane.jobs.purgeExpired(), 0);
  currentNow = '2026-08-17T00:00:00.001Z';
  assert.equal(await plane.jobs.purgeExpired(), 1);
});

test('revoked owners fail atomically while durable jobs survive session termination without starving FIFO', async () => {
  const first = await client('c8-revoked-head', 'revoked-head-session');
  first.plane.jobExecutor.stop();
  const revokedJob = await createJob(first.plane, first.principal);
  await first.registry.revokeClient('c8-revoked-head');
  currentNow = '2026-07-18T00:00:00.001Z';
  const second = await client('c8-terminated-head', 'terminated-head-session');
  second.plane.jobExecutor.stop();
  const terminatedJob = await createJob(second.plane, second.principal);
  await second.registry.terminateSession(second.principal.sessionId);
  currentNow = '2026-07-18T00:00:00.002Z';
  const valid = await client('c8-valid-tail', 'valid-tail-session');
  const validJob = await createJob(valid.plane, valid.principal);
  valid.plane.jobExecutor.start();
  await waitForJob(valid.plane, valid.principal, validJob.result.value.jobId, ['completed']);
  const database = await environment.databaseService.getDatabase();
  assert.deepEqual(database.exec('SELECT status, error_code FROM agent_jobs WHERE job_id = ?', [revokedJob.result.value.jobId])[0].values[0], ['failed', 'CLIENT_REVOKED']);
  assert.deepEqual(database.exec('SELECT status, error_code FROM agent_jobs WHERE job_id = ?', [terminatedJob.result.value.jobId])[0].values[0], ['completed', null]);
});

test('persisted job row corruption fences before recovery can trust casts', async () => {
  for (const [column, value] of [
    ['catalog_hash', `sha256-v1:${'0'.repeat(64)}`],
    ['operation', 'unknown.operation'],
    ['created_at', '2026-99-99T99:99:99.999Z']
  ]) {
    await reset();
    const { plane, principal } = await client(`c8-corrupt-${column}`, `corrupt-${column}-session`);
    plane.jobExecutor.stop();
    const created = await createJob(plane, principal);
    await plane.jobs.leaseNext();
    const database = await environment.databaseService.getDatabase();
    database.run('PRAGMA ignore_check_constraints = ON');
    database.run(`UPDATE agent_jobs SET ${column} = ? WHERE job_id = ?`, [value, created.result.value.jobId]);
    await assert.rejects(plane.jobs.recoveryCandidates(), (error) => error.code === 'RECOVERY_FENCE', column);
  }
});

test('retention reconciles a DB-first deletion after unlink failure on restart', async () => {
  const { plane, principal } = await client('c8-retention-restart', 'retention-restart-session');
  const created = await createJob(plane, principal, crypto.randomUUID(), 1_000);
  const job = await waitForJob(plane, principal, created.result.value.jobId, ['completed']);
  const resultPath = path.join(environment.resultRoot, `${job.jobId}.result.json`);
  currentNow = '2026-07-18T00:00:01.001Z';
  const originalUnlink = fs.promises.unlink;
  fs.promises.unlink = async (target) => { if (path.resolve(target) === path.resolve(resultPath)) { const error = new Error('injected unlink failure'); error.code = 'EACCES'; throw error; } return originalUnlink(target); };
  try { await assert.rejects(plane.jobs.purgeExpired(), /injected unlink failure/); }
  finally { fs.promises.unlink = originalUnlink; }
  let database = await environment.databaseService.getDatabase();
  assert.deepEqual(database.exec('SELECT job_id FROM agent_jobs WHERE job_id = ?', [job.jobId]), []);
  assert.equal(fs.existsSync(resultPath), true);
  environment.databaseService.resetDatabaseConnection();
  await environment.databaseService.initializeDatabase({ now: () => currentNow, agent: { appInstanceId: 'c8-job-instance', jobResultRoot: environment.resultRoot,
    credentialVerifier: { verify() { throw new Error('unused after restart'); } } } });
  database = await environment.databaseService.getDatabase();
  assert.deepEqual(database.exec('SELECT job_id FROM agent_jobs WHERE job_id = ?', [job.jobId]), []);
  assert.equal(fs.existsSync(resultPath), false);
});

test('result publication rejects junction result roots and junction result targets', async () => {
  const junctionRoot = environment.assertOwnedPath(path.join(environment.testRoot, 'c8-junction-root'));
  const junctionOutside = environment.assertOwnedPath(path.join(environment.testRoot, 'c8-junction-outside'));
  fs.rmSync(junctionRoot, { recursive: true, force: true });
  fs.rmSync(junctionOutside, { recursive: true, force: true });
  fs.mkdirSync(junctionOutside, { recursive: true });
  fs.symlinkSync(junctionOutside, junctionRoot, 'junction');
  await assert.rejects(reset({ jobResultRoot: junctionRoot }), (error) => error.code === 'RECOVERY_FENCE');
  assert.deepEqual(fs.readdirSync(junctionOutside), []);

  const safeRoot = environment.assertOwnedPath(path.join(environment.testRoot, 'c8-safe-results'));
  const targetOutside = environment.assertOwnedPath(path.join(environment.testRoot, 'c8-target-outside'));
  fs.rmSync(safeRoot, { recursive: true, force: true });
  fs.rmSync(targetOutside, { recursive: true, force: true });
  await reset({ jobResultRoot: safeRoot });
  const active = await client('c8-target-junction', 'target-junction-session');
  active.plane.jobExecutor.stop();
  const created = await createJob(active.plane, active.principal);
  fs.mkdirSync(safeRoot, { recursive: true });
  fs.mkdirSync(targetOutside, { recursive: true });
  fs.writeFileSync(path.join(targetOutside, 'sentinel.txt'), 'outside');
  fs.symlinkSync(targetOutside, path.join(safeRoot, `${created.result.value.jobId}.result.json`), 'junction');
  active.plane.jobExecutor.start();
  const failed = await waitForJob(active.plane, active.principal, created.result.value.jobId, ['failed']);
  assert.equal(failed.error.code, 'RECOVERY_FENCE');
  assert.equal(fs.readFileSync(path.join(targetOutside, 'sentinel.txt'), 'utf8'), 'outside');
});

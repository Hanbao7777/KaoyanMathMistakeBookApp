const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const databaseService = environment.databaseService;
const localRendererJobSessionId = environment.requireMain('agent/jobStore.js').localRendererJobSessionId;
const { createDatabaseCoordinatorControlCapability } = environment.requireMain('persistence/databaseCoordinator.js');

test.beforeEach(environment.resetControlPlaneEnvironment);
test.after(() => environment.cleanupControlPlaneRoot());

test('C13 local Renderer jobs admit only managed materializers and terminalize forged sentinel jobs without dispatch', async () => {
  const [plane, coordinator] = await Promise.all([databaseService.getAgentControlPlane(), databaseService.getDatabaseCoordinator()]);
  plane.jobExecutor.stop();
  const renderer = plane.renderer.principal();
  const capability = createDatabaseCoordinatorControlCapability(coordinator);
  const created = await coordinator.executeControlWrite(capability, {
    requestId: crypto.randomUUID(),
    execute: (activeDatabase, scope) => plane.jobs.createInTransaction(activeDatabase, scope, {
      target: { operation: 'backups.materialize', kind: 'command', payload: { assetId: 'asset-safe' }, expectedVersion: coordinator.currentVersion() }
    }, renderer)
  });
  const jobId = created.value.jobId;
  const readOnly = await databaseService.getReadOnlyDatabase();
  assert.deepEqual(readOnly.select('SELECT owner_client_id AS ownerClientId, creating_session_id AS creatingSessionId, operation FROM agent_jobs WHERE job_id=?', [jobId])[0], {
    ownerClientId: 'local-renderer-management', creatingSessionId: localRendererJobSessionId, operation: 'backups.materialize'
  });
  await coordinator.executeControlWrite(capability, {
    requestId: crypto.randomUUID(),
    execute: (activeDatabase) => {
      activeDatabase.run('PRAGMA ignore_check_constraints = ON');
      activeDatabase.run("UPDATE agent_jobs SET operation='database.clear_all' WHERE job_id=?", [jobId]);
      return { changed: true, value: undefined };
    }
  });
  const lease = await plane.jobs.leaseNext();
  assert.equal(lease, null);
  assert.deepEqual((await databaseService.getReadOnlyDatabase()).select('SELECT status, error_code AS errorCode FROM agent_jobs WHERE job_id=?', [jobId])[0], { status: 'failed', errorCode: 'RECOVERY_FENCE' });

  const protectedJob = await coordinator.executeControlWrite(capability, {
    requestId: crypto.randomUUID(),
    execute: (activeDatabase, scope) => plane.jobs.createInTransaction(activeDatabase, scope, {
      target: { operation: 'exports.materialize', kind: 'command', payload: { assetId: 'asset-identity' }, expectedVersion: coordinator.currentVersion() }
    }, renderer)
  });
  await coordinator.executeControlWrite(capability, {
    requestId: crypto.randomUUID(),
    execute: (activeDatabase) => {
      activeDatabase.run("UPDATE agent_clients SET trust='observer' WHERE client_id='local-renderer-management'");
      activeDatabase.run("UPDATE agent_sessions SET terminated_at='2026-07-20T00:00:00.000Z' WHERE session_id=?", [localRendererJobSessionId]);
      return { changed: true, value: undefined };
    }
  });
  assert.equal(await plane.jobs.leaseNext(), null);
  assert.deepEqual((await databaseService.getReadOnlyDatabase()).select('SELECT status, error_code AS errorCode FROM agent_jobs WHERE job_id=?', [protectedJob.value.jobId])[0], { status: 'failed', errorCode: 'RECOVERY_FENCE' });

  await assert.rejects(coordinator.executeControlWrite(capability, {
    requestId: crypto.randomUUID(),
    execute: (activeDatabase, scope) => Promise.resolve(plane.jobs.createInTransaction(activeDatabase, scope, {
      target: { operation: 'backups.materialize', kind: 'command', payload: { assetId: 'asset-forged' }, expectedVersion: coordinator.currentVersion() }
    }, { ...renderer, clientId: 'forged-renderer' }))
  }), (error) => error.code === 'SCOPE_DENIED');
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

const journalApi = environment.requireMain('persistence/operationJournal/index.js');
const root = path.join(environment.dataRoot, 'operation-journal');
const managedRoot = path.join(root, 'managed');
const sourceRoot = path.join(root, 'sources');
const dataManifestRoot = path.join(managedRoot, '.operations');
const externalManifestRoot = path.join(environment.recoveryRoot, 'operations');
const versionBefore = { dataEpoch: 'epoch-operation', dataRevision: 10 };
const versionAfter = { dataEpoch: 'epoch-operation', dataRevision: 11 };
let operationSequence = 0;

function evidence(value) {
  return journalApi.evidenceForBytes(Buffer.from(value));
}

async function write(filePath, value) {
  environment.assertOwnedPath(filePath);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, value);
}

async function read(filePath) {
  return fs.promises.readFile(filePath, 'utf8');
}

function pathsFor(name) {
  return {
    source: path.join(sourceRoot, `${name}.source`),
    target: path.join(managedRoot, `${name}.target`),
    staging: path.join(managedRoot, '.staging', `${name}.stage`),
    quarantine: path.join(managedRoot, '.quarantine', `${name}.old`)
  };
}

function createFile(name, value) {
  const paths = pathsFor(name);
  return {
    paths,
    file: {
      fileId: `${name}-file`, kind: 'create', sourcePath: paths.source, targetPath: paths.target,
      stagingPath: paths.staging, content: evidence(value), status: 'pending'
    }
  };
}

function replaceFile(name, newValue, oldValue) {
  const paths = pathsFor(name);
  return {
    paths,
    file: {
      fileId: `${name}-file`, kind: 'replace', sourcePath: paths.source, targetPath: paths.target,
      stagingPath: paths.staging, quarantinePath: paths.quarantine, content: evidence(newValue),
      original: evidence(oldValue), status: 'pending'
    }
  };
}

function deleteFile(name, value) {
  const paths = pathsFor(name);
  return {
    paths,
    file: {
      fileId: `${name}-file`, kind: 'quarantine_delete', targetPath: paths.target,
      quarantinePath: paths.quarantine, content: evidence(value), status: 'pending'
    }
  };
}

function manifestFor(files, options = {}) {
  const operationId = options.operationId ?? `operation-${++operationSequence}`;
  const manifestRoot = options.external ? externalManifestRoot : dataManifestRoot;
  return journalApi.createOperationManifest({
    operationId,
    requestId: `request-${operationId}`,
    commandType: options.commandType ?? 'test.files',
    source: 'internal',
    clientId: 'control-plane-test',
    traceId: `trace-${operationId}`,
    inputHash: evidence(`input-${operationId}`).sha256,
    storage: options.external ? 'external_recovery' : 'data_root',
    versionBefore,
    versionAfter,
    affectedEntities: [{ entityType: 'test', entityId: operationId }],
    roots: { manifestRoot, managedRoots: [managedRoot], sourceRoots: [sourceRoot] },
    files,
    createdAt: '2026-07-15T10:00:00.000Z'
  });
}

function createStore(manifestRoot, overrides = {}) {
  let nonce = 0;
  return new journalApi.OperationManifestStore(manifestRoot, {
    randomId: () => `nonce-${++nonce}`,
    ...overrides
  });
}

function createJournal(store, overrides = {}) {
  return new journalApi.OperationJournal(store, {
    now: () => '2026-07-15T10:00:01.000Z',
    ...overrides
  });
}

async function reset() {
  await fs.promises.rm(root, { recursive: true, force: true });
  await fs.promises.rm(externalManifestRoot, { recursive: true, force: true });
  await fs.promises.mkdir(sourceRoot, { recursive: true });
  await fs.promises.mkdir(managedRoot, { recursive: true });
  await fs.promises.mkdir(externalManifestRoot, { recursive: true });
}

async function recoverOne(store, manifest, databaseVersion = versionBefore, dependencies = {}) {
  const outcome = await createJournal(store, dependencies).recover(manifest, databaseVersion);
  assert.ok(['completed', 'compensated', 'needs_recovery'].includes(outcome.terminalState));
  return outcome;
}

test.beforeEach(reset);
test.after(() => environment.cleanupControlPlaneRoot());

test('strictly validates v1 manifests, transitions, roots, and path confinement', () => {
  const { file } = createFile('strict', 'new');
  const manifest = manifestFor([file], { external: true });
  assert.equal(manifest.manifestVersion, 1);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.roots.manifestRoot, externalManifestRoot);
  assert.doesNotThrow(() => journalApi.validateOperationManifest(manifest));
  assert.throws(() => journalApi.validateOperationManifest({ ...manifest, manifestVersion: 0 }), /Unsupported operation manifest version/);
  assert.throws(() => journalApi.validateOperationManifest({ ...manifest, schemaVersion: 0 }), /Unsupported operation manifest schema version/);
  assert.throws(() => journalApi.validateOperationManifest({ ...manifest, unexpected: true }), /not supported/);
  assert.throws(() => journalApi.transitionOperationManifest(manifest, 'db_committed', manifest.updatedAt), /Illegal operation transition/);
  assert.throws(() => manifestFor([{ ...file, targetPath: path.join(root, '..', 'escape') }]), /escapes its authorized roots/);
  assert.throws(() => manifestFor([{ ...file, stagingPath: path.join(sourceRoot, 'wrong-volume-stage') }]), /escapes its authorized roots/);
  assert.throws(() => manifestFor([{ ...file, stagingPath: file.targetPath }]), /colliding effect paths/);
  assert.throws(() => journalApi.createOperationManifest({
    ...manifest,
    roots: { ...manifest.roots, manifestRoot: managedRoot },
    storage: 'external_recovery'
  }), /outside managed roots/);
});

test('runtime confinement rejects a symbolic-link escape', async () => {
  const outsideRoot = path.join(root, 'outside-managed');
  const linkPath = path.join(managedRoot, 'linked-outside');
  await fs.promises.mkdir(outsideRoot, { recursive: true });
  await fs.promises.symlink(outsideRoot, linkPath, 'junction');
  await assert.rejects(
    () => journalApi.assertRealPathConfined(path.join(linkPath, 'escaped.file'), [managedRoot]),
    /symbolic link/
  );
});

test('atomically publishes manifests and classifies malformed or downgraded scan entries', async () => {
  const { file } = createFile('store', 'new');
  const manifest = manifestFor([file]);
  const store = createStore(dataManifestRoot);
  await store.publish(manifest);
  assert.deepEqual(await store.read(manifest.operationId), manifest);
  const staged = journalApi.transitionOperationManifest(manifest, 'files_staged', '2026-07-15T10:00:01.000Z', {
    files: [{ ...file, status: 'staged' }]
  });
  await store.publish(staged);
  await assert.rejects(() => store.publish(manifest), /Illegal operation transition|timestamp cannot move backwards/);

  await write(path.join(dataManifestRoot, 'malformed.operation.json'), '{bad json');
  await write(path.join(dataManifestRoot, 'downgraded.operation.json'), JSON.stringify({ ...manifest, operationId: 'downgraded', manifestVersion: 0 }));
  const scan = await store.scan();
  assert.equal(scan.manifests.length, 1);
  assert.equal(scan.issues.length, 2);
  const recovered = await journalApi.recoverOperationStores([store], () => versionBefore);
  assert.equal(recovered.compensated, 1, JSON.stringify(recovered));
  assert.equal(recovered.needsRecovery, 2);
  assert.equal(recovered.outcomes.every((outcome) => ['completed', 'compensated', 'needs_recovery'].includes(outcome.terminalState)), true);
});

test('manifest atomic publication faults leave either no manifest or a fully valid manifest', async () => {
  for (const stage of journalApi.manifestPublishStages) {
    await reset();
    const { file } = createFile(`publish-${stage}`, 'new');
    const manifest = manifestFor([file]);
    let fired = false;
    const store = createStore(dataManifestRoot, {
      hook(current) {
        if (!fired && current === stage) {
          fired = true;
          throw new Error(`fault:${stage}`);
        }
      }
    });
    await assert.rejects(() => store.publish(manifest), new RegExp(`fault:${stage}`));
    const cleanStore = createStore(dataManifestRoot);
    const loaded = await cleanStore.read(manifest.operationId);
    if (stage === 'afterRename' || stage === 'afterDirectoryFlush') {
      assert.equal(loaded.state, 'prepared', stage);
    } else {
      assert.equal(loaded, null, stage);
    }
  }
});

test('recovers staged create to completed and repeated recovery is idempotent', async () => {
  const { file, paths } = createFile('create', 'created-content');
  await write(paths.source, 'created-content');
  const manifest = manifestFor([file], { external: true });
  const store = createStore(externalManifestRoot);
  const journal = createJournal(store);
  await journal.prepare(manifest);
  const staged = await journal.stage(manifest);
  assert.equal(await read(paths.staging), 'created-content');
  const first = await recoverOne(store, staged, versionAfter);
  assert.equal(first.terminalState, 'completed');
  assert.equal(await read(paths.target), 'created-content');
  assert.equal(fs.existsSync(paths.staging), false);
  const second = await recoverOne(store, await store.read(manifest.operationId), versionAfter);
  assert.equal(second.terminalState, 'completed');
  assert.equal(second.code, 'already_terminal');
});

test('recovers replacement with verified original quarantine and new target', async () => {
  const { file, paths } = replaceFile('replace', 'new-content', 'old-content');
  await write(paths.source, 'new-content');
  await write(paths.target, 'old-content');
  const manifest = manifestFor([file]);
  const store = createStore(dataManifestRoot);
  const journal = createJournal(store);
  await journal.prepare(manifest);
  const staged = await journal.stage(manifest);
  const dbCommitted = await journal.markDatabaseCommitted(staged);
  const outcome = await recoverOne(store, dbCommitted, versionAfter);
  assert.equal(outcome.terminalState, 'completed');
  assert.equal(await read(paths.target), 'new-content');
  assert.equal(await read(paths.quarantine), 'old-content');
  assert.equal((await store.read(manifest.operationId)).files[0].status, 'committed');
});

test('quarantine deletion compensates before database commit and is idempotent', async () => {
  const { file, paths } = deleteFile('delete-compensate', 'delete-me');
  await write(paths.target, 'delete-me');
  const manifest = manifestFor([file]);
  const store = createStore(dataManifestRoot);
  const journal = createJournal(store);
  await journal.prepare(manifest);
  const staged = await journal.stage(manifest);
  assert.equal(fs.existsSync(paths.target), false);
  assert.equal(await read(paths.quarantine), 'delete-me');
  const first = await recoverOne(store, staged, versionBefore);
  assert.equal(first.terminalState, 'compensated');
  assert.equal(await read(paths.target), 'delete-me');
  assert.equal(fs.existsSync(paths.quarantine), false);
  const second = await recoverOne(store, await store.read(manifest.operationId), versionBefore);
  assert.equal(second.terminalState, 'compensated');
});

test('quarantine deletion completes after database commit', async () => {
  const { file, paths } = deleteFile('delete-complete', 'delete-me');
  await write(paths.target, 'delete-me');
  const manifest = manifestFor([file]);
  const store = createStore(dataManifestRoot);
  const journal = createJournal(store);
  await journal.prepare(manifest);
  const staged = await journal.stage(manifest);
  const outcome = await recoverOne(store, staged, versionAfter);
  assert.equal(outcome.terminalState, 'completed');
  assert.equal(fs.existsSync(paths.target), false);
  assert.equal(await read(paths.quarantine), 'delete-me');
});

test('prepared and staged creates compensate without leaving untracked files', async () => {
  const { file, paths } = createFile('create-compensate', 'new');
  await write(paths.source, 'new');
  const manifest = manifestFor([file]);
  const store = createStore(dataManifestRoot);
  const journal = createJournal(store);
  await journal.prepare(manifest);
  const staged = await journal.stage(manifest);
  const outcome = await recoverOne(store, staged, versionBefore);
  assert.equal(outcome.terminalState, 'compensated');
  assert.equal(fs.existsSync(paths.staging), false);
  assert.equal(fs.existsSync(paths.target), false);
});

test('hash mismatch, missing recovery asset, and ambiguous database state require recovery', async () => {
  const mismatch = createFile('hash-mismatch', 'expected');
  await write(mismatch.paths.source, 'expected');
  let manifest = manifestFor([mismatch.file]);
  let store = createStore(dataManifestRoot);
  let journal = createJournal(store);
  await journal.prepare(manifest);
  let staged = await journal.stage(manifest);
  await write(mismatch.paths.staging, 'tampered');
  let outcome = await recoverOne(store, staged, versionAfter);
  assert.equal(outcome.terminalState, 'needs_recovery');
  assert.match(outcome.error.code, /staging_hash_mismatch/);

  await reset();
  const missing = replaceFile('missing', 'new', 'old');
  await write(missing.paths.source, 'new');
  await write(missing.paths.target, 'old');
  manifest = manifestFor([missing.file]);
  store = createStore(dataManifestRoot);
  journal = createJournal(store);
  await journal.prepare(manifest);
  staged = await journal.stage(manifest);
  const committed = await journal.markDatabaseCommitted(staged);
  await fs.promises.rm(missing.paths.target, { force: true });
  await fs.promises.rm(missing.paths.staging, { force: true });
  outcome = await recoverOne(store, committed, versionAfter);
  assert.equal(outcome.terminalState, 'needs_recovery');

  await reset();
  const ambiguous = createFile('ambiguous', 'new');
  await write(ambiguous.paths.source, 'new');
  manifest = manifestFor([ambiguous.file]);
  store = createStore(dataManifestRoot);
  journal = createJournal(store);
  await journal.prepare(manifest);
  staged = await journal.stage(manifest);
  outcome = await recoverOne(store, staged, { dataEpoch: 'other-epoch', dataRevision: 99 });
  assert.equal(outcome.terminalState, 'needs_recovery');
  assert.equal(outcome.manifest.lastError.code, 'database_state_ambiguous');
});

test('missing staging source fails definitely and prepared recovery compensates', async () => {
  const entry = createFile('missing-source', 'expected');
  const manifest = manifestFor([entry.file]);
  const store = createStore(dataManifestRoot);
  const journal = createJournal(store);
  await journal.prepare(manifest);
  await assert.rejects(() => journal.stage(manifest), (error) => error.code === 'source_missing');
  const outcome = await recoverOne(store, await store.read(manifest.operationId), versionBefore);
  assert.equal(outcome.terminalState, 'compensated');
  assert.equal(fs.existsSync(entry.paths.target), false);
  assert.equal(fs.existsSync(entry.paths.staging), false);
});

test('cross-device quarantine fallback copies, flushes, renames, verifies, then removes source', async () => {
  const { file, paths } = deleteFile('cross-device', 'portable-content');
  await write(paths.target, 'portable-content');
  let sourceRenameAttempts = 0;
  let copyTempRenamed = false;
  let syncs = 0;
  const files = {
    async mkdir(directoryPath) { await fs.promises.mkdir(directoryPath, { recursive: true }); },
    async openExclusive(filePath) {
      const handle = await fs.promises.open(filePath, 'wx');
      return {
        writeFile: handle.writeFile.bind(handle),
        sync: async () => { syncs += 1; await handle.sync(); },
        close: handle.close.bind(handle)
      };
    },
    async readFile(filePath) { return fs.promises.readFile(filePath); },
    async realpath(filePath) { return fs.promises.realpath(filePath); },
    async rename(from, to) {
      if (from === paths.target && to === paths.quarantine) {
        sourceRenameAttempts += 1;
        throw Object.assign(new Error('cross device'), { code: 'EXDEV' });
      }
      if (to === paths.quarantine && from.endsWith('.copy.tmp')) copyTempRenamed = true;
      await fs.promises.rename(from, to);
    },
    async unlink(filePath) { await fs.promises.unlink(filePath); }
  };
  const mode = await journalApi.moveToQuarantine(paths.target, paths.quarantine, file.content, file.fileId, {
    files,
    randomId: () => 'copy-nonce'
  });
  assert.equal(mode, 'copied');
  assert.equal(sourceRenameAttempts, 1);
  assert.equal(copyTempRenamed, true);
  assert.ok(syncs >= 1);
  assert.equal(fs.existsSync(paths.target), false);
  assert.equal(await read(paths.quarantine), 'portable-content');
  assert.equal(await journalApi.moveToQuarantine(paths.target, paths.quarantine, file.content, file.fileId, { files }), 'already_quarantined');
});

test('restart recovery resolves faults before and after every forward transition', async () => {
  const transitionPhases = [
    'prepared_publish', 'files_staged_publish', 'db_committed_publish', 'files_committed_publish', 'completed_publish'
  ];
  for (const phase of transitionPhases) {
    for (const boundary of ['before', 'after']) {
      await reset();
      const entry = createFile(`forward-${phase}-${boundary}`, 'new');
      await write(entry.paths.source, 'new');
      const manifest = manifestFor([entry.file]);
      let fired = false;
      const store = createStore(dataManifestRoot);
      const faulted = createJournal(store, {
        hook(context) {
          if (!fired && context.phase === phase && context.boundary === boundary) {
            fired = true;
            throw new Error(`crash:${phase}:${boundary}`);
          }
        }
      });
      let current = manifest;
      let failed = false;
      try {
        current = await faulted.prepare(current);
        current = await faulted.stage(current);
        current = await faulted.markDatabaseCommitted(current);
        current = await faulted.commitFiles(current);
      } catch (error) {
        failed = true;
        assert.match(error.message, /crash:/);
      }
      assert.equal(failed, true, `${phase}:${boundary}`);
      const durable = await store.read(manifest.operationId);
      if (!durable) {
        assert.equal(phase, 'prepared_publish');
        assert.equal(boundary, 'before');
        continue;
      }
      const databaseVersion = ['prepared_publish', 'files_staged_publish'].includes(phase) ? versionBefore : versionAfter;
      const outcome = await recoverOne(store, durable, databaseVersion);
      assert.ok(['completed', 'compensated'].includes(outcome.terminalState), `${phase}:${boundary}`);
      const repeated = await recoverOne(store, await store.read(manifest.operationId), databaseVersion);
      assert.equal(repeated.terminalState, outcome.terminalState, `${phase}:${boundary}:repeat`);
    }
  }
});

test('restart recovery resolves faults around staging, file commit, and compensation boundaries', async () => {
  for (const phase of ['file_stage', 'file_commit']) {
    for (const boundary of ['before', 'after']) {
      await reset();
      const entry = createFile(`effect-${phase}-${boundary}`, 'new');
      await write(entry.paths.source, 'new');
      const manifest = manifestFor([entry.file]);
      const store = createStore(dataManifestRoot);
      let fired = false;
      const faulted = createJournal(store, {
        hook(context) {
          if (!fired && context.phase === phase && context.boundary === boundary) {
            fired = true;
            throw new Error(`crash:${phase}:${boundary}`);
          }
        }
      });
      let current = await faulted.prepare(manifest);
      try {
        current = await faulted.stage(current);
        current = await faulted.markDatabaseCommitted(current);
        await faulted.commitFiles(current);
        assert.fail('fault was not injected');
      } catch (error) {
        assert.match(error.message, /crash:/);
      }
      const durable = await store.read(manifest.operationId);
      const databaseVersion = phase === 'file_stage' ? versionBefore : versionAfter;
      const outcome = await recoverOne(store, durable, databaseVersion);
      assert.ok(['completed', 'compensated'].includes(outcome.terminalState), `${phase}:${boundary}`);
    }
  }

  for (const phase of ['compensating_publish', 'compensation', 'compensated_publish']) {
    for (const boundary of ['before', 'after']) {
      await reset();
      const entry = deleteFile(`compensate-${phase}-${boundary}`, 'old');
      await write(entry.paths.target, 'old');
      const manifest = manifestFor([entry.file]);
      const store = createStore(dataManifestRoot);
      const normal = createJournal(store);
      await normal.prepare(manifest);
      const staged = await normal.stage(manifest);
      let fired = false;
      const faulted = createJournal(store, {
        hook(context) {
          if (!fired && context.phase === phase && context.boundary === boundary) {
            fired = true;
            throw new Error(`crash:${phase}:${boundary}`);
          }
        }
      });
      await assert.rejects(() => faulted.compensate(staged), /crash:/);
      const outcome = await recoverOne(store, await store.read(manifest.operationId), versionBefore);
      assert.equal(outcome.terminalState, 'compensated', `${phase}:${boundary}`);
      assert.equal(await read(entry.paths.target), 'old');
    }
  }
});

test('needs_recovery publication faults remain safely classified and recover deterministically', async () => {
  for (const boundary of ['before', 'after']) {
    await reset();
    const entry = createFile(`needs-${boundary}`, 'new');
    await write(entry.paths.source, 'new');
    const manifest = manifestFor([entry.file]);
    const store = createStore(dataManifestRoot);
    const normal = createJournal(store);
    await normal.prepare(manifest);
    const staged = await normal.stage(manifest);
    let fired = false;
    const faulted = createJournal(store, {
      hook(context) {
        if (!fired && context.phase === 'needs_recovery_publish' && context.boundary === boundary) {
          fired = true;
          throw new Error(`crash:needs:${boundary}`);
        }
      }
    });
    const first = await faulted.recover(staged, { dataEpoch: 'ambiguous', dataRevision: 0 });
    assert.equal(first.terminalState, 'needs_recovery');
    const second = await recoverOne(store, await store.read(manifest.operationId), { dataEpoch: 'ambiguous', dataRevision: 0 });
    assert.equal(second.terminalState, 'needs_recovery');
  }
});

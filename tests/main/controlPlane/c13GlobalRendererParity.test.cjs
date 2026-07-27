const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { requireMain } = require('../helpers/mainTestEnv.cjs');

const root = path.resolve(__dirname, '../../..');
const adapterPath = path.join(root, 'src/main/ipc/adapters/globalIpc.ts');
const registerPath = path.join(root, 'src/main/ipc/registerIpc.ts');
const preloadPath = path.join(root, 'src/preload/preload.ts');
const adapterSource = fs.readFileSync(adapterPath, 'utf8');
const registerSource = fs.readFileSync(registerPath, 'utf8');
const preloadSource = fs.readFileSync(preloadPath, 'utf8');
const adapter = requireMain('ipc/adapters/globalIpc.js');

test('C13 Renderer global adapter dispatches only the four fixed Gateway operations', async () => {
  const calls = [];
  const principal = Object.freeze({ renderer: true, clientId: 'local-renderer-management' });
  const gateway = {
    async execute(envelope, receivedPrincipal) { calls.push({ kind: 'execute', envelope, receivedPrincipal }); return { kind: 'completed', result: { value: { assetId: 'asset-safe', jobId: '123e4567-e89b-42d3-a456-426614174001', status: 'intent' } } }; },
    async query(envelope, receivedPrincipal) { calls.push({ kind: 'query', envelope, receivedPrincipal }); return { kind: 'completed', result: { value: envelope.operation === 'backups.list' ? { items: [{ assetId: 'asset-safe', kind: 'backup', status: 'published', metadata: {}, createdAt: '2026-07-20T00:00:00.000Z', updatedAt: '2026-07-20T00:00:00.000Z' }] } : { assetId: envelope.payload.exportId, kind: 'export', status: 'intent', metadata: {}, createdAt: '2026-07-20T00:00:00.000Z', updatedAt: '2026-07-20T00:00:00.000Z' } } }; }
  };
  const global = adapter.createGlobalRendererAdapter({ gateway, principal: () => principal, currentVersion: () => ({ dataEpoch: 'epoch', dataRevision: 1 }) });

  const backup = await global.createBackup();
  assert.deepEqual(Object.keys(backup).sort(), ['assetId', 'jobId', 'status']);
  assert.equal(backup.status, 'intent');
  assert.equal(JSON.stringify(backup).includes('path'), false);
  assert.equal((await global.listBackups()).some((entry) => entry.assetId === backup.assetId), true);

  const exported = await global.createExport({ scope: 'all', mode: 'practice' });
  const metadata = await global.getExport(exported.assetId);
  assert.equal(metadata.assetId, exported.assetId);
  assert.equal(metadata.kind, 'export');
  assert.equal(JSON.stringify(metadata).includes('path'), false);
  assert.deepEqual(calls.map(({ kind, envelope, receivedPrincipal }) => ({ kind, operation: envelope.operation, payload: envelope.payload, principal: receivedPrincipal })), [
    { kind: 'execute', operation: 'backups.create', payload: { kind: 'manual' }, principal },
    { kind: 'query', operation: 'backups.list', payload: { pageSize: 100 }, principal },
    { kind: 'execute', operation: 'exports.create', payload: { specification: { scope: 'all', mode: 'practice' } }, principal },
    { kind: 'query', operation: 'exports.get', payload: { exportId: 'asset-safe' }, principal }
  ]);
});

test('C13 Renderer routes cannot directly call legacy backup or PDF writers', () => {
  for (const operation of ['backups.create', 'backups.list', 'exports.create', 'exports.get']) assert.match(adapterSource, new RegExp(`['\"]${operation.replace('.', '\\.')}['\"]`));
  assert.match(adapterSource, /gateway\.execute\(/);
  assert.match(adapterSource, /gateway\.query\(/);
  assert.match(registerSource, /principal: \(\) => controlPlane\.renderer\.principal\(\)/);
  assert.doesNotMatch(adapterSource, /backupService|pdfExportService|materialize/);
  assert.doesNotMatch(registerSource, /handle\('backups:(create|list)',[^\n]*listDatabaseBackups|handle\('pdfExport:create',[^\n]*exportQuestionsToPdf/);
  assert.match(registerSource, /handle\('backups:create', async \(\) => \(await global\(\)\)\.createBackup\(\)\)/);
  assert.match(registerSource, /handle\('backups:list', async \(\) => \(await global\(\)\)\.listBackups\(\)\)/);
  assert.match(registerSource, /handle\('backups:listLegacy', \(\) => listDatabaseBackups\(\)\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'src/renderer/pages/SettingsPage.tsx'), 'utf8'), /restoreBackup\(backup\.assetId\)|deleteBackup\(backup\.assetId\)/);
  assert.match(registerSource, /handle\('pdfExport:get'/);
  assert.doesNotMatch(preloadSource, /backups\.materialize|exports\.materialize/);
});

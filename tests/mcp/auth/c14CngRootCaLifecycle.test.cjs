const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../..');
const keyModule = require(path.join(root, 'dist/main/main/mcp/tls/currentUserKeyStore.js'));
const caModule = require(path.join(root, 'dist/main/main/mcp/tls/currentUserRootCa.js'));

test('C14 CurrentUser CNG lifecycle fails closed for non-CNG, exportable, or wrong-scope handles', async () => {
  const backend = {
    async create(keyName) { return { keyName, provider: 'Microsoft Software Key Storage Provider', scope: 'CurrentUser', algorithm: 'RSA', exportable: true }; },
    async open(keyName) { return this.create(keyName); },
    async verify(keyName) { return this.create(keyName); },
    async remove() {}
  };
  const store = new keyModule.CurrentUserKeyStore(backend);
  await assert.rejects(store.create('kaoyan-http-root-test'), /non-exportable|failed closed/i);
  await assert.rejects(store.create('not-safe'), /Invalid CurrentUser CNG key name/);
});

test('C14 CurrentUser Root consent, exact-thumbprint install/remove, rotation rollback, and stale-root denial are enforced', async () => {
  const counts = new Map(); const installed = [];
  const backend = {
    async install(der) { installed.push(Buffer.from(der).toString('hex')); counts.set('A'.repeat(40), (counts.get('A'.repeat(40)) || 0) + 1); },
    async remove(value) { counts.set(value, 0); },
    async count(value) { return counts.get(value) || 0; }
  };
  const lifecycle = new caModule.CurrentUserRootCaLifecycle(backend);
  const material = { der: Buffer.from('certificate'), thumbprint: 'a'.repeat(40), notAfter: '2026-07-22T00:00:00.000Z', subject: 'kaoyan C14' };
  await assert.rejects(lifecycle.install(material, false), /consent/i);
  await lifecycle.install(material, true);
  assert.deepEqual(installed, ['6365727469666963617465']);
  await lifecycle.remove('A'.repeat(40));
  await lifecycle.assertNoStale(['A'.repeat(40)]);
  counts.set('C'.repeat(40), 1);
  await assert.rejects(lifecycle.assertNoStale(['A'.repeat(40), 'C'.repeat(40)]), /stale/i);
  assert.doesNotThrow(() => caModule.assertCurrentUserRootPath('Cert:\\CurrentUser\\Root'));
  assert.throws(() => caModule.assertCurrentUserRootPath('Cert:\\LocalMachine\\Root'), /CurrentUser/i);
});

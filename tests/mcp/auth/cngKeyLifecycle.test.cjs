const assert = require('node:assert/strict');
const { constants, createPublicKey, randomUUID, verify } = require('node:crypto');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '../../..');
const { WindowsCngKeyLifecycle } = require(path.join(projectRoot, 'packages/kaoyan-mcp-stdio/src/cngKeyLifecycle.cjs'));

test('launcher CNG key signs RSA-PSS and is deleted in finally', { skip: process.platform !== 'win32' }, async () => {
  const lifecycle = new WindowsCngKeyLifecycle();
  const keyName = `kaoyan-c3-${randomUUID()}`;
  const message = Buffer.from('kaoyan-c3-canonical-challenge', 'utf8');
  try {
    const binding = await lifecycle.create(keyName);
    assert.equal(binding.publicKeyFormat, 'spki-der-base64url');
    assert.equal(binding.signatureAlgorithm, 'rsa-pss-sha256');
    assert.match(binding.publicKeyFingerprint, /^sha256-v1:[0-9a-f]{64}$/);
    const signature = await lifecycle.sign(keyName, message.toString('base64url'));
    assert.equal(verify('sha256', message, {
      key: createPublicKey({ key: Buffer.from(binding.publicKey, 'base64url'), format: 'der', type: 'spki' }),
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32
    }, Buffer.from(signature, 'base64url')), true);
  } finally {
    await lifecycle.delete(keyName);
  }
  await assert.rejects(lifecycle.sign(keyName, message.toString('base64url')));
});

test('launcher CNG lifecycle rejects unsafe key names before invoking PowerShell', async () => {
  const lifecycle = new WindowsCngKeyLifecycle();
  await assert.rejects(lifecycle.create('../not-safe'), /Invalid disposable CNG key name/);
  await assert.rejects(lifecycle.sign('not-kaoyan', 'QQ'), /Invalid disposable CNG key name/);
});

test('launcher CNG rotation removes the old key and keeps the replacement usable', { skip: process.platform !== 'win32' }, async () => {
  const lifecycle = new WindowsCngKeyLifecycle();
  const first = `kaoyan-c3-${randomUUID()}`;
  const second = `kaoyan-c3-${randomUUID()}`;
  const message = Buffer.from('rotation-proof', 'utf8').toString('base64url');
  try {
    await lifecycle.create(first);
    const replacement = await lifecycle.rotate(first, second);
    await assert.rejects(lifecycle.sign(first, message));
    assert.equal(typeof await lifecycle.sign(second, message), 'string');
    assert.match(replacement.publicKeyFingerprint, /^sha256-v1:[0-9a-f]{64}$/);
  } finally {
    await lifecycle.delete(first).catch(() => undefined);
    await lifecycle.delete(second).catch(() => undefined);
  }
});

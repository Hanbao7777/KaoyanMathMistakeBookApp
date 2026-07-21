const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../..');
const sessions = require(path.join(root, 'dist/main/main/ipc/trustedRendererContext.js'));

function event(id, url, main = true) {
  const mainFrame = { url };
  return { sender: { id, mainFrame }, senderFrame: main ? mainFrame : { url } };
}

const options = { packaged: false, packagedUrl: 'file:///app/renderer/index.html', developmentOrigin: 'http://127.0.0.1:5173' };

test('C14 renderer trust context rejects frames and origins and advances across navigation and crashes', () => {
  sessions.registerRendererSession(41);
  assert.deepEqual(sessions.deriveTrustedRendererContext(event(41, 'http://127.0.0.1:5173/settings'), options), { webContentsId: 41, navigationGeneration: 0 });
  assert.throws(() => sessions.deriveTrustedRendererContext(event(41, 'http://127.0.0.1:5173/settings', false), options), /frame/);
  assert.throws(() => sessions.deriveTrustedRendererContext(event(41, 'http://127.0.0.1:5174/settings'), options), /origin/);
  sessions.advanceRendererSession(41);
  sessions.advanceRendererSession(41);
  assert.equal(sessions.deriveTrustedRendererContext(event(41, 'http://127.0.0.1:5173/'), options).navigationGeneration, 2);
  sessions.removeRendererSession(41);
  assert.throws(() => sessions.deriveTrustedRendererContext(event(41, 'http://127.0.0.1:5173/'), options), /Unknown renderer/);
});

test('C14 packaged renderer accepts the exact file document with a hash but rejects replacement files', () => {
  sessions.registerRendererSession(42);
  const packaged = { ...options, packaged: true };
  assert.equal(sessions.deriveTrustedRendererContext(event(42, 'file:///app/renderer/index.html#/agent-control'), packaged).navigationGeneration, 0);
  assert.throws(() => sessions.deriveTrustedRendererContext(event(42, 'file:///app/renderer/other.html'), packaged), /origin/);
  assert.throws(() => sessions.deriveTrustedRendererContext(event(42, 'file:///app/renderer/index.html?replacement=1'), packaged), /origin/);
  sessions.removeRendererSession(42);
});

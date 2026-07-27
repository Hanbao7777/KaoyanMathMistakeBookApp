'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WindowsCngKeyLifecycle } = require('../../../packages/kaoyan-mcp-stdio/src/cngKeyLifecycle.cjs');
const agent = require('../../../dist/main/shared/agent/index.js');
const mcp = require('../../../dist/main/shared/mcp/v1/index.js');

const launcherExe = path.join(process.cwd(), 'dist', 'mcp-stdio', 'kaoyan-mcp.exe');
const fakeAppExe = path.join(process.cwd(), 'dist', 'mcp-stdio', 'kaoyan-fake-app.exe');
const available = process.platform === 'win32' && fs.existsSync(launcherExe) && fs.existsSync(fakeAppExe);
const clientId = 'real-client';

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
async function waitFor(predicate, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await delay(25); }
  throw new Error('Timed out waiting for real-process fixture');
}
function readJson(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 }); }

function secureRoot() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-c4-real-'));
  assert.equal(path.resolve(value).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase()), true);
  assert.equal(path.resolve(value).toLowerCase().includes('d:\\kaoyanmathmistakebook'), false);
  if (process.platform === 'win32') {
    const user = execFileSync('whoami', [], { encoding: 'utf8', windowsHide: true }).trim();
    execFileSync('icacls', [value, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], { windowsHide: true, stdio: 'ignore' });
  }
  return value;
}

async function fixture(options = {}) {
  const root = secureRoot();
  const lifecycle = new WindowsCngKeyLifecycle();
  const keyName = `kaoyan-c4-${randomUUID()}`;
  const binding = await lifecycle.create(keyName);
  const publicKeyFile = path.join(root, 'public-key.txt');
  fs.writeFileSync(publicKeyFile, binding.publicKey, { mode: 0o600 });
  writeJson(path.join(root, 'fake-app-control.json'), options.control || {});
  const environment = {
    ...process.env,
    KAOYAN_FAKE_ROOT: root,
    KAOYAN_FAKE_PUBLIC_KEY_FILE: publicKeyFile,
    KAOYAN_FAKE_CATALOG_VERSION: agent.operationCatalogIdentity.version,
    KAOYAN_FAKE_CATALOG_HASH: agent.operationCatalogIdentity.hash,
    KAOYAN_FAKE_SCHEMA_VERSION: mcp.mcpSchemaVersion,
    KAOYAN_FAKE_CLIENT_ID: clientId
  };
  let app = null;
  const startApp = async () => {
    app = spawn(fakeAppExe, ['--agent-startup'], { env: environment, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    app.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    app.once('exit', (code) => { if (code && !app.expectedStop) process.stderr.write(`fake App exited ${code}: ${stderr}\n`); });
    await waitFor(() => {
      const discovery = readJson(path.join(root, 'mcp-loopback.discovery.json'));
      return discovery?.pid === app.pid ? discovery : null;
    });
    return app;
  };
  const stopApp = async () => {
    const pid = readJson(path.join(root, 'fake-app-state.json'))?.pid;
    if (app && app.exitCode === null) {
      app.expectedStop = true;
      app.kill('SIGTERM');
      await new Promise((resolve) => app.once('exit', resolve));
    } else if (pid) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
      await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    }
    app = null;
  };
  const cleanup = async () => {
    await stopApp().catch(() => undefined);
    await lifecycle.delete(keyName).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { root, keyName, environment, startApp, stopApp, cleanup, state: () => readJson(path.join(root, 'fake-app-state.json')), control: (value) => writeJson(path.join(root, 'fake-app-control.json'), value) };
}

class LauncherProcess {
  constructor(config, options = {}) {
    this.root = config.root;
    const args = [
      '--client-id', clientId, '--key-name', config.keyName, '--discovery-root', config.root, '--journal-root', config.root,
      '--startup-timeout-ms', '10000', '--timeout-ms', '3000', ...(options.appPath ? ['--app-path', options.appPath] : [])
    ];
    this.child = spawn(launcherExe, args, { env: options.environment || process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map();
    this.stderr = '';
    this.buffer = '';
    this.allStdout = '';
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk.toString('utf8'); });
    this.child.stdout.on('data', (chunk) => {
      this.allStdout += chunk.toString('utf8');
      this.buffer += chunk.toString('utf8');
      while (this.buffer.includes('\n')) {
        const index = this.buffer.indexOf('\n');
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        const waiter = this.pending.get(`${typeof message.id}:${String(message.id)}`);
        if (waiter) { this.pending.delete(`${typeof message.id}:${String(message.id)}`); waiter.resolve(message); }
      }
    });
  }
  request(message, timeout = 10_000) {
    return new Promise((resolve, reject) => {
      const key = `${typeof message.id}:${String(message.id)}`;
      const timer = setTimeout(() => { this.pending.delete(key); reject(new Error(`Launcher response timeout: ${this.stderr}; stdout=${this.allStdout}; exit=${this.child.exitCode}; state=${JSON.stringify(readJson(path.join(this.root, 'fake-app-state.json')))}`)); }, timeout);
      this.pending.set(key, { resolve: (value) => { clearTimeout(timer); resolve(value); } });
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }
  notify(message) { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  async initialize(id = 1) {
    const result = await this.request({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c4-test', version: '1' } } });
    assert.ok(result.result, JSON.stringify({ result, stderr: this.stderr, state: readJson(path.join(this.root, 'fake-app-state.json')) }));
    assert.equal(result.result.protocolVersion, '2025-11-25');
    this.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await delay(50);
  }
  async close() {
    if (this.child.exitCode !== null) return this.child.exitCode;
    this.child.stdin.end();
    return Promise.race([
      new Promise((resolve) => this.child.once('exit', resolve)),
      delay(3_000).then(() => { if (this.child.exitCode === null) this.child.kill('SIGTERM'); return new Promise((resolve) => this.child.once('exit', resolve)); })
    ]);
  }
  async signal(signal = 'SIGTERM') {
    this.child.kill(signal);
    return new Promise((resolve) => this.child.once('exit', resolve));
  }
}

function writeCall(id, requestId, payload = { input: {} }) {
  return {
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'questions.create', arguments: { apiVersion: 1, kind: 'mcp-tool-arguments', operation: 'questions.create', requestId, idempotencyKey: requestId, expectedVersion: { dataEpoch: 'fake-epoch', dataRevision: 0 }, payload } }
  };
}
function queryCall(id, requestId) {
  return {
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'questions.list', arguments: { apiVersion: 1, kind: 'mcp-tool-arguments', operation: 'questions.list', requestId, payload: { filter: {} } } }
  };
}

test('standalone launcher authenticates, initializes, and forwards real query/write envelopes', { skip: !available, timeout: 30_000 }, async () => {
  const setup = await fixture();
  try {
    await setup.startApp();
    const launcher = new LauncherProcess(setup);
    try {
      await launcher.initialize();
      const listed = await launcher.request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      assert.deepEqual(listed.result.tools.map(({ name }) => name), ['questions.create', 'questions.list']);
      const query = await launcher.request(queryCall(3, randomUUID()));
      assert.equal(query.result.ok, true);
      const requestId = randomUUID();
      const write = await launcher.request(writeCall(4, requestId));
      assert.equal(write.result.data.executorCount, 1);
      assert.equal(setup.state().executorCount, 1);
      assert.equal(setup.state().initialized, 1);
      const receipt = setup.state().receipts[`${clientId}:${requestId}`];
      const journal = readJson(path.join(setup.root, 'journal', clientId, `${requestId}.json`));
      assert.equal(journal.receiptOutcomeHash, receipt.receipt.outcomeHash);
    } finally { await launcher.close(); }
  } finally { await setup.cleanup(); }
});

test('lost response, restart replay, duplicate, and mismatch execute exactly once', { skip: !available, timeout: 40_000 }, async () => {
  const setup = await fixture({ control: { loseResponseOnce: true } });
  const requestId = randomUUID();
  let launcher = null;
  try {
    await setup.startApp();
    launcher = new LauncherProcess(setup);
    await launcher.initialize();
    const lost = await launcher.request(writeCall(10, requestId));
    assert.equal(lost.result.data.executorCount, 1);
    const recovered = await launcher.request(writeCall(11, requestId));
    assert.equal(recovered.result.data.executorCount, 1);
    assert.equal(setup.state().executorCount, 1);
    await launcher.close();

    launcher = new LauncherProcess(setup);
    await launcher.initialize(20);
    const replay = await launcher.request(writeCall(21, requestId));
    assert.deepEqual(replay.result, recovered.result);
    const mismatch = await launcher.request(writeCall(22, requestId, { input: { different: true } }));
    assert.equal(mismatch.error.code, -32000);
    assert.equal(setup.state().executorCount, 1);
    const journal = fs.readFileSync(path.join(setup.root, 'journal', clientId, `${requestId}.json`), 'utf8');
    assert.equal(/accepted|executorCount|input|credential|signature/i.test(journal), false);
  } finally { await launcher?.close().catch(() => undefined); await setup.cleanup(); }
});

test('session expiry, revocation, and App restart/port change require fresh authentication', { skip: !available, timeout: 40_000 }, async () => {
  const setup = await fixture();
  try {
    await setup.startApp();
    const launcher = new LauncherProcess(setup);
    try {
      await launcher.initialize();
      setup.control({ expireSessionsOnce: true });
      assert.equal((await launcher.request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })).result.tools.length, 2);
      setup.control({ revoke: true });
      assert.equal((await launcher.request({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })).error.code, -32000);
      setup.control({});
      assert.equal((await launcher.request({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} })).result.tools.length, 2);
      const writeRequestId = randomUUID();
      const beforeRestart = await launcher.request(writeCall(5, writeRequestId));
      assert.equal(beforeRestart.result.data.executorCount, 1);
      const old = setup.state().instanceId;
      await setup.stopApp();
      await setup.startApp();
      assert.notEqual(setup.state().instanceId, old);
      assert.equal((await launcher.request(queryCall(6, randomUUID()))).result.ok, true);
      const afterRestart = await launcher.request(writeCall(7, writeRequestId));
      assert.deepEqual(afterRestart.result, beforeRestart.result);
      assert.equal(setup.state().executorCount, 1);
      assert.ok(setup.state().initialized >= 1);
    } finally { await launcher.close(); }
  } finally { await setup.cleanup(); }
});

test('concurrent standalone launchers share the journal and preserve one executor', { skip: !available, timeout: 40_000 }, async () => {
  const setup = await fixture({ control: { loseResponseOnce: true } });
  const requestId = randomUUID();
  try {
    await setup.startApp();
    const first = new LauncherProcess(setup);
    const second = new LauncherProcess(setup);
    try {
      await Promise.all([first.initialize(1), second.initialize(2)]);
      const results = await Promise.all([first.request(writeCall(10, requestId)), second.request(writeCall(20, requestId))]);
      assert.equal(results.filter((value) => value.result?.ok === true).length, 2);
      assert.deepEqual(results[0].result, results[1].result);
      assert.equal(setup.state().executorCount, 1);
    } finally { await Promise.all([first.close(), second.close()]); }
  } finally { await setup.cleanup(); }
});

test('launcher-started App survives launcher SIGTERM and ELECTRON_RUN_AS_NODE is stripped', { skip: !available, timeout: 40_000 }, async () => {
  const setup = await fixture();
  try {
    const launcher = new LauncherProcess(setup, { appPath: fakeAppExe, environment: { ...setup.environment, ELECTRON_RUN_AS_NODE: '1' } });
    await launcher.initialize();
    const appPid = setup.state().pid;
    await launcher.signal('SIGTERM');
    assert.doesNotThrow(() => process.kill(appPid, 0));
    assert.equal(readJson(path.join(setup.root, 'mcp-loopback.discovery.json')).pid, appPid);
  } finally { await setup.cleanup(); }
});

test('concurrent launchers recover a stale startup claim and start one App instance', { skip: !available, timeout: 40_000 }, async () => {
  const setup = await fixture();
  const claims = path.join(setup.root, '.claims');
  fs.mkdirSync(claims, { mode: 0o700 });
  const token = '123e4567-e89b-42d3-a456-426614174099';
  fs.writeFileSync(path.join(claims, `app-startup.${token}.json`), JSON.stringify({ version: 1, phase: 'owned', pid: 999999, user: `${process.env.USERDOMAIN || ''}\\${process.env.USERNAME || ''}`.toLowerCase(), createdAt: '2020-01-01T00:00:00.000Z', token }));
  const first = new LauncherProcess(setup, { appPath: fakeAppExe, environment: setup.environment });
  const second = new LauncherProcess(setup, { appPath: fakeAppExe, environment: setup.environment });
  try {
    await Promise.all([first.initialize(31), second.initialize(32)]);
    const state = setup.state();
    assert.equal(state.sessionsAdmitted, 2);
    assert.equal(readJson(path.join(setup.root, 'mcp-loopback.discovery.json')).instanceId, state.instanceId);
    assert.doesNotThrow(() => process.kill(state.pid, 0));
  } finally {
    await Promise.all([first.close(), second.close()]);
    await setup.cleanup();
  }
});

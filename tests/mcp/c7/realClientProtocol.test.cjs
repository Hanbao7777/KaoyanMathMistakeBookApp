'use strict';

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '../../..');
const launcherExe = path.join(projectRoot, 'dist', 'mcp-stdio', 'kaoyan-mcp.exe');
const protocolApp = path.join(projectRoot, 'tests', 'mcp', 'c7', 'protocolApp.cjs');
const pairing = require(path.join(projectRoot, 'dist/main/main/mcp/pairing/pairingService.js'));
const agent = require(path.join(projectRoot, 'dist/main/shared/agent/index.js'));
const mcp = require(path.join(projectRoot, 'dist/main/shared/mcp/v1/index.js'));

const canRun = process.platform === 'win32' && fs.existsSync(launcherExe) && fs.existsSync(protocolApp);
const products = [
  { name: 'codex', cli: 'codex' },
  { name: 'claude_code', cli: 'claude' }
];
const businessScopes = Object.freeze([
  'files.images.read', 'focus.control', 'focus.read', 'questions.archive', 'questions.read', 'questions.write',
  'reviews.read', 'reviews.submit', 'system.read', 'tasks.execute', 'tasks.read', 'tasks.write'
]);

function invoke(file, args, env) {
  let target = file;
  let targetArgs = [...args];
  if (process.platform === 'win32' && file === 'claude') {
    target = path.join(env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  } else if (process.platform === 'win32' && file === 'codex') {
    const searchPath = env.PATH ?? env.Path ?? '';
    const node = searchPath.split(path.delimiter).map((entry) => path.join(entry.replace(/^"|"$/g, ''), 'node.exe')).find(fs.existsSync);
    target = node;
    targetArgs = [path.join(env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), ...args];
  }
  const result = spawnSync(target, targetArgs, { encoding: 'utf8', timeout: 30_000, env, windowsHide: true });
  return { stdout: result.stdout || '', stderr: result.stderr || '', exitCode: result.status ?? 1 };
}

function present(cli) {
  const result = invoke(cli, ['--version'], process.env);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

function secureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-c7-real-'));
  assert.equal(path.resolve(root).toLowerCase().includes('d:\\kaoyanmathmistakebook'), false);
  const user = execFileSync('whoami', [], { encoding: 'utf8', windowsHide: true }).trim();
  execFileSync('icacls', [root, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], { windowsHide: true, stdio: 'ignore' });
  return root;
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 }); }
async function waitFor(predicate, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for C7 protocol fixture');
}

function gatewayHarness(publicKeyFile) {
  const clients = new Map();
  const outcomes = new Map();
  return {
    gateway: {
      async execute(envelope) {
        if (outcomes.has(envelope.requestId)) return outcomes.get(envelope.requestId);
        const payload = envelope.payload;
        let value;
        if (envelope.operation === 'agent.clients.register_key') {
          if (clients.has(payload.clientId)) return { kind: 'rejected', error: { code: 'IDEMPOTENCY_CONFLICT', details: {} } };
          clients.set(payload.clientId, { ...payload, registryGeneration: 1, keyGeneration: 1, revoked: false });
          fs.writeFileSync(publicKeyFile, payload.publicKey, { mode: 0o600 });
          value = { apiVersion: 1, kind: 'client-key-binding', clientId: payload.clientId, publicKeyFormat: payload.publicKeyFormat, publicKeyFingerprint: payload.publicKeyFingerprint, signatureAlgorithm: payload.signatureAlgorithm, keyGeneration: 1, registryGeneration: 1, status: 'registered' };
        } else if (envelope.operation === 'agent.clients.update_access') {
          value = { clientId: payload.clientId };
        } else if (envelope.operation === 'agent.clients.revoke') {
          const client = clients.get(payload.clientId); if (client) client.revoked = true;
          value = { clientId: payload.clientId, revoked: true };
        } else {
          throw new Error(`Unexpected pairing Gateway operation ${envelope.operation}`);
        }
        const outcome = { kind: 'completed', result: { value } };
        outcomes.set(envelope.requestId, outcome);
        return outcome;
      }
    },
    clients
  };
}

class LauncherProcess {
  constructor(root, journalRoot, clientId, keyName) {
    this.root = root;
    this.child = spawn(launcherExe, ['--client-id', clientId, '--key-name', keyName, '--discovery-root', root, '--journal-root', journalRoot, '--timeout-ms', '5000'], {
      env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    this.pending = new Map();
    this.buffer = '';
    this.stdout = '';
    this.stderr = '';
    this.child.stdout.on('data', (chunk) => {
      this.stdout += chunk.toString('utf8');
      this.buffer += chunk.toString('utf8');
      while (this.buffer.includes('\n')) {
        const newline = this.buffer.indexOf('\n');
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        const key = `${typeof message.id}:${String(message.id)}`;
        const waiter = this.pending.get(key);
        if (waiter) { this.pending.delete(key); waiter.resolve(message); }
      }
    });
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk.toString('utf8'); });
  }
  request(message, timeout = 20_000) {
    return new Promise((resolve, reject) => {
      const key = `${typeof message.id}:${String(message.id)}`;
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`C7 launcher timeout: ${this.stderr}; app=${JSON.stringify(readJson(path.join(this.root, 'mcp-loopback.discovery.json')))}; childExit=${this.child.exitCode}; appStderr=${this.appStderr?.() || ''}; appEvents=${JSON.stringify(this.appEvents || [])}`));
      }, timeout);
      this.pending.set(key, { resolve: (value) => { clearTimeout(timer); resolve(value); } });
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }
  notify(message) { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  async initialize(id = 1) {
    const result = await this.request({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c7-real-client', version: '1' } } });
    assert.equal(result.result?.protocolVersion, '2025-11-25', JSON.stringify(result));
    this.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  async close() {
    if (this.child.exitCode !== null) return this.child.exitCode;
    this.child.stdin.end();
    return new Promise((resolve) => this.child.once('exit', (code) => resolve(code)));
  }
}

function questionInput(title, content) {
  return { title, content, wrong_thinking: '', wrong_solution: '', correct_solution: 'x = 1', answer: '1', category: 'calculus', question_type: 'single', error_reason: 'careless', source: 'c7-protocol-fixture', difficulty: '简单', mastery_level: '未掌握', note: '', tags: [], questionImageSources: [], solutionImageSources: [] };
}
function toolCall(id, name, args) { return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }; }
function commandArgs(operation, requestId, expectedVersion, payload) { return { apiVersion: 1, kind: 'mcp-tool-arguments', operation, requestId, idempotencyKey: requestId, expectedVersion, payload }; }
function queryArgs(operation, requestId, payload) { return { apiVersion: 1, kind: 'mcp-tool-arguments', operation, requestId, payload }; }

async function startApp(root, publicKeyFile, clientId) {
  const child = spawn(process.execPath, [protocolApp], {
    env: { ...process.env, KAOYAN_C7_ROOT: root, KAOYAN_C7_PUBLIC_KEY_FILE: publicKeyFile, KAOYAN_C7_CLIENT_ID: clientId },
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  const events = [];
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  child.on('exit', (code, signal) => events.push({ code, signal }));
  try {
    const discovery = await waitFor(() => {
      if (child.exitCode !== null) throw new Error(`C7 protocol fixture exited ${child.exitCode}: ${stderr}`);
      return readJson(path.join(root, 'mcp-loopback.discovery.json'));
    });
    return { child, discovery, stderr: () => stderr, events };
  } catch (error) {
    child.kill('SIGKILL');
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nstderr=${stderr}`);
  }
}
async function stopApp(app) {
  if (!app || app.child.exitCode !== null) return;
  app.child.kill('SIGTERM');
  await new Promise((resolve) => app.child.once('exit', resolve));
}

for (const product of products) {
  test(`C7 ${product.name} real disposable profile and launcher protocol evidence`, {
    skip: !canRun || !present(product.cli),
    timeout: 180_000
  }, async (t) => {
    const root = secureRoot();
    const profile = path.join(root, 'profile');
    const localAppData = path.join(root, 'local-app-data');
    const userData = path.join(root, 'user-data');
    const journalRoot = path.join(root, 'journal');
    const publicKeyFile = path.join(root, 'public-key.txt');
    const controlFile = path.join(root, 'protocol-app-control.json');
    const requestTracePath = path.join(root, 'protocol-app-request-trace.json');
    const clientId = `${product.name}-c7-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const previousEnvironment = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, LOCALAPPDATA: process.env.LOCALAPPDATA };
    let app;
    let launcher;
    await Promise.all([fsp.mkdir(profile), fsp.mkdir(localAppData), fsp.mkdir(userData), fsp.mkdir(journalRoot)]);
    fs.writeFileSync(publicKeyFile, '', { mode: 0o600 });
    writeJson(controlFile, {});
    if (product.name === 'codex') process.env.CODEX_HOME = profile; else process.env.CLAUDE_CONFIG_DIR = profile;
    process.env.LOCALAPPDATA = localAppData;
    const env = { ...process.env };
    const artifactBytes = await fsp.readFile(launcherExe);
    const artifact = { root: path.dirname(launcherExe), path: launcherExe, version: '1.0.0', sha256: createHash('sha256').update(artifactBytes).digest('hex'), compatibility: { pairingApiVersion: 'kaoyan-pairing-v1@1', launcherVersion: '1.0.0' } };
    const gateway = gatewayHarness(publicKeyFile);
    const service = new pairing.PairingService({ gateway: gateway.gateway, principal: () => ({}), launcherArtifact: artifact, localAppData, discoveryRoot: userData, journalRoot, run: async (file, args) => invoke(file, args, env) });
    const target = { product: product.name, clientId };
    const request = { ...target, requestedScopes: businessScopes, trust: 'full_control', disclosureAccepted: true, authorityConfirmed: true };
    const assertions = [];
    try {
      app = await startApp(root, publicKeyFile, clientId);
      const connected = await service.connect(request);
      assert.equal(connected.state, 'healthy', JSON.stringify(connected));
      assertions.push('control-center pairing adapter installed a verified launcher');
      assert.match(connected.launcherPath, /local-app-data/i);
      const profileList = invoke(product.cli, ['mcp', 'list'], env);
      assert.equal(profileList.exitCode, 0, `${profileList.stdout}\n${profileList.stderr}`);
      assert.match(`${profileList.stdout}\n${profileList.stderr}`, /kaoyan-mcp-/i);
      const configName = connected.manualConfiguration.argv[connected.manualConfiguration.argv.indexOf('--') - 1];
      const profileReload = invoke(product.cli, product.name === 'codex' ? ['mcp', 'get', '--json', configName] : ['mcp', 'get', configName], env);
      assert.equal(profileReload.exitCode, 0, `${profileReload.stdout}\n${profileReload.stderr}`);
      assertions.push(`${product.cli} profile reload/list succeeded`);

      launcher = new LauncherProcess(root, journalRoot, clientId, connected.manualConfiguration.argv[connected.manualConfiguration.argv.indexOf('--key-name') + 1]);
      launcher.appStderr = app.stderr;
      launcher.appEvents = app.events;
      await launcher.initialize();
      const listed = await launcher.request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      const toolNames = listed.result.tools.map(({ name }) => name);
      assert.equal(toolNames.length, 24);
      assert.equal(toolNames.some((name) => /execute|query|catalog/.test(name)), false);
      assertions.push('initialize and tools/list exposed the 19 C7 tools plus 5 C8 job tools');
      const resources = await launcher.request({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'kaoyan://capabilities/summary' } });
      assert.equal(JSON.parse(resources.result.contents[0].text).data.tools, 24);
      assertions.push('resource read returned structured capability evidence');
      const prompt = await launcher.request({ jsonrpc: '2.0', id: 4, method: 'prompts/get', params: { name: 'review.daily.zh_en', arguments: { focus: '今日' } } });
      assert.match(prompt.result.messages[0].content.text, /请基于|今日复习/);
      const protocolTrace = readJson(requestTracePath, []);
      assert.equal(protocolTrace.some(({ rpcMethod }) => rpcMethod === 'initialize'), true);
      assert.equal(protocolTrace.some(({ rpcMethod }) => rpcMethod === 'tools/list'), true);
      assert.equal(protocolTrace.some(({ rpcMethod }) => rpcMethod === 'resources/read'), true);
      assert.equal(protocolTrace.some(({ rpcMethod }) => rpcMethod === 'prompts/get'), true);
      assertions.push('Chinese prompt retrieval returned protocol evidence');

      const createRequestId = randomUUID();
      const initialVersion = { dataEpoch: 'c7-protocol-epoch', dataRevision: 0 };
      const created = await launcher.request(toolCall(5, 'questions.create', commandArgs('questions.create', createRequestId, initialVersion, { input: questionInput('C7 real profile question', 'protocol evidence') })));
      assert.equal(created.result?.structuredContent?.ok, true, `${JSON.stringify(created)} stderr=${launcher.stderr} state=${JSON.stringify(readJson(path.join(root, 'protocol-app-state.json')))} toolTrace=${JSON.stringify(readJson(path.join(root, 'protocol-app-last-tool-response.json')))} trace=${JSON.stringify(readJson(path.join(root, 'protocol-app-last-response.json')))}`);
      const questionId = created.result.structuredContent.data.id;
      const updated = await launcher.request(toolCall(6, 'questions.update', commandArgs('questions.update', randomUUID(), created.result.structuredContent.dataVersion, { questionId, input: questionInput('C7 updated question', 'updated through launcher') })));
      assert.equal(updated.result?.structuredContent?.ok, true, `${JSON.stringify(updated)} stderr=${launcher.stderr} state=${JSON.stringify(readJson(path.join(root, 'protocol-app-state.json')))}`);
      assertions.push('create/update completed through the protocol-faithful C6 operation envelope');
      const conflict = await launcher.request(toolCall(7, 'questions.update', commandArgs('questions.update', randomUUID(), created.result.structuredContent.dataVersion, { questionId, input: questionInput('stale update', 'must conflict') })));
      assert.equal(conflict.result?.structuredContent?.ok, false, `${JSON.stringify(conflict)} stderr=${launcher.stderr}`);
      assert.equal(conflict.result?.structuredContent?.code, 'DATA_REVISION_CONFLICT');
      assertions.push('concurrent stale revision conflict was returned as structured evidence');

      writeJson(controlFile, { loseResponseOnce: true });
      const lostRequestId = randomUUID();
      const lost = await launcher.request(toolCall(8, 'questions.create', commandArgs('questions.create', lostRequestId, updated.result.structuredContent.dataVersion, { input: questionInput('lost response replay', 'durable receipt') })));
      assert.equal(lost.result?.structuredContent?.ok, true, JSON.stringify(lost));
      const replay = await launcher.request(toolCall(9, 'questions.create', commandArgs('questions.create', lostRequestId, updated.result.structuredContent.dataVersion, { input: questionInput('lost response replay', 'durable receipt') })));
      assert.deepEqual(replay.result, lost.result);
      assertions.push('lost response replay returned the exact terminal outcome without a second executor');

      await stopApp(app);
      app = await startApp(root, publicKeyFile, clientId);
      await launcher.close();
      launcher = new LauncherProcess(root, journalRoot, clientId, connected.manualConfiguration.argv[connected.manualConfiguration.argv.indexOf('--key-name') + 1]);
      await launcher.initialize(20);
      const afterRestart = await launcher.request({ jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} });
      assert.equal(afterRestart.result?.tools?.length, 24, `${JSON.stringify(afterRestart)} stderr=${launcher.stderr} appTrace=${JSON.stringify(readJson(path.join(root, 'protocol-app-last-response.json')))} authTrace=${JSON.stringify(readJson(path.join(root, 'protocol-app-auth-trace.json')))} requestTrace=${JSON.stringify(readJson(path.join(root, 'protocol-app-request-trace.json')))} appStderr=${app.stderr()}`);
      assertions.push('App restart caused fresh bridge authentication and preserved protocol access');
      writeJson(controlFile, { revoke: true });
      const revoked = await launcher.request({ jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} });
      assert.equal(revoked.error.code, -32000);
      assertions.push('revoked session denied without tool dispatch');
      const exitCode = await launcher.close();
      assert.equal(exitCode, 0);
      assert.equal(launcher.stdout.split('\n').filter(Boolean).every((line) => JSON.parse(line).jsonrpc === '2.0'), true);
      assert.equal(/credential|private-key|d:\\kaoyanmathmistakebook/i.test(launcher.stderr), false);
      assertions.push('clean disconnect and stdout purity passed');
      t.diagnostic(JSON.stringify({ product: product.name, cliVersion: present(product.cli), trace: assertions, limitation: 'model dispatch not used; create/update proof is protocol-faithful and C6 Gateway proof remains in c6GatewayIntegration.test.cjs' }));
    } finally {
      await launcher?.close().catch(() => undefined);
      await stopApp(app).catch(() => undefined);
      await service.disconnect(target).catch(() => undefined);
      if (previousEnvironment.CODEX_HOME === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousEnvironment.CODEX_HOME;
      if (previousEnvironment.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousEnvironment.CLAUDE_CONFIG_DIR;
      if (previousEnvironment.LOCALAPPDATA === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previousEnvironment.LOCALAPPDATA;
      await fsp.rm(root, { recursive: true, force: true });
      assert.equal(fs.existsSync(root), false);
    }
  });
}

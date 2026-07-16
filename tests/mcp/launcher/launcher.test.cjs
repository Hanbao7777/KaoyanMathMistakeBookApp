'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const launcherModule = require('../../../dist/launcher-build/packages/kaoyan-mcp-stdio/src/launcher.cjs');
const mcp = require('../../../dist/launcher-build/src/shared/mcp/v1/index.js');
const agent = require('../../../dist/launcher-build/src/shared/agent/index.js');

const {
  DurableClaimLock,
  ForwardingJournal,
  Launcher,
  boundedLines,
  hash,
  launcherRangeAllows,
  safeRoot,
  toolEnvelope
} = launcherModule;

const clientId = 'client-one';
const requestId = '123e4567-e89b-42d3-a456-426614174000';
const receiptId = '123e4567-e89b-42d3-a456-426614174001';
const instanceId = '123e4567-e89b-42d3-a456-426614174002';
const lookupId = `receipt-${requestId}`;
const catalog = agent.operationCatalogIdentity;
const dataVersion = { dataEpoch: 'epoch-one', dataRevision: 1 };
const commandResult = { changed: true, value: { ok: true }, events: [], dataVersion };
const completedTerminal = { kind: 'command-result', result: commandResult };
const completedOutcome = mcp.mapGatewayTerminalToMcpOutcome('questions.create', requestId, completedTerminal);

function root() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-c4-')); }

function command(id = 1, overrides = {}, paramsOverrides = {}) {
  return {
    jsonrpc: '2.0', id, method: 'tools/call', params: {
      name: 'questions.create',
      arguments: {
        apiVersion: 1, kind: 'mcp-tool-arguments', operation: 'questions.create', requestId,
        idempotencyKey: requestId, expectedVersion: dataVersion, payload: { input: {} }, ...overrides
      },
      ...paramsOverrides
    }
  };
}

function gatewayEnvelope(payload = { input: {} }) {
  return { apiVersion: 1, kind: 'agent-command', operation: 'questions.create', requestId, payload, expectedVersion: dataVersion, catalog };
}

function binding(payload = { input: {} }) {
  const envelope = gatewayEnvelope(payload);
  return {
    clientId, requestId, gatewayRequestId: requestId, operation: 'questions.create', operationKind: 'command',
    payloadHash: hash(payload), catalogVersion: catalog.version, catalogHash: catalog.hash,
    envelopeHash: hash(envelope), bindingHash: hash({ clientId, requestId, operation: 'questions.create', envelope })
  };
}

function receipt(status = 'completed', terminal = completedTerminal, options = {}) {
  const hashSubject = terminal.kind === 'command-result' ? terminal.result : terminal.error;
  const error = terminal.kind === 'serialized-agent-error'
    ? terminal.error
    : { code: 'PERSISTENCE_INDETERMINATE', message: 'Recovery is required.', retryable: false };
  return {
    apiVersion: 1, kind: 'receipt-status', clientId, requestId, status,
    receipt: {
      apiVersion: 1, receiptId, clientId, requestId, operation: 'questions.create', payloadHash: hash({ input: {} }), catalog, status,
      ...(status === 'completed' ? { dataVersion } : {}),
      ...(status !== 'admitted' ? { outcomeHash: options.outcomeHash || hash(hashSubject) } : {}),
      ...(!['admitted', 'completed'].includes(status) ? { error } : {}),
      createdAt: '2026-07-16T09:00:00.000Z', updatedAt: '2026-07-16T09:00:01.000Z'
    },
    ...(status === 'admitted' ? {} : { terminal })
  };
}

function response(outcome = completedOutcome, id = 1) {
  return { status: 200, body: { jsonrpc: '2.0', id, result: outcome } };
}

function launcher(temporaryRoot, bridge, options = {}) {
  const instance = new Launcher({
    clientId, keyName: 'kaoyan-client-one', discoveryRoot: temporaryRoot, journalRoot: temporaryRoot,
    bridge, startupTimeoutMs: 100, timeoutMs: 100, lockPollMs: 1, lockWaitMs: 500, ...options
  });
  instance.discovery = async () => ({ instanceId, port: 12345, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  return instance;
}

function captureStream() {
  let content = '';
  return { stream: { write(value, callback) { content += String(value); callback?.(); return true; }, once() {} }, read: () => content };
}

test('real C1 tool arguments inject trusted catalog and keep Gateway requestId canonical', async () => {
  const temporaryRoot = root();
  try {
    const forwards = [];
    const bridge = {
      async forward(_record, message) { forwards.push(message); return response(completedOutcome, message.id); },
      async lookup() { return { status: 200, body: { jsonrpc: '2.0', id: lookupId, result: receipt() } }; }
    };
    const instance = launcher(temporaryRoot, bridge);
    const parsed = toolEnvelope(command(7));
    assert.deepEqual(parsed.envelope.catalog, catalog);
    assert.equal(parsed.args.catalog, undefined);
    assert.equal((await instance.handle(command(7))).id, 7);
    assert.equal((await instance.handle(command(99))).id, 99);
    assert.deepEqual(forwards.map(({ id }) => id), [7]);
    const record = instance.journal.read(clientId, requestId);
    assert.equal(record.gatewayRequestId, requestId);
    assert.equal(record.state, 'terminal');
    assert.equal(record.receiptOutcomeHash, hash(commandResult));
    const raw = fs.readFileSync(path.join(temporaryRoot, 'journal', clientId, `${requestId}.json`), 'utf8');
    for (const forbidden of ['input', 'cachedResult', 'secret', 'credential', 'signature', '"id"']) assert.equal(raw.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  } finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }); }
});

test('caller catalog injection and malformed or mismatched tool identity reject before forwarding', async () => {
  const temporaryRoot = root();
  try {
    let forwards = 0;
    const instance = launcher(temporaryRoot, { async forward() { forwards += 1; return response(); } });
    await assert.rejects(instance.handle(command(1, { catalog })), /unsupported fields/);
    await assert.rejects(instance.handle(command(2, {}, { name: 'tasks.create' })), /tool identity/);
    await assert.rejects(instance.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'questions.create' } }), /tool call/);
    assert.equal(forwards, 0);
    assert.equal(fs.existsSync(path.join(temporaryRoot, 'journal')), false);
  } finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }); }
});

test('restart maps authoritative completed receipt to the exact direct MCP outcome', async () => {
  const temporaryRoot = root();
  try {
    let forwards = 0;
    const bridge = {
      async forward(_record, message) { forwards += 1; return response(completedOutcome, message.id); },
      async lookup() { return { status: 200, body: { jsonrpc: '2.0', id: lookupId, result: receipt() } }; }
    };
    const first = await launcher(temporaryRoot, bridge).handle(command(1));
    const replay = await launcher(temporaryRoot, bridge).handle(command(777));
    assert.deepEqual(first.result, completedOutcome);
    assert.deepEqual(replay, { jsonrpc: '2.0', id: 777, result: completedOutcome });
    assert.equal(forwards, 1);
    const record = new ForwardingJournal(temporaryRoot).read(clientId, requestId);
    assert.equal(record.publicOutcomeHash, hash(completedOutcome));
    assert.equal(record.receiptOutcomeHash, hash(commandResult));
  } finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }); }
});

test('failed receipt replay maps and verifies both receipt and public hashes', async () => {
  const temporaryRoot = root();
  const failedError = { code: 'VALIDATION_ERROR', message: 'The request is invalid.', retryable: false };
  const failedTerminal = { kind: 'serialized-agent-error', error: failedError };
  const failedOutcome = mcp.mapGatewayTerminalToMcpOutcome('questions.create', requestId, failedTerminal);
  try {
    const instance = launcher(temporaryRoot, {
      async forward() { throw new Error('lost response'); },
      async lookup() { return { status: 200, body: { jsonrpc: '2.0', id: lookupId, result: receipt('failed', failedTerminal) } }; }
    });
    const recovered = await instance.handle(command(1));
    const replay = await instance.handle(command(2));
    assert.deepEqual(recovered.result, failedOutcome);
    assert.deepEqual(replay.result, failedOutcome);
    const record = instance.journal.read(clientId, requestId);
    assert.equal(record.receiptOutcomeHash, hash(failedError));
    assert.equal(record.publicOutcomeHash, hash(failedOutcome));

    const mismatchRoot = root();
    try {
      const bad = launcher(mismatchRoot, {
        async forward() { throw new Error('lost response'); },
        async lookup() { return { status: 200, body: { jsonrpc: '2.0', id: lookupId, result: receipt('failed', failedTerminal, { outcomeHash: hash({ different: true }) }) } }; }
      });
      await assert.rejects(bad.handle(command(1)), /lost response|Receipt outcome hash mismatch/);
      await assert.rejects(bad.handle(command(2)), /Receipt outcome hash mismatch/);
    } finally { fs.rmSync(mismatchRoot, { recursive: true, force: true }); }
  } finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }); }
});

test('mismatched request reuse conflicts and JSON-RPC ids remain correlation only', async () => {
  const temporaryRoot = root();
  try {
    let forwards = 0;
    const bridge = { async forward(_record, message) { forwards += 1; return response(completedOutcome, message.id); }, async lookup() { return { status: 200, body: { jsonrpc: '2.0', id: lookupId, result: receipt() } }; } };
    const instance = launcher(temporaryRoot, bridge);
    await instance.handle(command('transport-a'));
    assert.equal((await instance.handle(command('transport-b'))).id, 'transport-b');
    await assert.rejects(instance.handle(command('transport-c', { payload: { input: { changed: true } } })), /binding conflict/);
    assert.equal(forwards, 1);
  } finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }); }
});

test('journal state machine is monotonic, terminal immutable, and CAS rejects stale records', () => {
  const temporaryRoot = root();
  try {
    const first = new ForwardingJournal(temporaryRoot);
    const second = new ForwardingJournal(temporaryRoot);
    const prepared = first.prepare(binding());
    const stale = second.read(clientId, requestId);
    assert.throws(() => first.transition(prepared, 'terminal', { publicOutcomeHash: hash(completedOutcome) }), /Illegal journal transition/);
    const forwarded = first.transition(prepared, 'forwarded');
    assert.throws(() => second.transition(stale, 'forwarded'), /Stale journal record/);
    const needsLookup = first.transition(forwarded, 'needs_lookup');
    const terminal = first.transition(needsLookup, 'terminal', { publicOutcomeHash: hash(completedOutcome), receiptOutcomeHash: hash(commandResult), receiptRef: receiptId });
    assert.throws(() => first.transition(terminal, 'needs_lookup'), /Illegal journal transition/);
    assert.throws(() => first.write({ ...terminal, publicOutcomeHash: hash({ changed: true }) }), /immutable/);
  } finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }); }
});

test('concurrent launchers serialize one uncertain forward and receipt lookup', async () => {
  const temporaryRoot = root();
  try {
    let forwards = 0;
    let lookups = 0;
    let active = 0;
    let maxActive = 0;
    const bridge = {
      async forward() { forwards += 1; active += 1; maxActive = Math.max(maxActive, active); await new Promise((resolve) => setTimeout(resolve, 20)); active -= 1; throw new Error('lost response'); },
      async lookup() { lookups += 1; return { status: 200, body: { jsonrpc: '2.0', id: lookupId, result: receipt() } }; }
    };
    const results = await Promise.allSettled([launcher(temporaryRoot, bridge).handle(command(1)), launcher(temporaryRoot, bridge).handle(command(2))]);
    assert.equal(forwards, 1);
    assert.equal(lookups, 2);
    assert.equal(maxActive, 1);
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 2);
  } finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }); }
});

test('stale contender recovery never deletes another process claim', async () => {
  const temporaryRoot = root();
  try {
    const claims = path.join(temporaryRoot, '.claims');
    fs.mkdirSync(claims, { mode: 0o700 });
    const namespace = `request-${clientId}-${requestId}`;
    const staleToken = '123e4567-e89b-42d3-a456-426614174010';
    const stalePath = path.join(claims, `${namespace}.${staleToken}.json`);
    fs.writeFileSync(stalePath, JSON.stringify({ version: 1, phase: 'owned', pid: 999999, user: 'test-user', createdAt: '2020-01-01T00:00:00.000Z', token: staleToken }));
    const lock = new DurableClaimLock(temporaryRoot, namespace, { user: 'test-user', lockStaleMs: 1, lockWaitMs: 100, lockPollMs: 1 });
    const acquired = await lock.acquire();
    await acquired.release();
    assert.equal(fs.existsSync(stalePath), true);

    const liveToken = '123e4567-e89b-42d3-a456-426614174011';
    const livePath = path.join(claims, `${namespace}.${liveToken}.json`);
    fs.writeFileSync(livePath, JSON.stringify({ version: 1, phase: 'owned', pid: process.pid, user: 'test-user', createdAt: new Date().toISOString(), token: liveToken }));
    const blocked = new DurableClaimLock(temporaryRoot, namespace, { user: 'test-user', lockStaleMs: 1, lockWaitMs: 20, lockPollMs: 1 });
    await assert.rejects(blocked.acquire(), /timed out/);
    assert.equal(fs.existsSync(livePath), true);
  } finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }); }
});

function faultFilesystem(phase) {
  let fail = true;
  const fault = (name, operation) => (...args) => {
    if (name === phase && fail) { fail = false; throw new Error(`fault:${phase}`); }
    return operation(...args);
  };
  return {
    readFile: (target) => fs.readFileSync(target), exists: (target) => fs.existsSync(target), stat: (target) => fs.lstatSync(target), list: (directory) => fs.readdirSync(directory),
    openExclusive: fault('openExclusive', (target, mode) => fs.openSync(target, 'wx', mode)),
    writeFile: fault('writeFile', (handle, content) => fs.writeFileSync(handle, content)),
    flushFile: fault('flushFile', (handle) => fs.fsyncSync(handle)), closeFile: (handle) => fs.closeSync(handle),
    atomicReplace: fault('atomicReplace', (temporary, target) => fs.renameSync(temporary, target)),
    flushDirectory: fault('flushDirectory', () => undefined), removeOwn: (target) => fs.rmSync(target, { force: true })
  };
}

test('every journal publication fault preserves a validated conservative state', () => {
  for (const phase of ['openExclusive', 'writeFile', 'flushFile', 'atomicReplace', 'flushDirectory']) {
    const temporaryRoot = root();
    try {
      const prepared = new ForwardingJournal(temporaryRoot).prepare(binding());
      const faulted = new ForwardingJournal(temporaryRoot, undefined, faultFilesystem(phase));
      assert.throws(() => faulted.transition(prepared, 'forwarded'), new RegExp(`fault:${phase}`));
      const recovered = new ForwardingJournal(temporaryRoot).read(clientId, requestId);
      assert.equal(recovered.state, phase === 'flushDirectory' ? 'forwarded' : 'prepared', phase);
      const directory = path.join(temporaryRoot, 'journal', clientId);
      assert.deepEqual(fs.readdirSync(directory).filter((name) => name.endsWith('.tmp')), [], phase);
    } finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }); }
  }
});

test('uncertain HTTP and malformed outcomes never terminalize or redispatch', async () => {
  const cases = [
    async () => ({ status: 500, body: { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'failed' } } }),
    async () => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: { bad: true } } }),
    async () => { throw new Error('timed out'); }
  ];
  for (const forward of cases) {
    const temporaryRoot = root();
    try {
      let forwards = 0;
      let lookups = 0;
      const instance = launcher(temporaryRoot, {
        async forward() { forwards += 1; return forward(); },
        async lookup() { lookups += 1; return { status: 200, body: { jsonrpc: '2.0', id: lookupId, result: receipt('admitted') } }; }
      });
      assert.equal((await instance.handle(command(1))).error.code, -32001);
      assert.equal(instance.journal.read(clientId, requestId).state, 'needs_lookup');
      assert.equal((await instance.handle(command(2))).error.code, -32001);
      assert.equal(forwards, 1);
      assert.equal(lookups, 2);
    } finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }); }
  }
});

test('mismatched App JSON-RPC correlation never terminalizes a write', async () => {
  const temporaryRoot = root();
  try {
    let forwards = 0;
    const instance = launcher(temporaryRoot, {
      async forward() { forwards += 1; return response(completedOutcome, 999); },
      async lookup() { return { status: 200, body: { jsonrpc: '2.0', id: lookupId, result: receipt('admitted') } }; }
    });
    assert.equal((await instance.handle(command(1))).error.code, -32001);
    assert.equal(instance.journal.read(clientId, requestId).state, 'needs_lookup');
    assert.equal(forwards, 1);
  } finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }); }
});

test('nonterminal receipt states are explicit failures and never dispatch again', async () => {
  for (const status of ['admitted', 'indeterminate', 'interrupted_precommit']) {
    const temporaryRoot = root();
    try {
      const terminal = { kind: 'serialized-agent-error', error: { code: 'PERSISTENCE_INDETERMINATE', message: 'Recovery is required.', retryable: false } };
      let forwards = 0;
      const instance = launcher(temporaryRoot, {
        async forward() { forwards += 1; throw new Error('should not forward'); },
        async lookup() { return { status: 200, body: { jsonrpc: '2.0', id: lookupId, result: receipt(status, terminal) } }; }
      });
      const prepared = instance.journal.prepare(binding());
      instance.journal.transition(prepared, 'forwarded');
      const result = await instance.handle(command(1));
      assert.equal(result.error.code, -32001);
      assert.equal(forwards, 0);
    } finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }); }
  }
});

test('bounded streaming parser rejects bytes before newline and resumes at the next frame', async () => {
  const valid = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  const input = Readable.from([Buffer.alloc(70 * 1024, 0x61), Buffer.from('\n'), valid]);
  const lines = [];
  for await (const line of boundedLines(input, 64 * 1024)) lines.push(line);
  assert.equal(lines[0], null);
  assert.equal(JSON.parse(lines[1]).method, 'ping');
});

test('bounded parser handles split CRLF, invalid UTF-8, and multiple frames without retaining an oversized prefix', async () => {
  const input = Readable.from([
    Buffer.from('{"jsonrpc":"2.0",'), Buffer.from('"method":"ping"}\r\n'),
    Buffer.from([0xff, 0x0a]), Buffer.from('{}\n')
  ]);
  const lines = [];
  for await (const line of boundedLines(input, 64 * 1024)) lines.push(line);
  assert.equal(JSON.parse(lines[0]).method, 'ping');
  assert.equal(lines[1], '');
  assert.equal(lines[2], '{}');
});

test('diagnostics are fixed, bounded, and never echo raw errors or credentials', async () => {
  const temporaryRoot = root();
  try {
    const stderr = captureStream();
    const stdout = captureStream();
    const instance = launcher(temporaryRoot, { async forward() { throw new Error('token=secret C:\\private\\file'); } }, { stderr: stderr.stream, stdout: stdout.stream });
    await instance.processLine(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }));
    assert.equal(stderr.read(), 'kaoyan-mcp: request_failed\n');
    assert.equal(/secret|private|token=/i.test(stderr.read()), false);
    assert.deepEqual(JSON.parse(stdout.read()), { jsonrpc: '2.0', id: 4, error: { code: -32000, message: 'Kaoyan MCP bridge unavailable' } });
  } finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }); }
});

test('cancellation aborts the correlated in-flight request without unbounded work', async () => {
  const temporaryRoot = root();
  try {
    let cancelled = false;
    const stdout = captureStream();
    const instance = launcher(temporaryRoot, {
      async forward(_record, message, signal) {
        if (message.method === 'notifications/cancelled') return { status: 202, body: null };
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => { cancelled = true; reject(new Error('cancelled')); }, { once: true }));
      }
    }, { stdout: stdout.stream });
    const pending = instance.processLine(JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tools/list', params: {} }));
    await new Promise((resolve) => setImmediate(resolve));
    await instance.processLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 12, reason: 'stop' } }));
    await pending;
    assert.equal(cancelled, true);
    assert.equal(JSON.parse(stdout.read()).id, 12);
  } finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }); }
});

test('launcher range validation is bounded and rejects incompatible discovery', () => {
  assert.equal(launcherRangeAllows('>=1 <2'), true);
  assert.equal(launcherRangeAllows('>=1.0.0 <1.0.1'), true);
  assert.equal(launcherRangeAllows('>=2 <3'), false);
  assert.equal(launcherRangeAllows('*'), false);
});

test('App startup strips ELECTRON_RUN_AS_NODE and never owns termination', async () => {
  const temporaryRoot = root();
  const previous = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = '1';
  try {
    const record = { instanceId, port: 12345 };
    let discoveries = 0;
    let spawnOptions;
    let unrefCalls = 0;
    const instance = new Launcher({
      clientId, keyName: 'kaoyan-client-one', discoveryRoot: temporaryRoot, journalRoot: temporaryRoot,
      appPath: process.execPath, startupTimeoutMs: 500, timeoutMs: 100, lockPollMs: 1,
      bridge: {}, spawn(_path, args, options) { spawnOptions = { args, options }; return { unref() { unrefCalls += 1; } }; }
    });
    instance.discovery = async () => (++discoveries >= 3 ? record : null);
    assert.equal(await instance.ensureApp(), record);
    assert.deepEqual(spawnOptions.args, ['--agent-startup']);
    assert.equal(spawnOptions.options.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(unrefCalls, 1);
    assert.equal(Object.hasOwn(spawnOptions, 'kill'), false);
  } finally {
    if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = previous;
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('running App is reused and absent App fails without spawning', async () => {
  const temporaryRoot = root();
  try {
    const record = { instanceId, port: 12345 };
    let spawns = 0;
    const running = new Launcher({ clientId, keyName: 'kaoyan-client-one', discoveryRoot: temporaryRoot, journalRoot: temporaryRoot, appPath: process.execPath, startupTimeoutMs: 100, timeoutMs: 100, bridge: {}, spawn() { spawns += 1; } });
    running.discovery = async () => record;
    assert.equal(await running.ensureApp(), record);
    assert.equal(spawns, 0);
    const absent = new Launcher({ clientId, keyName: 'kaoyan-client-one', discoveryRoot: temporaryRoot, journalRoot: temporaryRoot, startupTimeoutMs: 100, timeoutMs: 100, bridge: {} });
    absent.discovery = async () => null;
    await assert.rejects(absent.ensureApp(), /unavailable/);
  } finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }); }
});

test('App startup election ignores a dead stale claim without deleting it', async () => {
  const temporaryRoot = root();
  try {
    const claims = path.join(temporaryRoot, '.claims');
    fs.mkdirSync(claims, { mode: 0o700 });
    const token = '123e4567-e89b-42d3-a456-426614174020';
    const stale = path.join(claims, `app-startup.${token}.json`);
    fs.writeFileSync(stale, JSON.stringify({ version: 1, phase: 'owned', pid: 999999, user: 'startup-user', createdAt: '2020-01-01T00:00:00.000Z', token }));
    let discoveries = 0;
    let spawns = 0;
    const instance = new Launcher({
      clientId, keyName: 'kaoyan-client-one', discoveryRoot: temporaryRoot, journalRoot: temporaryRoot,
      appPath: process.execPath, startupTimeoutMs: 500, timeoutMs: 100, lockPollMs: 1, lockStaleMs: 1, user: 'startup-user', bridge: {},
      spawn() { spawns += 1; return { unref() {} }; }
    });
    instance.discovery = async () => (++discoveries >= 3 ? { instanceId, port: 12345 } : null);
    assert.equal((await instance.ensureApp()).instanceId, instanceId);
    assert.equal(spawns, 1);
    assert.equal(fs.existsSync(stale), true);
  } finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }); }
});

test('root overlap and link or junction boundaries reject before journal writes', () => {
  const temporaryRoot = root();
  const outside = root();
  try {
    assert.throws(() => safeRoot('D:\\KaoyanMathMistakeBook'), /protected data root/);
    assert.throws(() => safeRoot('D:\\'), /protected data root/);
    fs.symlinkSync(outside, path.join(temporaryRoot, 'journal'), 'junction');
    assert.throws(() => new ForwardingJournal(temporaryRoot).prepare(binding()), /link|junction|escapes/);
  } finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('built standalone launcher keeps stdout protocol-only for malformed and oversized frames', { skip: !fs.existsSync(path.join(process.cwd(), 'dist', 'mcp-stdio', 'kaoyan-mcp.exe')) }, () => {
  const temporaryRoot = root();
  try {
    const executable = path.join(process.cwd(), 'dist', 'mcp-stdio', 'kaoyan-mcp.exe');
    const result = spawnSync(executable, ['--client-id', clientId, '--key-name', 'kaoyan-client-one', '--discovery-root', temporaryRoot, '--journal-root', temporaryRoot], { input: `${'x'.repeat(70 * 1024)}\n{not-json}\n`, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map(({ error }) => error.code), [-32600, -32700]);
    assert.equal(result.stderr, '');
    assert.ok(fs.statSync(executable).size > 1_000_000);
  } finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }); }
});

test('launcher control modes reject mixed, missing, duplicated, and extra arguments', async () => {
  const { pairingControl } = launcherModule;
  for (const args of [[], ['create'], ['unknown', '--key-name', 'kaoyan-test'], ['create', '--key-name', 'kaoyan-test', '--extra'], ['create', '--key-name', 'kaoyan-test', '--key-name', 'kaoyan-other']]) {
    await assert.rejects(pairingControl(args), /Invalid pairing control arguments/);
  }
});

test('standalone launcher self-test is exact and mixed control modes fail closed', { skip: !fs.existsSync(path.join(process.cwd(), 'dist', 'mcp-stdio', 'kaoyan-mcp.exe')) }, () => {
  const executable = path.join(process.cwd(), 'dist', 'mcp-stdio', 'kaoyan-mcp.exe');
  const selfTest = spawnSync(executable, ['--self-test'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(selfTest.status, 0, selfTest.stderr); assert.equal(selfTest.stderr, '');
  assert.deepEqual(JSON.parse(selfTest.stdout), { ok: true, kind: 'kaoyan-mcp-self-test-v1', launcherVersion: '1.0.0' });
  for (const args of [['--self-test', '--extra'], ['--pairing-control', 'get', '--key-name', 'kaoyan-test', '--extra'], ['--client-id', clientId, '--self-test']]) {
    const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 10_000 });
    assert.notEqual(result.status, 0); assert.equal(result.stdout, ''); assert.match(result.stderr, /^kaoyan-mcp: (startup|pairing_control)_failed\n$/);
  }
});

test('standalone launcher owns an exact real CNG create/get/delete lifecycle', { skip: process.platform !== 'win32' || !fs.existsSync(path.join(process.cwd(), 'dist', 'mcp-stdio', 'kaoyan-mcp.exe')) }, () => {
  const executable = path.join(process.cwd(), 'dist', 'mcp-stdio', 'kaoyan-mcp.exe'); const keyName = `kaoyan-c5-exe-${require('node:crypto').randomUUID()}`;
  const invoke = (operation) => spawnSync(executable, ['--pairing-control', operation, '--key-name', keyName], { encoding: 'utf8', timeout: 30_000 });
  try {
    const created = invoke('create'); assert.equal(created.status, 0, created.stderr); assert.equal(created.stderr, '');
    const binding = JSON.parse(created.stdout); assert.deepEqual(Object.keys(binding).sort(), ['kind', 'publicKey', 'publicKeyFingerprint', 'publicKeyFormat', 'signatureAlgorithm', 'version']);
    assert.equal(binding.kind, 'cng-public-key-binding'); assert.match(binding.publicKeyFingerprint, /^sha256-v1:[0-9a-f]{64}$/); assert.ok(created.stdout.length < 16 * 1024);
    const loaded = invoke('get'); assert.equal(loaded.status, 0, loaded.stderr); assert.deepEqual(JSON.parse(loaded.stdout), binding);
    const deleted = invoke('delete'); assert.equal(deleted.status, 0, deleted.stderr); assert.deepEqual(JSON.parse(deleted.stdout), { version: 1, kind: 'cng-key-deleted', keyName });
    const missing = invoke('get'); assert.notEqual(missing.status, 0); assert.equal(missing.stdout, ''); assert.equal(missing.stderr, 'kaoyan-mcp: pairing_control_failed\n');
  } finally { invoke('delete'); }
});

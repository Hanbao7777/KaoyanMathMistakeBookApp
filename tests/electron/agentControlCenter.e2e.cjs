const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { launchElectron } = require('./launchElectron.cjs');

const projectRoot = path.resolve(__dirname, '../..');
const builtMain = path.join(projectRoot, 'dist', 'main', 'main', 'main.js');
const builtPreload = path.join(projectRoot, 'dist', 'main', 'preload', 'preload.js');
const controlCenterPage = path.join(projectRoot, 'src', 'renderer', 'pages', 'AgentControlCenterPage.tsx');
const realDataRoot = 'D:\\KaoyanMathMistakeBook';
const roots = new Set();

function createRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `kaoyan-agent-control-${label}-`));
  roots.add(root);
  return root;
}

function cleanEnvironment(overrides = {}) {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'KAOYAN_E2E_HARNESS', 'KAOYAN_E2E_FIXTURE_FILE', 'KAOYAN_E2E_RESULT_FILE', 'KAOYAN_NEGATIVE_PROBE_FILE']) delete env[key];
  return { ...env, KAOYAN_USE_RENDERER_BUILD: '1', ...overrides };
}

function prepare(root, name = 'run', fixture = '{"version":1}') {
  const fixtureFile = path.join(root, 'fixtures', `${name}.json`);
  const resultFile = path.join(root, 'results', `${name}.json`);
  const userDataDir = path.join(root, 'user-data');
  const dataRoot = path.join(root, 'data-root');
  fs.mkdirSync(path.dirname(fixtureFile), { recursive: true });
  fs.mkdirSync(path.dirname(resultFile), { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(fixtureFile, fixture, 'utf8');
  fs.writeFileSync(resultFile, '', 'utf8');
  return { root, fixtureFile, resultFile, userDataDir, dataRoot };
}

function writeMainWrapper(root, name, sourcePrefix = '') {
  const wrapper = path.join(root, `${name}.cjs`);
  fs.writeFileSync(wrapper, `${sourcePrefix}\nrequire(${JSON.stringify(builtMain)});\n`, 'utf8');
  return wrapper;
}

function launchPrepared(paths, overrides = {}) {
  return launchElectron({
    projectRoot,
    root: paths.root,
    appPath: projectRoot,
    userDataDir: paths.userDataDir,
    resultFile: paths.resultFile,
    fixtureFile: paths.fixtureFile,
    dataRoot: paths.dataRoot,
    timeoutMs: 30_000,
    env: cleanEnvironment(),
    ...overrides
  });
}

async function waitForExit(launch, timeoutMs = 10_000) {
  let timer;
  try {
    return await Promise.race([
      launch.exit,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Electron did not exit within ${timeoutMs}ms`)), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForFile(filePath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function expectStartupFailure(paths, expected, overrides = {}) {
  const wrapper = writeMainWrapper(paths.root, `failure-${path.basename(paths.resultFile, '.json')}`, "require('electron').dialog.showErrorBox = () => {};");
  const launch = launchPrepared(paths, { appPath: wrapper, timeoutMs: 10_000, ...overrides });
  try {
    await assert.rejects(launch.waitForResult(), (error) => {
      assert.match(error.message, expected);
      return true;
    });
  } finally {
    await launch.terminate();
  }
}

async function countPersistedClients(databasePath) {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ locateFile: (file) => path.join(projectRoot, 'node_modules', 'sql.js', 'dist', file) });
  const database = new SQL.Database(fs.readFileSync(databasePath));
  try {
    const result = database.exec('SELECT COUNT(*) AS count FROM agent_clients');
    return Number(result[0]?.values[0]?.[0] ?? -1);
  } finally {
    database.close();
  }
}

function assertIsolatedRunPaths(paths) {
  const owned = [paths.root, paths.fixtureFile, paths.resultFile, paths.userDataDir, paths.dataRoot].map((target) => path.resolve(target));
  assert.equal(new Set(owned.map((target) => target.toLowerCase())).size, owned.length);
  for (const target of owned) {
    assert.equal(target.toLowerCase().includes(realDataRoot.toLowerCase()), false);
    assert.equal(realDataRoot.toLowerCase().includes(target.toLowerCase()), false);
    assert.equal(path.relative(paths.root, target).startsWith('..'), false);
  }
}

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test('production control center retains the user-owned R4 creation contract', () => {
  const source = fs.readFileSync(controlCenterPage, 'utf8');
  const call = source.match(/window\.api\.agentControl\.createR4Grant\(\{([\s\S]*?)\n\s*\}\);/);
  assert.ok(call, 'typed R4 creation call is missing');
  for (const field of ['clientId', 'operation', 'payloadHash', 'targetHash', 'maxAffectedEntities', 'expiresAt']) {
    assert.match(call[1], new RegExp(`\\b${field}\\b`), field);
  }
  assert.doesNotMatch(call[1], /\b(?:grantId|catalog|recovery|maxUses|status|issuedAt)\b/);
  assert.match(source, /确认创建 R4 限时授权/);
  assert.match(source, /目标客户端：.*绑定操作：.*到期时间：/s);
});

test('real Electron completes the typed control-center flow and preserves durable state on restart', async (context) => {
  const paths = prepare(createRoot('positive'), 'control-center');
  assertIsolatedRunPaths(paths);
  const databasePath = path.join(paths.dataRoot, 'data', 'mistakes.db');
  const first = launchPrepared(paths);
  context.after(() => first.terminate());
  const initialResult = await first.waitForResult();
  assert.equal(initialResult.ok, true, JSON.stringify(initialResult));
  assert.ok(initialResult.assertions.includes('initial flow completed'));
  assert.ok(initialResult.assertions.includes('R4 creation returns a server-owned grant ID'));
  assert.ok(initialResult.assertions.includes('R4 creation preserves target operation impact and expiry'));
  assert.ok(initialResult.assertions.includes('created R4 grant appears in the typed list'));
  assert.ok(initialResult.assertions.includes('created R4 grant revocation is immediate'));
  assert.ok(initialResult.assertions.includes('change set applies through the Gateway'));
  assert.ok(initialResult.assertions.includes('audit ledger verifies after mutations'));
  const firstExit = await waitForExit(first);
  assert.equal(firstExit.exitCode, 0);
  assert.equal(fs.existsSync(databasePath), true);
  const persistedClientCount = await countPersistedClients(databasePath);
  assert.ok(persistedClientCount >= 2);

  const second = launchPrepared(paths);
  context.after(() => second.terminate());
  const restartResult = await second.waitForResult();
  assert.equal(restartResult.ok, true, JSON.stringify(restartResult));
  assert.ok(restartResult.assertions.includes('restart flow completed'));
  assert.ok(restartResult.assertions.includes('restart preserves created R4 grant and revocation'));
  assert.ok(restartResult.assertions.includes('restart preserves change set decisions'));
  assert.ok(restartResult.assertions.includes('restart verifies the durable audit ledger'));
  const secondExit = await waitForExit(second);
  assert.equal(secondExit.exitCode, 0);
  assert.equal(await countPersistedClients(databasePath), persistedClientCount);
});

test('flag absent and fixture environment alone never apply the fixture', async () => {
  for (const fixtureEnvironmentOnly of [false, true]) {
    const paths = prepare(createRoot(fixtureEnvironmentOnly ? 'fixture-env-only' : 'flag-absent'), 'ordinary');
    const env = cleanEnvironment(fixtureEnvironmentOnly ? {
      KAOYAN_E2E_FIXTURE_FILE: paths.fixtureFile,
      KAOYAN_E2E_RESULT_FILE: paths.resultFile
    } : {});
    const launch = launchPrepared(paths, { configureHarness: false, fixtureFile: undefined, env, timeoutMs: 8_000 });
    const databasePath = path.join(paths.dataRoot, 'data', 'mistakes.db');
    try {
      await waitForFile(databasePath);
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await launch.terminate();
    }
    assert.equal(await countPersistedClients(databasePath), 0, fixtureEnvironmentOnly ? 'fixture env alone seeded clients' : 'ordinary app seeded clients');
    assert.equal(fs.readFileSync(paths.resultFile, 'utf8'), '');
  }
});

test('main rejects outside, real-data, symlink-escape, and malformed fixtures before harness startup', async () => {
  const outsideRoot = createRoot('outside-fixture');
  const outsideFixture = path.join(outsideRoot, 'fixture.json');
  fs.writeFileSync(outsideFixture, '{"version":1}', 'utf8');

  const outsidePaths = prepare(createRoot('reject-outside'), 'outside');
  await expectStartupFailure(outsidePaths, /must share one unique kaoyan-\* temporary root/, {
    fixtureFile: undefined,
    env: cleanEnvironment({ KAOYAN_E2E_FIXTURE_FILE: outsideFixture })
  });

  const realPaths = prepare(createRoot('reject-real'), 'real');
  await expectStartupFailure(realPaths, /cannot relate to the real data root/, {
    fixtureFile: undefined,
    env: cleanEnvironment({ KAOYAN_E2E_FIXTURE_FILE: path.join(realDataRoot, 'fixture.json') })
  });

  const symlinkOutsideRoot = createRoot('symlink-target');
  const symlinkTarget = path.join(symlinkOutsideRoot, 'fixture.json');
  fs.writeFileSync(symlinkTarget, '{"version":1}', 'utf8');
  const symlinkPaths = prepare(createRoot('reject-symlink'), 'symlink');
  const linkDirectory = path.join(symlinkPaths.root, 'fixture-link');
  fs.symlinkSync(symlinkOutsideRoot, linkDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  await expectStartupFailure(symlinkPaths, /must share one unique kaoyan-\* temporary root/, {
    fixtureFile: undefined,
    env: cleanEnvironment({ KAOYAN_E2E_FIXTURE_FILE: path.join(linkDirectory, 'fixture.json') })
  });

  const malformedPaths = prepare(createRoot('reject-malformed'), 'malformed', '{"version":1,"unknown":true}');
  await expectStartupFailure(malformedPaths, /Invalid agent-control E2E fixture/);
});

test('main rejects missing, outside, shared, overlapping, and malformed result paths', async () => {
  const missingPaths = prepare(createRoot('result-missing'), 'missing');
  const missingResult = path.join(missingPaths.root, 'results', 'does-not-exist.json');
  await expectStartupFailure(missingPaths, /ENOENT|Result file/, {
    configureHarness: 'preserve',
    env: cleanEnvironment({
      KAOYAN_E2E_HARNESS: '1',
      KAOYAN_E2E_FIXTURE_FILE: missingPaths.fixtureFile,
      KAOYAN_E2E_RESULT_FILE: missingResult
    })
  });

  const outsideRoot = createRoot('outside-result');
  const outsideResult = path.join(outsideRoot, 'result.json');
  fs.writeFileSync(outsideResult, '', 'utf8');
  const outsidePaths = prepare(createRoot('result-outside'), 'outside');
  await expectStartupFailure(outsidePaths, /must share one unique kaoyan-\* temporary root/, {
    configureHarness: 'preserve',
    env: cleanEnvironment({
      KAOYAN_E2E_HARNESS: '1',
      KAOYAN_E2E_FIXTURE_FILE: outsidePaths.fixtureFile,
      KAOYAN_E2E_RESULT_FILE: outsideResult
    })
  });

  const sharedPaths = prepare(createRoot('result-shared'), 'shared');
  await expectStartupFailure(sharedPaths, /must be distinct/, {
    configureHarness: 'preserve',
    env: cleanEnvironment({
      KAOYAN_E2E_HARNESS: '1',
      KAOYAN_E2E_FIXTURE_FILE: sharedPaths.fixtureFile,
      KAOYAN_E2E_RESULT_FILE: sharedPaths.fixtureFile
    })
  });

  const overlappingPaths = prepare(createRoot('result-overlap'), 'overlap');
  const overlappingResult = path.join(overlappingPaths.dataRoot, 'result.json');
  fs.writeFileSync(overlappingResult, '', 'utf8');
  await expectStartupFailure(overlappingPaths, /must not overlap userData or the data root/, {
    configureHarness: 'preserve',
    env: cleanEnvironment({
      KAOYAN_E2E_HARNESS: '1',
      KAOYAN_E2E_FIXTURE_FILE: overlappingPaths.fixtureFile,
      KAOYAN_E2E_RESULT_FILE: overlappingResult
    })
  });

  const directoryPaths = prepare(createRoot('result-directory'), 'directory');
  const resultDirectory = path.join(directoryPaths.root, 'result-directory');
  fs.mkdirSync(resultDirectory);
  await expectStartupFailure(directoryPaths, /must be an existing file/, {
    configureHarness: 'preserve',
    env: cleanEnvironment({
      KAOYAN_E2E_HARNESS: '1',
      KAOYAN_E2E_FIXTURE_FILE: directoryPaths.fixtureFile,
      KAOYAN_E2E_RESULT_FILE: resultDirectory
    })
  });
});

test('guarded result IPC rejects unknown fields and a second invocation', async (context) => {
  const paths = prepare(createRoot('result-payload'), 'payload');
  const probeFile = path.join(paths.root, 'result-payload-probe.json');
  const wrapper = writeMainWrapper(paths.root, 'result-payload-wrapper', `
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
let injected = false;
app.on('browser-window-created', () => {
  if (injected) return;
  injected = true;
  const attacker = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  attacker.loadURL('data:text/html,<title>guard-probe</title>').then(async () => {
    const probe = await attacker.webContents.executeJavaScript(\`
      (async () => {
        const { ipcRenderer } = require('electron');
        let malformedRejected = false;
        try { await ipcRenderer.invoke('agentControl:e2e:writeResult', { ok: true, assertions: ['bad'], unknown: true }); } catch { malformedRejected = true; }
        await ipcRenderer.invoke('agentControl:e2e:writeResult', { ok: true, assertions: ['guard probe completed'] });
        let secondRejected = false;
        try { await ipcRenderer.invoke('agentControl:e2e:writeResult', { ok: true, assertions: ['second'] }); } catch { secondRejected = true; }
        return { malformedRejected, secondRejected };
      })()
    \`);
    fs.writeFileSync(${JSON.stringify(probeFile)}, JSON.stringify(probe), 'utf8');
  });
});`);
  const launch = launchPrepared(paths, { appPath: wrapper });
  context.after(() => launch.terminate());
  const result = await launch.waitForResult();
  assert.deepEqual(result, { ok: true, assertions: ['guard probe completed'] });
  await waitForFile(probeFile);
  assert.deepEqual(JSON.parse(fs.readFileSync(probeFile, 'utf8')), { malformedRejected: true, secondRejected: true });
  assert.equal((await waitForExit(launch)).exitCode, 0);
});

test('ordinary app exposes no result bridge and cannot invoke the result channel', async (context) => {
  const paths = prepare(createRoot('ordinary-channel'), 'ordinary-channel');
  const wrapper = path.join(paths.root, 'ordinary-channel-wrapper.cjs');
  fs.writeFileSync(wrapper, `
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
require(${JSON.stringify(builtMain)});
app.whenReady().then(() => setTimeout(async () => {
  const preloadWindow = new BrowserWindow({ show: false, webPreferences: { preload: ${JSON.stringify(builtPreload)}, nodeIntegration: false, contextIsolation: true } });
  await preloadWindow.loadURL('data:text/html,<title>preload-probe</title>');
  const bridgeType = await preloadWindow.webContents.executeJavaScript('typeof window.agentControlE2e');
  const attacker = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  await attacker.loadURL('data:text/html,<title>ipc-probe</title>');
  const invocation = await attacker.webContents.executeJavaScript(\`
    require('electron').ipcRenderer.invoke('agentControl:e2e:writeResult', { ok: true, assertions: ['ordinary'] })
      .then(() => ({ resolved: true }), error => ({ resolved: false, message: String(error && error.message || error) }))
  \`);
  fs.writeFileSync(process.env.KAOYAN_NEGATIVE_PROBE_FILE, JSON.stringify({ bridgeType, invocation }), 'utf8');
  app.quit();
}, 2500));
`, 'utf8');
  const launch = launchPrepared(paths, {
    appPath: wrapper,
    configureHarness: false,
    fixtureFile: undefined,
    env: cleanEnvironment({ KAOYAN_NEGATIVE_PROBE_FILE: paths.resultFile })
  });
  context.after(() => launch.terminate());
  const probe = await launch.waitForResult();
  assert.equal(probe.bridgeType, 'undefined');
  assert.equal(probe.invocation.resolved, false);
  assert.match(probe.invocation.message, /No handler registered|not registered/i);
  assert.equal((await waitForExit(launch)).exitCode, 0);
});

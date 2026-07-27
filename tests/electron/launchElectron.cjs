const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const realDataRoot = 'D:\\KaoyanMathMistakeBook';

function normalizedPath(value) {
  return path.resolve(value).toLowerCase();
}

function isSameOrDescendant(candidate, ancestor) {
  const relative = path.relative(normalizedPath(ancestor), normalizedPath(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertOwnedPath(target, root, label) {
  if (typeof target !== 'string' || !target) {
    throw new Error(`${label} must be a non-empty path`);
  }
  if (!isSameOrDescendant(target, root)) {
    throw new Error(`${label} escapes the owned temporary root`);
  }
  return path.resolve(target);
}

function assertOwnedRoot(root) {
  if (typeof root !== 'string' || !root) {
    throw new Error('Temporary root must be a non-empty path');
  }
  const resolvedRoot = path.resolve(root);
  const resolvedTempRoot = path.resolve(os.tmpdir());
  if (isSameOrDescendant(resolvedRoot, realDataRoot) || isSameOrDescendant(realDataRoot, resolvedRoot)) {
    throw new Error('Electron tests must never access the real data root');
  }
  if (normalizedPath(resolvedRoot) === normalizedPath(resolvedTempRoot)) {
    throw new Error('Temporary root must be a strict child of the OS temporary directory');
  }
  if (!isSameOrDescendant(resolvedRoot, resolvedTempRoot) || !path.basename(resolvedRoot).toLowerCase().startsWith('kaoyan-')) {
    throw new Error('Temporary root must be a unique kaoyan-* child of the OS temporary directory');
  }
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
    throw new Error('Temporary root must be an existing directory');
  }
  return resolvedRoot;
}

function resolveElectronBinary(projectRoot) {
  const electronModulePath = require.resolve('electron', { paths: [projectRoot] });
  const inheritedRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
  delete process.env.ELECTRON_RUN_AS_NODE;
  delete require.cache[electronModulePath];
  let electronBinary;
  try {
    electronBinary = require(electronModulePath);
  } finally {
    if (inheritedRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = inheritedRunAsNode;
  }
  if (typeof electronBinary !== 'string' || !electronBinary) {
    throw new Error('Installed Electron module did not resolve to an executable path');
  }
  return electronBinary;
}

function formatFailure(message, details) {
  const sections = [message];
  if (details.exitCode !== undefined) sections.push(`exit code: ${details.exitCode}`);
  if (details.signal) sections.push(`signal: ${details.signal}`);
  if (details.stdout) sections.push(`stdout:\n${details.stdout}`);
  if (details.stderr) sections.push(`stderr:\n${details.stderr}`);
  return new Error(sections.join('\n'));
}

function launchElectron(options) {
  const {
    projectRoot,
    root,
    appPath,
    userDataDir,
    resultFile,
    fixtureFile,
    dataRoot,
    configureHarness = true,
    timeoutMs = 15_000,
    env = process.env,
    electronBinary
  } = options ?? {};
  const resolvedRoot = assertOwnedRoot(root);
  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedAppPath = path.resolve(appPath);
  if (normalizedPath(resolvedAppPath) !== normalizedPath(resolvedProjectRoot) && !isSameOrDescendant(resolvedAppPath, resolvedRoot)) {
    throw new Error('Electron app path must be the project root or an owned test fixture');
  }
  const resolvedUserDataDir = assertOwnedPath(userDataDir, resolvedRoot, 'Electron userData path');
  const resolvedResultFile = assertOwnedPath(resultFile, resolvedRoot, 'Electron result file');
  const resolvedFixtureFile = fixtureFile === undefined ? undefined : assertOwnedPath(fixtureFile, resolvedRoot, 'Electron fixture file');
  const resolvedDataRoot = dataRoot === undefined ? undefined : assertOwnedPath(dataRoot, resolvedRoot, 'Electron data root');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Electron timeout must be a positive finite value');
  }
  if (![true, false, 'preserve'].includes(configureHarness)) {
    throw new Error('Electron harness configuration mode is invalid');
  }
  if (!fs.existsSync(resolvedAppPath)) {
    throw new Error(`Electron app path does not exist: ${resolvedAppPath}`);
  }
  if (resolvedFixtureFile && (!fs.existsSync(resolvedFixtureFile) || !fs.statSync(resolvedFixtureFile).isFile())) {
    throw new Error('Electron fixture file must be an existing file');
  }
  const resolvedElectronBinary = electronBinary ?? resolveElectronBinary(projectRoot);

  fs.mkdirSync(resolvedUserDataDir, { recursive: true });
  fs.mkdirSync(path.dirname(resolvedResultFile), { recursive: true });
  fs.writeFileSync(resolvedResultFile, '', 'utf8');
  if (resolvedDataRoot) {
    fs.mkdirSync(resolvedDataRoot, { recursive: true });
    fs.writeFileSync(path.join(resolvedUserDataDir, 'data-root.json'), `${JSON.stringify({ root: resolvedDataRoot }, null, 2)}\n`, 'utf8');
  }

  const childEnv = { ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  if (configureHarness === true) {
    childEnv.KAOYAN_E2E_HARNESS = '1';
    childEnv.KAOYAN_E2E_RESULT_FILE = resolvedResultFile;
    if (resolvedFixtureFile) childEnv.KAOYAN_E2E_FIXTURE_FILE = resolvedFixtureFile;
  } else if (configureHarness === false) {
    delete childEnv.KAOYAN_E2E_HARNESS;
  }

  const child = spawn(resolvedElectronBinary, [resolvedAppPath, `--user-data-dir=${resolvedUserDataDir}`], {
    cwd: projectRoot,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let stdout = '';
  let stderr = '';
  let launchError;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => { launchError = error; });

  const exit = new Promise((resolve) => {
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
  });

  let terminated = false;
  async function terminate() {
    if (terminated) return exit;
    terminated = true;
    if (child.exitCode !== null || child.signalCode !== null) return exit;
    child.kill();
    const forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 2_000);
    try {
      return await exit;
    } finally {
      clearTimeout(forceKillTimer);
    }
  }

  async function waitForResult() {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(resolvedResultFile)) {
        try {
          const result = JSON.parse(fs.readFileSync(resolvedResultFile, 'utf8'));
          if (!result || typeof result !== 'object' || Array.isArray(result)) {
            throw new Error('Electron harness result must be a JSON object');
          }
          return result;
        } catch (error) {
          if (error instanceof SyntaxError) {
            if (child.exitCode === null && child.signalCode === null && !launchError) {
              await new Promise((resolve) => setTimeout(resolve, 25));
              continue;
            }
          } else {
            await terminate();
            throw formatFailure(`Electron harness produced an invalid result: ${error.message}`, {
              ...await exit,
              stdout,
              stderr
            });
          }
        }
      }
      if (child.exitCode !== null || child.signalCode !== null || launchError) {
        const exitDetails = await exit;
        throw formatFailure(`Electron exited before writing its harness result${launchError ? `: ${launchError.message}` : ''}`, {
          ...exitDetails,
          stdout,
          stderr
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await terminate();
    throw formatFailure(`Electron harness timed out after ${timeoutMs}ms`, {
      ...await exit,
      stdout,
      stderr
    });
  }

  return {
    child,
    resultFile: resolvedResultFile,
    userDataDir: resolvedUserDataDir,
    exit,
    terminate,
    waitForResult,
    getOutput() {
      return { stdout, stderr };
    }
  };
}

module.exports = { assertOwnedPath, assertOwnedRoot, launchElectron, resolveElectronBinary };

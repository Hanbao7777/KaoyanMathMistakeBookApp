const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '../../..');
const realDataRoot = 'D:\\KaoyanMathMistakeBook';
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-control-plane-'));
const dataRoot = path.join(testRoot, 'data-root');
const userDataRoot = path.join(testRoot, 'user-data');
const recoveryRoot = path.join(userDataRoot, 'agent-recovery');

function normalizedPath(value) {
  return path.resolve(value).toLowerCase();
}

function isSameOrDescendant(candidate, ancestor) {
  const relative = path.relative(normalizedPath(ancestor), normalizedPath(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertOwnedPath(target) {
  if (typeof target !== 'string' || !target) {
    throw new Error('Control-plane test path must be a non-empty string');
  }
  if (isSameOrDescendant(target, realDataRoot) || isSameOrDescendant(realDataRoot, target)) {
    throw new Error('Control-plane tests must never access the real data root');
  }
  if (!isSameOrDescendant(target, testRoot)) {
    throw new Error('Control-plane test path escapes the owned temporary root');
  }
  return path.resolve(target);
}

function installElectronStub() {
  const electronStub = {
    app: {
      getPath(name) {
        if (name === 'userData') return userDataRoot;
        return path.join(testRoot, 'electron-paths', name);
      }
    },
    dialog: {
      showMessageBox() {
        return Promise.resolve();
      },
      showOpenDialog() {
        return Promise.resolve({ canceled: true, filePaths: [] });
      }
    },
    shell: {
      openPath() {
        return Promise.resolve('');
      }
    }
  };

  const electronPath = require.resolve('electron', { paths: [projectRoot] });
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: electronStub
  };
}

installElectronStub();
process.chdir(projectRoot);

const databaseService = require(path.join(projectRoot, 'dist/main/main/services/databaseService.js'));
const pathService = require(path.join(projectRoot, 'dist/main/main/services/pathService.js'));

function getControlPlanePaths() {
  return {
    testRoot,
    dataRoot,
    userDataRoot,
    recoveryRoot
  };
}

async function resetControlPlaneEnvironment() {
  databaseService.resetDatabaseConnection();
  fs.rmSync(assertOwnedPath(dataRoot), { recursive: true, force: true });
  fs.rmSync(assertOwnedPath(userDataRoot), { recursive: true, force: true });
  fs.mkdirSync(assertOwnedPath(recoveryRoot), { recursive: true });
  pathService.setDataRoot(dataRoot);
  await databaseService.initializeDatabase();
}

function cleanupControlPlaneRoot(target = testRoot) {
  const resolvedTarget = assertOwnedPath(target);
  if (normalizedPath(resolvedTarget) !== normalizedPath(testRoot)) {
    throw new Error('Control-plane cleanup may remove only its temporary root');
  }
  databaseService.resetDatabaseConnection();
  fs.rmSync(resolvedTarget, { recursive: true, force: true });
}

function requireMain(relativePath) {
  return require(path.join(projectRoot, 'dist/main/main', relativePath));
}

module.exports = {
  projectRoot,
  realDataRoot,
  testRoot,
  dataRoot,
  userDataRoot,
  recoveryRoot,
  databaseService,
  assertOwnedPath,
  getControlPlanePaths,
  resetControlPlaneEnvironment,
  cleanupControlPlaneRoot,
  requireMain
};

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '../../..');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-main-test-'));

function installElectronStub() {
  const electronStub = {
    app: {
      getPath(name) {
        return path.join(testRoot, name);
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

async function resetTestDatabase() {
  databaseService.resetDatabaseConnection();
  const dataRoot = path.join(testRoot, 'data-root');
  fs.rmSync(dataRoot, { recursive: true, force: true });
  pathService.setDataRoot(dataRoot);
  await databaseService.initializeDatabase();
}

function cleanupTestRoot() {
  databaseService.resetDatabaseConnection();
  fs.rmSync(testRoot, { recursive: true, force: true });
}

function requireMain(relativePath) {
  return require(path.join(projectRoot, 'dist/main/main', relativePath));
}

module.exports = {
  projectRoot,
  testRoot,
  databaseService,
  resetTestDatabase,
  cleanupTestRoot,
  requireMain
};

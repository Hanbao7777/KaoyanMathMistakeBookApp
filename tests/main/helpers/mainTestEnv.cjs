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
const { bootstrapControlMetadata } = require(path.join(projectRoot, 'dist/main/main/persistence/databaseBootstrap.js'));
const initializeRuntimeDatabase = databaseService.initializeDatabase.bind(databaseService);
const persistRuntimeDatabase = databaseService.persistDatabase.bind(databaseService);
const getRuntimeDatabase = databaseService.getDatabase.bind(databaseService);
let compatibilityDatabase = null;

databaseService.getDatabase = async (...args) => {
  compatibilityDatabase = await getRuntimeDatabase(...args);
  return compatibilityDatabase;
};

databaseService.initializeDatabase = async (...args) => {
  const result = await initializeRuntimeDatabase(...args);
  const database = await databaseService.getDatabase();
  database.run('DELETE FROM control_metadata');
  return result;
};

databaseService.persistDatabase = () => {
  const database = compatibilityDatabase;
  if (!database) throw new Error('Legacy test persistence requires an initialized database');
  const hasMetadata = database.exec('SELECT id FROM control_metadata').some((result) => result.values.length > 0);
  if (!hasMetadata) {
    bootstrapControlMetadata(database, {
      createEpoch: () => 'main-test-compatibility-epoch',
      now: () => '2026-07-15T00:00:00.000Z'
    });
  }
  persistRuntimeDatabase();
  if (!hasMetadata) database.run('DELETE FROM control_metadata');
};

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

const assert = require('node:assert/strict');
const test = require('node:test');
const environment = require('../helpers/controlPlaneTestEnv.cjs');

function loadMain() {
  const electron = require('electron');
  Object.assign(electron.app, {
    isPackaged: true,
    requestSingleInstanceLock: () => false,
    quit: () => undefined,
    on: () => undefined,
    whenReady: () => Promise.resolve()
  });
  electron.BrowserWindow = class BrowserWindow { static getAllWindows() { return []; } };
  electron.dialog.showErrorBox = () => undefined;
  electron.ipcMain = { on: () => undefined, handle: () => undefined };
  electron.net = { fetch: () => undefined };
  electron.protocol = {
    registerSchemesAsPrivileged: () => undefined,
    handle: () => undefined,
    unhandle: () => undefined
  };
  const originalSetInterval = global.setInterval;
  global.setInterval = () => ({ unref() {} });
  try {
    return environment.requireMain('main.js');
  } finally {
    global.setInterval = originalSetInterval;
  }
}

function writableInitialization() {
  return {
    state: 'writable',
    bootstrapChanged: false,
    databaseRecovery: { status: 'empty' },
    journalRecovery: { outcomes: [], completed: 0, compensated: 0, needsRecovery: 0 }
  };
}

const main = loadMain();

test.after(() => environment.cleanupControlPlaneRoot());

test('dispatches seed, bounded category migration, and bounded rematch before IPC admission', async () => {
  const commands = [];
  let categoryBatch = 0;
  const trace = [];

  await main.runStartupQuestionCommands({
    countKnowledgePoints: async () => 0,
    listQuestionIds: async () => Array.from({ length: 501 }, (_, index) => index + 1),
    seedKnowledgeMap: async () => {
      trace.push('seed');
      return { importedCount: 10, failedCount: 0 };
    },
    executeQuestionCommand: async (command) => {
      commands.push(command);
      trace.push(command.type);
      if (command.type === 'questions.migrate_categories') {
        categoryBatch += 1;
        return { value: { migrated: categoryBatch === 1 ? 500 : 2 } };
      }
      return { value: { scannedQuestions: command.payload.questionIds.length, insertedCount: 1 } };
    },
    assertWritesSafe: () => trace.push('safe'),
    warn: () => assert.fail('successful startup commands must not warn')
  });

  assert.deepEqual(trace, [
    'seed',
    'questions.migrate_categories',
    'questions.migrate_categories',
    'questions.rematch_knowledge',
    'questions.rematch_knowledge'
  ]);
  assert.deepEqual(commands.map((command) => command.type), [
    'questions.migrate_categories',
    'questions.migrate_categories',
    'questions.rematch_knowledge',
    'questions.rematch_knowledge'
  ]);
  assert.equal(commands[2].payload.questionIds.length, 500);
  assert.deepEqual(commands[3].payload.questionIds, [501]);
});

test('continues after safely failed or compensated startup operations', async () => {
  const trace = [];

  await main.runStartupQuestionCommands({
    countKnowledgePoints: async () => 0,
    listQuestionIds: async () => [7],
    seedKnowledgeMap: async () => { throw new Error('seed compensated'); },
    executeQuestionCommand: async (command) => {
      trace.push(command.type);
      if (command.type === 'questions.migrate_categories') throw new Error('migration rolled back');
      return { value: { scannedQuestions: 1, insertedCount: 0 } };
    },
    assertWritesSafe: () => trace.push('writable'),
    warn: (label) => trace.push(label)
  });

  assert.deepEqual(trace, [
    'writable',
    '[StartupSeed]',
    'questions.migrate_categories',
    'writable',
    '[StartupCategoryMigration]',
    'questions.rematch_knowledge'
  ]);
});

test('recovery fence aborts startup command handling and prevents IPC admission', async () => {
  const trace = [];
  const recoveryFence = Object.assign(new Error('recovery required'), { code: 'RECOVERY_FENCE' });
  const runQuestionCommands = () => main.runStartupQuestionCommands({
    countKnowledgePoints: async () => 1,
    listQuestionIds: async () => {
      assert.fail('rematch must not run after a recovery fence');
    },
    seedKnowledgeMap: async () => {
      assert.fail('seed must not run when knowledge points already exist');
    },
    executeQuestionCommand: async () => {
      trace.push('migration-failed');
      throw new Error('indeterminate publication');
    },
    assertWritesSafe: () => {
      trace.push('fenced');
      throw recoveryFence;
    },
    warn: () => assert.fail('unsafe failures must not be downgraded to warnings')
  });

  await assert.rejects(main.runMainStartup({
    initializePaths: () => trace.push('paths'),
    initializeDatabase: async () => {
      trace.push('recovery');
      return writableInitialization();
    },
    assertDatabaseReadyForRuntimeIpc: () => trace.push('admission'),
    runStartupQuestionCommands: runQuestionCommands,
    initializeStudySupervisor: async () => assert.fail('study initialization must not run after a recovery fence'),
    initializeTickTickService: async () => assert.fail('TickTick initialization must not run after a recovery fence'),
    ensureDailyAutoBackup: () => trace.push('backup'),
    registerImageProtocol: () => trace.push('protocol'),
    registerWindowStateIpc: () => trace.push('window-ipc'),
    registerRuntimeIpc: () => trace.push('runtime-ipc'),
    createWindow: () => trace.push('window')
  }), (error) => error === recoveryFence);

  assert.deepEqual(trace, ['paths', 'recovery', 'migration-failed', 'fenced']);
});

test('main startup orders recovery, question commands, service initialization, admission, then runtime IPC', async () => {
  const trace = [];
  await main.runMainStartup({
    initializePaths: () => trace.push('paths'),
    initializeDatabase: async () => {
      trace.push('recovery');
      return writableInitialization();
    },
    assertDatabaseReadyForRuntimeIpc: () => trace.push('admission'),
    runStartupQuestionCommands: async () => trace.push('commands'),
    initializeStudySupervisor: async () => trace.push('study'),
    initializeTickTickService: async () => trace.push('ticktick'),
    ensureDailyAutoBackup: () => trace.push('backup'),
    registerImageProtocol: () => trace.push('protocol'),
    registerWindowStateIpc: () => trace.push('window-ipc'),
    registerRuntimeIpc: () => trace.push('runtime-ipc'),
    createWindow: () => trace.push('window')
  });

  assert.deepEqual(trace, [
    'paths', 'recovery', 'commands', 'study', 'ticktick', 'admission', 'backup',
    'protocol', 'window-ipc', 'runtime-ipc', 'window'
  ]);
});

test('study supervisor initialization failure prevents admission, IPC, and window creation', async () => {
  const trace = [];
  const initializationError = new Error('study initialization failed');

  await assert.rejects(main.runMainStartup({
    initializePaths: () => trace.push('paths'),
    initializeDatabase: async () => {
      trace.push('recovery');
      return writableInitialization();
    },
    assertDatabaseReadyForRuntimeIpc: () => trace.push('admission'),
    runStartupQuestionCommands: async () => trace.push('commands'),
    initializeStudySupervisor: async () => {
      trace.push('study');
      throw initializationError;
    },
    initializeTickTickService: async () => assert.fail('TickTick initialization must not run after study failure'),
    ensureDailyAutoBackup: () => trace.push('backup'),
    registerImageProtocol: () => trace.push('protocol'),
    registerWindowStateIpc: () => trace.push('window-ipc'),
    registerRuntimeIpc: () => trace.push('runtime-ipc'),
    createWindow: () => trace.push('window')
  }), (error) => error === initializationError);

  assert.deepEqual(trace, ['paths', 'recovery', 'commands', 'study']);
});

test('TickTick initialization failure prevents admission, IPC, and window creation', async () => {
  const trace = [];
  const initializationError = new Error('TickTick initialization failed');

  await assert.rejects(main.runMainStartup({
    initializePaths: () => trace.push('paths'),
    initializeDatabase: async () => {
      trace.push('recovery');
      return writableInitialization();
    },
    assertDatabaseReadyForRuntimeIpc: () => trace.push('admission'),
    runStartupQuestionCommands: async () => trace.push('commands'),
    initializeStudySupervisor: async () => trace.push('study'),
    initializeTickTickService: async () => {
      trace.push('ticktick');
      throw initializationError;
    },
    ensureDailyAutoBackup: () => trace.push('backup'),
    registerImageProtocol: () => trace.push('protocol'),
    registerWindowStateIpc: () => trace.push('window-ipc'),
    registerRuntimeIpc: () => trace.push('runtime-ipc'),
    createWindow: () => trace.push('window')
  }), (error) => error === initializationError);

  assert.deepEqual(trace, ['paths', 'recovery', 'commands', 'study', 'ticktick']);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '../..');
const apiPath = path.join(projectRoot, 'src/shared/api.ts');
const preloadPath = path.join(projectRoot, 'src/preload/preload.ts');
const registerIpcPath = path.join(projectRoot, 'src/main/ipc/registerIpc.ts');
const mainPath = path.join(projectRoot, 'src/main/main.ts');

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

const NON_IPC_METHODS = new Set(['toFileUrl']);

function extractApiMethods(apiSource) {
  const methods = new Set();
  const lines = apiSource.split('\n');
  const inInterface = lines.findIndex((l) => l.includes('export interface AppApi')) >= 0;
  const regex = /^\s{2}([a-zA-Z_][a-zA-Z0-9_]*)\s*[:<(]/;
  for (const line of lines) {
    const m = regex.exec(line);
    if (m && !NON_IPC_METHODS.has(m[1])) {
      methods.add(m[1]);
    }
  }
  return methods;
}

function extractPreloadMethods(preloadSource) {
  const methods = new Set();
  const regex = /^\s{2}([a-zA-Z_][a-zA-Z0-9_]*)\s*[:<(]/gm;
  let m;
  const apiBlockStart = preloadSource.indexOf('const api: AppApi');
  if (apiBlockStart < 0) throw new Error('could not find api block in preload');
  const block = preloadSource.slice(apiBlockStart);
  while ((m = regex.exec(block)) !== null) {
    if (!NON_IPC_METHODS.has(m[1])) {
      methods.add(m[1]);
    }
  }
  return methods;
}

function extractPreloadChannels(preloadSource) {
  const channels = new Set();
  const invokeRe = /invoke<[^>]*>\(\s*['"]([^'"]+)['"]/g;
  const sendRe = /ipcRenderer\.send\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = invokeRe.exec(preloadSource)) !== null) channels.add(m[1]);
  while ((m = sendRe.exec(preloadSource)) !== null) channels.add(m[1]);
  return channels;
}

function extractRegisteredChannels(registerIpcSource) {
  const channels = new Set();
  const handleRe = /handle\(\s*['"]([^'"]+)['"]/g;
  const onRe = /ipcMain\.on\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = handleRe.exec(registerIpcSource)) !== null) channels.add(m[1]);
  while ((m = onRe.exec(registerIpcSource)) !== null) channels.add(m[1]);
  return channels;
}

const apiSource = readSource(apiPath);
const preloadSource = readSource(preloadPath);
const registerIpcSource = readSource(registerIpcPath);
const mainSource = fs.existsSync(mainPath) ? readSource(mainPath) : '';

const apiMethods = extractApiMethods(apiSource);
const preloadMethods = extractPreloadMethods(preloadSource);
const preloadChannels = extractPreloadChannels(preloadSource);
const registeredChannels = extractRegisteredChannels(registerIpcSource + '\n' + mainSource);

test('AppApi methods are exposed in preload', () => {
  const missing = [...apiMethods].filter((m) => !preloadMethods.has(m));
  assert.deepEqual(missing, [], `preload missing AppApi methods: ${missing.join(', ')}`);
});

test('preload invoke/send channels are registered in main', () => {
  const missing = [...preloadChannels].filter((c) => !registeredChannels.has(c));
  assert.deepEqual(missing, [], `registerIpc missing channels: ${missing.join(', ')}`);
});

test('contract scan detects intentional mismatch', () => {
  const fakeChannels = new Set([...preloadChannels, 'nonexistent:channel']);
  const missing = [...fakeChannels].filter((c) => !registeredChannels.has(c));
  assert.deepEqual(missing, ['nonexistent:channel']);
});

test('question IPC channels retain their public registrations', () => {
  for (const channel of [
    'questions:list', 'questions:get', 'questions:create', 'questions:update', 'questions:delete',
    'questions:markMastery', 'images:remove', 'reviews:list', 'reviews:add', 'reviews:submitResult', 'review:buckets'
  ]) {
    assert.equal(registeredChannels.has(channel), true, `missing question channel: ${channel}`);
  }
});

test('question IPC registrations use the adapter boundary', () => {
  const adapterPath = path.join(projectRoot, 'src/main/ipc/adapters/questionsIpc.ts');
  const adapterSource = readSource(adapterPath);
  assert.match(registerIpcSource, /from '\.\/adapters\/questionsIpc'/);
  assert.match(adapterSource, /getQuestionsApplication/);
  assert.match(adapterSource, /createRendererExecutionContext/);
  assert.doesNotMatch(registerIpcSource, /handle\('questions:(create|update|delete|markMastery)'[^\n]*(?<!FromRenderer)(createQuestion|updateQuestion|deleteQuestion|markMastery)\(/);
});

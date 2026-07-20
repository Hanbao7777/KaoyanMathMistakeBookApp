const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '../..');
const apiPath = path.join(projectRoot, 'src/shared/api.ts');
const preloadPath = path.join(projectRoot, 'src/preload/preload.ts');
const registerIpcPath = path.join(projectRoot, 'src/main/ipc/registerIpc.ts');
const agentControlAdapterPath = path.join(projectRoot, 'src/main/ipc/adapters/agentControlCenterIpc.ts');
const mainPath = path.join(projectRoot, 'src/main/main.ts');

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

const NON_IPC_METHODS = new Set(['toFileUrl', 'agentControl']);

function blockAfter(source, marker, endMarker) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`could not find ${marker}`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`could not find end of ${marker}`);
  return source.slice(start, end);
}

function extractIndentedMethods(source, indentation) {
  const methods = new Set();
  const regex = new RegExp(`^\\s{${indentation}}([a-zA-Z_][a-zA-Z0-9_]*)\\s*:`, 'gm');
  let match;
  while ((match = regex.exec(source)) !== null) methods.add(match[1]);
  return methods;
}

function extractApiMethods(apiSource) {
  const block = blockAfter(apiSource, 'export interface AppApi {', '\n}');
  return new Set([...extractIndentedMethods(block, 2)].filter((method) => !NON_IPC_METHODS.has(method)));
}

function extractPreloadMethods(preloadSource) {
  const block = blockAfter(preloadSource, 'const api: AppApi = {', '\n};');
  return new Set([...extractIndentedMethods(block, 2)].filter((method) => !NON_IPC_METHODS.has(method)));
}

function extractAgentControlApiMethods(apiSource) {
  return extractIndentedMethods(blockAfter(apiSource, 'export interface AgentControlApi {', '\n}'), 2);
}

function extractPreloadAgentControlMethods(preloadSource) {
  return extractIndentedMethods(blockAfter(preloadSource, '  agentControl: {', '\n  } satisfies AgentControlApi'), 4);
}

function extractAdapterAgentControlMethods(adapterSource) {
  const factory = adapterSource.slice(adapterSource.indexOf('export function createAgentControlCenterIpc'));
  const block = blockAfter(factory, '  return Object.freeze({', '  } satisfies AgentControlApi);');
  const methods = new Set();
  for (const match of block.matchAll(/^\s{4}async\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm)) methods.add(match[1]);
  return methods;
}

function extractAgentControlChannels(source) {
  return new Set([...source.matchAll(/agentControl:([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((match) => match[1]));
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
const agentControlAdapterSource = readSource(agentControlAdapterPath);
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

test('AgentControlApi, preload, adapter, and registerIpc retain exact nested method/channel parity', () => {
  const apiMethods = extractAgentControlApiMethods(apiSource);
  const preloadMethods = extractPreloadAgentControlMethods(preloadSource);
  const adapterMethods = extractAdapterAgentControlMethods(agentControlAdapterSource);
  const preloadChannels = extractAgentControlChannels(blockAfter(preloadSource, '  agentControl: {', '\n  } satisfies AgentControlApi'));
  const registeredChannels = extractAgentControlChannels(registerIpcSource);
  assert.deepEqual([...preloadMethods].sort(), [...apiMethods].sort());
  assert.deepEqual([...adapterMethods].sort(), [...apiMethods].sort());
  assert.deepEqual([...preloadChannels].sort(), [...apiMethods].sort());
  assert.deepEqual([...registeredChannels].sort(), [...apiMethods].sort());
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
  assert.match(adapterSource, /getAgentControlPlane/);
  assert.match(adapterSource, /renderer\.principal\(\)/);
  assert.doesNotMatch(adapterSource, /getQuestionsApplication/);
  assert.doesNotMatch(adapterSource, /createRendererExecutionContext/);
  assert.doesNotMatch(registerIpcSource, /handle\('questions:(create|update|delete|markMastery)'[^\n]*(?<!FromRenderer)(createQuestion|updateQuestion|deleteQuestion|markMastery)\(/);
});

test('direct IPC database writers use coordinator-contained application mutations', () => {
  for (const channel of ['imports:createDraft', 'imports:validateDraft', 'imports:previewDraft', 'imports:applyDraft', 'ticktick:whiteNoise:get', 'ticktick:whiteNoise:set']) {
    assert.equal(registeredChannels.has(channel), true, `missing contained IPC channel: ${channel}`);
  }
  assert.doesNotMatch(registerIpcSource, /\bgetDatabase\s*\(/);
  assert.doesNotMatch(registerIpcSource, /\bpersistDatabase\s*\(/);
  assert.doesNotMatch(registerIpcSource, /\b(?:createImportBatch|recordImportBatchItem)\s*\(/);
  assert.match(registerIpcSource, /async function executeLegacyMutation/);
  assert.match(registerIpcSource, /getReadOnlyDatabase/);
  assert.doesNotMatch(registerIpcSource, /ai:recordImport|recordAiImport/);
  assert.match(registerIpcSource, /from '\.\/adapters\/importsIpc'/);
  assert.match(registerIpcSource, /handle\('ticktick:whiteNoise:set'[^\n]+setWhiteNoiseState/);
});

test('focus session-end persistence has an explicit failure observer', () => {
  const callbackStart = registerIpcSource.indexOf('focusTimerEngine.setSessionEndCallback');
  const callbackEnd = registerIpcSource.indexOf('function startEngineTick', callbackStart);
  const callbackSource = registerIpcSource.slice(callbackStart, callbackEnd);
  assert.match(callbackSource, /void createTickTickFocusSession/);
  assert.match(callbackSource, /\.then\(/);
  assert.match(callbackSource, /console\.error\('focusTimerEngine: saveSession failed'/);
  assert.doesNotMatch(callbackSource, /\.catch\([^)]*=>\s*\{?\s*\}?\s*\)/);
});

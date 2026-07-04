const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { projectRoot } = require('./helpers/mainTestEnv.cjs');

const { runLoad, toReadableError, runCommand } = require(path.join(projectRoot, 'dist/main/shared/loadState.js'));

test.after(() => {});

test('runLoad returns ok outcome with value on success', async () => {
  const outcome = await runLoad(async () => 42);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.value, 42);
});

test('runLoad returns error outcome with readable message on failure', async () => {
  const outcome = await runLoad(async () => { throw new Error('网络错误'); }, '加载失败');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.message, '网络错误');
});

test('runLoad uses fallback when error has no message', async () => {
  const outcome = await runLoad(async () => { throw 123; }, '自定义失败');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.message, '自定义失败');
});

test('toReadableError extracts message from Error', () => {
  assert.equal(toReadableError(new Error('boom')), 'boom');
});

test('toReadableError uses fallback for non-Error', () => {
  assert.equal(toReadableError(null, 'fallback'), 'fallback');
  assert.equal(toReadableError(undefined, 'fallback'), 'fallback');
  assert.equal(toReadableError('', 'fallback'), 'fallback');
});

test('runCommand returns ok outcome with value on success', async () => {
  const outcome = await runCommand(async () => 'done');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.value, 'done');
});

test('runCommand returns error outcome with readable message on failure', async () => {
  const outcome = await runCommand(async () => { throw new Error('命令失败'); }, '操作失败');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.message, '命令失败');
});

test('runCommand uses fallback when error has no message', async () => {
  const outcome = await runCommand(async () => { throw null; }, '默认操作失败');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.message, '默认操作失败');
});

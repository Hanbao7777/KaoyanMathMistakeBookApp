const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '../..');
const { toReadableError, runLoad } = require(path.join(projectRoot, 'dist/main/shared/loadState.js'));

test('toReadableError extracts message from Error instances', () => {
  assert.equal(toReadableError(new Error('清单不存在')), '清单不存在');
});

test('toReadableError falls back for empty/unknown errors', () => {
  assert.equal(toReadableError(undefined), '加载失败，请重试');
  assert.equal(toReadableError(null), '加载失败，请重试');
  assert.equal(toReadableError(new Error('')), '加载失败，请重试');
  assert.equal(toReadableError({}), '加载失败，请重试');
});

test('toReadableError accepts a custom fallback', () => {
  assert.equal(toReadableError(null, '任务加载失败'), '任务加载失败');
});

test('toReadableError passes through non-empty string throws', () => {
  assert.equal(toReadableError('boom'), 'boom');
});

test('runLoad returns ok outcome with the resolved value', async () => {
  const outcome = await runLoad(async () => ({ tasks: [1, 2, 3] }));
  assert.deepEqual(outcome, { ok: true, value: { tasks: [1, 2, 3] } });
});

test('runLoad captures failures as a readable error outcome without throwing', async () => {
  const outcome = await runLoad(async () => { throw new Error('IPC 通道断开'); }, '任务加载失败');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.message, 'IPC 通道断开');
});

test('runLoad uses fallback message when the failure has no message', async () => {
  const outcome = await runLoad(async () => { throw null; }, '任务加载失败');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.message, '任务加载失败');
});

test('runLoad distinguishes an empty successful result from a failure', async () => {
  const outcome = await runLoad(async () => []);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.value, []);
});

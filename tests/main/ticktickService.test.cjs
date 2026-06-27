const assert = require('node:assert/strict');
const test = require('node:test');
const {
  cleanupTestRoot,
  databaseService,
  requireMain,
  resetTestDatabase
} = require('./helpers/mainTestEnv.cjs');

const ticktickService = requireMain('services/ticktickService.js');

test.after(cleanupTestRoot);

test.beforeEach(resetTestDatabase);

async function createList(name = '默认清单') {
  return ticktickService.createTickTickList({ name });
}

async function createTask(overrides = {}) {
  const list = await createList();
  return ticktickService.createTickTickTask({
    list_id: list.id,
    title: '复习高数',
    note: '原备注',
    priority: 'none',
    tags: ['复习'],
    ...overrides
  });
}

test('createTickTickTask rejects empty list_id', async () => {
  await assert.rejects(
    () => ticktickService.createTickTickTask({ list_id: '', title: '复习高数' }),
    /请先创建或选择一个清单/
  );
});

test('createTickTickTask rejects nonexistent list_id', async () => {
  await assert.rejects(
    () => ticktickService.createTickTickTask({ list_id: 'missing-list', title: '复习高数' }),
    /清单不存在/
  );
});

test('updateTickTickTask rejects empty title', async () => {
  const task = await createTask();
  await assert.rejects(
    () => ticktickService.updateTickTickTask(task.id, { title: '   ' }),
    /任务标题不能为空/
  );
});

test('updateTickTickTask rejects nonexistent list_id', async () => {
  const task = await createTask();
  await assert.rejects(
    () => ticktickService.updateTickTickTask(task.id, { list_id: 'missing-list' }),
    /清单不存在/
  );
});

test('createTickTickTask creates task with valid list_id', async () => {
  const list = await createList();
  const task = await ticktickService.createTickTickTask({
    list_id: list.id,
    title: '  复习高数  ',
    note: '完成第 1 章',
    due_date: '2026-06-27',
    priority: '高',
    tags: ['数学', '复习']
  });

  assert.equal(task.list_id, list.id);
  assert.equal(task.title, '复习高数');
  assert.equal(task.note, '完成第 1 章');
  assert.equal(task.due_date, '2026-06-27');
  assert.equal(task.priority, '高');
  assert.deepEqual(task.tags_list, ['数学', '复习']);
});

test('updateTickTickTask updates editable fields', async () => {
  const source = await createTask();
  const targetList = await createList('目标清单');

  const updated = await ticktickService.updateTickTickTask(source.id, {
    title: '  更新标题  ',
    note: '新备注',
    due_date: '2026-06-28',
    priority: '中',
    list_id: targetList.id,
    tags: ['新标签']
  });

  assert.ok(updated);
  assert.equal(updated.title, '更新标题');
  assert.equal(updated.note, '新备注');
  assert.equal(updated.due_date, '2026-06-28');
  assert.equal(updated.priority, '中');
  assert.equal(updated.list_id, targetList.id);
  assert.deepEqual(updated.tags_list, ['新标签']);
});

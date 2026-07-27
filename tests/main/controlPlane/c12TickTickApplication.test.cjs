const assert = require('node:assert/strict');
const test = require('node:test');
const {
  cleanupControlPlaneRoot,
  databaseService,
  resetControlPlaneEnvironment,
  requireMain
} = require('../helpers/controlPlaneTestEnv.cjs');

const ticktickService = requireMain('services/ticktickService.js');
const ticktickIpc = requireMain('ipc/adapters/ticktickIpc.js');

test.after(() => cleanupControlPlaneRoot());
test.beforeEach(resetControlPlaneEnvironment);

function today() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

test('C12 Renderer/service parity covers lists, habits, calendar, and bridges', async () => {
  const list = await ticktickService.createTickTickList({ name: 'C12 List', color: '#123456' });
  assert.equal((await ticktickService.listTickTickLists()).find(({ id }) => id === list.id).name, 'C12 List');
  const updatedList = await ticktickService.updateTickTickList(list.id, { color: '#654321' });
  assert.equal(updatedList.color, '#654321');

  const habit = await ticktickService.createTickTickHabit({ name: 'C12 Habit', frequency: 'daily' });
  await ticktickService.toggleTickTickHabit(habit.id, today());
  const listedHabit = (await ticktickService.listTickTickHabits()).find(({ id }) => id === habit.id);
  assert.equal(listedHabit.today_completed, 1);
  assert.equal(listedHabit.streak, 1);
  const updatedHabit = await ticktickService.updateTickTickHabit(habit.id, { target_count: 2 });
  assert.equal(updatedHabit.target_count, 2);

  const task = await ticktickService.createTickTickTask({ list_id: list.id, title: 'C12 calendar task', due_date: '2026-07-18' });
  const bridge = await ticktickService.createTickTickBridge({ ticktick_task_id: task.id, linked_type: 'question', linked_id: '42', sync_review: 1 });
  assert.equal((await ticktickService.getTickTickTaskBridges(task.id))[0].id, bridge.id);
  const calendar = await ticktickService.getTickTickCalendarMonth(2026, 7);
  const calendarDay = calendar.find(({ date }) => date === '2026-07-18');
  assert.equal(calendarDay.task_count, 1);
  assert.equal(calendarDay.tasks[0].id, task.id);
});

test('C12 Renderer writes replay the exact Gateway outcome and reject mismatched reuse', async () => {
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  const input = { name: 'Replay List' };
  const first = await ticktickIpc.createTickTickListFromRenderer(input, requestId);
  const version = (await databaseService.getDatabaseCoordinator()).currentVersion();
  const replay = await ticktickIpc.createTickTickListFromRenderer(input, requestId);
  assert.deepEqual(replay, first);
  assert.deepEqual((await databaseService.getDatabaseCoordinator()).currentVersion(), version);
  await assert.rejects(() => ticktickIpc.createTickTickListFromRenderer({ name: 'Different List' }, requestId), /conflict|idempot/i);
  assert.equal((await ticktickService.listTickTickLists()).filter(({ name }) => name.includes('List')).length, 1);
});

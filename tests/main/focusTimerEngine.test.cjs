const assert = require('node:assert/strict');
const test = require('node:test');
const {
  cleanupTestRoot,
  requireMain,
  resetTestDatabase
} = require('./helpers/mainTestEnv.cjs');

const { FocusTimerEngine } = requireMain('services/focusTimerEngine.js');

test.after(cleanupTestRoot);

test.beforeEach(resetTestDatabase);

function makeEngine(config = {}) {
  return new FocusTimerEngine({
    focusMinutes: 25,
    shortBreakMinutes: 5,
    longBreakMinutes: 15,
    sessionsBeforeLongBreak: 4,
    ...config
  });
}

test('start transitions from idle to running and sets sessionStartTime', () => {
  const engine = makeEngine();
  const now = Date.now();

  engine.start(now);

  const state = engine.getState();
  assert.equal(state.status, 'running');
  assert.equal(state.secondsLeft, 25 * 60);
  assert.equal(state.totalSeconds, 25 * 60);
  assert.ok(state.sessionStartTime !== null);
  assert.equal(state.currentSession, 1);
});

test('pause transitions from running to paused and freezes secondsLeft', () => {
  const engine = makeEngine();
  const now = 1000000;
  engine.start(now);

  engine.tick(now + 10000);
  engine.pause(now + 10000);

  const state = engine.getState();
  assert.equal(state.status, 'paused');
  assert.equal(state.sessionStartTime, null);
  assert.ok(state.secondsLeft < 25 * 60);
});

test('reset returns to idle with default focus duration', () => {
  const engine = makeEngine();
  engine.start();
  engine.reset();

  const state = engine.getState();
  assert.equal(state.status, 'idle');
  assert.equal(state.secondsLeft, 25 * 60);
  assert.equal(state.totalSeconds, 25 * 60);
  assert.equal(state.completedSessions, 0);
  assert.equal(state.currentSession, 1);
  assert.equal(state.sessionStartTime, null);
});

test('tick auto-transitions running focus to break when time expires', () => {
  const engine = makeEngine({ focusMinutes: 1 });
  const now = 1000000;
  engine.start(now);

  engine.tick(now + 60 * 1000);

  const state = engine.getState();
  assert.equal(state.status, 'break');
  assert.equal(state.completedSessions, 1);
  assert.equal(state.secondsLeft, 5 * 60);
  assert.equal(state.totalSeconds, 5 * 60);
  assert.ok(state.sessionStartTime !== null);
});

test('tick auto-transitions break to idle for next session when break expires', () => {
  const engine = makeEngine({ focusMinutes: 1, shortBreakMinutes: 1 });
  const now = 1000000;
  engine.start(now);
  engine.tick(now + 60 * 1000);
  assert.equal(engine.getState().status, 'break');

  engine.tick(now + 60 * 1000 + 60 * 1000);

  const state = engine.getState();
  assert.equal(state.status, 'idle');
  assert.equal(state.currentSession, 2);
  assert.equal(state.secondsLeft, 60);
  assert.equal(state.totalSeconds, 60);
  assert.equal(state.sessionStartTime, null);
});

test('tick uses long break after configured sessions', () => {
  const engine = makeEngine({ focusMinutes: 1, shortBreakMinutes: 1, longBreakMinutes: 3, sessionsBeforeLongBreak: 2 });
  const now = 1000000;

  engine.start(now);
  engine.tick(now + 60 * 1000);
  engine.tick(now + 60 * 1000 + 60 * 1000);
  assert.equal(engine.getState().status, 'idle');
  assert.equal(engine.getState().currentSession, 2);

  engine.start(now + 200000);
  engine.tick(now + 200000 + 60 * 1000);

  const state = engine.getState();
  assert.equal(state.status, 'break');
  assert.equal(state.completedSessions, 2);
  assert.equal(state.secondsLeft, 3 * 60);
  assert.equal(state.totalSeconds, 3 * 60);
});

test('skipBreak transitions from break to idle and increments session', () => {
  const engine = makeEngine({ focusMinutes: 1 });
  const now = 1000000;
  engine.start(now);
  engine.tick(now + 60 * 1000);
  assert.equal(engine.getState().status, 'break');

  engine.skipBreak(now + 70000);

  const state = engine.getState();
  assert.equal(state.status, 'idle');
  assert.equal(state.currentSession, 2);
  assert.equal(state.secondsLeft, 60);
  assert.equal(state.totalSeconds, 60);
  assert.equal(state.sessionStartTime, null);
});

test('start from paused resumes with remaining time', () => {
  const engine = makeEngine({ focusMinutes: 1 });
  const now = 1000000;
  engine.start(now);
  engine.tick(now + 20000);
  engine.pause(now + 20000);
  assert.equal(engine.getState().status, 'paused');
  assert.ok(engine.getState().secondsLeft <= 40);

  engine.start(now + 30000);

  const state = engine.getState();
  assert.equal(state.status, 'running');
  assert.ok(state.sessionStartTime !== null);
});

test('tick computes secondsLeft from sessionStartTime during running', () => {
  const engine = makeEngine({ focusMinutes: 1 });
  const now = 1000000;
  engine.start(now);

  engine.tick(now + 15000);

  const state = engine.getState();
  assert.equal(state.status, 'running');
  assert.equal(state.secondsLeft, 45);
});

test('tick does nothing when idle or paused', () => {
  const engine = makeEngine();

  engine.tick();
  assert.equal(engine.getState().status, 'idle');

  engine.start();
  engine.pause();
  engine.tick();
  assert.equal(engine.getState().status, 'paused');
});

test('sessionEndCallback fires when a focus session completes', () => {
  const sessions = [];
  const engine = makeEngine({ focusMinutes: 1 });
  engine.setSessionEndCallback((info) => sessions.push(info));
  const now = 1000000;
  engine.start(now);
  engine.setBoundTaskId('task-1');

  engine.tick(now + 60 * 1000);

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionType, 'focus');
  assert.equal(sessions[0].boundTaskId, 'task-1');
  assert.ok(sessions[0].sessionStartTime > 0);
});

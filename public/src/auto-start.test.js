import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAutoStartDeadline, MAX_PLAYERS, LONE_TIMEOUT_MS, GATHER_WINDOW_MS } from './auto-start.js';

const now = 1000;

test('first arrival sets lone timer', () => {
  const r = computeAutoStartDeadline({ playerCount: 1, gatherTriggered: false, now });
  assert.deepEqual(r, { deadline: now + LONE_TIMEOUT_MS, gatherTriggered: false });
});

test('second arrival triggers gather', () => {
  const r = computeAutoStartDeadline({ playerCount: 2, gatherTriggered: false, now });
  assert.deepEqual(r, { deadline: now + GATHER_WINDOW_MS, gatherTriggered: true });
});

test('third/fourth/fifth arrival does NOT reset once gather triggered', () => {
  for (const n of [3, 4, 5]) {
    const r = computeAutoStartDeadline({ playerCount: n, gatherTriggered: true, now });
    assert.equal(r.deadline, null, `count=${n} should not reset`);
    assert.equal(r.gatherTriggered, true);
  }
});

test('reaching MAX_PLAYERS fires immediately', () => {
  const r = computeAutoStartDeadline({ playerCount: MAX_PLAYERS, gatherTriggered: true, now });
  assert.equal(r.deadline, now);
});

test('arrival counts not in {1,2,MAX_PLAYERS} with gatherTriggered=false return null (defensive)', () => {
  const r = computeAutoStartDeadline({ playerCount: 3, gatherTriggered: false, now });
  assert.equal(r.deadline, null);
});

test('MAX_PLAYERS constant is 6, timers are 5000ms', () => {
  assert.equal(MAX_PLAYERS, 6);
  assert.equal(LONE_TIMEOUT_MS, 5000);
  assert.equal(GATHER_WINDOW_MS, 5000);
});

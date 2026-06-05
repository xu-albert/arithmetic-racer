import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRaceResultPayload } from './room-stats.js';

function makePlayer(overrides = {}) {
  return {
    id: 'p-1',
    handle: 'BraveOtter',
    score: 0,
    attempts: 0,
    longestStreak: 0,
    finishMs: null,
    dropped: false,
    dnf: false,
    deviceId: 'device-1',
    userId: null,
    ...overrides,
  };
}

function makeState(overrides = {}) {
  return {
    id: 'brave-otter-eel',
    difficulty: 'medium',
    raceLength: 10,
    ...overrides,
  };
}

test('finisher: finished=true, finish_time_ms set, room_id from state', () => {
  const p = makePlayer({ score: 10, attempts: 11, longestStreak: 6, finishMs: 30000 });
  const out = buildRaceResultPayload(p, makeState());
  assert.equal(out.finished, true);
  assert.equal(out.finish_time_ms, 30000);
  assert.equal(out.room_id, 'brave-otter-eel');
  assert.equal(out.problems_total, 10);
  assert.equal(out.problems_correct, 10);
  assert.equal(out.problems_attempted, 11);
  assert.equal(out.longest_streak, 6);
});

test('finisher: accuracy_pct and avg_time_per_problem_ms computed correctly', () => {
  const p = makePlayer({ score: 10, attempts: 12, finishMs: 36000 });
  const out = buildRaceResultPayload(p, makeState());
  assert.ok(Math.abs(out.accuracy_pct - (10 / 12) * 100) < 1e-9);
  assert.equal(out.avg_time_per_problem_ms, 3600); // 36000 / 10
});

test('dnf: finished=false, finish_time_ms null, avg_time_per_problem_ms 0', () => {
  const p = makePlayer({ score: 4, attempts: 5, longestStreak: 3, dnf: true });
  const out = buildRaceResultPayload(p, makeState());
  assert.equal(out.finished, false);
  assert.equal(out.finish_time_ms, null);
  assert.equal(out.avg_time_per_problem_ms, 0);
  assert.equal(out.problems_correct, 4);
  assert.equal(out.problems_attempted, 5);
});

test('dropped: same shape as dnf — finished=false', () => {
  const p = makePlayer({ score: 6, attempts: 8, longestStreak: 4, dropped: true });
  const out = buildRaceResultPayload(p, makeState());
  assert.equal(out.finished, false);
  assert.equal(out.finish_time_ms, null);
});

test('zero attempts: accuracy is 0 (not NaN)', () => {
  const p = makePlayer({ score: 0, attempts: 0, dnf: true });
  const out = buildRaceResultPayload(p, makeState());
  assert.equal(out.accuracy_pct, 0);
  assert.equal(out.problems_attempted, 0);
});

test('user_id and device_id flow through from player', () => {
  const p = makePlayer({ score: 10, attempts: 10, finishMs: 25000, userId: 'user-42' });
  const out = buildRaceResultPayload(p, makeState());
  assert.equal(out.user_id, 'user-42');
  assert.equal(out.device_id, 'device-1');
});

test('difficulty flows through from state', () => {
  const p = makePlayer({ score: 10, attempts: 10, finishMs: 25000 });
  const out = buildRaceResultPayload(p, makeState({ difficulty: 'hard' }));
  assert.equal(out.difficulty, 'hard');
});

test('null userId yields null user_id in payload', () => {
  const p = makePlayer({ score: 10, attempts: 10, finishMs: 25000, userId: null });
  const out = buildRaceResultPayload(p, makeState());
  assert.equal(out.user_id, null);
});

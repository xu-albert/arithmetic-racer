// What main.js posts to /api/race-result when a solo race ends — and, since a
// quit is no longer stored, when it posts nothing. Driven through the real solo
// runner so the fields come from the counters it actually keeps.

import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRunner, COUNTDOWN_SECONDS, GRACE_PERIOD_MS } from './runner.js';
import { soloResultPayload } from './solo-result.js';

const DEVICE = 'device-1';

function soloAtFinish(play) {
  const runner = createRunner({ difficulty: 'easy', seed: 4242, player: { handle: 'Me' }, length: 3 });
  let finished = false;
  runner.on((event) => { if (event === 'finish') finished = true; });
  runner.start();
  for (let i = 0; i < COUNTDOWN_SECONDS; i++) mock.timers.tick(1000);
  play(runner);
  mock.timers.tick(GRACE_PERIOD_MS);
  assert.equal(finished, true, 'the race has ended');
  return runner;
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
});
afterEach(() => {
  mock.timers.reset();
});

test('a finished solo race reports its time, counts and streak', () => {
  const runner = soloAtFinish((r) => {
    r.submitAnswer('-1');
    mock.timers.tick(1500);
    for (const p of r.sequence) r.submitAnswer(String(p.answer));
  });
  assert.deepEqual(soloResultPayload({ runner, difficulty: 'easy', deviceId: DEVICE }), {
    device_id: DEVICE,
    difficulty: 'easy',
    finished: true,
    finish_time_ms: 1500,
    problems_total: 3,
    problems_correct: 3,
    problems_attempted: 4,
    avg_time_per_problem_ms: 500,
    accuracy_pct: 75,
    longest_streak: 3,
  });
});

test('a quit reports nothing, however far the player got', () => {
  const runner = soloAtFinish((r) => {
    r.submitAnswer(String(r.sequence[0].answer));
    r.submitAnswer(String(r.sequence[1].answer));
    r.quit();
  });
  assert.equal(runner.racers[0].dropped, true);
  assert.equal(soloResultPayload({ runner, difficulty: 'easy', deviceId: DEVICE }), null);
});

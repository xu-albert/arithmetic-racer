// The solo "Quickplay" race runner — the default mode, and the one whose
// attempts/streak counters main.js posts straight to /api/race-result.
//
// Timers and Date are mocked so a race that would take seconds runs in
// microseconds and finishes on an exact tick; Math.random is pinned where
// the bot dropout roll would otherwise make a test flaky.

import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRunner, RACE_LENGTH, COUNTDOWN_SECONDS, GRACE_PERIOD_MS } from './runner.js';

const SEED = 4242;
const PLAYER = { handle: 'Me' };

function record(runner) {
  const events = [];
  runner.on((event, data) => events.push({ event, data }));
  return events;
}

function solo(opts = {}) {
  return createRunner({ difficulty: 'easy', seed: SEED, player: PLAYER, length: 3, ...opts });
}

// Race through the whole sequence, answering from the runner's own problems.
function finishPlayer(runner) {
  for (const p of runner.sequence) runner.submitAnswer(String(p.answer));
}

// Mock timers only fire what is due when tick() is called, not timers a
// callback chains after them, so the countdown is walked one tick at a time.
function startRacing(runner) {
  runner.start();
  for (let i = 0; i < COUNTDOWN_SECONDS; i++) mock.timers.tick(1000);
}

// Same reason: bots chain one timer per answer, so a long wait is many ticks.
function waitMs(ms, step = 100) {
  for (let t = 0; t < ms; t += step) mock.timers.tick(step);
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
});
afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

describe('setup', () => {
  test('racers are the player first, then one entry per bot, all at the start line', () => {
    const runner = solo({ bots: [{ handle: 'A', tier: 'slow' }, { handle: 'B', tier: 'fast' }] });
    assert.deepEqual(
      runner.racers.map((r) => [r.id, r.handle, r.isBot, r.tier, r.score]),
      [['player', 'Me', false, null, 0], ['bot-0', 'A', true, 'slow', 0], ['bot-1', 'B', true, 'fast', 0]],
    );
    assert.equal(runner.raceLength, 3);
    assert.equal(runner.sequence.length, 3);
    assert.equal(runner.getState(), 'idle');
  });

  test('defaults to a RACE_LENGTH race', () => {
    const runner = createRunner({ difficulty: 'easy', seed: SEED, player: PLAYER });
    assert.equal(runner.raceLength, RACE_LENGTH);
    assert.equal(runner.sequence.length, RACE_LENGTH);
  });

  test('the same seed yields the same sequence, so a rematch can be replayed', () => {
    assert.deepEqual(solo().sequence, solo().sequence);
  });
});

describe('countdown', () => {
  test('ticks 3, 2, 1 a second apart, then starts with the first problem', () => {
    const runner = solo();
    const events = record(runner);
    runner.start();
    assert.deepEqual(events, [{ event: 'countdown', data: { n: 3 } }]);
    assert.equal(runner.getState(), 'countdown');
    mock.timers.tick(1000);
    mock.timers.tick(1000);
    assert.deepEqual(events.map((e) => e.data.n), [3, 2, 1]);
    mock.timers.tick(1000);
    assert.deepEqual(events.at(-1), { event: 'start', data: { problem: runner.sequence[0] } });
    assert.equal(runner.getState(), 'racing');
  });

  test('answers before the start are refused, and start() is one-shot', () => {
    const runner = solo();
    assert.deepEqual(runner.submitAnswer('1'), { correct: false, reason: 'not-racing' });
    runner.start();
    const events = record(runner);
    runner.start();
    assert.deepEqual(events, []);
  });
});

describe('submitAnswer', () => {
  test('a correct answer advances the car, emits the next problem, and counts toward the streak', () => {
    const runner = solo();
    startRacing(runner);
    const events = record(runner);
    const answer = String(runner.sequence[0].answer);
    const result = runner.submitAnswer(answer);
    assert.deepEqual(result, { correct: true, next: runner.sequence[1] });
    assert.deepEqual(events, [
      { event: 'advance', data: { laneId: 'player', score: 1, finishMs: null } },
      { event: 'problem', data: { problem: runner.sequence[1] } },
    ]);
    const me = runner.racers[0];
    assert.equal(me.attempts, 1);
    assert.equal(me.currentStreak, 1);
    assert.equal(me.longestStreak, 1);
    assert.deepEqual(runner.currentProblemFor('player'), runner.sequence[1]);
  });

  test('a wrong answer costs nothing but the streak, and is counted as an attempt', () => {
    const runner = solo();
    startRacing(runner);
    runner.submitAnswer(String(runner.sequence[0].answer));
    const events = record(runner);
    assert.deepEqual(runner.submitAnswer('not a number'), { correct: false });
    assert.deepEqual(events, [{ event: 'wrong', data: { laneId: 'player' } }]);
    const me = runner.racers[0];
    assert.equal(me.score, 1);
    assert.equal(me.attempts, 2);
    assert.equal(me.currentStreak, 0);
    assert.equal(me.longestStreak, 1);
  });

  test('longestStreak keeps the best run, not the current one', () => {
    const runner = solo({ length: 5 });
    startRacing(runner);
    const [a, b, c] = runner.sequence;
    runner.submitAnswer(String(a.answer));
    runner.submitAnswer(String(b.answer));
    runner.submitAnswer('wrong');
    runner.submitAnswer(String(c.answer));
    const me = runner.racers[0];
    assert.equal(me.longestStreak, 2);
    assert.equal(me.currentStreak, 1);
    assert.equal(me.attempts, 4);
  });

  test('crossing the line stamps finishMs from the race clock and issues no further problem', () => {
    const runner = solo();
    startRacing(runner);
    const events = record(runner);
    runner.submitAnswer(String(runner.sequence[0].answer));
    runner.submitAnswer(String(runner.sequence[1].answer));
    mock.timers.tick(2_500);
    const result = runner.submitAnswer(String(runner.sequence[2].answer));
    assert.deepEqual(result, { correct: true, next: null });
    const lastAdvance = events.filter((e) => e.event === 'advance').at(-1);
    assert.deepEqual(lastAdvance, { event: 'advance', data: { laneId: 'player', score: 3, finishMs: 2_500 } });
    // Nobody else to wait for: the race is over the instant the player is.
    assert.deepEqual(runner.submitAnswer('1'), { correct: false, reason: 'not-racing' });
  });
});

describe('finishing', () => {
  test('a solo race ends the moment the player finishes, ranked first', () => {
    const runner = solo();
    startRacing(runner);
    const events = record(runner);
    finishPlayer(runner);
    const finish = events.find((e) => e.event === 'finish');
    assert.ok(finish, 'finish emitted');
    assert.deepEqual(finish.data.rankings.map((r) => r.id), ['player']);
    assert.equal(runner.getState(), 'finished');
  });

  test('after the player finishes, bots still racing get the grace period, then read as dnf', () => {
    mock.method(Math, 'random', () => 0.5); // never drop out; delays sit on the mean
    const runner = solo({ bots: [{ handle: 'Slow', tier: 'slow' }], difficulty: 'hard', length: 3 });
    startRacing(runner);
    const events = record(runner);
    finishPlayer(runner);
    assert.equal(events.some((e) => e.event === 'finish'), false, 'podium not locked yet');
    // Still racing (the bot is), but this player is done.
    assert.deepEqual(runner.submitAnswer('1'), { correct: false, reason: 'finished' });
    mock.timers.tick(GRACE_PERIOD_MS);
    const finish = events.find((e) => e.event === 'finish');
    assert.ok(finish, 'finish emitted after the grace period');
    const bot = finish.data.rankings.find((r) => r.id === 'bot-0');
    assert.equal(bot.dnf, true);
    assert.equal(bot.finishMs, null);
    assert.deepEqual(finish.data.rankings.map((r) => r.id), ['player', 'bot-0']);
  });

  test('a bot that beats the player is ranked ahead by finish time', () => {
    mock.method(Math, 'random', () => 0.5);
    // Fast bots on easy answer every ~1.2s; the player waits 10s before answering.
    const runner = solo({ bots: [{ handle: 'Fast', tier: 'fast' }], difficulty: 'easy', length: 3 });
    startRacing(runner);
    const events = record(runner);
    waitMs(10_000);
    const botAdvances = events.filter((e) => e.event === 'advance' && e.data.laneId === 'bot-0');
    assert.equal(botAdvances.at(-1).data.score, 3);
    assert.ok(botAdvances.at(-1).data.finishMs > 0);
    finishPlayer(runner);
    const finish = events.find((e) => e.event === 'finish');
    assert.deepEqual(finish.data.rankings.map((r) => r.id), ['bot-0', 'player']);
    assert.ok(finish.data.rankings[0].finishMs < finish.data.rankings[1].finishMs);
  });

  test('the race ends early when every racer is done, without waiting out the grace period', () => {
    mock.method(Math, 'random', () => 0.5);
    const runner = solo({ bots: [{ handle: 'Fast', tier: 'fast' }], difficulty: 'easy', length: 3 });
    startRacing(runner);
    const events = record(runner);
    waitMs(10_000);
    finishPlayer(runner);
    assert.equal(events.at(-1).event, 'finish');
  });

  test('finish fires once even though both the grace timer and allDone can reach it', () => {
    mock.method(Math, 'random', () => 0.5);
    const runner = solo({ bots: [{ handle: 'Fast', tier: 'fast' }], difficulty: 'easy', length: 3 });
    startRacing(runner);
    const events = record(runner);
    finishPlayer(runner);
    waitMs(GRACE_PERIOD_MS * 4);
    assert.equal(events.filter((e) => e.event === 'finish').length, 1);
  });
});

describe('bot dropouts', () => {
  test('a bot can drop mid-race, is announced, and lands at the bottom of the podium', () => {
    // Below DROPOUT_CHANCE_PER_ANSWER on every roll: the bot drops the first
    // time it is allowed to (score 3, with more than 2 problems left).
    mock.method(Math, 'random', () => 0.001);
    const runner = solo({ bots: [{ handle: 'Flaky', tier: 'fast' }], difficulty: 'easy', length: 10 });
    startRacing(runner);
    const events = record(runner);
    waitMs(60_000);
    const drop = events.find((e) => e.event === 'drop');
    assert.deepEqual(drop, { event: 'drop', data: { laneId: 'bot-0' } });
    const bot = runner.racers[1];
    assert.equal(bot.dropped, true);
    assert.equal(bot.score, 3);
    assert.equal(events.filter((e) => e.event === 'advance' && e.data.laneId === 'bot-0').length, 3);
    for (const p of runner.sequence) runner.submitAnswer(String(p.answer));
    const finish = events.find((e) => e.event === 'finish');
    assert.deepEqual(finish.data.rankings.map((r) => r.id), ['player', 'bot-0']);
  });

  test('a bot never drops within two problems of the finish', () => {
    mock.method(Math, 'random', () => 0.001);
    // length 5: dropouts allowed only at score 3 < length - 2 = 3 → never.
    const runner = solo({ bots: [{ handle: 'Flaky', tier: 'fast' }], difficulty: 'easy', length: 5 });
    startRacing(runner);
    const events = record(runner);
    waitMs(60_000);
    assert.equal(events.some((e) => e.event === 'drop'), false);
    assert.equal(runner.racers[1].score, 5);
  });
});

describe('quit and stop', () => {
  test('quit mid-race drops the player and locks the podium immediately', () => {
    mock.method(Math, 'random', () => 0.5);
    const runner = solo({ bots: [{ handle: 'A', tier: 'medium' }] });
    startRacing(runner);
    const events = record(runner);
    runner.submitAnswer(String(runner.sequence[0].answer));
    runner.quit();
    assert.deepEqual(events.slice(-2).map((e) => e.event), ['drop', 'finish']);
    assert.deepEqual(events.at(-2).data, { laneId: 'player' });
    const me = runner.racers[0];
    assert.equal(me.dropped, true);
    assert.equal(me.finishMs, null);
    assert.equal(runner.getState(), 'finished');
    // The still-racing bot is marked dnf; quitter and dnf share the bottom
    // tier, so the original lane order holds between them.
    assert.deepEqual(events.at(-1).data.rankings.map((r) => [r.id, r.dropped, r.dnf]), [['player', true, false], ['bot-0', false, true]]);
  });

  test('quit is a no-op outside racing or after finishing', () => {
    const runner = solo();
    const events = record(runner);
    runner.quit();
    startRacing(runner);
    finishPlayer(runner);
    const before = events.length;
    runner.quit();
    assert.equal(events.length, before);
    assert.equal(runner.racers[0].dropped, false);
  });

  test('stop clears every pending timer so nothing fires after the screen is torn down', () => {
    mock.method(Math, 'random', () => 0.5);
    const runner = solo({ bots: [{ handle: 'A', tier: 'fast' }] });
    runner.start();
    const events = record(runner);
    runner.stop();
    waitMs(60_000);
    assert.deepEqual(events, []);
    assert.equal(runner.getState(), 'finished');
  });
});

describe('getRankings', () => {
  test('finished by time, then still racing by score, then dropped or dnf', () => {
    const runner = solo({ bots: [{ handle: 'A', tier: 'slow' }, { handle: 'B', tier: 'slow' }, { handle: 'C', tier: 'slow' }] });
    const [me, a, b, c] = runner.racers;
    Object.assign(me, { score: 2 });
    Object.assign(a, { score: 3, finishMs: 9_000 });
    Object.assign(b, { score: 1, dropped: true });
    Object.assign(c, { score: 3, finishMs: 4_000 });
    assert.deepEqual(runner.getRankings().map((r) => r.id), ['bot-2', 'bot-0', 'player', 'bot-1']);
    // Pure: racers are not reordered in place.
    assert.deepEqual(runner.racers.map((r) => r.id), ['player', 'bot-0', 'bot-1', 'bot-2']);
  });
});

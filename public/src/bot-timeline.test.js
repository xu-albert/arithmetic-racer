import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBotTimelines, scoreBotAt } from './bot-timeline.js';

test('deterministic — same seed/tiers/difficulty produces same timelines', () => {
  const a = computeBotTimelines({ botSeed: 12345, botTiers: ['slow', 'medium', 'fast'], difficulty: 'medium', raceLength: 10 });
  const b = computeBotTimelines({ botSeed: 12345, botTiers: ['slow', 'medium', 'fast'], difficulty: 'medium', raceLength: 10 });
  assert.deepEqual(a, b);
});

test('different seeds yield different timelines', () => {
  const a = computeBotTimelines({ botSeed: 1, botTiers: ['medium'], difficulty: 'medium', raceLength: 10 });
  const b = computeBotTimelines({ botSeed: 2, botTiers: ['medium'], difficulty: 'medium', raceLength: 10 });
  assert.notDeepEqual(a, b);
});

test('timeline is monotonically increasing within each bot', () => {
  const tl = computeBotTimelines({ botSeed: 999, botTiers: ['fast', 'medium', 'slow'], difficulty: 'hard', raceLength: 10 });
  for (const bot of tl) {
    for (let i = 1; i < bot.length; i++) {
      assert.ok(bot[i] > bot[i - 1], `not strictly increasing: ${JSON.stringify(bot)}`);
    }
  }
});

test('timeline length equals raceLength per bot', () => {
  const tl = computeBotTimelines({ botSeed: 7, botTiers: ['slow', 'slow'], difficulty: 'easy', raceLength: 10 });
  assert.equal(tl.length, 2);
  for (const bot of tl) assert.equal(bot.length, 10);
});

test('scoreBotAt counts ticks at or before the elapsed time', () => {
  const timeline = [100, 200, 300, 400, 500];
  assert.equal(scoreBotAt(timeline, 50), 0);
  assert.equal(scoreBotAt(timeline, 100), 1);
  assert.equal(scoreBotAt(timeline, 350), 3);
  assert.equal(scoreBotAt(timeline, 9999), 5);
});

test('empty botTiers returns empty array', () => {
  const tl = computeBotTimelines({ botSeed: 1, botTiers: [], difficulty: 'medium', raceLength: 10 });
  assert.deepEqual(tl, []);
});

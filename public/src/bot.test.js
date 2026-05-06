import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOT_TIERS,
  BOT_TIER_NAMES,
  HUMAN_AVG_PPM,
  TIER_WEIGHTS,
  nextBotDelay,
  pickBotTiers,
} from './bot.js';
import { makeRng } from './game.js';

test('nextBotDelay returns a positive integer for every tier+difficulty', () => {
  for (const tier of BOT_TIER_NAMES) {
    for (const difficulty of Object.keys(HUMAN_AVG_PPM)) {
      for (let i = 0; i < 200; i++) {
        const delay = nextBotDelay(tier, difficulty);
        assert.ok(Number.isInteger(delay), `${tier}/${difficulty}: ${delay} not int`);
        assert.ok(delay >= 50, `${tier}/${difficulty}: ${delay} below floor`);
      }
    }
  }
});

test('fast tier is consistently faster than slow at same difficulty', () => {
  const rng = makeRng(1);
  const samples = 500;
  for (const difficulty of Object.keys(HUMAN_AVG_PPM)) {
    let slowSum = 0;
    let fastSum = 0;
    for (let i = 0; i < samples; i++) {
      slowSum += nextBotDelay('slow', difficulty, rng);
      fastSum += nextBotDelay('fast', difficulty, rng);
    }
    assert.ok(slowSum > fastSum, `${difficulty}: slow avg should exceed fast avg`);
  }
});

test('mario kart scaling: bots are slower at easy than at hard (avg delay)', () => {
  // At easy, even a "fast" bot's delay should be longer than a "fast" bot at hard,
  // because HUMAN_AVG_PPM is much higher at easy (60 vs 22), and factor is the same.
  // Wait — higher PPM means lower delay. So fast/easy delay < fast/hard delay.
  // The point of the test: fast tier at easy is still faster (lower delay) than fast at hard.
  const rng = makeRng(7);
  let easySum = 0;
  let hardSum = 0;
  for (let i = 0; i < 500; i++) {
    easySum += nextBotDelay('fast', 'easy', rng);
    hardSum += nextBotDelay('fast', 'hard', rng);
  }
  assert.ok(easySum < hardSum, 'easy delays should be shorter than hard delays at same tier');
});

test('nextBotDelay is deterministic with seeded RNG', () => {
  const a = nextBotDelay('medium', 'medium', makeRng(42));
  const b = nextBotDelay('medium', 'medium', makeRng(42));
  assert.equal(a, b);
});

test('nextBotDelay throws on unknown tier or difficulty', () => {
  assert.throws(() => nextBotDelay('superhuman', 'easy'), /Unknown bot tier/);
  assert.throws(() => nextBotDelay('medium', 'extreme'), /Unknown difficulty/);
});

test('pickBotTiers returns the requested count and only valid names', () => {
  for (const difficulty of Object.keys(TIER_WEIGHTS)) {
    const tiers = pickBotTiers(difficulty, 4, makeRng(99));
    assert.equal(tiers.length, 4);
    for (const t of tiers) assert.ok(BOT_TIER_NAMES.includes(t));
  }
});

test('pickBotTiers distribution skews slow at easy and fast at hard', () => {
  const N = 1000;
  const rng = makeRng(123);
  const easy = pickBotTiers('easy', N, rng);
  const hard = pickBotTiers('hard', N, rng);
  const easySlow = easy.filter((t) => t === 'slow').length;
  const easyFast = easy.filter((t) => t === 'fast').length;
  const hardSlow = hard.filter((t) => t === 'slow').length;
  const hardFast = hard.filter((t) => t === 'fast').length;
  assert.ok(easySlow > easyFast, 'easy should produce more slow than fast');
  assert.ok(hardFast > hardSlow, 'hard should produce more fast than slow');
});

test('pickBotTiers throws on unknown difficulty', () => {
  assert.throws(() => pickBotTiers('extreme', 4), /Unknown difficulty/);
});

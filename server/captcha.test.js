// Pure-helper tests for the active-verification (captcha) flow. Runs under
// node:test — no Workers runtime needed. The room-integration half of the
// behavior lives in server/room-captcha.test.js (vitest).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPTCHA_TRIGGER_MS_PER_PROBLEM,
  CAPTCHA_PROBLEM_COUNT,
  CAPTCHA_MS_PER_PROBLEM,
} from '../worker/plausibility.js';
import {
  needsCaptchaTrigger,
  newCaptchaSeed,
  captchaProblems,
  captchaWireProblems,
  captchaDeadline,
} from './captcha.js';

test('needsCaptchaTrigger fires below the per-problem trigger over the whole race', () => {
  // 10-problem race: 4999ms triggers, 5000ms does not (the bound is strict).
  assert.equal(needsCaptchaTrigger(10 * CAPTCHA_TRIGGER_MS_PER_PROBLEM - 1, 10), true);
  assert.equal(needsCaptchaTrigger(10 * CAPTCHA_TRIGGER_MS_PER_PROBLEM, 10), false);
  assert.equal(needsCaptchaTrigger(10 * CAPTCHA_TRIGGER_MS_PER_PROBLEM + 1, 10), false);
});

test('needsCaptchaTrigger fires only for the standard race length', () => {
  // The 500ms/problem evidence is a rate over a full ten-problem set, and ten
  // is the only length a board ranks. A five-problem easy room finished in 2.4s
  // is a fast human, not a script, and is never challenged.
  assert.equal(needsCaptchaTrigger(5 * CAPTCHA_TRIGGER_MS_PER_PROBLEM - 1, 5), false);
  assert.equal(needsCaptchaTrigger(1, 5), false);
  assert.equal(needsCaptchaTrigger(1, 20), false);
  assert.equal(needsCaptchaTrigger(1, 50), false);
  assert.equal(needsCaptchaTrigger(1, 10), true);
});

test('needsCaptchaTrigger ignores junk and degenerate races', () => {
  for (const bad of [null, undefined, NaN, Infinity, '5000', -1]) {
    assert.equal(needsCaptchaTrigger(bad, 10), false, String(bad));
  }
  assert.equal(needsCaptchaTrigger(1000, 0), false);
  assert.equal(needsCaptchaTrigger(1000, -5), false);
  assert.equal(needsCaptchaTrigger(null, 10), false);
});

test('captchaProblems is deterministic per seed and regenerable', () => {
  const a = captchaProblems(12345, 'medium');
  const b = captchaProblems(12345, 'medium');
  assert.deepEqual(a, b);
  assert.equal(a.length, CAPTCHA_PROBLEM_COUNT);
  for (const p of a) {
    assert.equal(typeof p.problem, 'string');
    assert.equal(typeof p.answer, 'number');
    assert.ok(Number.isFinite(p.answer));
  }
});

test('captchaProblems honors an explicit count and avoids consecutive duplicates', () => {
  for (const difficulty of ['easy', 'medium', 'hard']) {
    const problems = captchaProblems(999, difficulty, 8);
    assert.equal(problems.length, 8);
    for (let i = 1; i < problems.length; i++) {
      assert.notEqual(problems[i].problem, problems[i - 1].problem);
    }
  }
});

test('different seeds give different problem sets', () => {
  const a = captchaProblems(1, 'easy').map((p) => p.problem).join('|');
  const b = captchaProblems(2, 'easy').map((p) => p.problem).join('|');
  assert.notEqual(a, b);
});

test('captchaWireProblems strips answers — they never reach a client', () => {
  const problems = captchaProblems(42, 'hard');
  const wire = captchaWireProblems(problems);
  assert.equal(wire.length, problems.length);
  for (const w of wire) {
    assert.deepEqual(Object.keys(w), ['problem']);
    assert.equal(typeof w.problem, 'string');
  }
  assert.ok(!JSON.stringify(wire).includes('"answer"'));
});

test('captchaDeadline is count × the per-problem budget', () => {
  assert.equal(captchaDeadline(1000), 1000 + CAPTCHA_PROBLEM_COUNT * CAPTCHA_MS_PER_PROBLEM);
  assert.equal(captchaDeadline(1000, 5), 1000 + 5 * CAPTCHA_MS_PER_PROBLEM);
});

test('newCaptchaSeed draws distinct uint32 values', () => {
  const seen = new Set(Array.from({ length: 64 }, () => newCaptchaSeed()));
  for (const s of seen) {
    assert.ok(Number.isInteger(s) && s >= 0 && s <= 0xffffffff);
  }
  assert.ok(seen.size > 60);
});

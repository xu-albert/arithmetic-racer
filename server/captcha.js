// Active-verification (captcha) helpers, kept pure so they run under node:test
// without the Workers runtime. The room DO wires these into the race finish
// flow; the constants and their evidence live in worker/plausibility.js.
//
// The challenge is server-authoritative end to end: the server draws the seed,
// regenerates the problems to grade them, and only the problem *strings* ever
// leave the DO — answers stay server-side (unlike `race-start`, which ships the
// full sequence to clients). The seed lets a hibernated DO re-derive everything
// after wake without persisting answers in state.

import {
  CAPTCHA_TRIGGER_MS_PER_PROBLEM,
  CAPTCHA_PROBLEM_COUNT,
  CAPTCHA_MS_PER_PROBLEM,
} from '../worker/plausibility.js';
import { makeRng, generateProblem } from '../public/src/game.js';

/**
 * True when a finished race's sustained pace is faster than a plausible human
 * rate — see CAPTCHA_TRIGGER_MS_PER_PROBLEM for the number and its evidence.
 * Only meaningful for server-timed finishes (room races); a client-asserted
 * solo time must never earn a "verified" badge.
 */
export function needsCaptchaTrigger(finishMs, problemsTotal) {
  return typeof finishMs === 'number' && Number.isFinite(finishMs) && finishMs >= 0
    && problemsTotal > 0
    && finishMs < problemsTotal * CAPTCHA_TRIGGER_MS_PER_PROBLEM;
}

/** Unpredictable per-challenge seed; the problem set is derived from it. */
export function newCaptchaSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;
}

// Consecutive duplicates read like a bug (easy's operand space is tiny), same
// rule as generateSequence in game.js — and equally deterministic per seed.
const MAX_REROLLS = 10;

/** Deterministic problem set for a seed; regenerable after DO hibernation. */
export function captchaProblems(seed, difficulty, count = CAPTCHA_PROBLEM_COUNT) {
  const rng = makeRng(seed);
  const out = [];
  for (let i = 0; i < count; i++) {
    let next = generateProblem(difficulty, rng);
    for (let attempt = 0; attempt < MAX_REROLLS && i > 0 && next.problem === out[i - 1].problem; attempt++) {
      next = generateProblem(difficulty, rng);
    }
    out.push(next);
  }
  return out;
}

/**
 * Wire projection: problem strings only. The `answer` field must never reach a
 * client — a captcha whose answers ship alongside it grades nothing.
 */
export function captchaWireProblems(problems) {
  return problems.map((p) => ({ problem: p.problem }));
}

/** Absolute deadline for a challenge issued at `issuedAt`. */
export function captchaDeadline(issuedAt, count = CAPTCHA_PROBLEM_COUNT) {
  return issuedAt + count * CAPTCHA_MS_PER_PROBLEM;
}

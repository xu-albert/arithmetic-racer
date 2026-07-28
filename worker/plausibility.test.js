// Tests for the race plausibility assessor.
//
// The contract here is deliberately "flag, never reject" — every case below
// asserts on the returned verdict, and none of them expect a throw. Hard
// rejection would destroy the one record worth examining.

import { describe, it, expect } from "vitest";
import { assessPlausibility, MIN_MS_PER_PROBLEM, MAX_RACE_MS } from "./plausibility.js";

function race(overrides = {}) {
  return {
    finished: true,
    finish_time_ms: 48000,
    problems_total: 10,
    ...overrides,
  };
}

describe("assessPlausibility", () => {
  it("clears an ordinary finished race", () => {
    expect(assessPlausibility(race())).toEqual({ suspect: 0, reason: null });
  });

  it("clears a race at the exact speed floor", () => {
    const atFloor = race({ finish_time_ms: 10 * MIN_MS_PER_PROBLEM });
    expect(assessPlausibility(atFloor)).toEqual({ suspect: 0, reason: null });
  });

  it("flags a finished race faster than the per-problem floor", () => {
    const tooFast = race({ finish_time_ms: 10 * MIN_MS_PER_PROBLEM - 1 });
    expect(assessPlausibility(tooFast)).toEqual({
      suspect: 1,
      reason: "impossibly_fast",
    });
  });

  it("flags a zero-millisecond finish", () => {
    expect(assessPlausibility(race({ finish_time_ms: 0 }))).toEqual({
      suspect: 1,
      reason: "impossibly_fast",
    });
  });

  it("scales the floor with the number of problems", () => {
    // 2000ms clears a 10-problem race but is impossible over 100 problems.
    const long = race({ problems_total: 100, finish_time_ms: 2000 });
    expect(assessPlausibility(long).suspect).toBe(1);
  });

  it("flags a race that ran longer than the maximum", () => {
    expect(assessPlausibility(race({ finish_time_ms: MAX_RACE_MS + 1 }))).toEqual({
      suspect: 1,
      reason: "implausibly_slow",
    });
  });

  it("clears an idle-but-bounded race at the maximum", () => {
    expect(assessPlausibility(race({ finish_time_ms: MAX_RACE_MS }))).toEqual({
      suspect: 0,
      reason: null,
    });
  });

  it("clears an unfinished race, which carries no finish time to judge", () => {
    const quit = race({ finished: false, finish_time_ms: null });
    expect(assessPlausibility(quit)).toEqual({ suspect: 0, reason: null });
  });

  it("clears a finished race with a missing finish time rather than throwing", () => {
    // Defensive: the caller validates first, but this must never be the thing
    // that turns a recoverable write into a 500.
    expect(assessPlausibility(race({ finish_time_ms: null }))).toEqual({
      suspect: 0,
      reason: null,
    });
  });
});

// Tests for the per-race score/speed formulas.
//
// The reference values come from the TypeRacer analogue the formula was
// derived from: points = volume × rate / 60. Because
// points = correct × (correct × 60000 / ms) / 60 collapses to
// correct² × 1000 / ms, several cases below double as an algebraic check.

import { describe, it, expect } from "vitest";
import { computePoints, computePpm } from "./race-score.js";

function race(overrides = {}) {
  return {
    finished: true,
    finish_time_ms: 60_000,
    problems_correct: 20,
    ...overrides,
  };
}

describe("computePpm", () => {
  it("is problems per minute", () => {
    expect(computePpm(race({ finish_time_ms: 60_000, problems_correct: 20 }))).toBe(20);
    expect(computePpm(race({ finish_time_ms: 30_000, problems_correct: 20 }))).toBe(40);
    expect(computePpm(race({ finish_time_ms: 120_000, problems_correct: 20 }))).toBe(10);
  });

  it("handles very short races without special-casing them", () => {
    // 10 problems in 2s = 300 ppm. Absurd, but plausibility.js is what flags
    // absurd — the formula's job is only to be right.
    expect(computePpm(race({ finish_time_ms: 2_000, problems_correct: 10 }))).toBe(300);
    // 1ms: still finite and correct, never Infinity.
    expect(computePpm(race({ finish_time_ms: 1, problems_correct: 1 }))).toBe(60_000);
  });

  it("is 0 when nothing was correct, not null", () => {
    expect(computePpm(race({ problems_correct: 0 }))).toBe(0);
  });

  it("is null for an unfinished or untimed race", () => {
    expect(computePpm(race({ finished: false, finish_time_ms: null }))).toBeNull();
    expect(computePpm(race({ finished: false, finish_time_ms: 30_000 }))).toBeNull();
    expect(computePpm(race({ finish_time_ms: null }))).toBeNull();
    expect(computePpm(race({ finish_time_ms: 0 }))).toBeNull();
    expect(computePpm(race({ finish_time_ms: -5 }))).toBeNull();
    expect(computePpm(race({ finish_time_ms: NaN }))).toBeNull();
    expect(computePpm(race({ finish_time_ms: Infinity }))).toBeNull();
    expect(computePpm(race({ finish_time_ms: "30000" }))).toBeNull();
    expect(computePpm(race({ problems_correct: null }))).toBeNull();
    expect(computePpm(undefined)).toBeNull();
  });
});

describe("computePoints", () => {
  it("is volume × rate: correct × ppm / 60", () => {
    // 20 correct at 20 ppm -> 20 × 20/60 = 6.667
    expect(computePoints(race({ finish_time_ms: 60_000, problems_correct: 20 }))).toBeCloseTo(
      6.6667,
      4
    );
    // Twice the volume in the same time -> four times the points: volume enters
    // twice, once directly and once through the rate.
    expect(computePoints(race({ finish_time_ms: 60_000, problems_correct: 40 }))).toBeCloseTo(
      26.6667,
      4
    );
    // Twice the volume at the same rate -> twice the points. This is the
    // property that makes a longer race worth grinding.
    expect(computePoints(race({ finish_time_ms: 120_000, problems_correct: 40 }))).toBeCloseTo(
      13.3333,
      4
    );
  });

  it("matches the closed form correct² × 1000 / ms", () => {
    for (const [ms, correct] of [
      [60_000, 20],
      [17_500, 9],
      [2_000, 10],
      [301_337, 47],
    ]) {
      expect(computePoints(race({ finish_time_ms: ms, problems_correct: correct }))).toBeCloseTo(
        (correct * correct * 1000) / ms,
        9
      );
    }
  });

  it("scores 0 for a finished race with nothing correct", () => {
    // 0 is a result a racer can genuinely earn, so it must not be null.
    expect(computePoints(race({ problems_correct: 0 }))).toBe(0);
  });

  it("is null for an unfinished race — a DNF is not a zero score", () => {
    expect(computePoints(race({ finished: false, finish_time_ms: null }))).toBeNull();
    expect(computePoints(race({ finished: false, finish_time_ms: 30_000 }))).toBeNull();
    expect(computePoints(race({ finished: true, finish_time_ms: null }))).toBeNull();
  });

  it("stays finite on a 1ms race", () => {
    const p = computePoints(race({ finish_time_ms: 1, problems_correct: 10 }));
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeCloseTo(100_000, 6);
  });
});

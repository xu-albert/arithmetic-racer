// Tests for the shared log throttle.
//
// Relocated from worker/routes/leaderboard.test.js when the throttle moved out
// of that route — worker/rate-limit.js needed it too and cannot import from a
// route module. The assertions are the originals, renamed for the neutral
// `count` field the shared version returns.
//
// Driven by an injected `now` rather than wall-clock timing, so the bound is
// asserted deterministically and in any order.

import { describe, it, expect } from "vitest";
import { logThrottleDecision, FRESH_THROTTLE } from "./log-throttle.js";

describe("logThrottleDecision", () => {
  const WINDOW_MS = 60_000;

  it("emits on the first occurrence, as a notice rather than a count", () => {
    const first = logThrottleDecision(FRESH_THROTTLE, 1_000, WINDOW_MS);
    expect(first.emit).toBe(true);
    expect(first.count).toBe(1);
    // No previous line to measure from — the field that stops a reader taking
    // `count: 1` for "it happened once".
    expect(first.sinceMs).toBeNull();
  });

  it("stays silent for the rest of the window, however many arrive", () => {
    let state = logThrottleDecision(FRESH_THROTTLE, 1_000, WINDOW_MS).state;
    for (let i = 1; i <= 4; i++) {
      const d = logThrottleDecision(state, 1_000 + i, WINDOW_MS);
      expect(d.emit).toBe(false);
      state = d.state;
    }
    // Suppressed, not dropped: the tail is still being counted.
    expect(state.count).toBe(4);
  });

  it("reports the suppressed tail on the next occurrence past the window", () => {
    let state = logThrottleDecision(FRESH_THROTTLE, 1_000, WINDOW_MS).state;
    for (let i = 1; i <= 4; i++) {
      state = logThrottleDecision(state, 1_000 + i, WINDOW_MS).state;
    }

    const next = logThrottleDecision(state, 1_000 + WINDOW_MS, WINDOW_MS);
    expect(next.emit).toBe(true);
    // Four suppressed plus the one that carried them out.
    expect(next.count).toBe(5);
    expect(next.sinceMs).toBe(WINDOW_MS);
    expect(next.state).toEqual({ count: 0, lastLogMs: 1_000 + WINDOW_MS });
  });

  it("does not emit one millisecond early", () => {
    const state = logThrottleDecision(FRESH_THROTTLE, 1_000, WINDOW_MS).state;
    expect(logThrottleDecision(state, 1_000 + WINDOW_MS - 1, WINDOW_MS).emit).toBe(false);
  });

  it("takes the window from the caller rather than assuming one", () => {
    // The two callers bound different things: board denials on the limiter's
    // own period, limiter failures on a volume budget of their own.
    const state = logThrottleDecision(FRESH_THROTTLE, 1_000, WINDOW_MS).state;
    expect(logThrottleDecision(state, 1_000 + 10_000, WINDOW_MS).emit).toBe(false);
    expect(logThrottleDecision(state, 1_000 + 10_000, 5_000).emit).toBe(true);
  });

  it("never mutates the state it is handed", () => {
    const state = { count: 3, lastLogMs: 1_000 };
    logThrottleDecision(state, 1_000 + WINDOW_MS, WINDOW_MS);
    expect(state).toEqual({ count: 3, lastLogMs: 1_000 });
  });
});

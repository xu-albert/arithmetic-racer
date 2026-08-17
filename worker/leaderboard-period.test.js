// Period-boundary regression tests.
//
// These are the tests that matter most for the boards: a window that is one
// millisecond or one timezone off silently shows the wrong day's leaderboard,
// and nothing about the response looks broken when it happens. So every case
// below asserts an exact epoch-millisecond value computed with Date.UTC —
// never with local-time constructors, which would make the suite pass or fail
// depending on where it runs.

import { describe, it, expect } from "vitest";
import { PERIODS, isPeriod, periodStartMs } from "./leaderboard-period.js";

// 2026-08-17T01:19:42.123Z — a Monday, 01:19 UTC. Deliberately a moment that
// is still "yesterday" in every timezone west of London: if any boundary were
// computed in local time, a US-based runner would disagree with this.
const MON = Date.UTC(2026, 7, 17, 1, 19, 42, 123);

describe("isPeriod", () => {
  it("accepts exactly the five board windows", () => {
    expect(PERIODS).toEqual(["all", "day", "week", "month", "year"]);
    for (const p of PERIODS) expect(isPeriod(p)).toBe(true);
  });

  it("rejects anything else", () => {
    for (const bad of ["", "ALL", "daily", "hour", "decade", null, undefined, 7, {}]) {
      expect(isPeriod(bad)).toBe(false);
    }
  });
});

describe("periodStartMs — all-time", () => {
  it("returns 0 so the same bound parameter works for every window", () => {
    expect(periodStartMs("all", MON)).toBe(0);
  });

  it("ignores nowMs entirely", () => {
    expect(periodStartMs("all", Number.NaN)).toBe(0);
  });
});

describe("periodStartMs — day", () => {
  it("starts at UTC midnight of the current UTC day", () => {
    expect(periodStartMs("day", MON)).toBe(Date.UTC(2026, 7, 17));
  });

  it("is inclusive at midnight — the first race of the day is in the window", () => {
    const midnight = Date.UTC(2026, 7, 17);
    expect(periodStartMs("day", midnight)).toBe(midnight);
  });

  it("rolls over at UTC midnight, not local midnight", () => {
    // 23:59:59.999Z and the millisecond after belong to different days, even
    // though both are the same afternoon in US Pacific.
    const lastMs = Date.UTC(2026, 7, 17, 23, 59, 59, 999);
    expect(periodStartMs("day", lastMs)).toBe(Date.UTC(2026, 7, 17));
    expect(periodStartMs("day", lastMs + 1)).toBe(Date.UTC(2026, 7, 18));
  });
});

describe("periodStartMs — week", () => {
  it("starts on Monday (ISO week)", () => {
    expect(periodStartMs("week", MON)).toBe(Date.UTC(2026, 7, 17));
  });

  it("keeps Sunday in the week that began the previous Monday", () => {
    // 2026-08-23 is the Sunday after MON. It must NOT open a new week.
    const sun = Date.UTC(2026, 7, 23, 12);
    expect(periodStartMs("week", sun)).toBe(Date.UTC(2026, 7, 17));
    // ...and the next millisecond of Monday does.
    expect(periodStartMs("week", Date.UTC(2026, 7, 24))).toBe(Date.UTC(2026, 7, 24));
  });

  it("walks back across a month boundary", () => {
    // 2026-09-02 is a Wednesday; its Monday is 2026-08-31.
    expect(periodStartMs("week", Date.UTC(2026, 8, 2, 9))).toBe(Date.UTC(2026, 7, 31));
  });

  it("walks back across a year boundary", () => {
    // 2027-01-01 is a Friday; its Monday is 2026-12-28.
    expect(periodStartMs("week", Date.UTC(2027, 0, 1, 5))).toBe(Date.UTC(2026, 11, 28));
  });

  it("covers every weekday: each day of one week maps to the same Monday", () => {
    const monday = Date.UTC(2026, 7, 17);
    for (let i = 0; i < 7; i++) {
      const t = monday + i * 86_400_000 + 3_600_000;
      expect(periodStartMs("week", t)).toBe(monday);
    }
    // Day 7 is the next Monday and starts a new week.
    expect(periodStartMs("week", monday + 7 * 86_400_000)).toBe(monday + 7 * 86_400_000);
  });
});

describe("periodStartMs — month", () => {
  it("starts at UTC midnight on the 1st", () => {
    expect(periodStartMs("month", MON)).toBe(Date.UTC(2026, 7, 1));
  });

  it("rolls over between months, not on the 30-day mark", () => {
    const lastMs = Date.UTC(2026, 7, 31, 23, 59, 59, 999);
    expect(periodStartMs("month", lastMs)).toBe(Date.UTC(2026, 7, 1));
    expect(periodStartMs("month", lastMs + 1)).toBe(Date.UTC(2026, 8, 1));
  });

  it("handles February in a leap year", () => {
    expect(periodStartMs("month", Date.UTC(2028, 1, 29, 18))).toBe(Date.UTC(2028, 1, 1));
  });
});

describe("periodStartMs — year", () => {
  it("starts at UTC midnight on Jan 1", () => {
    expect(periodStartMs("year", MON)).toBe(Date.UTC(2026, 0, 1));
  });

  it("rolls over at the new year in UTC", () => {
    const lastMs = Date.UTC(2026, 11, 31, 23, 59, 59, 999);
    expect(periodStartMs("year", lastMs)).toBe(Date.UTC(2026, 0, 1));
    expect(periodStartMs("year", lastMs + 1)).toBe(Date.UTC(2027, 0, 1));
  });
});

describe("periodStartMs — nesting", () => {
  it("windows widen monotonically: day ⊆ week ⊆ month is not guaranteed, but day ⊆ month ⊆ year is", () => {
    const day = periodStartMs("day", MON);
    const month = periodStartMs("month", MON);
    const year = periodStartMs("year", MON);
    expect(day).toBeGreaterThanOrEqual(month);
    expect(month).toBeGreaterThanOrEqual(year);
    // The week is the one that can reach back further than the month — it is
    // an ISO week, not a slice of the calendar month. 2026-09-02 proves it.
    const early = Date.UTC(2026, 8, 2, 9);
    expect(periodStartMs("week", early)).toBeLessThan(periodStartMs("month", early));
  });

  it("never returns a bound in the future", () => {
    for (const p of PERIODS) {
      expect(periodStartMs(p, MON)).toBeLessThanOrEqual(MON);
    }
  });
});

describe("periodStartMs — bad input", () => {
  it("throws on an unknown period rather than silently showing all-time", () => {
    expect(() => periodStartMs("decade", MON)).toThrow(TypeError);
    expect(() => periodStartMs("", MON)).toThrow(TypeError);
    expect(() => periodStartMs(undefined, MON)).toThrow(TypeError);
  });

  it("throws on a non-finite nowMs for a bounded period", () => {
    expect(() => periodStartMs("day", Number.NaN)).toThrow(TypeError);
    expect(() => periodStartMs("week", Infinity)).toThrow(TypeError);
  });
});

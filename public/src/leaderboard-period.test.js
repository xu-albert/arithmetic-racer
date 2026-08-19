// Period-boundary regression tests.
//
// These are the tests that matter most for the boards: a window that is one
// millisecond or one timezone off silently shows the wrong day's leaderboard,
// and nothing about the response looks broken when it happens. So every case
// below asserts an exact epoch-millisecond value computed with Date.UTC —
// never with local-time constructors, which would make the suite pass or fail
// depending on where it runs.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PERIODS, isPeriod, periodStartMs } from "./leaderboard-period.js";

// 2026-08-17T01:19:42.123Z — a Monday, 01:19 UTC. Deliberately a moment that
// is still "yesterday" in every timezone west of London: if any boundary were
// computed in local time, a US-based runner would disagree with this.
const MON = Date.UTC(2026, 7, 17, 1, 19, 42, 123);

describe("isPeriod", () => {
  it("accepts exactly the five board windows", () => {
    assert.deepEqual(PERIODS, ["all", "day", "week", "month", "year"]);
    for (const p of PERIODS) assert.equal(isPeriod(p), true);
  });

  it("rejects anything else", () => {
    for (const bad of ["", "ALL", "daily", "hour", "decade", null, undefined, 7, {}]) {
      assert.equal(isPeriod(bad), false);
    }
  });
});

describe("periodStartMs — all-time", () => {
  it("returns 0 so the same bound parameter works for every window", () => {
    assert.equal(periodStartMs("all", MON), 0);
  });

  it("ignores nowMs entirely", () => {
    assert.equal(periodStartMs("all", Number.NaN), 0);
  });
});

describe("periodStartMs — day", () => {
  it("starts at UTC midnight of the current UTC day", () => {
    assert.equal(periodStartMs("day", MON), Date.UTC(2026, 7, 17));
  });

  it("is inclusive at midnight — the first race of the day is in the window", () => {
    const midnight = Date.UTC(2026, 7, 17);
    assert.equal(periodStartMs("day", midnight), midnight);
  });

  it("rolls over at UTC midnight, not local midnight", () => {
    // 23:59:59.999Z and the millisecond after belong to different days, even
    // though both are the same afternoon in US Pacific.
    const lastMs = Date.UTC(2026, 7, 17, 23, 59, 59, 999);
    assert.equal(periodStartMs("day", lastMs), Date.UTC(2026, 7, 17));
    assert.equal(periodStartMs("day", lastMs + 1), Date.UTC(2026, 7, 18));
  });
});

describe("periodStartMs — week", () => {
  it("starts on Monday (ISO week)", () => {
    assert.equal(periodStartMs("week", MON), Date.UTC(2026, 7, 17));
  });

  it("keeps Sunday in the week that began the previous Monday", () => {
    // 2026-08-23 is the Sunday after MON. It must NOT open a new week.
    const sun = Date.UTC(2026, 7, 23, 12);
    assert.equal(periodStartMs("week", sun), Date.UTC(2026, 7, 17));
    // ...and the next millisecond of Monday does.
    assert.equal(periodStartMs("week", Date.UTC(2026, 7, 24)), Date.UTC(2026, 7, 24));
  });

  it("walks back across a month boundary", () => {
    // 2026-09-02 is a Wednesday; its Monday is 2026-08-31.
    assert.equal(periodStartMs("week", Date.UTC(2026, 8, 2, 9)), Date.UTC(2026, 7, 31));
  });

  it("walks back across a year boundary", () => {
    // 2027-01-01 is a Friday; its Monday is 2026-12-28.
    assert.equal(periodStartMs("week", Date.UTC(2027, 0, 1, 5)), Date.UTC(2026, 11, 28));
  });

  it("covers every weekday: each day of one week maps to the same Monday", () => {
    const monday = Date.UTC(2026, 7, 17);
    for (let i = 0; i < 7; i++) {
      const t = monday + i * 86_400_000 + 3_600_000;
      assert.equal(periodStartMs("week", t), monday);
    }
    // Day 7 is the next Monday and starts a new week.
    assert.equal(periodStartMs("week", monday + 7 * 86_400_000), monday + 7 * 86_400_000);
  });
});

describe("periodStartMs — month", () => {
  it("starts at UTC midnight on the 1st", () => {
    assert.equal(periodStartMs("month", MON), Date.UTC(2026, 7, 1));
  });

  it("rolls over between months, not on the 30-day mark", () => {
    const lastMs = Date.UTC(2026, 7, 31, 23, 59, 59, 999);
    assert.equal(periodStartMs("month", lastMs), Date.UTC(2026, 7, 1));
    assert.equal(periodStartMs("month", lastMs + 1), Date.UTC(2026, 8, 1));
  });

  it("handles February in a leap year", () => {
    assert.equal(periodStartMs("month", Date.UTC(2028, 1, 29, 18)), Date.UTC(2028, 1, 1));
  });
});

describe("periodStartMs — year", () => {
  it("starts at UTC midnight on Jan 1", () => {
    assert.equal(periodStartMs("year", MON), Date.UTC(2026, 0, 1));
  });

  it("rolls over at the new year in UTC", () => {
    const lastMs = Date.UTC(2026, 11, 31, 23, 59, 59, 999);
    assert.equal(periodStartMs("year", lastMs), Date.UTC(2026, 0, 1));
    assert.equal(periodStartMs("year", lastMs + 1), Date.UTC(2027, 0, 1));
  });
});

describe("periodStartMs — nesting", () => {
  it("windows widen monotonically: day ⊆ week ⊆ month is not guaranteed, but day ⊆ month ⊆ year is", () => {
    const day = periodStartMs("day", MON);
    const month = periodStartMs("month", MON);
    const year = periodStartMs("year", MON);
    assert.ok(day >= month, `${day} should not precede ${month}`);
    assert.ok(month >= year, `${month} should not precede ${year}`);
    // The week is the one that can reach back further than the month — it is
    // an ISO week, not a slice of the calendar month. 2026-09-02 proves it.
    const early = Date.UTC(2026, 8, 2, 9);
    assert.ok(
      periodStartMs("week", early) < periodStartMs("month", early),
      "an ISO week can start before the month it falls in"
    );
  });

  it("never returns a bound in the future", () => {
    for (const p of PERIODS) {
      assert.ok(periodStartMs(p, MON) <= MON, `${p} reached past now`);
    }
  });
});

describe("periodStartMs — bad input", () => {
  it("throws on an unknown period rather than silently showing all-time", () => {
    assert.throws(() => periodStartMs("decade", MON), TypeError);
    assert.throws(() => periodStartMs("", MON), TypeError);
    assert.throws(() => periodStartMs(undefined, MON), TypeError);
  });

  it("throws on a non-finite nowMs for a bounded period", () => {
    assert.throws(() => periodStartMs("day", Number.NaN), TypeError);
    assert.throws(() => periodStartMs("week", Infinity), TypeError);
  });
});

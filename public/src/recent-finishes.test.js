// Tests for the lobby's recent-finishes strip.
//
// Runs on `node --test` with no DOM (docs/testing.md), so what is exercised
// here is the display mapping and the polling behavior — every timer, clock and
// fetch is injected. The endpoint's own eligibility/ordering/limit rules are
// tested against real D1 in worker/routes/recent-finishes.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatAgo,
  formatPpm,
  formatPoints,
  toFeedRows,
  createRecentFinishesFeed,
  POLL_INTERVAL_MS,
  TICK_INTERVAL_MS,
} from "./recent-finishes.js";

// --- relative time ---------------------------------------------------------

test("formatAgo reads as liveness at the short end", () => {
  assert.equal(formatAgo(0), "just now");
  assert.equal(formatAgo(4_999), "just now");
  assert.equal(formatAgo(5_000), "5s ago");
  assert.equal(formatAgo(42_000), "42s ago");
  assert.equal(formatAgo(59_999), "59s ago");
});

test("formatAgo steps up through minutes, hours, days", () => {
  assert.equal(formatAgo(60_000), "1m ago");
  assert.equal(formatAgo(59 * 60_000), "59m ago");
  assert.equal(formatAgo(60 * 60_000), "1h ago");
  assert.equal(formatAgo(23 * 3600_000), "23h ago");
  assert.equal(formatAgo(24 * 3600_000), "1d ago");
  assert.equal(formatAgo(50 * 3600_000), "2d ago");
});

test("formatAgo never prints a finish from the future", () => {
  // A device clock running ahead of the server yields a negative age.
  assert.equal(formatAgo(-30_000), "just now");
  assert.equal(formatAgo(NaN), "just now");
});

// --- numbers ---------------------------------------------------------------

test("formatPpm keeps one decimal", () => {
  assert.equal(formatPpm(20), "20.0");
  assert.equal(formatPpm(41.27), "41.3");
  assert.equal(formatPpm(null), null);
  assert.equal(formatPpm("fast"), null);
});

test("formatPoints distinguishes unscored from zero", () => {
  // 0 is a score a racer can earn (finished, nothing correct); null means the
  // race was never scored. They must not render the same way.
  assert.equal(formatPoints(0), "0");
  assert.equal(formatPoints(6.6667), "7");
  assert.equal(formatPoints(null), null);
  assert.equal(formatPoints(undefined), null);
});

// --- payload → rows --------------------------------------------------------

const PAYLOAD = {
  generated_at: "2026-08-17T12:00:00.000Z",
  limit: 6,
  finishes: [
    {
      username: "speedy",
      difficulty: "hard",
      problems_correct: 20,
      ppm: 24.5,
      points: 8.1667,
      played_at: "2026-08-17T11:59:58.000Z",
    },
    {
      username: null,
      difficulty: "easy",
      problems_correct: 15,
      ppm: 30,
      points: null,
      played_at: "2026-08-17T11:55:00.000Z",
    },
  ],
};

test("toFeedRows maps a payload to display rows", () => {
  const rows = toFeedRows(PAYLOAD);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    name: "speedy",
    isGuest: false,
    difficulty: "hard",
    ppm: "24.5",
    points: "8",
    ago: "just now",
  });
});

test("toFeedRows labels an unnamed racer Guest and drops unscored points", () => {
  const rows = toFeedRows(PAYLOAD);
  assert.equal(rows[1].name, "Guest");
  assert.equal(rows[1].isGuest, true);
  assert.equal(rows[1].points, null);
  assert.equal(rows[1].ago, "5m ago");
});

test("toFeedRows ages rows against the server clock, not the device's", () => {
  // Same payload, but the client has held it for 40 seconds: the labels tick up
  // by exactly that much rather than being recomputed from a local Date.now().
  const rows = toFeedRows(PAYLOAD, 40_000);
  assert.equal(rows[0].ago, "42s ago");
  assert.equal(rows[1].ago, "5m ago");
});

test("toFeedRows survives a malformed payload", () => {
  assert.deepEqual(toFeedRows(null), []);
  assert.deepEqual(toFeedRows({}), []);
  assert.deepEqual(toFeedRows({ finishes: "nope" }), []);
  const rows = toFeedRows({ finishes: [{}] });
  assert.equal(rows[0].name, "Guest");
  assert.equal(rows[0].ago, "just now");
});

// --- polling ---------------------------------------------------------------

/** Minimal fake timers: records callbacks so a test can fire them by hand. */
function fakeTimers() {
  const timers = new Map();
  let nextId = 1;
  return {
    timers,
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    /** Fire every timer registered at this interval. */
    fire(ms) {
      for (const t of timers.values()) if (t.ms === ms) t.fn();
    },
  };
}

function harness({ fetchFeed, isActive = () => true, clock = { t: 0 } } = {}) {
  const timers = fakeTimers();
  const painted = [];
  const feed = createRecentFinishesFeed({
    fetchFeed,
    isActive,
    now: () => clock.t,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    render: (rows) => painted.push(rows),
  });
  return { feed, timers, painted, clock };
}

test("init fetches once and then polls on the poll interval", async () => {
  let calls = 0;
  const h = harness({ fetchFeed: async () => { calls++; return PAYLOAD; } });

  await h.feed.init();
  assert.equal(calls, 1);
  assert.equal(h.painted.length, 1);

  h.timers.fire(POLL_INTERVAL_MS);
  await Promise.resolve();
  assert.equal(calls, 2);
});

test("the tick interval re-renders without refetching", async () => {
  let calls = 0;
  const h = harness({ fetchFeed: async () => { calls++; return PAYLOAD; } });
  await h.feed.init();

  h.clock.t += 40_000;
  h.timers.fire(TICK_INTERVAL_MS);

  assert.equal(calls, 1, "a tick must not hit the endpoint");
  assert.equal(h.painted.length, 2);
  assert.equal(h.painted[1][0].ago, "42s ago");
});

test("neither timer does anything while the lobby is off-screen", async () => {
  let calls = 0;
  let active = true;
  const h = harness({
    fetchFeed: async () => { calls++; return PAYLOAD; },
    isActive: () => active,
  });
  await h.feed.init();
  assert.equal(calls, 1);

  active = false;
  h.timers.fire(POLL_INTERVAL_MS);
  h.timers.fire(TICK_INTERVAL_MS);
  await Promise.resolve();
  assert.equal(calls, 1, "no polling while hidden");
  assert.equal(h.painted.length, 1, "no re-render while hidden");

  active = true;
  h.timers.fire(POLL_INTERVAL_MS);
  await Promise.resolve();
  assert.equal(calls, 2);
});

test("a slow response does not let polls stack up", async () => {
  let calls = 0;
  let release;
  const h = harness({
    fetchFeed: () => {
      calls++;
      return new Promise((resolve) => { release = () => resolve(PAYLOAD); });
    },
  });

  const initPromise = h.feed.init();
  assert.equal(calls, 1);
  // Poll again while the first request is still in flight. It must be dropped,
  // not queued behind the slow one.
  await h.feed.refresh();
  assert.equal(calls, 1);

  release();
  await initPromise;
  h.timers.fire(POLL_INTERVAL_MS);
  await Promise.resolve();
  assert.equal(calls, 2);
});

test("a failed poll leaves the last good rows up", async () => {
  let fail = false;
  const h = harness({
    fetchFeed: async () => {
      if (fail) throw new Error("network");
      return PAYLOAD;
    },
  });
  await h.feed.init();
  assert.equal(h.painted.length, 1);

  fail = true;
  const warn = console.warn;
  console.warn = () => {};
  try {
    await h.feed.refresh();
  } finally {
    console.warn = warn;
  }
  // No throw, and nothing repainted — the strip keeps showing what it had.
  assert.equal(h.painted.length, 1);
});

test("stop clears both timers", async () => {
  let calls = 0;
  const h = harness({ fetchFeed: async () => { calls++; return PAYLOAD; } });
  await h.feed.init();
  h.feed.stop();

  h.timers.fire(POLL_INTERVAL_MS);
  h.timers.fire(TICK_INTERVAL_MS);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(h.painted.length, 1);
  assert.equal(h.timers.timers.size, 0);
});

test("the poll cadence stays in the sane band", () => {
  // Guardrail, not a preference: the endpoint is uncached and D1 bills by rows
  // read, so a stray edit dropping this to a second would be a cost bug.
  assert.ok(POLL_INTERVAL_MS >= 15_000 && POLL_INTERVAL_MS <= 30_000);
  assert.ok(TICK_INTERVAL_MS < POLL_INTERVAL_MS);
});

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
  feedSignature,
  renderFeed,
  createRecentFinishesFeed,
  mountRecentFinishes,
  POLL_INTERVAL_MS,
  TICK_INTERVAL_MS,
} from "./recent-finishes.js";

// --- a DOM small enough to run on node --test -------------------------------

/** Just the surface the strip touches: classes, text, children. */
function fakeElement(tag = "div", ownerDocument = null) {
  const classes = new Set();
  const el = {
    tag,
    ownerDocument,
    className: "",
    children: [],
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !classes.has(c) : on;
        if (want) classes.add(c);
        else classes.delete(c);
        return want;
      },
    },
    append(...kids) {
      el.children.push(...kids);
    },
  };
  let text = "";
  Object.defineProperty(el, "textContent", {
    get: () => text,
    // Assigning textContent replaces every child, which is what makes an
    // unconditional redraw an announcement in an aria-live region.
    set: (v) => {
      text = v;
      el.children.length = 0;
    },
  });
  return el;
}

function fakeDocument() {
  const created = [];
  const elements = new Map();
  const listeners = new Map();
  const doc = {
    visibilityState: "visible",
    createElement(tag) {
      const el = fakeElement(tag, doc);
      created.push(el);
      return el;
    },
    getElementById: (id) => elements.get(id) ?? null,
    addEventListener(type, fn) {
      const fns = listeners.get(type) ?? [];
      fns.push(fn);
      listeners.set(type, fns);
    },
    /** Test-only: put an element on the page. */
    addElement(id, tag) {
      const el = fakeElement(tag, doc);
      elements.set(id, el);
      return el;
    },
    /** Test-only: fire a listener registered on the document. */
    dispatch(type) {
      for (const fn of listeners.get(type) ?? []) fn();
    },
    created,
  };
  return doc;
}

/** Drain the microtask queue so a fire-and-forget refresh has finished. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

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

// --- rendering -------------------------------------------------------------

test("an identical redraw leaves the live region alone", () => {
  // #recent-finishes-list is aria-live="polite": removing and re-adding its
  // children is an announcement, and the 5s tick redraws whether or not
  // anything changed. A draw identical to the last one must not rebuild.
  const doc = fakeDocument();
  const list = doc.addElement("recent-finishes-list", "ul");

  assert.equal(renderFeed(list, toFeedRows(PAYLOAD)), true);
  assert.equal(list.children.length, 2);
  const createdAfterFirst = doc.created.length;
  const firstRow = list.children[0];

  assert.equal(renderFeed(list, toFeedRows(PAYLOAD)), false);
  assert.equal(doc.created.length, createdAfterFirst, "no new nodes were built");
  assert.equal(list.children.length, 2);
  assert.equal(list.children[0], firstRow, "the original nodes are still in place");
});

test("a redraw whose labels have ticked over does repaint", () => {
  const doc = fakeDocument();
  const list = doc.addElement("recent-finishes-list", "ul");
  renderFeed(list, toFeedRows(PAYLOAD));
  const createdAfterFirst = doc.created.length;

  // Only the relative label differs — "just now" became "42s ago" — which is
  // exactly the change the strip exists to show.
  assert.equal(renderFeed(list, toFeedRows(PAYLOAD, 40_000)), true);
  assert.ok(doc.created.length > createdAfterFirst);
  assert.equal(list.children[0].children[2].textContent, "42s ago");
});

test("feedSignature covers every field the row puts on screen", () => {
  // A field left out of the signature would be a field whose change the strip
  // silently refuses to paint, so each one is pinned.
  const base = {
    name: "ana", isGuest: false, difficulty: "easy",
    ppm: "20.0", points: "7", ago: "just now",
  };
  const sig = feedSignature([base]);
  assert.equal(feedSignature([{ ...base }]), sig);
  const changes = {
    name: "bob", isGuest: true, difficulty: "hard",
    ppm: "21.0", points: "8", ago: "5s ago",
  };
  for (const [field, value] of Object.entries(changes)) {
    assert.notEqual(
      feedSignature([{ ...base, [field]: value }]),
      sig,
      `${field} must be part of the signature`
    );
  }
  assert.notEqual(feedSignature([base, base]), sig, "row count must matter");
  assert.equal(feedSignature([]), "");
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

function harness({ fetchFeed, isActive = () => true, clock = { t: 0 }, sectionEl } = {}) {
  const timers = fakeTimers();
  const painted = [];
  const feed = createRecentFinishesFeed({
    fetchFeed,
    isActive,
    sectionEl,
    now: () => clock.t,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    render: (rows) => painted.push(rows),
  });
  return { feed, timers, painted, clock };
}

/** Run `fn` with console.warn muted — a failed poll logs one by design. */
async function quietly(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
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
  const sectionEl = fakeElement("section");
  const h = harness({
    sectionEl,
    fetchFeed: async () => {
      if (fail) throw new Error("network");
      return PAYLOAD;
    },
  });
  await h.feed.init();
  assert.equal(h.painted.length, 1);

  fail = true;
  await quietly(() => h.feed.refresh());
  // No throw, and nothing repainted — the strip keeps showing what it had, and
  // a section with rows on it is never hidden out from under them.
  assert.equal(h.painted.length, 1);
  assert.equal(sectionEl.classList.contains("hidden"), false);
});

test("a strip hidden by a failed first poll comes back when one succeeds", async () => {
  // The endpoint can 500 for a whole deploy window (worker/routes/
  // recent-finishes.js), so hiding has to be recoverable: otherwise every later
  // poll paints rows into a section that is display:none for the page session.
  let fail = true;
  const sectionEl = fakeElement("section");
  const h = harness({
    sectionEl,
    fetchFeed: async () => {
      if (fail) throw new Error("network");
      return PAYLOAD;
    },
  });

  await quietly(() => h.feed.init());
  assert.equal(sectionEl.classList.contains("hidden"), true);
  assert.equal(h.painted.length, 0);

  fail = false;
  await h.feed.refresh();
  assert.equal(sectionEl.classList.contains("hidden"), false);
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

// --- browser wiring --------------------------------------------------------

/** A lobby page with the strip's elements on it, plus a stubbed endpoint. */
function mountHarness() {
  const doc = fakeDocument();
  doc.addElement("recent-finishes", "section");
  doc.addElement("recent-finishes-list", "ul");
  doc.addElement("recent-finishes-empty", "p");
  const lobbyEl = doc.addElement("lobby", "div");

  const realFetch = globalThis.fetch;
  const state = { calls: 0 };
  globalThis.fetch = async () => {
    state.calls++;
    return { ok: true, json: async () => PAYLOAD };
  };
  return {
    doc,
    lobbyEl,
    state,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

test("returning to the tab while the lobby is off-screen does not query", async () => {
  // docs/testing.md F4: polling stops while the lobby is off-screen. A tab
  // regaining focus mid-race has nowhere to put the rows, so it must not spend
  // a read on them either; the lobby-shown event covers the way back.
  const h = mountHarness();
  let feed = null;
  try {
    feed = mountRecentFinishes(h.doc);
    await flush();
    const afterMount = h.state.calls;

    h.lobbyEl.classList.add("hidden");
    h.doc.visibilityState = "hidden";
    h.doc.dispatch("visibilitychange");
    h.doc.visibilityState = "visible";
    h.doc.dispatch("visibilitychange");
    await flush();
    assert.equal(h.state.calls, afterMount, "no query while the lobby is away");

    h.lobbyEl.classList.remove("hidden");
    h.doc.dispatch("visibilitychange");
    await flush();
    assert.equal(h.state.calls, afterMount + 1, "back on the lobby, it refreshes");
  } finally {
    feed?.stop();
    h.restore();
  }
});

test("returning to the lobby refreshes and paints the rows", async () => {
  const h = mountHarness();
  let feed = null;
  try {
    feed = mountRecentFinishes(h.doc);
    await flush();
    const afterMount = h.state.calls;

    h.doc.dispatch("lobby-shown");
    await flush();
    assert.equal(h.state.calls, afterMount + 1);
    assert.equal(h.doc.getElementById("recent-finishes-list").children.length, 2);
    assert.equal(
      h.doc.getElementById("recent-finishes-empty").classList.contains("hidden"),
      true
    );
  } finally {
    feed?.stop();
    h.restore();
  }
});

test("the poll cadence stays in the sane band", () => {
  // Guardrail, not a preference: the endpoint is uncached and D1 bills by rows
  // read, so a stray edit dropping this to a second would be a cost bug.
  assert.ok(POLL_INTERVAL_MS >= 15_000 && POLL_INTERVAL_MS <= 30_000);
  assert.ok(TICK_INTERVAL_MS < POLL_INTERVAL_MS);
});

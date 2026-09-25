// Tests for profile.js: the pure helpers, plus the stat tiles as mountProfile
// paints them from /api/me over a DOM stub.

import { test } from "node:test";
import assert from "node:assert/strict";
import { _internals, mountProfile } from "./profile.js";

const {
  fmtMs,
  fmtAvgMs,
  fmtPpm,
  fmtPoints,
  fmtPct,
  fmtRelative,
  fmtDate,
  headlinePpm,
  headlinePoints,
  computeTotalRaces,
  computeOverallAccuracy,
  computeFinishRate,
  findAgg,
  errorText,
  escapeHtml,
  renderRaceRows,
  historyEmptyMessage,
  olderRacesCursor,
} = _internals;

// ---------- fmtMs ----------

test("fmtMs basic", () => {
  assert.equal(fmtMs(48100), "0:48.1");
  assert.equal(fmtMs(null), "—");
  assert.equal(fmtMs(undefined), "—");
});

test("fmtMs pads sub-10-second values", () => {
  // 9.1s -> "0:09.1" (4-char pad on the seconds portion).
  assert.equal(fmtMs(9100), "0:09.1");
});

test("fmtMs handles minutes", () => {
  // 1 minute and 5.5s
  assert.equal(fmtMs(65500), "1:05.5");
  // 2 minutes and 0s
  assert.equal(fmtMs(120000), "2:00.0");
});

// ---------- fmtAvgMs ----------

test("fmtAvgMs renders one decimal seconds", () => {
  assert.equal(fmtAvgMs(1234), "1.2s");
  assert.equal(fmtAvgMs(0), "0.0s");
  assert.equal(fmtAvgMs(null), "—");
});

// ---------- fmtPct ----------

test("fmtPct rounds to integer", () => {
  assert.equal(fmtPct(92.4), "92%");
  assert.equal(fmtPct(92.6), "93%");
  assert.equal(fmtPct(0), "0%");
  assert.equal(fmtPct(null), "—");
});

// ---------- fmtRelative ----------

test("fmtRelative produces stable relative strings", () => {
  const now = Date.now();
  // Less than 30 min back rounds to 0h → "just now".
  assert.equal(fmtRelative(new Date(now - 5 * 60_000).toISOString()), "just now");
  assert.equal(fmtRelative(new Date(now - 5 * 3_600_000).toISOString()), "5h ago");
  assert.equal(fmtRelative(new Date(now - 3 * 86_400_000).toISOString()), "3d ago");
  assert.equal(fmtRelative(null), "—");
  assert.equal(fmtRelative("not-a-date"), "—");
});

// ---------- fmtDate ----------

test("fmtDate handles bad input", () => {
  assert.equal(fmtDate(null), "—");
  assert.equal(fmtDate("not-a-date"), "—");
  // Just check non-empty for a valid date — output is locale-dependent.
  const v = fmtDate("2025-06-15T00:00:00Z");
  assert.ok(v && v !== "—", `expected formatted date, got ${v}`);
});

// ---------- fmtPpm / fmtPoints ----------

test("fmtPpm shows one decimal", () => {
  assert.equal(fmtPpm(34.06), "34.1");
  assert.equal(fmtPpm(0), "0.0");
  assert.equal(fmtPpm(null), "—");
  assert.equal(fmtPpm(undefined), "—");
  assert.equal(fmtPpm(Infinity), "—");
});

test("fmtPoints shows one decimal", () => {
  // Points are stored unrounded so sums stay exact; only the display rounds.
  // A single race is worth a few points, so whole numbers would collapse the
  // column and stop the rows adding up to the tier total shown above them.
  assert.equal(
    fmtPoints(6.6667),
    (6.6667).toLocaleString(undefined, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }),
  );
  assert.equal(
    fmtPoints(0),
    (0).toLocaleString(undefined, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }),
  );
  // A DNF earned nothing and is not a zero score.
  assert.equal(fmtPoints(null), "—");
  assert.equal(fmtPoints(Infinity), "—");
});

// ---------- headlinePpm / headlinePoints ----------

const AGGS = [
  { difficulty: "easy", races_played: 4, races_finished: 4, avg_ppm: 34.2, total_points: 120.4 },
  { difficulty: "medium", races_played: 2, races_finished: 1, avg_ppm: 22.5, total_points: 40 },
  { difficulty: "hard", races_played: 0, races_finished: 0, avg_ppm: null, total_points: 0 },
];

test("headlinePpm reads one tier and never blends tiers", () => {
  assert.equal(headlinePpm(AGGS, "easy"), 34.2);
  assert.equal(headlinePpm(AGGS, "medium"), 22.5);
  // An untouched tier has no speed to show — not 0, which would read as slow.
  assert.equal(headlinePpm(AGGS, "hard"), null);
});

test("headlinePpm is null for missing or malformed aggregates", () => {
  assert.equal(headlinePpm([], "easy"), null);
  assert.equal(headlinePpm(null, "easy"), null);
  assert.equal(headlinePpm([{ difficulty: "easy" }], "easy"), null);
  assert.equal(headlinePpm([{ difficulty: "easy", avg_ppm: "20" }], "easy"), null);
});

test("headlinePoints reports the tier's own pool, 0 included", () => {
  assert.equal(headlinePoints(AGGS, "easy"), 120.4);
  assert.equal(headlinePoints(AGGS, "medium"), 40);
  // Never raced -> null, so it renders as "—" rather than a real 0 standing.
  assert.equal(headlinePoints(AGGS, "hard"), null);
  // Raced but earned nothing -> a genuine 0.
  assert.equal(
    headlinePoints([{ difficulty: "easy", races_played: 1, total_points: 0 }], "easy"),
    0,
  );
});

test("headlinePoints is null for missing aggregates", () => {
  assert.equal(headlinePoints([], "easy"), null);
  assert.equal(headlinePoints(null, "easy"), null);
});

// ---------- computeTotalRaces ----------

test("computeTotalRaces sums races_played", () => {
  const aggs = [
    { races_played: 4 },
    { races_played: 1 },
    { races_played: 7 },
  ];
  assert.equal(computeTotalRaces(aggs), 12);
  assert.equal(computeTotalRaces([]), 0);
  assert.equal(computeTotalRaces(null), 0);
});

// ---------- computeOverallAccuracy ----------

test("computeOverallAccuracy weights by races_played", () => {
  const aggs = [
    { races_played: 3, avg_accuracy: 90 },
    { races_played: 1, avg_accuracy: 50 },
  ];
  // (3*90 + 1*50) / 4 = 80
  assert.equal(computeOverallAccuracy(aggs), 80);
});

test("computeOverallAccuracy is null with no races", () => {
  assert.equal(
    computeOverallAccuracy([{ races_played: 0, avg_accuracy: 99 }]),
    null,
  );
});

// ---------- computeFinishRate ----------

test("computeFinishRate is multiplayer finished/played * 100, solo left out", () => {
  const aggs = [
    { races_played: 9, races_finished: 8, room_races_played: 4, room_races_finished: 3 },
    { races_played: 6, races_finished: 6, room_races_played: 6, room_races_finished: 6 },
  ];
  // 9/10 * 100 = 90, not the 14/15 the solo finishes would make it.
  assert.equal(computeFinishRate(aggs), 90);
});

test("computeFinishRate is null with no multiplayer races, however many solo", () => {
  assert.equal(
    computeFinishRate([{ races_played: 5, races_finished: 5, room_races_played: 0, room_races_finished: 0 }]),
    null,
  );
});

// ---------- findAgg ----------

test("findAgg finds entries by difficulty", () => {
  const aggs = [
    { difficulty: "easy", best_time_ms: 1000 },
    { difficulty: "medium", best_time_ms: 2000 },
    { difficulty: "hard", best_time_ms: 3000 },
  ];
  assert.equal(findAgg(aggs, "easy").best_time_ms, 1000);
  assert.equal(findAgg(aggs, "medium").best_time_ms, 2000);
  assert.equal(findAgg(aggs, "hard").best_time_ms, 3000);
  assert.equal(findAgg(aggs, "missing"), null);
  assert.equal(findAgg(null, "easy"), null);
});

// ---------- errorText ----------

test("errorText maps known codes", () => {
  assert.match(errorText("taken"), /taken/i);
  assert.match(errorText("banned"), /allowed/i);
  assert.match(errorText("reserved"), /reserved/i);
  assert.match(errorText("invalid_format"), /letters/i);
  // Unknown / undefined → generic.
  assert.match(errorText("nonsense"), /wrong/i);
  assert.match(errorText(undefined), /wrong/i);
});

// ---------- escapeHtml ----------

test("escapeHtml escapes the usual suspects", () => {
  assert.equal(escapeHtml(`<a href="x">&'</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
});

// ---------- race history ----------

const RACE = {
  race_seq: 7,
  difficulty: "medium",
  finish_time_ms: 48100,
  accuracy_pct: 92.4,
  avg_time_per_problem_ms: 2400,
  points: 5.25,
  ppm: 24.94,
  played_at: new Date().toISOString(),
};

test("renderRaceRows renders one row per race with the formatted cells", () => {
  const html = renderRaceRows([RACE]);
  assert.equal((html.match(/<tr>/g) || []).length, 1);
  assert.match(html, /<td>#7<\/td>/);
  assert.match(html, /<td>Medium<\/td>/);
  assert.match(html, /<td>0:48\.1<\/td>/);
  assert.match(html, /<td>24\.9<\/td>/);
  assert.match(html, /<td>5\.3<\/td>/);
  assert.match(html, /<td>92%<\/td>/);
  assert.match(html, /<td>2\.4s<\/td>/);
  assert.match(html, /<td>just now<\/td>/);
});

test("renderRaceRows shows DNF and dashes for a quit race", () => {
  const html = renderRaceRows([
    { ...RACE, finish_time_ms: null, points: null, ppm: null },
  ]);
  assert.match(html, /<td>DNF<\/td>/);
  // PPM and points columns both fall back to the em dash.
  assert.equal((html.match(/<td>—<\/td>/g) || []).length, 2);
});

test("renderRaceRows is empty for no rows and escapes what it interpolates", () => {
  assert.equal(renderRaceRows([]), "");
  assert.equal(renderRaceRows(undefined), "");
  const html = renderRaceRows([{ ...RACE, difficulty: "<b>x" }]);
  assert.ok(!html.includes("<b>"));
  assert.match(html, /&lt;b&gt;x/);
});

test("historyEmptyMessage names the filtered tier, or the generic line for all", () => {
  assert.equal(historyEmptyMessage(null), "Race a few times and your stats will show up here.");
  assert.equal(historyEmptyMessage("hard"), "No hard races yet.");
});

test("olderRacesCursor is the oldest race_seq on the page, or null at race #1", () => {
  // /api/me's `recent` is the newest ten of a dense 1-based counter: a page
  // whose oldest row is #1 has nothing older, any other page does.
  assert.equal(olderRacesCursor([]), null);
  assert.equal(olderRacesCursor(undefined), null);
  const seqs = (list) => list.map((race_seq) => ({ race_seq }));
  assert.equal(olderRacesCursor(seqs([5, 4, 3, 2, 1])), null);
  assert.equal(olderRacesCursor(seqs([12, 11, 10, 9, 8, 7, 6, 5, 4, 3])), 3);
  // Defensive: it finds the minimum rather than trusting the ordering.
  assert.equal(olderRacesCursor(seqs([3, 9, 4])), 3);
  assert.equal(olderRacesCursor([{ race_seq: "nope" }]), null);
});

// ---------- mountProfile: the stat tiles ----------

// Just enough DOM for mountProfile: every selector resolves to one element the
// test can read back, and the host keeps the markup it was given.
function fakeEl() {
  const classes = new Set();
  const found = new Map();
  return {
    textContent: "",
    innerHTML: "",
    hidden: false,
    dataset: {},
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
    },
    addEventListener: () => {},
    setAttribute: () => {},
    querySelector(sel) {
      if (!found.has(sel)) found.set(sel, fakeEl());
      return found.get(sel);
    },
    querySelectorAll: () => [],
  };
}

async function openProfile(me) {
  const listeners = new Map();
  globalThis.document = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    dispatchEvent: () => true,
    getElementById: () => null,
  };
  globalThis.fetch = async (url) => {
    assert.equal(url, "/api/me");
    return { ok: true, status: 200, json: async () => me };
  };
  const host = fakeEl();
  mountProfile(host);
  listeners.get("open-profile")();
  // getMe's fetch and json, then render.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  return host;
}

const ME = {
  username: "Alice",
  email: "a@example.com",
  created_at: "2026-01-02T00:00:00.000Z",
  recent: [],
};

test("the finish-rate tile counts multiplayer races only, and says so", async () => {
  const host = await openProfile({
    ...ME,
    aggregates: [
      { difficulty: "easy", races_played: 6, races_finished: 5, room_races_played: 2, room_races_finished: 1, avg_accuracy: 90 },
      { difficulty: "medium", races_played: 2, races_finished: 2, room_races_played: 2, room_races_finished: 2, avg_accuracy: 80 },
      { difficulty: "hard", races_played: 0, races_finished: 0, room_races_played: 0, room_races_finished: 0, avg_accuracy: 0 },
    ],
  });
  // 3 of 4 multiplayer races, where every race would have made it 7 of 8.
  assert.equal(host.querySelector("#t-finish").textContent, "75%");
  // The tiles beside it still count every stored race.
  assert.equal(host.querySelector("#t-total").textContent, "8");
  // The label is part of the markup mountProfile renders into the host.
  const label = host.innerHTML.match(/id="t-finish">[^<]*<\/div><div class="profile__tile-lbl">([^<]*)</)?.[1];
  assert.equal(label, "Multiplayer Finish Rate");
});

test("the finish-rate tile is a dash for a racer who has only raced solo", async () => {
  const host = await openProfile({
    ...ME,
    aggregates: [
      { difficulty: "easy", races_played: 3, races_finished: 3, room_races_played: 0, room_races_finished: 0, avg_accuracy: 100 },
    ],
  });
  assert.equal(host.querySelector("#t-finish").textContent, "—");
  assert.equal(host.querySelector("#t-total").textContent, "3");
});

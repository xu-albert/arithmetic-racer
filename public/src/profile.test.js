// Pure-helper tests for profile.js. DOM/event tests are skipped — those
// belong in an integration suite once the integrator wires things together.

import { test } from "node:test";
import assert from "node:assert/strict";
import { _internals } from "./profile.js";

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

test("fmtPoints rounds for display", () => {
  // Points are stored unrounded so sums stay exact; only the display rounds.
  assert.equal(fmtPoints(6.6667), "7");
  assert.equal(fmtPoints(0), "0");
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

test("computeFinishRate is finished/played * 100", () => {
  const aggs = [
    { races_played: 4, races_finished: 3 },
    { races_played: 6, races_finished: 6 },
  ];
  // 9/10 * 100 = 90
  assert.equal(computeFinishRate(aggs), 90);
});

test("computeFinishRate is null with no races", () => {
  assert.equal(computeFinishRate([{ races_played: 0, races_finished: 0 }]), null);
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

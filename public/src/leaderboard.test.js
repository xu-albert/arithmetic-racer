// Pure-helper tests for leaderboard.js. DOM/event wiring is not covered here,
// matching profile.test.js — the row-rendering helper is pure by design so the
// escaping and the empty cases can be tested without a browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { _internals } from "./leaderboard.js";

const {
  DIFFICULTIES,
  PERIODS,
  boardKey,
  titleCase,
  windowCaption,
  emptyMessage,
  rankLabel,
  renderRows,
  escapeHtml,
} = _internals;

// ---------- tab definitions ----------

test("difficulty tabs are exactly the three siloed tiers, in lobby order", () => {
  assert.deepEqual(DIFFICULTIES, ["easy", "medium", "hard"]);
});

test("period tabs cover all-time plus the four calendar windows", () => {
  assert.deepEqual(
    PERIODS.map((p) => p.id),
    ["all", "day", "week", "month", "year"]
  );
  // Every tab needs a label; an unlabeled tab is an invisible tab.
  for (const p of PERIODS) assert.ok(p.label && p.label.length > 0);
});

test("boardKey separates every difficulty/period pair", () => {
  const keys = new Set();
  for (const d of DIFFICULTIES) {
    for (const p of PERIODS) keys.add(boardKey(d, p.id));
  }
  assert.equal(keys.size, DIFFICULTIES.length * PERIODS.length);
  assert.equal(boardKey("easy", "day"), "easy:day");
});

// ---------- titleCase ----------

test("titleCase capitalizes a difficulty name", () => {
  assert.equal(titleCase("easy"), "Easy");
  assert.equal(titleCase("hard"), "Hard");
  assert.equal(titleCase(""), "");
  assert.equal(titleCase(undefined), "");
});

// ---------- windowCaption ----------

test("windowCaption describes the all-time board without a date", () => {
  assert.equal(windowCaption("all", null), "Every race, since the beginning.");
  // Even if the server sent one, all-time has no start worth printing.
  assert.equal(windowCaption("all", "2026-08-17T00:00:00.000Z"), "Every race, since the beginning.");
});

test("windowCaption renders the boundary in UTC, not the viewer's timezone", () => {
  const caption = windowCaption("day", "2026-08-17T00:00:00.000Z");
  // The whole point of the caption is naming the reset moment; a local-time
  // render would show 17:00 on the 16th for a US Pacific viewer.
  assert.match(caption, /^Since /);
  assert.match(caption, /UTC\.$/);
  assert.match(caption, /2026/);
  assert.match(caption, /00:00/);
  assert.ok(!caption.includes("16"), `expected the 17th, got: ${caption}`);
});

test("windowCaption stays quiet when the server sent no boundary", () => {
  assert.equal(windowCaption("week", null), "");
  assert.equal(windowCaption("week", undefined), "");
  assert.equal(windowCaption("week", "not-a-date"), "");
});

// ---------- emptyMessage ----------

test("emptyMessage words the all-time empty state differently from a window", () => {
  const all = emptyMessage("all");
  const day = emptyMessage("day");
  assert.notEqual(all, day);
  // The all-time board being empty means nobody has ever qualified, so it is
  // the one that should explain how to qualify.
  assert.match(all, /multiplayer/i);
  assert.match(day, /window/i);
  // Finishing is what qualifies — there is no placement predicate anywhere in
  // boardSql, so the one line that tells a new racer how to get on the board
  // must not ask them to win one.
  assert.doesNotMatch(all, /\bwins?\b/i);
});

// ---------- rankLabel ----------

test("rankLabel medals the podium and numbers the rest", () => {
  assert.equal(rankLabel(1), "🥇");
  assert.equal(rankLabel(2), "🥈");
  assert.equal(rankLabel(3), "🥉");
  assert.equal(rankLabel(4), "4");
  assert.equal(rankLabel(10), "10");
});

// ---------- renderRows ----------

const ENTRY = {
  rank: 1,
  username: "ada",
  ppm: 34.06,
  points: 11.353,
  played_at: new Date(Date.now() - 5 * 3_600_000).toISOString(),
};

test("renderRows returns empty markup for an empty or missing board", () => {
  assert.equal(renderRows([]), "");
  assert.equal(renderRows(null), "");
  assert.equal(renderRows(undefined), "");
});

test("renderRows formats PPM, points, and time the way the profile does", () => {
  const html = renderRows([ENTRY]);
  assert.match(html, />34\.1</);
  assert.match(html, />11\.4</);
  assert.match(html, />5h ago</);
  assert.match(html, />ada</);
});

test("renderRows shows an em dash for a race with no points recorded", () => {
  const html = renderRows([{ ...ENTRY, points: null }]);
  assert.match(html, />—</);
  // ...and still shows the speed that earned the rank.
  assert.match(html, />34\.1</);
});

test("renderRows marks the podium rows so CSS can lift them", () => {
  const rows = renderRows([
    { ...ENTRY, rank: 1 },
    { ...ENTRY, rank: 3 },
    { ...ENTRY, rank: 4 },
  ]);
  assert.equal(rows.match(/leaderboard__row--top/g)?.length, 2);
});

test("renderRows emits one row per entry", () => {
  const rows = renderRows([ENTRY, { ...ENTRY, rank: 2 }, { ...ENTRY, rank: 3 }]);
  assert.equal(rows.match(/<tr/g).length, 3);
});

test("renderRows escapes the username — it is user-supplied text off the wire", () => {
  const html = renderRows([{ ...ENTRY, username: '<img src=x onerror="alert(1)">' }]);
  assert.ok(!html.includes("<img"), "raw markup reached the row");
  assert.ok(!html.includes('onerror="'), "raw attribute reached the row");
  assert.match(html, /&lt;img/);
});

test("renderRows survives a malformed entry instead of throwing", () => {
  const html = renderRows([{}]);
  assert.match(html, /<tr/);
  // Missing name and missing numbers both degrade to an em dash.
  assert.match(html, />—</);
});

// ---------- escapeHtml ----------

test("escapeHtml covers every character that can break out of a cell", () => {
  assert.equal(escapeHtml(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
  assert.equal(escapeHtml("plain"), "plain");
});

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
  boardLabel,
  boardSummary,
  isStaleBoard,
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
  const all = emptyMessage("hard", "all");
  const day = emptyMessage("hard", "day");
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

test("emptyMessage names the board, so two empty boards never read alike", () => {
  // The status region is aria-live and is commonly silent when assigned text
  // it already holds. Fourteen of the fifteen boards can be empty at once on a
  // quiet day, so a shared sentence would make those tab switches announce
  // nothing at all — the gap boardSummary was added to close, reappearing on
  // exactly the boards with no rows to fall back on.
  const seen = new Set();
  for (const d of DIFFICULTIES) {
    for (const p of PERIODS) seen.add(emptyMessage(d, p.id));
  }
  assert.equal(seen.size, DIFFICULTIES.length * PERIODS.length);
  assert.notEqual(emptyMessage("easy", "all"), emptyMessage("medium", "all"));
  assert.notEqual(emptyMessage("easy", "day"), emptyMessage("easy", "week"));
});

test("boardLabel is the one name both announcements open with", () => {
  assert.equal(boardLabel("hard", "all"), "Hard, All-time");
  assert.equal(boardLabel("medium", "week"), "Medium, This week");
  for (const d of DIFFICULTIES) {
    for (const p of PERIODS) {
      const label = boardLabel(d, p.id);
      assert.ok(emptyMessage(d, p.id).startsWith(label), `${d}/${p.id} empty state`);
      assert.ok(boardSummary(d, p.id, 3).startsWith(label), `${d}/${p.id} summary`);
    }
  }
});

// ---------- boardSummary ----------

test("boardSummary names the board a screen reader is about to be given", () => {
  // The status region is aria-live, so this string is the whole announcement
  // for a board switch. It has to say which board, in the words on the tabs.
  const summary = boardSummary("hard", "all", 8);
  assert.equal(summary, "Hard, All-time — 8 racers");
});

test("boardSummary uses the period's own label, not its id", () => {
  const labels = PERIODS.map((p) => boardSummary("easy", p.id, 3));
  for (const [i, line] of labels.entries()) {
    assert.ok(
      line.includes(PERIODS[i].label),
      `${line} should carry ${PERIODS[i].label}`
    );
    assert.ok(line.startsWith("Easy, "), line);
  }
  // "week" is the id; "This week" is what the tab says and what is spoken.
  assert.equal(boardSummary("medium", "week", 3), "Medium, This week — 3 racers");
});

test("boardSummary counts one racer without saying '1 racers'", () => {
  assert.match(boardSummary("easy", "day", 1), /\b1 racer\b/);
  assert.doesNotMatch(boardSummary("easy", "day", 1), /racers/);
  assert.match(boardSummary("easy", "day", 2), /\b2 racers\b/);
});

// ---------- isStaleBoard ----------

// Fixed UTC instants, not "now" — a cache-invalidation rule about where the
// day begins must not be tested against a clock that moves under it.
const DAY_START = Date.UTC(2026, 7, 17); // Monday
const NEXT_DAY_START = Date.UTC(2026, 7, 18);

/** A board response the way the route sends one. */
function boardAt(period, periodStartMs_) {
  return {
    difficulty: "medium",
    period,
    period_start: periodStartMs_ === null ? null : new Date(periodStartMs_).toISOString(),
    entries: [],
  };
}

test("isStaleBoard keeps a board whose window is still open", () => {
  const today = boardAt("day", DAY_START);
  assert.equal(isStaleBoard(today, DAY_START), false);
  assert.equal(isStaleBoard(today, DAY_START + 12 * 3_600_000), false);
  // Still inside the day at the last millisecond of it.
  assert.equal(isStaleBoard(today, NEXT_DAY_START - 1), false);
});

test("isStaleBoard drops a bounded board once its window has rolled", () => {
  // The reported sequence: open the lobby at 23:50 UTC on Today, come back at
  // 00:30 the next day. Without this the Map repaints yesterday's racers under
  // a highlighted Today tab, with no request and no way to force one.
  const yesterday = boardAt("day", DAY_START);
  assert.equal(isStaleBoard(yesterday, NEXT_DAY_START), true);
  assert.equal(isStaleBoard(yesterday, NEXT_DAY_START + 30 * 60_000), true);

  // Every bounded window, not just the day.
  const lastWeek = boardAt("week", Date.UTC(2026, 7, 10));
  assert.equal(isStaleBoard(lastWeek, DAY_START), true);
  const lastMonth = boardAt("month", Date.UTC(2026, 6, 1));
  assert.equal(isStaleBoard(lastMonth, DAY_START), true);
  const lastYear = boardAt("year", Date.UTC(2025, 0, 1));
  assert.equal(isStaleBoard(lastYear, DAY_START), true);
});

test("isStaleBoard never invalidates the all-time board", () => {
  // All-time has no window to roll: period_start is null by design, and
  // expiring it would turn every tab flip back into a request.
  const all = boardAt("all", null);
  assert.equal(isStaleBoard(all, DAY_START), false);
  assert.equal(isStaleBoard(all, DAY_START + 400 * 86_400_000), false);
});

test("isStaleBoard refetches rather than trusting a board it cannot place", () => {
  assert.equal(isStaleBoard(boardAt("day", null), DAY_START), false);
  assert.equal(isStaleBoard({ ...boardAt("day", DAY_START), period_start: "nope" }, DAY_START), true);
  // An unknown period cannot be handed to periodStartMs, which throws on one.
  assert.equal(isStaleBoard(boardAt("decade", DAY_START), DAY_START), false);
  assert.equal(isStaleBoard(undefined, DAY_START), false);
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

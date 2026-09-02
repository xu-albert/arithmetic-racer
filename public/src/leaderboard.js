// Lobby leaderboards.
//
// Mounts into a `<section class="leaderboard">` host inside #lobby. Two rows of
// tabs — difficulty and period — select one board; the board itself is a table
// of the fastest single races in that window.
//
// There are three difficulty tabs rather than one blended board because the
// three tiers are separate pools that are never compared — the same rule the
// profile screen follows and the API enforces (worker/routes/leaderboard.js).
// Switching difficulty is therefore switching *boards*, not filtering one.
//
// Pure helpers are exported via `_internals` for unit testing — see
// leaderboard.test.js.

import { getLeaderboard } from "./stats-api.js";
import { fmtPpm, fmtPoints, fmtRelative, escapeHtml } from "./race-format.js";
import { periodStartMs } from "./leaderboard-period.js";

// ---------- pure helpers ----------

/** Difficulty tabs, in the order the lobby's other pickers use. */
const DIFFICULTIES = ["easy", "medium", "hard"];

/**
 * Period tabs. `all` leads because it is the board that always has rows —
 * a day board is empty most mornings, and an empty default reads as broken.
 */
const PERIODS = [
  { id: "all", label: "All-time" },
  { id: "day", label: "Today" },
  { id: "week", label: "This week" },
  { id: "month", label: "This month" },
  { id: "year", label: "This year" },
];

/** Cache/identity key for one board. */
function boardKey(difficulty, period) {
  return `${difficulty}:${period}`;
}

/** "easy" → "Easy". */
function titleCase(s) {
  if (!s) return "";
  return s[0].toUpperCase() + s.slice(1);
}

/**
 * The line under the tabs. It names the window in UTC, because that is the
 * boundary the server actually used — a racer whose "today" ended two hours
 * ago deserves to be told which midnight the board resets on rather than left
 * to guess from an empty table.
 */
function windowCaption(period, periodStartIso) {
  if (period === "all") return "Every race, since the beginning.";
  if (!periodStartIso) return "";
  const d = new Date(periodStartIso);
  if (Number.isNaN(d.getTime())) return "";
  const when = d.toLocaleString(undefined, {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `Since ${when} UTC.`;
}

/**
 * Which board this is, in the words on its two tabs: "Hard, All-time".
 *
 * Every line the status region announces opens with this. An aria-live region
 * assigned text it already holds is commonly not re-announced, so two boards
 * that would otherwise share a sentence — the fourteen that can come up empty,
 * most of all — have to differ somewhere, and the board's own name is the
 * honest place for them to differ.
 */
function boardLabel(difficulty, period) {
  const label = PERIODS.find((p) => p.id === period)?.label ?? titleCase(period);
  return `${titleCase(difficulty)}, ${label}`;
}

/** Empty-state copy, worded for the window that came up empty. */
function emptyMessage(difficulty, period) {
  const who = boardLabel(difficulty, period);
  if (period === "all") {
    return `${who} — no qualifying races yet. Finish a standard multiplayer race while signed in and you'll be first.`;
  }
  return `${who} — nobody has posted a qualifying race in this window yet.`;
}

/**
 * The one-line board summary that goes in the aria-live status region.
 *
 * That region is the only thing spoken when the board changes, so it must not
 * be left empty on a successful load: a racer using a screen reader presses
 * "Hard", hears nothing, and has to walk into the table to find out whether
 * anything happened. One short line, because it is announced rather than read.
 */
function boardSummary(difficulty, period, count) {
  const racers = count === 1 ? "1 racer" : `${count} racers`;
  return `${boardLabel(difficulty, period)} — ${racers}`;
}

/**
 * Has this cached board's window closed since it was fetched?
 *
 * A lobby tab stays open for hours, so a board fetched at 23:50 UTC is still
 * in the Map at 00:30 and would repaint yesterday's racers under a highlighted
 * "Today" — from a feature whose whole subject is where the UTC day begins.
 * The bound is the window, deliberately not a timer: a rolled window is the
 * only staleness that misstates what the tab claims, and re-fetching on the
 * clock instead would break the arithmetic sizing LEADERBOARD_IP_LIMIT, which
 * assumes a full fifteen-tab exploration costs fifteen requests.
 *
 * A board with no `period_start` has no window to roll — that is the all-time
 * board's own shape — so it is never stale here. One that carries a start we
 * cannot read is: refetching costs a request, and painting a window we cannot
 * identify under a tab that names one is the thing being ruled out.
 */
function isStaleBoard(board, nowMs) {
  const period = board?.period;
  if (period === "all" || board?.period_start == null || !PERIODS.some((p) => p.id === period)) {
    return false;
  }
  return Date.parse(board.period_start) !== periodStartMs(period, nowMs);
}

/** Medal for the top three; plain rank number after that. */
function rankLabel(rank) {
  if (rank === 1) return "🥇";
  if (rank === 2) return "🥈";
  if (rank === 3) return "🥉";
  return String(rank);
}

/**
 * Render the table body for one board response.
 *
 * Takes the parsed response rather than the fetch so it can be tested without
 * a DOM or a network — the escaping in here is the part that must not rot,
 * since `username` is user-supplied text arriving over the wire.
 */
function renderRows(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return "";
  return entries
    .map((e) => {
      const rank = Number(e?.rank);
      const cls = rank <= 3 ? ` class="leaderboard__row--top"` : "";
      return `<tr${cls}>
        <td class="leaderboard__rank">${escapeHtml(rankLabel(rank))}</td>
        <td class="leaderboard__racer">${escapeHtml(e?.username ?? "—")}</td>
        <td class="leaderboard__ppm">${escapeHtml(fmtPpm(e?.ppm))}</td>
        <td>${escapeHtml(fmtPoints(e?.points))}</td>
        <td>${escapeHtml(fmtRelative(e?.played_at))}</td>
      </tr>`;
    })
    .join("");
}

// ---------- DOM template ----------

// The two tab rows are toggle-button groups, not a tab widget: nothing here
// owns a tabpanel or manages a roving tabindex, and role="tab" would replace
// the native button role with a promise the markup does not keep. aria-pressed
// is the same state attribute the lobby's difficulty picker uses two cards up,
// so the two pickers on this screen announce alike — see the specificity note
// in css/leaderboard.css, which that shared attribute drags in.
const LEADERBOARD_HTML = `
  <h3>Leaderboards</h3>
  <p class="leaderboard__blurb">
    Fastest single race, by problems per minute. Standard 10-problem
    multiplayer races only — Solo vs Bots is practice, and a private room set
    to a different length won't show up here either. Sign in to appear.
  </p>

  <div class="leaderboard__tabs" role="group" aria-label="Leaderboard difficulty" data-tabs="difficulty">
    ${DIFFICULTIES.map(
      (d) =>
        `<button type="button" class="leaderboard__tab" data-difficulty="${d}" aria-pressed="false">${titleCase(
          d
        )}</button>`
    ).join("")}
  </div>

  <div class="leaderboard__tabs leaderboard__tabs--period" role="group" aria-label="Leaderboard period" data-tabs="period">
    ${PERIODS.map(
      (p) =>
        `<button type="button" class="leaderboard__tab" data-period="${p.id}" aria-pressed="false">${p.label}</button>`
    ).join("")}
  </div>

  <p class="leaderboard__window" id="leaderboard-window"></p>

  <div class="leaderboard__table-wrap">
    <table class="leaderboard__table">
      <thead>
        <tr><th>#</th><th>Racer</th><th>PPM</th><th>Points</th><th>When</th></tr>
      </thead>
      <tbody id="leaderboard-tbody"></tbody>
    </table>
  </div>

  <p class="leaderboard__status" id="leaderboard-status" aria-live="polite"></p>
`;

// ---------- mount ----------

const MOUNT_FLAG = "__leaderboardMounted";

/**
 * Mount the lobby leaderboard into the host element. Idempotent.
 *
 * @param {HTMLElement} host
 * @param {{difficulty?: string, period?: string}} [initial]
 */
export function mountLeaderboard(host, initial = {}) {
  if (!host) return;
  if (host[MOUNT_FLAG]) return;
  host[MOUNT_FLAG] = true;

  host.innerHTML = LEADERBOARD_HTML;
  const $ = (sel) => host.querySelector(sel);
  const tbody = $("#leaderboard-tbody");
  const statusEl = $("#leaderboard-status");
  const windowEl = $("#leaderboard-window");

  let difficulty = DIFFICULTIES.includes(initial.difficulty) ? initial.difficulty : "medium";
  let period = PERIODS.some((p) => p.id === initial.period) ? initial.period : "all";

  // One board per (difficulty, period). Cached because the tabs are cheap to
  // flip and a board does not change between two clicks; `loaded` also lets a
  // second mount-time refresh skip work the first one already did.
  const cache = new Map();
  // Counts *selections*, not requests. Every load takes a ticket before it
  // looks at the cache, so a board served instantly from cache still retires
  // the ticket of a slower board still in flight — otherwise a cached Easy
  // painted between a Hard request and its response leaves Hard's ticket
  // current, and Hard's rows land under the Easy tab.
  let currentSelection = 0;

  function syncTabs() {
    for (const btn of host.querySelectorAll("[data-difficulty]")) {
      btn.setAttribute("aria-pressed", btn.dataset.difficulty === difficulty ? "true" : "false");
    }
    for (const btn of host.querySelectorAll("[data-period]")) {
      btn.setAttribute("aria-pressed", btn.dataset.period === period ? "true" : "false");
    }
  }

  function paint(board) {
    windowEl.textContent = windowCaption(board.period, board.period_start);
    const entries = Array.isArray(board.entries) ? board.entries : [];
    const rows = renderRows(entries);
    tbody.innerHTML = rows;
    statusEl.textContent =
      rows === ""
        ? emptyMessage(board.difficulty, board.period)
        : boardSummary(board.difficulty, board.period, entries.length);
  }

  async function load() {
    syncTabs();
    const ticket = ++currentSelection;
    const key = boardKey(difficulty, period);
    const cached = cache.get(key);
    if (cached && !isStaleBoard(cached, Date.now())) {
      paint(cached);
      return;
    }

    // Blank the table before going to the network, and only here — the
    // cache-hit path above repaints instantly and must not flash empty. The
    // tab is already highlighted by syncTabs(), so leaving the previous
    // board's rows and its "Since … UTC" caption up would put one tier's rows
    // under another tier's tab for the length of the request. The silo is an
    // absolute claim in this module's header and the route's; a slower empty
    // table is the honest version of "we don't know yet".
    tbody.innerHTML = "";
    windowEl.textContent = "";
    statusEl.textContent = "Loading…";
    try {
      const board = await getLeaderboard({ difficulty, period });
      cache.set(key, board);
      if (ticket !== currentSelection) return;
      paint(board);
    } catch (err) {
      if (ticket !== currentSelection) return;
      // Best-effort, like every other read on this screen: the lobby stays
      // usable and the racer is told the board specifically is missing.
      console.warn("[leaderboard] load failed", err);
      tbody.innerHTML = "";
      windowEl.textContent = "";
      statusEl.textContent = "Couldn't load the leaderboard. Try again in a moment.";
    }
  }

  host.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const tab = t.closest("[data-difficulty], [data-period]");
    if (!tab || !host.contains(tab)) return;
    e.preventDefault();
    if (tab.dataset.difficulty) difficulty = tab.dataset.difficulty;
    else if (tab.dataset.period) period = tab.dataset.period;
    load();
  });

  syncTabs();
  load();

  // No `race-finished` listener on purpose: the race that just finished in
  // this tab was Solo vs Bots (a room race navigates away from the lobby), and
  // solo races never enter a board — refreshing on it would be a request that
  // cannot change the answer. `refresh()` is for the caller that knows the
  // lobby is being *re-shown* after a while, where staleness is real.
  return {
    refresh: () => {
      cache.clear();
      return load();
    },
  };
}

// ---------- test exports ----------

export const _internals = {
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
};

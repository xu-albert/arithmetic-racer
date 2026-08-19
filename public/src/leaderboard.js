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

/** Empty-state copy, worded for the window that came up empty. */
function emptyMessage(period) {
  if (period === "all") {
    return "No qualifying races yet. Finish a standard multiplayer race while signed in and you'll be first.";
  }
  return "Nobody has posted a qualifying race in this window yet.";
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

const LEADERBOARD_HTML = `
  <h3>Leaderboards</h3>
  <p class="leaderboard__blurb">
    Fastest single race, by problems per minute. Standard 10-problem
    multiplayer races only — Solo vs Bots is practice, and a private room set
    to a different length won't show up here either. Sign in to appear.
  </p>

  <div class="leaderboard__tabs" role="tablist" aria-label="Leaderboard difficulty" data-tabs="difficulty">
    ${DIFFICULTIES.map(
      (d) =>
        `<button type="button" role="tab" class="leaderboard__tab" data-difficulty="${d}" aria-selected="false">${titleCase(
          d
        )}</button>`
    ).join("")}
  </div>

  <div class="leaderboard__tabs leaderboard__tabs--period" role="tablist" aria-label="Leaderboard period" data-tabs="period">
    ${PERIODS.map(
      (p) =>
        `<button type="button" role="tab" class="leaderboard__tab" data-period="${p.id}" aria-selected="false">${p.label}</button>`
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
      btn.setAttribute("aria-selected", btn.dataset.difficulty === difficulty ? "true" : "false");
    }
    for (const btn of host.querySelectorAll("[data-period]")) {
      btn.setAttribute("aria-selected", btn.dataset.period === period ? "true" : "false");
    }
  }

  function paint(board) {
    windowEl.textContent = windowCaption(board.period, board.period_start);
    const rows = renderRows(board.entries);
    tbody.innerHTML = rows;
    statusEl.textContent = rows === "" ? emptyMessage(board.period) : "";
  }

  async function load() {
    syncTabs();
    const ticket = ++currentSelection;
    const key = boardKey(difficulty, period);
    const cached = cache.get(key);
    if (cached) {
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
  rankLabel,
  renderRows,
  escapeHtml,
};

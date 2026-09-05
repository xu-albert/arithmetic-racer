// Profile screen for arithmetic-racer.
//
// Mounts into a `<section id="profile" class="screen hidden">` host element
// provided by the integrator. Listens for `open-profile` (dispatched by the
// header dropdown) to reveal itself, fetch /api/me, and render. Listens for
// `auth-changed` to re-fetch when the user signs in/out or renames.
//
// Pure helpers (fmtMs, headlinePpm, fmtPct, etc.) are exported via the
// `_internals` object for unit testing — see profile.test.js. That object also
// re-exports the shared formatters from race-format.js, so a test does not
// have to know which module a formatter ended up in.

import { getMe, getRaceHistory, setUsername } from "./stats-api.js";
import { validateUsernameSync } from "./username-validator-client.js";
// PPM / points / "3d ago" must read the same here and on the lobby
// leaderboard, so they live in one module rather than two copies. The escaper
// is there for the same reason, and matters more: both screens interpolate a
// username off the wire into innerHTML.
import { fmtPpm, fmtPoints, fmtRelative, escapeHtml } from "./race-format.js";

// ---------- pure helpers ----------

/** Format milliseconds as `m:ss.s`. Shows em dash for null/undefined. */
function fmtMs(ms) {
  if (ms == null) return "—";
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60);
  const s = (totalSec - m * 60).toFixed(1);
  // Pad seconds so single-digit seconds (e.g. 9.1) render as "09.1".
  return `${m}:${String(s).padStart(4, "0")}`;
}

/** Format milliseconds as `1.2s` for the per-problem average. */
function fmtAvgMs(ms) {
  if (ms == null) return "—";
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Format a 0..100 percentage with no decimals. */
function fmtPct(p) {
  if (p == null) return "—";
  return `${Math.round(p)}%`;
}

/** Format an ISO date as a short locale date — used for "Racing Since". */
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * The headline speed number for one difficulty: average problems per minute.
 *
 * Deliberately per-difficulty and never blended. The previous headline was a
 * races-weighted average of per-problem time across all three tiers, which is
 * exactly the cross-difficulty comparison the scoring model rules out — a hard
 * problem takes roughly three times as long as an easy one, so a single
 * blended speed says more about which tier you played than how fast you are.
 * Three tiers, three numbers, no combining.
 *
 * @returns {number|null} null when the tier has no finished race yet.
 */
function headlinePpm(aggregates, difficulty) {
  const agg = findAgg(aggregates, difficulty);
  const ppm = agg?.avg_ppm;
  return typeof ppm === "number" && Number.isFinite(ppm) ? ppm : null;
}

/**
 * Points earned in one difficulty. Null (rather than 0) when the tier has never
 * been raced, so "no races yet" reads differently from "raced, earned nothing".
 */
function headlinePoints(aggregates, difficulty) {
  const agg = findAgg(aggregates, difficulty);
  if (!agg || (agg.races_played ?? 0) <= 0) return null;
  const points = agg.total_points;
  return typeof points === "number" && Number.isFinite(points) ? points : null;
}

/** Total races played across all difficulties. */
function computeTotalRaces(aggregates) {
  if (!Array.isArray(aggregates)) return 0;
  let total = 0;
  for (const a of aggregates) total += a?.races_played ?? 0;
  return total;
}

/** Weighted overall accuracy (0..100). Null if no races. */
function computeOverallAccuracy(aggregates) {
  if (!Array.isArray(aggregates)) return null;
  let totalRaces = 0;
  let weighted = 0;
  for (const a of aggregates) {
    const r = a?.races_played ?? 0;
    if (r <= 0) continue;
    totalRaces += r;
    weighted += r * (a?.avg_accuracy ?? 0);
  }
  if (totalRaces === 0) return null;
  return weighted / totalRaces;
}

/** Finish rate as 0..100 percentage. Null if no races. */
function computeFinishRate(aggregates) {
  if (!Array.isArray(aggregates)) return null;
  let played = 0;
  let finished = 0;
  for (const a of aggregates) {
    played += a?.races_played ?? 0;
    finished += a?.races_finished ?? 0;
  }
  if (played === 0) return null;
  return (finished / played) * 100;
}

/** Find the per-difficulty aggregate row, or null. */
function findAgg(aggregates, difficulty) {
  if (!Array.isArray(aggregates)) return null;
  return aggregates.find((a) => a?.difficulty === difficulty) ?? null;
}

/** "easy" → "Easy". */
function titleCase(s) {
  if (!s) return "";
  return s[0].toUpperCase() + s.slice(1);
}

/** The three tiers, in the order every other picker on the site lists them. */
const DIFFICULTIES = ["easy", "medium", "hard"];

/**
 * Render the race-history table body for one list of RaceListItems.
 *
 * Takes the parsed rows rather than the fetch so it can be tested without a
 * DOM — every cell is escaped, because a row arrives over the wire.
 */
function renderRaceRows(races) {
  if (!Array.isArray(races) || races.length === 0) return "";
  return races
    .map((r) => {
      const finish = r.finish_time_ms == null ? "DNF" : fmtMs(r.finish_time_ms);
      const diff = r.difficulty ? titleCase(r.difficulty) : "—";
      return `<tr>
          <td>#${escapeHtml(String(r.race_seq ?? "—"))}</td>
          <td>${escapeHtml(diff)}</td>
          <td>${escapeHtml(finish)}</td>
          <td>${escapeHtml(fmtPpm(r.ppm))}</td>
          <td>${escapeHtml(fmtPoints(r.points))}</td>
          <td>${escapeHtml(fmtPct(r.accuracy_pct))}</td>
          <td>${escapeHtml(fmtAvgMs(r.avg_time_per_problem_ms))}</td>
          <td>${escapeHtml(fmtRelative(r.played_at))}</td>
        </tr>`;
    })
    .join("");
}

/** Empty-state copy for the history table, worded for the filter in force. */
function historyEmptyMessage(difficulty) {
  if (!difficulty) return "Race a few times and your stats will show up here.";
  return `No ${difficulty} races yet.`;
}

/**
 * The `before` cursor for the page after `rows`, when `rows` is the unfiltered
 * newest-first list /api/me hands over as `recent`.
 *
 * race_seq is a dense counter from 1 over every race the account owns, so a
 * page whose oldest row is #1 has nothing older and any other page's oldest
 * row is exactly the cursor GET /api/me/races wants next. That is what lets
 * the profile open on a single request and still know whether to offer "Load
 * older races". A *filtered* page gets no such shortcut — the rows between
 * two matching ones are invisible here — and uses the server's `next_cursor`.
 *
 * @returns {number|null}
 */
function olderRacesCursor(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let oldest = Infinity;
  for (const r of rows) {
    const seq = Number(r?.race_seq);
    if (Number.isFinite(seq) && seq < oldest) oldest = seq;
  }
  return Number.isFinite(oldest) && oldest > 1 ? oldest : null;
}

function errorText(code) {
  switch (code) {
    case "taken":
      return "That name is already taken.";
    case "banned":
      return "That name isn't allowed.";
    case "reserved":
      return "That name is reserved.";
    case "invalid_format":
      return "Use 3-20 letters, digits, or underscores. Must start with a letter.";
    default:
      return "Something went wrong.";
  }
}

// ---------- DOM templates ----------

const PROFILE_HTML = `
  <div class="profile">
    <a href="#" class="profile__back">← Back to lobby</a>

    <section class="profile__identity">
      <div class="profile__avatar"></div>
      <div class="profile__name-block">
        <h2 class="profile__username">
          <span id="profile-username-display"></span>
          <button class="profile__edit" type="button">Change your display name</button>
        </h2>
        <p class="profile__email" id="profile-email"></p>
      </div>
      <!-- Three tiers, three speeds. There is no combined number here on
           purpose: the difficulties are separate pools and are never blended
           into one score or ranking. -->
      <div class="profile__headline">
        <div class="profile__headline-stat">
          <span class="profile__headline-num" id="p-ppm-easy">—</span>
          <span class="profile__headline-label">Easy PPM</span>
          <span class="profile__headline-sub" id="p-points-easy">—</span>
        </div>
        <div class="profile__headline-stat">
          <span class="profile__headline-num" id="p-ppm-medium">—</span>
          <span class="profile__headline-label">Medium PPM</span>
          <span class="profile__headline-sub" id="p-points-medium">—</span>
        </div>
        <div class="profile__headline-stat">
          <span class="profile__headline-num" id="p-ppm-hard">—</span>
          <span class="profile__headline-label">Hard PPM</span>
          <span class="profile__headline-sub" id="p-points-hard">—</span>
        </div>
      </div>
    </section>

    <section class="profile__tiles">
      <div class="profile__tile"><div class="profile__tile-num" id="t-best-easy">—</div><div class="profile__tile-lbl">Best Easy</div></div>
      <div class="profile__tile"><div class="profile__tile-num" id="t-best-medium">—</div><div class="profile__tile-lbl">Best Medium</div></div>
      <div class="profile__tile"><div class="profile__tile-num" id="t-best-hard">—</div><div class="profile__tile-lbl">Best Hard</div></div>
      <div class="profile__tile"><div class="profile__tile-num" id="t-total">0</div><div class="profile__tile-lbl">Total Races</div></div>
      <div class="profile__tile"><div class="profile__tile-num" id="t-acc">—</div><div class="profile__tile-lbl">Overall Accuracy</div></div>
      <div class="profile__tile"><div class="profile__tile-num" id="t-finish">—</div><div class="profile__tile-lbl">Finish Rate</div></div>
    </section>

    <section class="profile__info-row">
      <div class="profile__info-card">
        <h3>Account</h3>
        <p>Racing Since: <span id="p-since">—</span></p>
        <p>Email: <span id="p-email-2">—</span></p>
      </div>
      <div class="profile__info-card profile__avatar-card">
        <h3>Avatar</h3>
        <button disabled class="profile__avatar-btn">Change Avatar (coming soon)</button>
      </div>
    </section>

    <!-- The filter is a toggle-button group, like the lobby leaderboard's
         tabs: aria-pressed marks the selection. A history filter is the one
         place the three tiers legitimately share a list — this is the racer's
         own log, not a ranking, so "All" is the default. -->
    <section class="profile__races">
      <div class="profile__races-head">
        <h3>Race History</h3>
        <div class="profile__filter" role="group" aria-label="Filter races by difficulty">
          <button type="button" class="profile__filter-btn" data-history-difficulty="" aria-pressed="true">All</button>
          ${DIFFICULTIES.map(
            (d) =>
              `<button type="button" class="profile__filter-btn" data-history-difficulty="${d}" aria-pressed="false">${titleCase(d)}</button>`
          ).join("")}
        </div>
      </div>
      <div class="profile__table-wrap">
        <table class="profile__table">
          <thead>
            <tr>
              <th>Race #</th><th>Difficulty</th><th>Time</th><th>PPM</th><th>Points</th><th>Accuracy</th><th>Avg/problem</th><th>Date</th>
            </tr>
          </thead>
          <tbody id="profile-races-tbody"></tbody>
        </table>
      </div>
      <p class="profile__empty" id="profile-empty" hidden>Race a few times and your stats will show up here.</p>
      <p class="profile__history-status" id="profile-history-status" aria-live="polite"></p>
      <button type="button" class="profile__more" id="profile-more" hidden>Load older races</button>
    </section>
  </div>

  <div class="profile__rename" id="profile-rename" hidden>
    <div class="profile__rename-card">
      <h3>Change display name</h3>
      <input type="text" id="profile-rename-input" maxlength="20" autocomplete="off" />
      <span class="profile__rename-status"></span>
      <div class="profile__rename-actions">
        <button id="profile-rename-cancel" type="button">Cancel</button>
        <button id="profile-rename-save" type="button">Save</button>
      </div>
    </div>
  </div>
`;

// ---------- mount ----------

const MOUNT_FLAG = "__profileMounted";

/**
 * Mount the profile screen into the host element. Idempotent.
 *
 * @param {HTMLElement} host
 */
export function mountProfile(host) {
  if (!host) return;
  if (host[MOUNT_FLAG]) return;
  host[MOUNT_FLAG] = true;

  host.innerHTML = PROFILE_HTML;
  // Start hidden — the `open-profile` event reveals us.
  host.classList.add("hidden");

  const $ = (sel) => host.querySelector(sel);

  // ---- screen visibility ----
  function showProfile() {
    // Hide siblings that look like screens; we only know the conventional ids.
    for (const id of ["lobby", "race", "results"]) {
      const el = document.getElementById(id);
      if (el) el.classList.add("hidden");
    }
    host.classList.remove("hidden");
  }
  function hideProfile() {
    host.classList.add("hidden");
    const lobby = document.getElementById("lobby");
    if (lobby) lobby.classList.remove("hidden");
  }

  // ---- render ----
  function renderEmpty() {
    $("#profile-username-display").textContent = "—";
    $("#profile-email").textContent = "";
    for (const d of ["easy", "medium", "hard"]) {
      $(`#p-ppm-${d}`).textContent = "—";
      $(`#p-points-${d}`).textContent = "—";
    }
    $("#t-best-easy").textContent = "—";
    $("#t-best-medium").textContent = "—";
    $("#t-best-hard").textContent = "—";
    $("#t-total").textContent = "0";
    $("#t-acc").textContent = "—";
    $("#t-finish").textContent = "—";
    $("#p-since").textContent = "—";
    $("#p-email-2").textContent = "—";
    showRecent([]);
  }

  function render(me) {
    if (!me) {
      renderEmpty();
      return;
    }

    $("#profile-username-display").textContent = me.username || "—";
    $("#profile-email").textContent = me.email || "";
    $("#p-email-2").textContent = me.email || "—";
    $("#p-since").textContent = fmtDate(me.created_at);

    const aggs = me.aggregates || [];
    for (const d of ["easy", "medium", "hard"]) {
      $(`#p-ppm-${d}`).textContent = fmtPpm(headlinePpm(aggs, d));
      const points = headlinePoints(aggs, d);
      $(`#p-points-${d}`).textContent = points == null ? "—" : `${fmtPoints(points)} pts`;
    }

    $("#t-best-easy").textContent = fmtMs(findAgg(aggs, "easy")?.best_time_ms ?? null);
    $("#t-best-medium").textContent = fmtMs(findAgg(aggs, "medium")?.best_time_ms ?? null);
    $("#t-best-hard").textContent = fmtMs(findAgg(aggs, "hard")?.best_time_ms ?? null);

    const total = computeTotalRaces(aggs);
    $("#t-total").textContent = String(total);
    $("#t-acc").textContent = fmtPct(computeOverallAccuracy(aggs));
    $("#t-finish").textContent = fmtPct(computeFinishRate(aggs));

    // ---- race history ----
    // `recent` is the first unfiltered page and comes free with /api/me. If a
    // filter is in force (this is a re-render after a rename), the filtered
    // page is re-fetched instead so the table keeps saying what the pressed
    // button says.
    if (history.difficulty) loadHistory({ reset: true });
    else showRecent(Array.isArray(me.recent) ? me.recent : []);
  }

  // ---- race history ----
  // One page-set of GET /api/me/races: `rows` accumulates as the racer loads
  // older pages, `nextCursor` is the server's word on whether older races
  // exist (null = this is the end), `difficulty` is the filter (null = every
  // tier). The endpoint is only hit on a filter change or "Load older races";
  // opening the profile still costs the one /api/me request it always did.
  const history = { difficulty: null, rows: [], nextCursor: null };
  // Counts selections, not responses: a slower page must not land under a
  // filter pressed after it was requested.
  let historyTicket = 0;
  const historyTbody = $("#profile-races-tbody");
  const historyEmpty = $("#profile-empty");
  const historyStatus = $("#profile-history-status");
  const moreBtn = $("#profile-more");

  function syncFilter() {
    for (const btn of host.querySelectorAll("[data-history-difficulty]")) {
      const pressed = (btn.dataset.historyDifficulty || null) === history.difficulty;
      btn.setAttribute("aria-pressed", pressed ? "true" : "false");
    }
  }

  function paintHistory() {
    syncFilter();
    historyTbody.innerHTML = renderRaceRows(history.rows);
    historyEmpty.textContent = historyEmptyMessage(history.difficulty);
    historyEmpty.hidden = history.rows.length > 0;
    historyStatus.textContent = "";
    moreBtn.hidden = history.nextCursor == null;
    moreBtn.disabled = false;
  }

  /** Show /api/me's `recent` as the unfiltered first page. */
  function showRecent(recent) {
    ++historyTicket; // drop any filtered page still in flight
    history.difficulty = null;
    history.rows = recent;
    history.nextCursor = olderRacesCursor(recent);
    paintHistory();
  }

  /**
   * Fetch a page. `reset` starts over from the newest race under the current
   * filter; otherwise the next older page is appended below what is shown.
   */
  async function loadHistory({ reset }) {
    const ticket = ++historyTicket;
    if (reset) {
      // Blank the table before the request rather than leave one tier's rows
      // under another tier's pressed button; the empty line waits for the
      // answer so it cannot flash "No hard races yet" over a loading page.
      syncFilter();
      history.rows = [];
      history.nextCursor = null;
      historyTbody.innerHTML = "";
      historyEmpty.hidden = true;
      moreBtn.hidden = true;
    }
    historyStatus.textContent = "Loading…";
    moreBtn.disabled = true;
    try {
      const page = await getRaceHistory({
        difficulty: history.difficulty,
        before: reset ? null : history.nextCursor,
      });
      if (ticket !== historyTicket) return;
      const races = Array.isArray(page?.races) ? page.races : [];
      history.rows = reset ? races : history.rows.concat(races);
      history.nextCursor = page?.next_cursor ?? null;
      paintHistory();
    } catch (err) {
      if (ticket !== historyTicket) return;
      // Best-effort, like every other read on this screen: what is already
      // on the table stays, and the racer is told this page is missing.
      console.error("profile: race history failed", err);
      historyStatus.textContent = "Couldn't load race history. Try again in a moment.";
      moreBtn.disabled = false;
    }
  }

  // ---- data fetching ----
  let inflight = null;
  async function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const me = await getMe();
        render(me);
      } catch (err) {
        // Best-effort: leave skeleton in place. Don't crash the screen.
        console.error("profile: getMe failed", err);
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  // ---- rename overlay ----
  const overlay = $("#profile-rename");
  const renameInput = $("#profile-rename-input");
  const renameStatus = overlay.querySelector(".profile__rename-status");
  const renameSave = $("#profile-rename-save");
  const renameCancel = $("#profile-rename-cancel");

  function setStatus(kind, message) {
    renameStatus.textContent = message || "";
    renameStatus.classList.remove("ok", "bad");
    if (kind) renameStatus.classList.add(kind);
  }

  function openRename() {
    const current = $("#profile-username-display").textContent.trim();
    renameInput.value = current === "—" ? "" : current;
    setStatus(null, "");
    overlay.hidden = false;
    // Focus & select after the overlay paints.
    setTimeout(() => {
      renameInput.focus();
      renameInput.select();
    }, 0);
  }
  function closeRename() {
    overlay.hidden = true;
    setStatus(null, "");
    renameSave.disabled = false;
  }

  function previewValidate() {
    const v = validateUsernameSync(renameInput.value.trim());
    if (v.valid) {
      setStatus(null, "");
    } else {
      setStatus("bad", errorText(v.reason));
    }
  }

  async function doSave() {
    const next = renameInput.value.trim();
    const v = validateUsernameSync(next);
    if (!v.valid) {
      setStatus("bad", errorText(v.reason));
      return;
    }
    renameSave.disabled = true;
    setStatus(null, "Saving…");
    try {
      await setUsername(next);
      setStatus("ok", "Saved");
      document.dispatchEvent(new Event("auth-changed"));
      closeRename();
      // Refresh local view so the new name shows immediately.
      $("#profile-username-display").textContent = next;
    } catch (err) {
      setStatus("bad", errorText(err?.code));
      renameSave.disabled = false;
    }
  }

  // ---- wiring ----
  host.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;

    if (t.closest(".profile__back")) {
      e.preventDefault();
      hideProfile();
      return;
    }
    if (t.closest(".profile__edit")) {
      e.preventDefault();
      openRename();
      return;
    }
    if (t.id === "profile-rename-cancel") {
      e.preventDefault();
      closeRename();
      return;
    }
    if (t.id === "profile-rename-save") {
      e.preventDefault();
      doSave();
      return;
    }
    const filterBtn = t.closest("[data-history-difficulty]");
    if (filterBtn) {
      e.preventDefault();
      history.difficulty = filterBtn.dataset.historyDifficulty || null;
      loadHistory({ reset: true });
      return;
    }
    if (t.id === "profile-more") {
      e.preventDefault();
      loadHistory({ reset: false });
      return;
    }
    // Click outside the rename card closes the overlay.
    if (t === overlay) {
      closeRename();
    }
  });

  renameInput.addEventListener("input", previewValidate);
  renameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeRename();
    }
  });

  document.addEventListener("open-profile", () => {
    showProfile();
    refresh();
  });

  document.addEventListener("auth-changed", () => {
    // Only refresh if we're currently visible — otherwise wait until shown.
    if (!host.classList.contains("hidden")) {
      refresh();
    }
  });
}

// ---------- test exports ----------

export const _internals = {
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
};

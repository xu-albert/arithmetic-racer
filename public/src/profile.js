// Profile screen for arithmetic-racer.
//
// M1: shell + pure formatting/aggregation helpers. Future milestones wire
// the `open-profile` / `auth-changed` event listeners (M2) and the rename
// overlay (M3).
//
// Pure helpers (fmtMs, computeHeadlineMs, fmtPct, etc.) are exported via the
// `_internals` object for unit testing — see profile.test.js.

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

/** Coarse "h ago" / "d ago" relative timestamp. */
function fmtRelative(iso) {
  if (!iso) return "—";
  const d = new Date(iso).getTime();
  if (!Number.isFinite(d)) return "—";
  const diff = Date.now() - d;
  const h = Math.round(diff / 3_600_000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  return `${days}d ago`;
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
 * Headline metric: weighted average of per-problem time (ms) across the
 * three difficulty buckets, weighted by races_played. Null if zero races.
 */
function computeHeadlineMs(aggregates) {
  if (!Array.isArray(aggregates)) return null;
  let totalRaces = 0;
  let weighted = 0;
  for (const a of aggregates) {
    const r = a?.races_played ?? 0;
    if (r <= 0) continue;
    totalRaces += r;
    weighted += r * (a?.avg_problem_time_ms ?? 0);
  }
  if (totalRaces === 0) return null;
  return weighted / totalRaces;
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

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
          <button class="profile__edit" aria-label="Change username">✎</button>
        </h2>
        <p class="profile__email" id="profile-email"></p>
      </div>
      <div class="profile__headline">
        <span id="profile-headline-num">—</span>
        <span class="profile__headline-label">avg/problem</span>
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

    <section class="profile__races">
      <h3>Latest Race Results</h3>
      <table class="profile__table">
        <thead>
          <tr>
            <th>Race #</th><th>Difficulty</th><th>Time</th><th>Accuracy</th><th>Avg/problem</th><th>Date</th>
          </tr>
        </thead>
        <tbody id="profile-races-tbody"></tbody>
      </table>
      <p class="profile__empty" id="profile-empty" hidden>Race a few times and your stats will show up here.</p>
    </section>
  </div>
`;

// ---------- mount ----------

const MOUNT_FLAG = "__profileMounted";

/**
 * Mount the profile screen into the host element. Idempotent.
 * M1: renders the static shell; data wiring + rename overlay come in M2/M3.
 *
 * @param {HTMLElement} host
 */
export function mountProfile(host) {
  if (!host) return;
  if (host[MOUNT_FLAG]) return;
  host[MOUNT_FLAG] = true;

  host.innerHTML = PROFILE_HTML;
  // Start hidden — the `open-profile` event (wired in M2) reveals us.
  host.classList.add("hidden");
}

// ---------- test exports ----------

export const _internals = {
  fmtMs,
  fmtAvgMs,
  fmtPct,
  fmtRelative,
  fmtDate,
  computeHeadlineMs,
  computeTotalRaces,
  computeOverallAccuracy,
  computeFinishRate,
  findAgg,
  errorText,
  escapeHtml,
};

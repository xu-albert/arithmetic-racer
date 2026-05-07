// Profile screen for arithmetic-racer.
//
// Mounts into a `<section id="profile" class="screen hidden">` host element
// provided by the integrator. Listens for `open-profile` (dispatched by the
// header dropdown) to reveal itself, fetch /api/me, and render. Listens for
// `auth-changed` to re-fetch when the user signs in/out or renames.
//
// Pure helpers (fmtMs, computeHeadlineMs, fmtPct, etc.) are exported via the
// `_internals` object for unit testing — see profile.test.js.

import { getMe, setUsername } from "./stats-api.js";
import { validateUsernameSync } from "./username-validator-client.js";

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
    $("#profile-headline-num").textContent = "—";
    $("#t-best-easy").textContent = "—";
    $("#t-best-medium").textContent = "—";
    $("#t-best-hard").textContent = "—";
    $("#t-total").textContent = "0";
    $("#t-acc").textContent = "—";
    $("#t-finish").textContent = "—";
    $("#p-since").textContent = "—";
    $("#p-email-2").textContent = "—";
    $("#profile-races-tbody").innerHTML = "";
    $("#profile-empty").hidden = false;
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
    const headlineMs = computeHeadlineMs(aggs);
    $("#profile-headline-num").textContent = fmtAvgMs(headlineMs);

    $("#t-best-easy").textContent = fmtMs(findAgg(aggs, "easy")?.best_time_ms ?? null);
    $("#t-best-medium").textContent = fmtMs(findAgg(aggs, "medium")?.best_time_ms ?? null);
    $("#t-best-hard").textContent = fmtMs(findAgg(aggs, "hard")?.best_time_ms ?? null);

    const total = computeTotalRaces(aggs);
    $("#t-total").textContent = String(total);
    $("#t-acc").textContent = fmtPct(computeOverallAccuracy(aggs));
    $("#t-finish").textContent = fmtPct(computeFinishRate(aggs));

    // ---- recent races table ----
    const tbody = $("#profile-races-tbody");
    const recent = Array.isArray(me.recent) ? me.recent : [];
    if (recent.length === 0) {
      tbody.innerHTML = "";
      $("#profile-empty").hidden = false;
    } else {
      $("#profile-empty").hidden = true;
      const rows = recent.map((r) => {
        const finish = r.finish_time_ms == null ? "DNF" : fmtMs(r.finish_time_ms);
        const diff = r.difficulty
          ? r.difficulty[0].toUpperCase() + r.difficulty.slice(1)
          : "—";
        return `<tr>
          <td>#${escapeHtml(String(r.race_seq ?? "—"))}</td>
          <td>${escapeHtml(diff)}</td>
          <td>${escapeHtml(finish)}</td>
          <td>${escapeHtml(fmtPct(r.accuracy_pct))}</td>
          <td>${escapeHtml(fmtAvgMs(r.avg_time_per_problem_ms))}</td>
          <td>${escapeHtml(fmtRelative(r.played_at))}</td>
        </tr>`;
      });
      tbody.innerHTML = rows.join("");
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

// ---------- helpers ----------

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

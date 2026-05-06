// Persistent app header. Owned by Agent E.
//
// Renders two states:
//   - logged out: anon handle (next to avatar) + CREATE ACCOUNT / SIGN IN buttons
//   - logged in:  username dropdown (Profile / Log out)
// Always shows two stat pills: Best (mm:ss.s + difficulty letter) and Races (count).
//
// Decoupling rule: this module MUST NOT import from auth.js or profile.js.
// User actions are dispatched as document-level CustomEvents:
//   open-signup, open-signin, open-profile, request-signout
// We listen for `auth-changed` to re-fetch and re-render.

import { getMe, getStatsByDevice } from "./stats-api.js";
import { generateHandle } from "./handles.js";

// ---------- Pure helpers (exported for tests via _internals) ----------

/**
 * Format ms as `m:ss.s`. Returns "—" when ms is null/undefined.
 *  fmtTime(48100)  -> "0:48.1"
 *  fmtTime(65432)  -> "1:05.4"
 *  fmtTime(0)      -> "0:00.0"
 *  fmtTime(null)   -> "—"
 */
function fmtTime(ms) {
  if (ms == null) return "—";
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60);
  const s = (totalSec - m * 60).toFixed(1);
  return `${m}:${String(s).padStart(4, "0")}`;
}

function difficultyLetter(d) {
  if (d === "easy") return "E";
  if (d === "medium") return "M";
  if (d === "hard") return "H";
  return "";
}

/**
 * Pick the difficulty whose best_time_ms is the lowest non-null value.
 * Returns { best_time_ms, best_difficulty } or null when no aggregate has a best.
 */
function pickBest(aggs) {
  if (!Array.isArray(aggs)) return null;
  let best = null;
  for (const a of aggs) {
    if (a && a.best_time_ms != null) {
      if (best === null || a.best_time_ms < best.best_time_ms) {
        best = { best_time_ms: a.best_time_ms, best_difficulty: a.difficulty };
      }
    }
  }
  return best;
}

// ---------- Local state helpers ----------

function getOrCreateAnonHandle() {
  let h = localStorage.getItem("anonHandle");
  if (!h) {
    h = generateHandle();
    localStorage.setItem("anonHandle", h);
  }
  return h;
}

function getDeviceId() {
  let id = localStorage.getItem("deviceId");
  if (!id) {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      id = crypto.randomUUID();
    } else {
      id = "dev-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
    localStorage.setItem("deviceId", id);
  }
  return id;
}

// ---------- Rendering ----------

const AVATAR_SVG = `
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M5 14l1.5-4.2A2 2 0 0 1 8.4 8.4h7.2a2 2 0 0 1 1.9 1.4L19 14v4a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H8v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-4zm2.6-.5h8.8l-1-2.8H8.6l-1 2.8zM8 16.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm8 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/>
  </svg>
`;

function renderShell(host) {
  host.innerHTML = `
    <div class="hdr">
      <div class="hdr__brand">
        <div class="hdr__avatar">${AVATAR_SVG}</div>
        <div class="hdr__name" id="hdr-name"></div>
      </div>
      <div class="hdr__cta" id="hdr-cta"></div>
      <div class="hdr__pills">
        <div class="hdr__pill" id="hdr-pill-best">Best —</div>
        <div class="hdr__pill" id="hdr-pill-races">0 Races</div>
      </div>
    </div>
  `;
}

function setNameDisplay(host, name) {
  const el = host.querySelector("#hdr-name");
  if (el) el.textContent = name;
}

function setPills(host, best, racesCount) {
  const bestEl = host.querySelector("#hdr-pill-best");
  const racesEl = host.querySelector("#hdr-pill-races");
  if (bestEl) {
    if (best && best.best_time_ms != null) {
      const letter = difficultyLetter(best.best_difficulty);
      bestEl.textContent = `Best ${fmtTime(best.best_time_ms)}${letter}`;
    } else {
      bestEl.textContent = "Best —";
    }
  }
  if (racesEl) {
    const n = Number.isFinite(racesCount) ? racesCount : 0;
    racesEl.textContent = `${n} Races`;
  }
}

function renderLoggedOutCta(host) {
  const ctaEl = host.querySelector("#hdr-cta");
  if (!ctaEl) return;
  ctaEl.innerHTML = `
    <button class="hdr__btn hdr__btn--primary" id="hdr-create" type="button">CREATE ACCOUNT</button>
    <button class="hdr__btn" id="hdr-signin" type="button">SIGN IN</button>
  `;
  ctaEl.querySelector("#hdr-create").addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("open-signup"));
  });
  ctaEl.querySelector("#hdr-signin").addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("open-signin"));
  });
}

function renderLoggedInCta(host, username) {
  const ctaEl = host.querySelector("#hdr-cta");
  if (!ctaEl) return;
  ctaEl.innerHTML = `
    <div class="hdr__userbox">
      <button class="hdr__userbtn" id="hdr-userbtn" type="button" aria-haspopup="menu" aria-expanded="false">
        <span id="hdr-username"></span>
        <span class="hdr__caret" aria-hidden="true">▾</span>
      </button>
      <div class="hdr__menu" hidden id="hdr-menu" role="menu">
        <button class="hdr__menuitem" id="hdr-menu-profile" role="menuitem" type="button">Profile</button>
        <button class="hdr__menuitem" id="hdr-menu-logout" role="menuitem" type="button">Log out</button>
      </div>
    </div>
  `;
  ctaEl.querySelector("#hdr-username").textContent = username;

  const userBtn = ctaEl.querySelector("#hdr-userbtn");
  const menu = ctaEl.querySelector("#hdr-menu");

  function closeMenu() {
    menu.hidden = true;
    userBtn.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("keydown", onKey);
  }
  function openMenu() {
    menu.hidden = false;
    userBtn.setAttribute("aria-expanded", "true");
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("keydown", onKey);
  }
  function onDocClick(ev) {
    if (!menu.contains(ev.target) && ev.target !== userBtn && !userBtn.contains(ev.target)) {
      closeMenu();
    }
  }
  function onKey(ev) {
    if (ev.key === "Escape") closeMenu();
  }

  userBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (menu.hidden) openMenu();
    else closeMenu();
  });

  ctaEl.querySelector("#hdr-menu-profile").addEventListener("click", () => {
    closeMenu();
    document.dispatchEvent(new CustomEvent("open-profile"));
  });
  ctaEl.querySelector("#hdr-menu-logout").addEventListener("click", () => {
    closeMenu();
    document.dispatchEvent(new CustomEvent("request-signout"));
  });
}

// ---------- Data fetch + state apply ----------

async function refresh(host) {
  // /api/me — returns null if logged out (per stats-api wrapper).
  const me = await getMe().catch(() => null);
  if (me && me.username) {
    setNameDisplay(host, me.username);
    renderLoggedInCta(host, me.username);
    const aggregates = Array.isArray(me.aggregates) ? me.aggregates : [];
    const best = pickBest(aggregates);
    const totalRaces = aggregates.reduce(
      (s, a) => s + (Number.isFinite(a && a.races_played) ? a.races_played : 0),
      0,
    );
    setPills(host, best, totalRaces);
    return;
  }

  // Logged-out: anon handle + by-device stats.
  setNameDisplay(host, getOrCreateAnonHandle());
  renderLoggedOutCta(host);
  const stats = await getStatsByDevice(getDeviceId()).catch(() => ({
    total_races: 0,
    best_time_ms: null,
    best_difficulty: null,
  }));
  const best =
    stats && stats.best_time_ms != null
      ? { best_time_ms: stats.best_time_ms, best_difficulty: stats.best_difficulty }
      : null;
  setPills(host, best, stats ? stats.total_races : 0);
}

// ---------- Public mount ----------

// Track per-host listener so repeated mounts don't pile up.
const HOST_LISTENERS = new WeakMap();

/**
 * Mount the header into a host element. Idempotent — safe to call multiple times.
 * @param {HTMLElement} host
 */
export function mountHeader(host) {
  if (!host) return;

  // If we previously mounted into this host, detach the old auth-changed listener
  // before clearing the DOM.
  const prev = HOST_LISTENERS.get(host);
  if (prev) {
    document.removeEventListener("auth-changed", prev);
    HOST_LISTENERS.delete(host);
  }

  // Initial paint must be sync — show the logged-out shell immediately so there's
  // no FOUC. refresh() will swap to the logged-in state once /api/me resolves.
  renderShell(host);
  setNameDisplay(host, getOrCreateAnonHandle());
  renderLoggedOutCta(host);

  refresh(host);

  const handler = () => refresh(host);
  document.addEventListener("auth-changed", handler);
  HOST_LISTENERS.set(host, handler);
}

// Test-only export. Production callers should not depend on this surface.
export const _internals = {
  pickBest,
  fmtTime,
  difficultyLetter,
};

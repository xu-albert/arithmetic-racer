// Persistent app header. Owned by Agent E.
//
// M1: logged-out shell with anon handle + CREATE ACCOUNT / SIGN IN + stat pills.
// Later milestones add the logged-in dropdown (M2) and live data fetching
// + auth-changed listener + tests (M3).
//
// Decoupling rule: this module MUST NOT import from auth.js or profile.js.
// User actions are dispatched as document-level CustomEvents:
//   open-signup, open-signin
// (open-profile and request-signout arrive in M2 alongside the dropdown.)

import { getStatsByDevice } from "./stats-api.js";
import { generateHandle } from "./handles.js";

// ---------- Pure helpers ----------

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

// ---------- Public mount ----------

/**
 * Mount the header into a host element. Idempotent — safe to call multiple times.
 * @param {HTMLElement} host
 */
export function mountHeader(host) {
  if (!host) return;
  renderShell(host);

  // Initial paint must be sync — show the logged-out shell immediately.
  setNameDisplay(host, getOrCreateAnonHandle());
  renderLoggedOutCta(host);

  // Best-effort fetch of by-device stats so pills aren't always zero on load.
  getStatsByDevice(getDeviceId())
    .then((stats) => {
      const best =
        stats && stats.best_time_ms != null
          ? { best_time_ms: stats.best_time_ms, best_difficulty: stats.best_difficulty }
          : null;
      setPills(host, best, stats ? stats.total_races : 0);
    })
    .catch(() => {
      // Leave default zero/em-dash pills.
    });
}

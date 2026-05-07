// Persistent app header.
//
// Layout:
//   left:  "Arithmetic Racer" branding
//   right: CREATE ACCOUNT / SIGN IN  (logged out)
//          username dropdown (Profile / Log out)  (logged in)
//          + Races pill (always shown)
//
// Decoupling rule: this module MUST NOT import from auth.js or profile.js.
// User actions are dispatched as document-level CustomEvents:
//   open-signup, open-signin, open-profile, request-signout
// We listen for `auth-changed` to re-fetch and re-render.

import { getMe, getStatsByDevice } from "./stats-api.js";

// ---------- Local state helpers ----------

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

function renderShell(host) {
  host.innerHTML = `
    <div class="hdr">
      <div class="hdr__brand">Arithmetic Racer</div>
      <div class="hdr__cta" id="hdr-cta"></div>
      <div class="hdr__pills">
        <div class="hdr__pill" id="hdr-pill-races">0 Races</div>
      </div>
    </div>
  `;
}

function setPills(host, racesCount) {
  const racesEl = host.querySelector("#hdr-pill-races");
  if (racesEl) {
    const n = Number.isFinite(racesCount) ? racesCount : 0;
    racesEl.textContent = `${n} ${n === 1 ? "Race" : "Races"}`;
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
    renderLoggedInCta(host, me.username);
    const aggregates = Array.isArray(me.aggregates) ? me.aggregates : [];
    const totalRaces = aggregates.reduce(
      (s, a) => s + (Number.isFinite(a && a.races_played) ? a.races_played : 0),
      0,
    );
    setPills(host, totalRaces);
    document.dispatchEvent(
      new CustomEvent("session-ready", { detail: { username: me.username } }),
    );
    return;
  }

  // Logged-out: by-device race count only (no name display in header).
  renderLoggedOutCta(host);
  const stats = await getStatsByDevice(getDeviceId()).catch(() => ({
    total_races: 0,
  }));
  setPills(host, stats ? stats.total_races : 0);
  document.dispatchEvent(
    new CustomEvent("session-ready", { detail: { username: null } }),
  );
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

  // Initial paint must be sync so there's no FOUC. refresh() then swaps the
  // CTA to the logged-in state once /api/me resolves.
  renderShell(host);
  renderLoggedOutCta(host);

  refresh(host);

  // Refresh on:
  //   - auth-changed   (sign-in/up/out — username may flip)
  //   - race-finished  (race POSTed; total_races may have incremented)
  const handler = () => refresh(host);
  document.addEventListener("auth-changed", handler);
  document.addEventListener("race-finished", handler);
  HOST_LISTENERS.set(host, handler);
}

// Auth modal — owned by Agent F.
//
// Mounts a single auth modal (Sign Up / Log In tabs + Forgot password pane)
// and a separate Pick-username modal triggered after Google OAuth when the
// user has no username yet.
//
// Decoupling rules:
//   LISTEN  — `open-signup`, `open-signin`, `request-signout`
//   DISPATCH — `auth-changed` after every transition (signin / signup /
//              signout / oauth-return / pick-username success).
//
// Idempotent: calling mountAuthModal(host) twice is a no-op on the second
// call (host already initialized). Internal state lives in module scope.

import { validateUsernameSync } from "./username-validator-client.js";

// ---- Pure helpers (testable) -------------------------------------------

/**
 * Format the inline username status string given a validator result.
 * Returns { text, ok } where ok is true if the format/banned/reserved
 * checks all pass (taken collisions are caught server-side).
 * @param {string} username
 */
export function formatUsernameStatus(username) {
  if (!username) return { text: "", ok: false };
  const result = validateUsernameSync(username);
  if (result.valid) return { text: "Looks good", ok: true };
  switch (result.reason) {
    case "banned":
      return { text: "Not allowed (banned)", ok: false };
    case "reserved":
      return { text: "Not allowed (reserved)", ok: false };
    case "invalid_format":
    default:
      return {
        text: "Use 3-20 letters/digits/underscore, starting with a letter",
        ok: false,
      };
  }
}

// ---- Module-scope DOM refs (assigned in mountAuthModal) ----------------

let mounted = false;
let backdropEl = null;
let modalEl = null;
let pickModalEl = null;

// ---- Modal lifecycle ----------------------------------------------------

function openModal(tab) {
  if (!modalEl) return;
  setTab(tab);
  clearAllErrors(modalEl);
  backdropEl.hidden = false;
  modalEl.hidden = false;
  // Focus first input in active pane for accessibility.
  const active = modalEl.querySelector(".auth-pane:not([hidden]) input");
  if (active) active.focus();
}

function closeModal() {
  if (!modalEl) return;
  backdropEl.hidden = true;
  modalEl.hidden = true;
}

function setTab(tab) {
  if (!modalEl) return;
  const tabs = modalEl.querySelectorAll(".auth-tab");
  const panes = modalEl.querySelectorAll(".auth-pane");
  tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  panes.forEach((p) => {
    p.hidden = p.id !== `auth-pane-${tab}`;
  });
}

function clearAllErrors(scope) {
  scope.querySelectorAll(".auth-error").forEach((el) => {
    el.hidden = true;
    el.textContent = "";
  });
  scope.querySelectorAll(".auth-success").forEach((el) => (el.hidden = true));
}

// ---- Markup ------------------------------------------------------------

const HTML = `
  <div id="auth-backdrop" class="auth-backdrop" hidden></div>

  <div id="auth-modal" class="auth-modal" hidden role="dialog" aria-modal="true" aria-label="Sign in or sign up">
    <button class="auth-close" type="button" aria-label="Close">&times;</button>
    <button class="auth-google" id="auth-google" type="button">Continue with Google</button>
    <div class="auth-tabs" role="tablist">
      <button class="auth-tab active" type="button" data-tab="signup" role="tab">Sign Up</button>
      <button class="auth-tab" type="button" data-tab="signin" role="tab">Log In</button>
    </div>

    <form class="auth-pane" id="auth-pane-signup" novalidate>
      <label>Email
        <input type="email" name="email" autocomplete="email" required />
      </label>
      <label>Confirm email
        <input type="email" name="email_confirm" autocomplete="email" required />
      </label>
      <label>Password
        <input type="password" name="password" autocomplete="new-password" minlength="8" required />
      </label>
      <label>Username
        <input type="text" name="username" autocomplete="username" required />
        <span class="auth-username-status"></span>
      </label>
      <button type="submit">Create account</button>
      <p class="auth-error" hidden></p>
    </form>

    <form class="auth-pane" id="auth-pane-signin" hidden novalidate>
      <label>Email
        <input type="email" name="email" autocomplete="email" required />
      </label>
      <label>Password
        <input type="password" name="password" autocomplete="current-password" required />
      </label>
      <button type="submit">Log in</button>
      <a class="auth-forgot" href="#">Forgot password?</a>
      <p class="auth-error" hidden></p>
    </form>

    <form class="auth-pane" id="auth-pane-forgot" hidden novalidate>
      <label>Email
        <input type="email" name="email" autocomplete="email" required />
      </label>
      <button type="submit">Send reset link</button>
      <a class="auth-back" href="#">&larr; Back to login</a>
      <p class="auth-error" hidden></p>
      <p class="auth-success" hidden>Check your email for the reset link.</p>
    </form>
  </div>

  <div id="pick-username-modal" class="auth-modal" hidden role="dialog" aria-modal="true" aria-label="Pick a username">
    <h2>Pick your username</h2>
    <p class="auth-pick-help">This is how other racers will see you. You can't change it later in v1.</p>
    <form id="pick-username-form" novalidate>
      <label>Username
        <input type="text" name="username" autocomplete="username" required />
        <span class="auth-username-status"></span>
      </label>
      <button type="submit">Save</button>
      <p class="auth-error" hidden></p>
    </form>
  </div>
`;

// ---- Wiring ------------------------------------------------------------

/**
 * Mount the auth modal markup into a host element and wire the open/close
 * lifecycle. Submit handlers and external auth flows are wired in M2/M3.
 * Idempotent — second call is a no-op.
 * @param {HTMLElement} host
 */
export function mountAuthModal(host) {
  if (mounted) return;
  if (!host) throw new Error("mountAuthModal: host required");

  host.innerHTML = HTML;
  backdropEl = host.querySelector("#auth-backdrop");
  modalEl = host.querySelector("#auth-modal");
  pickModalEl = host.querySelector("#pick-username-modal");

  // ---- Close behaviour (backdrop, ESC, ×) ---
  backdropEl.addEventListener("click", () => {
    // Only the regular auth modal closes on backdrop click; pick-username
    // is non-dismissable (M3).
    if (!pickModalEl.hidden) return;
    closeModal();
  });
  modalEl.querySelector(".auth-close").addEventListener("click", closeModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modalEl.hidden && pickModalEl.hidden) {
      closeModal();
    }
  });

  // ---- Tab switching ---
  modalEl.querySelectorAll(".auth-tab").forEach((btn) => {
    btn.addEventListener("click", () => setTab(btn.dataset.tab));
  });

  // ---- External events from header ---
  document.addEventListener("open-signup", () => openModal("signup"));
  document.addEventListener("open-signin", () => openModal("signin"));

  mounted = true;
}

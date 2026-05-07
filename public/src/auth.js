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
// better-auth endpoint deviations from the brief (verified against
// node_modules/better-auth@1.6.9):
//   - Password reset request endpoint is `/request-password-reset`
//     (NOT `/forget-password`; that path only exists in the email-otp
//     plugin in this version). Using the canonical endpoint here.
//
// stats-api.js note: the integrator may want to extend `setUsername` to
// include `deviceId`. Per the brief we do NOT modify stats-api.js from
// here — the pick-username flow POSTs `/api/me/username` inline below
// with `deviceId` from localStorage.
//
// Idempotent: calling mountAuthModal(host) twice is a no-op on the second
// call (host already initialized). Internal state lives in module scope.

import { validateUsernameSync } from "./username-validator-client.js";

const AUTH = "/api/auth";

// ---- HTTP helpers -------------------------------------------------------

async function signUpEmail({ email, password, username, deviceId }) {
  const res = await fetch(`${AUTH}/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password, name: username, username, deviceId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error("signup failed"), {
      status: res.status,
      code: body.code ?? body.error ?? body.message,
    });
  }
  return res.json().catch(() => ({}));
}

async function signInEmail({ email, password }) {
  const res = await fetch(`${AUTH}/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error("signin failed"), {
      status: res.status,
      code: body.code ?? body.error ?? body.message,
    });
  }
  return res.json().catch(() => ({}));
}

async function signOut() {
  // better-auth 1.6.9 returns 415 UNSUPPORTED_MEDIA_TYPE if the request
  // doesn't include a JSON content-type, even when the body is empty.
  await fetch(`${AUTH}/sign-out`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: "{}",
  });
}

/**
 * Initiate the Google OAuth flow.
 *
 * better-auth 1.6.9's /sign-in/social endpoint is POST-only (GET 404s).
 * It returns 200 with a JSON body { url, redirect: true } and sets a
 * better-auth.state cookie. We POST, read the URL, and navigate the
 * browser to Google's consent screen.
 */
async function startGoogleSignIn() {
  const res = await fetch(`${AUTH}/sign-in/social`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      provider: "google",
      callbackURL: "/?auth=google",
    }),
  });
  if (!res.ok) {
    throw Object.assign(new Error("google sign-in failed"), {
      status: res.status,
    });
  }
  const body = await res.json().catch(() => ({}));
  if (typeof body.url !== "string") {
    throw new Error("google sign-in: missing redirect url");
  }
  location.assign(body.url);
}

async function requestPasswordReset(email) {
  // Endpoint deviation from brief: better-auth 1.6.9 calls this
  // `/request-password-reset`, not `/forget-password`.
  const res = await fetch(`${AUTH}/request-password-reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      email,
      redirectTo: location.origin + "/reset-password.html",
    }),
  });
  if (!res.ok) {
    throw Object.assign(new Error("forgot failed"), { status: res.status });
  }
}

async function setUsernameForOAuth(username) {
  // Direct POST so we can include deviceId without mutating stats-api.js.
  const res = await fetch("/api/me/username", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      username,
      deviceId: localStorage.getItem("deviceId"),
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error("username failed"), {
      status: res.status,
      code: body.error ?? body.code,
    });
  }
  return res.json().catch(() => ({}));
}

// ---- Pure helpers (testable) -------------------------------------------

/**
 * Map a server error code (or username-validator reason) into user-facing
 * copy. Exported only as a side effect of being module-scoped — kept pure
 * for unit testing.
 * @param {string|undefined} code
 */
export function mapAuthError(code) {
  switch (code) {
    case "taken":
    case "USERNAME_IS_ALREADY_TAKEN":
      return "That username is already taken.";
    // The server's databaseHooks.user.create.before throws APIError with
    // `code: USERNAME_BANNED|USERNAME_RESERVED|USERNAME_INVALID_FORMAT`
    // for the email-signup path. The /api/me/username rename route returns
    // the lowercase reason directly. Both shapes map to the same UX copy.
    case "banned":
    case "USERNAME_BANNED":
      return "That username isn't allowed.";
    case "reserved":
    case "USERNAME_RESERVED":
      return "That username is reserved.";
    case "invalid_format":
    case "USERNAME_INVALID_FORMAT":
      return "Use 3-20 letters/digits/underscore, starting with a letter.";
    case "USER_ALREADY_EXISTS":
    case "EMAIL_ALREADY_EXISTS":
    case "email_in_use":
      return "An account with that email already exists.";
    case "INVALID_EMAIL_OR_PASSWORD":
    case "INVALID_PASSWORD":
    case "INVALID_EMAIL":
      return "Wrong email or password.";
    case "PASSWORD_TOO_SHORT":
      return "Password must be at least 8 characters.";
    default:
      return "Something went wrong. Please try again.";
  }
}

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

function openPickUsernameModal() {
  if (!pickModalEl) return;
  // Pick-username modal blocks the lobby — show backdrop too, but no
  // close affordance is wired up.
  backdropEl.hidden = false;
  pickModalEl.hidden = false;
  const input = pickModalEl.querySelector("input[name='username']");
  if (input) input.focus();
}

function closePickUsernameModal() {
  if (!pickModalEl) return;
  pickModalEl.hidden = true;
  // Only hide the backdrop if the regular auth modal is also closed.
  if (modalEl && modalEl.hidden) backdropEl.hidden = true;
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

function showError(formEl, message) {
  const err = formEl.querySelector(".auth-error");
  if (!err) return;
  err.textContent = message;
  err.hidden = false;
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
 * Mount the auth modal markup into a host element and wire all event
 * listeners. Idempotent — second call is a no-op.
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
    // is non-dismissable.
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

  // ---- Forgot-password sub-flow ---
  const forgotLink = modalEl.querySelector(".auth-forgot");
  forgotLink.addEventListener("click", (e) => {
    e.preventDefault();
    clearAllErrors(modalEl);
    modalEl.querySelectorAll(".auth-pane").forEach((p) => {
      p.hidden = p.id !== "auth-pane-forgot";
    });
    modalEl
      .querySelectorAll(".auth-tab")
      .forEach((t) => t.classList.remove("active"));
    const input = modalEl.querySelector("#auth-pane-forgot input[name='email']");
    if (input) input.focus();
  });
  const backLink = modalEl.querySelector(".auth-back");
  backLink.addEventListener("click", (e) => {
    e.preventDefault();
    clearAllErrors(modalEl);
    setTab("signin");
  });

  // ---- Inline username validation (signup pane) ---
  const signupForm = modalEl.querySelector("#auth-pane-signup");
  const signupUsername = signupForm.querySelector("input[name='username']");
  const signupUsernameStatus = signupForm.querySelector(".auth-username-status");
  signupUsername.addEventListener("input", () => {
    const { text, ok } = formatUsernameStatus(signupUsername.value);
    signupUsernameStatus.textContent = text;
    signupUsernameStatus.classList.toggle("ok", ok);
    signupUsernameStatus.classList.toggle("bad", !ok && !!signupUsername.value);
  });

  // ---- Sign-up submit ---
  signupForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAllErrors(modalEl);
    const fd = new FormData(signupForm);
    const email = String(fd.get("email") || "").trim();
    const emailConfirm = String(fd.get("email_confirm") || "").trim();
    const password = String(fd.get("password") || "");
    const username = String(fd.get("username") || "").trim();

    if (email !== emailConfirm) {
      showError(signupForm, "Emails don't match.");
      return;
    }
    if (password.length < 8) {
      showError(signupForm, mapAuthError("PASSWORD_TOO_SHORT"));
      return;
    }
    const usernameCheck = validateUsernameSync(username);
    if (!usernameCheck.valid) {
      showError(signupForm, mapAuthError(usernameCheck.reason));
      return;
    }

    const submitBtn = signupForm.querySelector("button[type='submit']");
    submitBtn.disabled = true;
    try {
      await signUpEmail({
        email,
        password,
        username,
        deviceId: localStorage.getItem("deviceId"),
      });
      closeModal();
      document.dispatchEvent(new Event("auth-changed"));
    } catch (err) {
      showError(signupForm, mapAuthError(err.code));
    } finally {
      submitBtn.disabled = false;
    }
  });

  // ---- Sign-in submit ---
  const signinForm = modalEl.querySelector("#auth-pane-signin");
  signinForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAllErrors(modalEl);
    const fd = new FormData(signinForm);
    const email = String(fd.get("email") || "").trim();
    const password = String(fd.get("password") || "");
    const submitBtn = signinForm.querySelector("button[type='submit']");
    submitBtn.disabled = true;
    try {
      await signInEmail({ email, password });
      closeModal();
      document.dispatchEvent(new Event("auth-changed"));
    } catch (err) {
      if (err.status === 401) {
        showError(signinForm, "Wrong email or password.");
      } else {
        showError(signinForm, mapAuthError(err.code));
      }
    } finally {
      submitBtn.disabled = false;
    }
  });

  // ---- Forgot-password submit ---
  const forgotForm = modalEl.querySelector("#auth-pane-forgot");
  forgotForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAllErrors(modalEl);
    const fd = new FormData(forgotForm);
    const email = String(fd.get("email") || "").trim();
    const submitBtn = forgotForm.querySelector("button[type='submit']");
    submitBtn.disabled = true;
    try {
      await requestPasswordReset(email);
      const success = forgotForm.querySelector(".auth-success");
      if (success) success.hidden = false;
    } catch (err) {
      showError(forgotForm, mapAuthError(err.code));
    } finally {
      submitBtn.disabled = false;
    }
  });

  // ---- Google sign-in ---
  modalEl.querySelector("#auth-google").addEventListener("click", () => {
    startGoogleSignIn().catch((err) => {
      console.error("[auth] google sign-in failed", err);
      const errEl = modalEl.querySelector(".auth-pane:not([hidden]) .auth-error");
      if (errEl) {
        errEl.textContent = "Couldn't start Google sign-in. Try again.";
        errEl.hidden = false;
      }
    });
  });

  // ---- Pick-username modal ---
  const pickForm = pickModalEl.querySelector("#pick-username-form");
  const pickUsername = pickForm.querySelector("input[name='username']");
  const pickStatus = pickForm.querySelector(".auth-username-status");
  pickUsername.addEventListener("input", () => {
    const { text, ok } = formatUsernameStatus(pickUsername.value);
    pickStatus.textContent = text;
    pickStatus.classList.toggle("ok", ok);
    pickStatus.classList.toggle("bad", !ok && !!pickUsername.value);
  });
  pickForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAllErrors(pickModalEl);
    const username = String(new FormData(pickForm).get("username") || "").trim();
    const check = validateUsernameSync(username);
    if (!check.valid) {
      showError(pickForm, mapAuthError(check.reason));
      return;
    }
    const submitBtn = pickForm.querySelector("button[type='submit']");
    submitBtn.disabled = true;
    try {
      await setUsernameForOAuth(username);
      closePickUsernameModal();
      document.dispatchEvent(new Event("auth-changed"));
    } catch (err) {
      showError(pickForm, mapAuthError(err.code));
    } finally {
      submitBtn.disabled = false;
    }
  });

  // ---- External events from header ---
  document.addEventListener("open-signup", () => openModal("signup"));
  document.addEventListener("open-signin", () => openModal("signin"));
  document.addEventListener("open-pick-username", () => openPickUsernameModal());
  document.addEventListener("request-signout", async () => {
    try {
      await signOut();
    } finally {
      document.dispatchEvent(new Event("auth-changed"));
    }
  });

  // ---- Post-auth: prompt for username if missing ---
  document.addEventListener("auth-changed", async () => {
    try {
      const { getMe } = await import("./stats-api.js");
      const me = await getMe().catch(() => null);
      if (me && !me.username) {
        openPickUsernameModal();
      } else if (!me) {
        // Logged out — make sure pick-username is dismissed.
        closePickUsernameModal();
      }
    } catch {
      // stats-api unreachable; nothing actionable here.
    }
  });

  // ---- OAuth-return detection ---
  // If we landed here from /api/auth/sign-in/social with ?auth=google,
  // dispatch auth-changed once and clean the URL.
  try {
    const params = new URLSearchParams(location.search);
    if (params.get("auth") === "google") {
      params.delete("auth");
      const cleanQuery = params.toString();
      const cleanUrl =
        location.pathname + (cleanQuery ? `?${cleanQuery}` : "") + location.hash;
      history.replaceState(null, "", cleanUrl);
      // Defer one tick so listeners (e.g. header) attached after this
      // module's top-level mount still receive the event.
      setTimeout(() => {
        document.dispatchEvent(new Event("auth-changed"));
      }, 0);
    }
  } catch {
    // location/history unavailable — non-fatal in non-browser test envs.
  }

  mounted = true;
}

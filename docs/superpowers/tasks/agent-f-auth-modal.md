# Agent F — Auth Modal & Client SDK

**Spec:** `docs/superpowers/specs/2026-05-06-users-auth-stats-design.md`
**Plan:** `docs/superpowers/plans/2026-05-06-users-auth-stats-implementation.md`
**Reference:** sections 5, 6.2, 6.3 of the spec.

---

## Mission

Build the user-facing auth UI: a single modal with Sign Up / Log In tabs and a separate "Pick username" modal for the Google OAuth flow. Wire the modals to better-auth's HTTP endpoints so signup/signin/forgot-password actually work. Listen for header-dispatched events to open modals; dispatch `auth-changed` after successful auth so the header re-fetches.

## Files you own

- `public/src/auth.js` — module entry, includes the modal renderer + better-auth client wrapper.
- `public/css/auth-modal.css`

## Files you must NOT touch

`public/index.html`, `public/style-a.css`, `public/main.js`, `public/src/header.js` (Agent E), `public/src/profile.js` (Agent G), anything in `worker/`.

## Contract

You export:

```js
/**
 * Mount the auth modals into a host element (a `<div id="auth-modal-root">` provided by the integrator).
 * Listens for `open-signup`, `open-signin`, `open-pick-username`, `request-signout` events on document.
 * Dispatches `auth-changed` after successful sign-in / sign-up / sign-out.
 * @param {HTMLElement} host
 */
export function mountAuthModal(host);
```

You **may** also export a thin `getSession()` helper for other internal use, but the canonical session source for header / profile is `getMe()` from `stats-api.js`. Don't duplicate state.

## better-auth client

Either use `better-auth/client` (the library's browser SDK — verify import path against installed version) **or** raw `fetch` against the documented endpoints. Raw fetch is simpler and fewer moving parts for v1; recommended.

Endpoints (under `/api/auth/`, exact suffixes per Agent D's notes):

```js
const AUTH = "/api/auth";

async function signUpEmail({ email, password, username, deviceId }) {
  const res = await fetch(`${AUTH}/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password, name: username, username, deviceId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error("signup failed"), { status: res.status, code: body.message ?? body.error });
  }
  return res.json();
}

async function signInEmail({ email, password }) {
  const res = await fetch(`${AUTH}/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw Object.assign(new Error("signin failed"), { status: res.status });
  return res.json();
}

async function signOut() {
  await fetch(`${AUTH}/sign-out`, { method: "POST", credentials: "include" });
}

function googleSignInUrl() {
  return `${AUTH}/sign-in/social?provider=google&callbackURL=${encodeURIComponent(location.origin + "/?auth=google")}`;
}

async function forgotPassword(email) {
  const res = await fetch(`${AUTH}/forget-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, redirectTo: location.origin + "/reset-password.html" }),
  });
  if (!res.ok) throw Object.assign(new Error("forgot failed"), { status: res.status });
}
```

(If the installed better-auth version uses different endpoint suffixes, update accordingly and document at the top of `auth.js`.)

## Modals

### Auth modal — two tabs

Layout:
- Backdrop covers the screen, click backdrop or ESC closes.
- Modal card has tab strip on top: `Sign Up` | `Log In`.
- Above the tabs (full-width): big `Continue with Google` button.

**Sign Up tab fields:**
- email
- confirm email (typo guard) — must match
- password (min 8)
- username — show inline preview as user types: `✓ Available` / `✗ Already taken` / `✗ Not allowed (banned)` / `✗ Not allowed (reserved)` / `✗ Use 3-20 letters/digits/underscore, start with a letter`.

Use `validateUsernameSync` from `public/src/username-validator-client.js` for the format/banned/reserved checks (Agent A's mirror). For the `taken` check, debounce 250ms and call a future endpoint... **wait** — there's no `GET /api/username-available` endpoint in the contract. Don't invent one. Show only format/banned/reserved inline; `taken` is reported by the server on submit and rendered as an error then.

**Log In tab fields:**
- email
- password
- "Forgot password?" link → swaps modal contents to a small one-field form (email) → submit calls `forgotPassword`, shows confirmation text, "Back to login" link.

**Submit logic:**

Sign up:
1. Pure-function validate (matching emails, password length, username format).
2. Call `signUpEmail({ email, password, username, deviceId: localStorage.getItem('deviceId') })`. The deviceId field is consumed by Agent D's signup hook for the claim step.
3. On success: close modal, dispatch `document.dispatchEvent(new Event('auth-changed'))`.
4. On 4xx: show error inline (`username already taken`, `email already in use`, `username_banned`, etc. — map server error codes to user-friendly text).

Log in:
1. Call `signInEmail({ email, password })`.
2. On success: close, dispatch `auth-changed`.
3. On 401: "Wrong email or password."

Sign out (in response to `request-signout` event):
1. Call `signOut()`.
2. Dispatch `auth-changed`.

Google sign-in: window.location = `googleSignInUrl()`. The Worker handles the OAuth dance and redirects back to `/` with `?auth=google`. After redirect, on page load, if `?auth=google` is present, dispatch `auth-changed` once and clean the URL with `history.replaceState`.

### Pick-username modal (separate)

Triggered by:
- The `auth-changed` handler should check `getMe()` and, if the user has no username yet, open this modal.
- OR by listening for an explicit `open-pick-username` event (you may dispatch it yourself when you detect the no-username state).

UI:
- Single field, same inline validation as the signup form's username.
- One submit button; cannot be dismissed (no backdrop close, no ESC).
- On submit: `POST /api/me/username` with `{ username, deviceId: localStorage.getItem('deviceId') }` (the integrator extends `setUsername` in `stats-api.js` to include deviceId — coordinate via comment in your code).
- On success: close modal, dispatch `auth-changed`.

**Important:** since `stats-api.js` already exists as the contract-bound module, propose your deviceId addition to the integrator via a comment, **don't modify `stats-api.js` yourself.** Instead, do the POST inline in `auth.js`:

```js
async function setUsernameForOAuth(username) {
  const res = await fetch("/api/me/username", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ username, deviceId: localStorage.getItem("deviceId") }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error("username failed"), { code: body.error });
  }
}
```

## DOM structure

```html
<!-- Root markup rendered into the host -->
<div id="auth-backdrop" class="auth-backdrop" hidden></div>
<div id="auth-modal" class="auth-modal" hidden role="dialog" aria-modal="true">
  <button class="auth-close" aria-label="Close">×</button>
  <button class="auth-google" id="auth-google">Continue with Google</button>
  <div class="auth-tabs">
    <button class="auth-tab" data-tab="signup">Sign Up</button>
    <button class="auth-tab" data-tab="signin">Log In</button>
  </div>
  <form class="auth-pane" id="auth-pane-signup">
    <label>Email <input type="email" name="email" required /></label>
    <label>Confirm email <input type="email" name="email_confirm" required /></label>
    <label>Password <input type="password" name="password" minlength="8" required /></label>
    <label>Username <input type="text" name="username" required />
      <span class="auth-username-status"></span>
    </label>
    <button type="submit">Create account</button>
    <p class="auth-error" hidden></p>
  </form>
  <form class="auth-pane" id="auth-pane-signin" hidden>
    <label>Email <input type="email" name="email" required /></label>
    <label>Password <input type="password" name="password" required /></label>
    <button type="submit">Log in</button>
    <a class="auth-forgot" href="#">Forgot password?</a>
    <p class="auth-error" hidden></p>
  </form>
  <form class="auth-pane" id="auth-pane-forgot" hidden>
    <label>Email <input type="email" name="email" required /></label>
    <button type="submit">Send reset link</button>
    <a class="auth-back" href="#">← Back to login</a>
    <p class="auth-success" hidden>Check your email for the reset link.</p>
  </form>
</div>

<div id="pick-username-modal" class="auth-modal" hidden role="dialog" aria-modal="true">
  <h2>Pick your username</h2>
  <form id="pick-username-form">
    <label>Username <input type="text" name="username" required />
      <span class="auth-username-status"></span>
    </label>
    <button type="submit">Save</button>
    <p class="auth-error" hidden></p>
  </form>
</div>
```

## CSS

`public/css/auth-modal.css` — backdrop, centered card, tab styling, error/success states. Keep it visually consistent with the header palette (deep blue accent for primary buttons, etc.). Modal max-width ~24rem.

```css
.auth-backdrop {
  position: fixed; inset: 0; background: rgba(15, 23, 42, 0.55);
  z-index: 90;
}
.auth-modal {
  position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
  background: #fff; padding: 1.6rem; border-radius: 10px;
  max-width: 24rem; width: 92vw; box-shadow: 0 20px 60px rgba(0,0,0,0.25);
  font-family: "Quicksand", system-ui, sans-serif; z-index: 100;
}
.auth-close { position: absolute; top: .4rem; right: .6rem; background: none; border: 0; font-size: 1.5rem; cursor: pointer; color: #64748b; }
.auth-google {
  width: 100%; padding: 0.7rem; border: 1px solid #cbd5e1; border-radius: 6px;
  background: #fff; font-weight: 600; cursor: pointer;
}
.auth-google:hover { background: #f8fafc; }
.auth-tabs {
  display: flex; gap: 0; margin: 1rem 0; border-bottom: 1px solid #e2e8f0;
}
.auth-tab {
  flex: 1; background: none; border: 0; padding: .55rem 0;
  font-weight: 600; cursor: pointer; color: #64748b;
  border-bottom: 2px solid transparent;
}
.auth-tab.active { color: #1e3a5f; border-bottom-color: #1e3a5f; }
.auth-pane label { display: block; margin: .8rem 0; font-weight: 500; }
.auth-pane input {
  width: 100%; padding: .55rem; border: 1px solid #cbd5e1; border-radius: 6px;
  font-size: 1rem;
}
.auth-pane button[type="submit"] {
  width: 100%; padding: .7rem; background: #1e3a5f; color: #fff;
  border: 0; border-radius: 6px; font-weight: 700; cursor: pointer;
  margin-top: .4rem;
}
.auth-pane button[type="submit"]:hover { background: #15294a; }
.auth-error { color: #b91c1c; margin-top: .8rem; }
.auth-success { color: #15803d; margin-top: .8rem; }
.auth-username-status { display: block; margin-top: .25rem; font-size: 0.85rem; }
.auth-username-status.ok { color: #15803d; }
.auth-username-status.bad { color: #b91c1c; }
```

## Wiring

```js
import { validateUsernameSync } from "./username-validator-client.js";

export function mountAuthModal(host) {
  // Render shell, attach listeners
  host.innerHTML = /* the markup above */;

  // Public events from header
  document.addEventListener("open-signup", () => openModal("signup"));
  document.addEventListener("open-signin", () => openModal("signin"));
  document.addEventListener("request-signout", async () => {
    await signOut();
    document.dispatchEvent(new Event("auth-changed"));
  });

  // Backdrop close, ESC close
  // Tab switching
  // Username inline validation
  // Form submit handlers
  // Google button → location.assign(googleSignInUrl())
  // OAuth-return detection: if URL has ?auth=google, dispatch auth-changed once and history.replaceState

  // After auth-changed, check if logged-in user is missing a username and open pick-username modal:
  document.addEventListener("auth-changed", async () => {
    const { getMe } = await import("./stats-api.js");
    const me = await getMe().catch(() => null);
    if (me && !me.username) openPickUsernameModal();
  });
}
```

## Testing

UI tests via headless DOM are heavy. v1 budget:

1. **Pure helpers test** — extract any pure function (e.g., a `mapAuthError(code) -> string`) and test it via `node --test`. Optional, only if you have non-trivial pure logic.
2. **Manual E2E** in Integration I4.

If you don't write tests for this slice, that's OK — call it out explicitly in the commit message: "no automated tests; covered by I4 manual E2E".

## Milestones

- [ ] **M1 — Modal markup + CSS rendered, open/close works (no submit yet).** Commit: `M1: agent F — auth modal shell with tabs + close behavior`.
- [ ] **M2 — Sign-up + sign-in submit working.** Commit: `M2: agent F — auth modal email/password flows`.
- [ ] **M3 — Forgot password + Google OAuth + pick-username modal.** Commit: `M3: agent F — forgot, Google OAuth, pick-username`.

## Definition of done

1. `mountAuthModal(host)` is exported and idempotent.
2. Modal opens on `open-signup` / `open-signin` events, closes on backdrop / ESC / × / submit-success.
3. Sign-up calls the email-sign-up endpoint with `username` and `deviceId` in the body.
4. Sign-in works.
5. `auth-changed` event is dispatched on every transition (signin, signup, signout, oauth-return).
6. Pick-username modal blocks the lobby until a username is set (no close affordance).
7. CSS lives only in `public/css/auth-modal.css`.
8. No files outside allowlist touched.

## How the integrator uses your work

- **Integrator I2:** adds `<div id="auth-modal-root"></div>` to `index.html`, links `css/auth-modal.css`, calls `mountAuthModal(...)` from `main.js`.
- **Agent E (header):** dispatches the open-signup / open-signin / request-signout events you listen for. After your `auth-changed` event, header re-fetches state.
- **Integrator (post-Agent D):** confirms that `setUsernameForOAuth` is hitting `/api/me/username`, and that Agent D's claim runs on first-username-set.

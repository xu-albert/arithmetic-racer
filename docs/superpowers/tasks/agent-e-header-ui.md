# Agent E — Header UI

**Spec:** `docs/superpowers/specs/2026-05-06-users-auth-stats-design.md`
**Plan:** `docs/superpowers/plans/2026-05-06-users-auth-stats-implementation.md`
**Reference:** sections 6.1, 6.7 of the spec.

---

## Mission

Implement the persistent app header that shows different states for logged-in vs logged-out users, plus stat pills that always reflect the current user's race history (anon-by-device when logged out, by-user when logged in).

## Files you own

- `public/src/header.js`
- `public/css/header.css`

## Files you must NOT touch

`public/index.html` (integrator wires the mount point), `public/style-a.css` (existing styles only), `public/main.js`, anything in `worker/` or in other agents' `public/src/` files.

## Contract

You export one function:

```js
/**
 * Mount the header into a host element. Idempotent — safe to call multiple times.
 * @param {HTMLElement} host
 */
export function mountHeader(host);
```

Inside `mountHeader`, you:

1. Render the logged-out skeleton initially (sync, before any fetch).
2. Fire two requests in parallel:
   - `GET /api/me` (via `getMe` from `stats-api.js`) — null if logged out.
   - `GET /api/stats/by-device/<deviceId>` if logged out (via `getStatsByDevice`). DeviceId comes from `localStorage.deviceId`.
3. Update the DOM based on what comes back.

You **must not** import from `auth.js` (Agent F's module). Instead, listen for these document-level custom events that Agent F dispatches:

- `auth-changed` — fired after sign-in, sign-out, or signup. Header re-fetches.

You **must not** call any auth function directly. Buttons just fire events:
- Click `CREATE ACCOUNT` → `document.dispatchEvent(new CustomEvent('open-signup'))`
- Click `SIGN IN` → `document.dispatchEvent(new CustomEvent('open-signin'))`
- Click `Profile` (in dropdown) → `document.dispatchEvent(new CustomEvent('open-profile'))`
- Click `Log out` → `document.dispatchEvent(new CustomEvent('request-signout'))`

Agent F binds those to actual auth flows.

## Display name when logged out

Use the existing generated handle. Generate one once (from `public/src/handles.js` — already exists), persist to `localStorage.anonHandle`, reuse on subsequent loads. The header shows `{anonHandle}` next to the avatar.

```js
import { generateHandle } from "./handles.js";

function getOrCreateAnonHandle() {
  let h = localStorage.getItem("anonHandle");
  if (!h) { h = generateHandle(); localStorage.setItem("anonHandle", h); }
  return h;
}
```

## Stat pills

Two pills, always present:

- **Best** — formatted as `0:48.1M` (mm:ss.s + difficulty letter). If no best yet: `Best —`.
- **Races** — count, e.g., `12 Races`. Zero state: `0 Races`.

When logged out: get from `getStatsByDevice(deviceId)` (`{ total_races, best_time_ms, best_difficulty }`).
When logged in: derive from `getMe()` — pick the best `best_time_ms` across the three aggregates and use that difficulty for the letter.

Format helper (put in `header.js`, not shared):

```js
function fmtTime(ms) {
  if (ms == null) return "—";
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60);
  const s = (totalSec - m * 60).toFixed(1);
  return `${m}:${String(s).padStart(4, "0")}`;
}
```

## DOM structure

Render this inside the host:

```html
<div class="hdr">
  <div class="hdr__brand">
    <div class="hdr__avatar" aria-hidden="true">
      <!-- car icon SVG -->
    </div>
    <div class="hdr__name" id="hdr-name">BraveOtter</div>
  </div>
  <div class="hdr__cta" id="hdr-cta">
    <!-- swapped between logged-out and logged-in states -->
  </div>
  <div class="hdr__pills">
    <div class="hdr__pill" id="hdr-pill-best">Best —</div>
    <div class="hdr__pill" id="hdr-pill-races">0 Races</div>
  </div>
</div>
```

**Logged-out CTA (`#hdr-cta` content):**
```html
<button class="hdr__btn hdr__btn--primary" id="hdr-create">CREATE ACCOUNT</button>
<button class="hdr__btn" id="hdr-signin">SIGN IN</button>
```

**Logged-in CTA:**
```html
<div class="hdr__userbox">
  <button class="hdr__userbtn" id="hdr-userbtn"><span id="hdr-username">albertxu</span> ▾</button>
  <div class="hdr__menu" hidden id="hdr-menu">
    <button class="hdr__menuitem" id="hdr-menu-profile">Profile</button>
    <button class="hdr__menuitem" id="hdr-menu-logout">Log out</button>
  </div>
</div>
```

## CSS

`public/css/header.css` — your visual style. Match the project's existing tone (the `style-a.css` palette uses cool blues with `Patrick Hand` + `Quicksand` fonts). Reference the TypeRacer-style header the user liked: avatar pill on the left, primary yellow CTA, secondary teal CTA, two darker pills on the right.

Suggested palette (adapt freely):
- Header background: `#1e3a5f` (deep blue)
- Primary CTA: `#facc15` (yellow), text `#1e3a5f`
- Secondary CTA: `#3aa691` (teal), text white
- Pills: `#2c5475` (mid blue), text white
- Hover states: 10% lighter

```css
.hdr {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 1rem;
  background: #1e3a5f;
  font-family: "Quicksand", system-ui, sans-serif;
  color: #fff;
}
.hdr__brand { display: flex; align-items: center; gap: 0.6rem; }
.hdr__avatar {
  width: 2.2rem; height: 2.2rem;
  background: #fff; border-radius: 6px;
  display: grid; place-items: center;
}
.hdr__name { font-weight: 700; font-size: 1.05rem; }
.hdr__cta { display: flex; gap: 0.5rem; margin-left: auto; }
.hdr__btn {
  padding: 0.55rem 1rem; border-radius: 6px; border: 0;
  font-weight: 700; cursor: pointer; font-size: 0.9rem; letter-spacing: 0.02em;
}
.hdr__btn--primary { background: #facc15; color: #1e3a5f; }
.hdr__btn:not(.hdr__btn--primary) { background: #3aa691; color: #fff; }
.hdr__btn:hover { filter: brightness(1.1); }
.hdr__pills { display: flex; gap: 0.4rem; }
.hdr__pill {
  background: #2c5475; padding: 0.55rem 0.9rem; border-radius: 6px;
  font-size: 0.9rem;
}
.hdr__userbox { position: relative; }
.hdr__userbtn {
  background: #2c5475; color: #fff; border: 0; padding: 0.55rem 0.9rem;
  border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 0.95rem;
}
.hdr__menu {
  position: absolute; top: 110%; right: 0; background: #fff; color: #1e3a5f;
  border-radius: 6px; box-shadow: 0 4px 16px rgba(0,0,0,.15); min-width: 9rem;
  display: flex; flex-direction: column; padding: 0.3rem 0; z-index: 5;
}
.hdr__menuitem {
  background: none; border: 0; text-align: left; padding: 0.55rem 1rem;
  cursor: pointer; font-size: 0.95rem; color: inherit;
}
.hdr__menuitem:hover { background: #f1f5f9; }
```

Avatar SVG: keep simple — a tiny car silhouette inline. The exact design isn't critical for v1.

## Behavior details

- **Initial paint must be sync.** Render the logged-out state immediately on `mountHeader()` so there's no FOUC. Then update once fetches return.
- **Re-fetch on `auth-changed` event.** Listen on `document`. Re-run the same fetch logic and update DOM.
- **Outside-click closes the dropdown.** When `#hdr-menu` is shown, clicks anywhere else dismiss it.
- **Idempotent mount.** If `mountHeader` is called twice, clear `host.innerHTML` first. The integrator may rely on this.

## Implementation skeleton

```js
// public/src/header.js
import { getMe, getStatsByDevice } from "./stats-api.js";
import { generateHandle } from "./handles.js";

function getOrCreateAnonHandle() { /* see above */ }
function getDeviceId() { /* same pattern as runner.js will use */ }
function fmtTime(ms) { /* see above */ }

function renderShell(host) {
  host.innerHTML = `<div class="hdr"> ... </div>`;
}

function renderLoggedOutCta(ctaEl, anonHandle) {
  ctaEl.innerHTML = `
    <button class="hdr__btn hdr__btn--primary" id="hdr-create">CREATE ACCOUNT</button>
    <button class="hdr__btn" id="hdr-signin">SIGN IN</button>
  `;
  document.getElementById("hdr-create").onclick = () => document.dispatchEvent(new CustomEvent("open-signup"));
  document.getElementById("hdr-signin").onclick = () => document.dispatchEvent(new CustomEvent("open-signin"));
}

function renderLoggedInCta(ctaEl, username) { /* dropdown, dispatch events */ }
function setPills(best, races) { /* updates two pills */ }

async function refresh() {
  const me = await getMe().catch(() => null);
  if (me) {
    setNameDisplay(me.username);
    renderLoggedInCta(/* ... */);
    const best = pickBest(me.aggregates);
    setPills(best, me.aggregates.reduce((s, a) => s + a.races_played, 0));
  } else {
    setNameDisplay(getOrCreateAnonHandle());
    renderLoggedOutCta(/* ... */);
    const stats = await getStatsByDevice(getDeviceId()).catch(() => ({ total_races: 0, best_time_ms: null, best_difficulty: null }));
    setPills(stats, stats.total_races);
  }
}

function pickBest(aggs) {
  let best = null;
  for (const a of aggs) {
    if (a.best_time_ms != null && (!best || a.best_time_ms < best.best_time_ms)) {
      best = { best_time_ms: a.best_time_ms, best_difficulty: a.difficulty };
    }
  }
  return best;
}

export function mountHeader(host) {
  renderShell(host);
  refresh();
  document.addEventListener("auth-changed", refresh);
}
```

## Testing

UI tests for vanilla JS without a framework get expensive fast. For v1, do **smoke checks via manual testing** on `wrangler dev` (covered in Integration I4). Add a small `header.test.js` only if you'd reach for one anyway — your test budget is better spent on:

1. `pickBest` — pure function, write a test for: no aggregates have a best, only one does, multiple do (returns shortest).
2. `fmtTime` — pure function, edge cases: 0, 999, 60000, 65432.

Put these in `public/src/header.test.js`. Run via `node --test`.

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { _internals } from "./header.js"; // export _internals = { pickBest, fmtTime } at bottom of header.js for testing only

test("pickBest returns null when no best times", () => {
  const aggs = [
    { difficulty: "easy", best_time_ms: null },
    { difficulty: "medium", best_time_ms: null },
  ];
  assert.equal(_internals.pickBest(aggs), null);
});
test("pickBest picks shortest", () => {
  const aggs = [
    { difficulty: "easy", best_time_ms: 30000 },
    { difficulty: "medium", best_time_ms: 25000 },
  ];
  const r = _internals.pickBest(aggs);
  assert.equal(r.best_difficulty, "medium");
});
test("fmtTime formats", () => {
  assert.equal(_internals.fmtTime(48100), "0:48.1");
  assert.equal(_internals.fmtTime(null), "—");
});
```

## Milestones

- [ ] **M1 — Logged-out shell renders.** Commit: `M1: agent E — header logged-out shell with anon handle + pills`.
- [ ] **M2 — Logged-in state + dropdown.** Commit: `M2: agent E — header logged-in state with dropdown`.
- [ ] **M3 — Live data wiring + auth-changed listener + tests.** Commit: `M3: agent E — header data fetching + tests`.

## Definition of done

1. `mountHeader(host)` is exported and idempotent.
2. Header renders both states correctly when given a stub me/stats response (verify visually on `wrangler dev` — Foundation's stub me data lets you see logged-in state without real auth).
3. Buttons dispatch the documented events. **No direct calls into Agent F's module.**
4. `node --test public/src/header.test.js` passes.
5. CSS lives only in `public/css/header.css`. No edits to `style-a.css`.
6. No files outside allowlist touched.

## How the integrator uses your work

- **Integrator I2:** adds the host element `<header id="app-header">` to `index.html`, links `css/header.css`, calls `mountHeader(...)` from `main.js`.
- **Agent F:** listens for `open-signup`, `open-signin`, `request-signout` events you dispatch and binds them to auth flows. After auth state changes, dispatches `auth-changed`.

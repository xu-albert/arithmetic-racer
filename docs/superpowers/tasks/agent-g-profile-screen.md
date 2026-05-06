# Agent G — Profile Screen

**Spec:** `docs/superpowers/specs/2026-05-06-users-auth-stats-design.md`
**Plan:** `docs/superpowers/plans/2026-05-06-users-auth-stats-implementation.md`
**Reference:** sections 6.4, 6.7 of the spec.

---

## Mission

Render the personal profile screen: identity card, six stat tiles, account info box, and the latest race results table. Powered by `GET /api/me`. Username rename via `POST /api/me/username` with the same client-side validator used in the auth modal.

## Files you own

- `public/src/profile.js`
- `public/css/profile.css`

## Files you must NOT touch

`public/index.html`, `public/style-a.css`, `public/main.js`, anything in `worker/`, anything owned by another agent.

## Contract

You export:

```js
/**
 * Mount the profile screen into a host element. Idempotent.
 * Listens for `open-profile` event on document — when fired, fetches /api/me
 * and reveals the profile section.
 * @param {HTMLElement} host
 */
export function mountProfile(host);
```

The host element is a `<section id="profile" class="screen hidden">` provided by the integrator. Your code adds the `hidden` class back to hide it (other screens use the same pattern; check `style-a.css` for `.screen.hidden { display: none }` — it already exists).

## Interactions

1. On `open-profile` event: hide other screens (`#lobby`, `#race`, `#results`), show `#profile`, fetch fresh data, render.
2. Click the username pencil icon → open rename modal (your own, simple inline overlay — don't reuse Agent F's modal).
3. Click "Back to lobby" link → hide `#profile`, show `#lobby`.

To hide other screens, find them by selector and toggle `.hidden`. Don't hardcode their structure.

## Layout

```html
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

<!-- Rename overlay (rendered, hidden) -->
<div class="profile__rename" id="profile-rename" hidden>
  <div class="profile__rename-card">
    <h3>Change username</h3>
    <input type="text" id="profile-rename-input" />
    <span class="profile__rename-status"></span>
    <div class="profile__rename-actions">
      <button id="profile-rename-cancel">Cancel</button>
      <button id="profile-rename-save">Save</button>
    </div>
  </div>
</div>
```

## Data shaping

Use `getMe()` from `stats-api.js`. It returns:

```js
{
  username, email, created_at,
  aggregates: [{ difficulty, races_played, races_finished, best_time_ms, avg_accuracy, avg_problem_time_ms }],
  recent: [{ race_seq, difficulty, finish_time_ms, accuracy_pct, avg_time_per_problem_ms, played_at }],
}
```

Compute:
- **Headline avg/problem:** weighted avg of `avg_problem_time_ms` across difficulties, weighted by `races_played`. If total races is 0, show `—`.
- **Total Races:** sum of `races_played` across all difficulties.
- **Overall Accuracy:** weighted avg of `avg_accuracy` by `races_played`.
- **Finish Rate:** `sum(races_finished) / sum(races_played) * 100`.
- **Best Easy/Medium/Hard tiles:** `best_time_ms` from each difficulty, formatted as `m:ss.s`. Show `—` if null.

Format helpers (put in `profile.js`, not shared with header):

```js
function fmtMs(ms) {
  if (ms == null) return "—";
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60);
  const s = (totalSec - m * 60).toFixed(1);
  return `${m}:${String(s).padStart(4, "0")}`;
}
function fmtAvgMs(ms) {
  if (ms == null) return "—";
  return `${(ms / 1000).toFixed(1)}s`;
}
function fmtPct(p) {
  if (p == null) return "—";
  return `${Math.round(p)}%`;
}
function fmtRelative(iso) {
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  const h = Math.round(diff / 3_600_000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  return `${days}d ago`;
}
```

## Username rename

```js
import { validateUsernameSync } from "./username-validator-client.js";
import { setUsername } from "./stats-api.js";

async function trySaveUsername(newName) {
  const v = validateUsernameSync(newName);
  if (!v.valid) return { ok: false, message: errorText(v.reason) };
  try {
    await setUsername(newName);
    document.dispatchEvent(new Event("auth-changed"));
    return { ok: true };
  } catch (err) {
    return { ok: false, message: errorText(err.code) };
  }
}

function errorText(code) {
  switch (code) {
    case "taken": return "That name is already taken.";
    case "banned": return "That name isn't allowed.";
    case "reserved": return "That name is reserved.";
    case "invalid_format": return "Use 3-20 letters, digits, or underscores. Must start with a letter.";
    default: return "Something went wrong.";
  }
}
```

## CSS

`public/css/profile.css`. Match palette with header (deep blues, cream pills, etc). Layout uses CSS Grid for the six tiles row.

```css
.profile {
  max-width: 56rem;
  margin: 1rem auto;
  font-family: "Quicksand", system-ui, sans-serif;
  color: #1e3a5f;
}
.profile__back { display: inline-block; margin-bottom: 1rem; color: #2c5475; text-decoration: none; }
.profile__identity {
  display: grid; grid-template-columns: auto 1fr auto;
  gap: 1.2rem; align-items: center;
  background: #fff; padding: 1.4rem; border-radius: 10px;
  box-shadow: 0 2px 10px rgba(0,0,0,0.06);
}
.profile__avatar {
  width: 4rem; height: 4rem; background: #2c5475; border-radius: 8px;
}
.profile__username { display: flex; align-items: center; gap: .5rem; margin: 0; font-size: 1.4rem; }
.profile__edit { background: none; border: 0; cursor: pointer; font-size: 1.1rem; color: #64748b; }
.profile__edit:hover { color: #1e3a5f; }
.profile__email { color: #64748b; margin: .25rem 0 0; }
.profile__headline { text-align: right; }
.profile__headline #profile-headline-num { font-size: 2.2rem; font-weight: 800; color: #1e3a5f; }
.profile__headline-label { display: block; color: #64748b; font-size: .9rem; }

.profile__tiles {
  display: grid; grid-template-columns: repeat(6, 1fr);
  gap: .6rem; margin-top: 1rem;
}
.profile__tile { background: #1e3a5f; color: #fff; padding: 1rem; border-radius: 8px; text-align: center; }
.profile__tile-num { font-size: 1.4rem; font-weight: 700; }
.profile__tile-lbl { font-size: .85rem; opacity: .8; margin-top: .25rem; }

.profile__info-row {
  display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 1rem;
}
.profile__info-card { background: #1e3a5f; color: #fff; padding: 1rem; border-radius: 8px; }
.profile__info-card h3 { margin: 0 0 .6rem; font-size: 1rem; opacity: .9; }
.profile__avatar-btn { background: #2c5475; color: #fff; border: 0; padding: .55rem .9rem; border-radius: 6px; opacity: .6; cursor: not-allowed; }

.profile__races { background: #fff; margin-top: 1rem; padding: 1rem; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.06); }
.profile__table { width: 100%; border-collapse: collapse; }
.profile__table th, .profile__table td { padding: .55rem .4rem; border-bottom: 1px solid #e2e8f0; text-align: left; }
.profile__table th { font-weight: 600; color: #1e3a5f; }
.profile__empty { color: #64748b; }

.profile__rename {
  position: fixed; inset: 0; background: rgba(15,23,42,.55);
  display: grid; place-items: center; z-index: 80;
}
.profile__rename-card { background: #fff; padding: 1.4rem; border-radius: 10px; min-width: 22rem; }
.profile__rename-card input { width: 100%; padding: .55rem; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 1rem; }
.profile__rename-status { display: block; margin-top: .25rem; font-size: 0.85rem; }
.profile__rename-status.bad { color: #b91c1c; }
.profile__rename-status.ok { color: #15803d; }
.profile__rename-actions { display: flex; gap: .5rem; justify-content: flex-end; margin-top: .8rem; }
.profile__rename-actions button { padding: .55rem 1rem; border: 0; border-radius: 6px; font-weight: 600; cursor: pointer; }

@media (max-width: 600px) {
  .profile__tiles { grid-template-columns: repeat(2, 1fr); }
  .profile__info-row { grid-template-columns: 1fr; }
  .profile__identity { grid-template-columns: 1fr; text-align: center; }
}
```

## Testing

Pure functions only — DOM tests skip:

```js
// public/src/profile.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { _internals } from "./profile.js";

test("fmtMs basic", () => {
  assert.equal(_internals.fmtMs(48100), "0:48.1");
  assert.equal(_internals.fmtMs(null), "—");
});
test("computeHeadline weights by races_played", () => {
  const aggs = [
    { races_played: 4, avg_problem_time_ms: 1100 },
    { races_played: 1, avg_problem_time_ms: 5000 },
  ];
  // (4*1100 + 1*5000) / 5 = 1880
  assert.equal(_internals.computeHeadlineMs(aggs), 1880);
});
test("computeHeadline returns null when no races", () => {
  assert.equal(_internals.computeHeadlineMs([{ races_played: 0, avg_problem_time_ms: 0 }]), null);
});
```

(Export `_internals = { fmtMs, computeHeadlineMs, fmtPct, ... }` from `profile.js` for testing.)

## Milestones

- [ ] **M1 — Render shell + format helpers + tests pass.** Commit: `M1: agent G — profile screen shell + pure helpers`.
- [ ] **M2 — Live data wiring (`open-profile` event, fetch + render).** Commit: `M2: agent G — profile data fetching and rendering`.
- [ ] **M3 — Username rename overlay.** Commit: `M3: agent G — username rename overlay with validation`.

## Definition of done

1. `mountProfile(host)` is exported and idempotent.
2. Profile screen hides on mount; appears on `open-profile` event.
3. All six tiles + headline + info row + race table populate from `/api/me`.
4. Username rename works end-to-end: validates client-side, calls `setUsername`, dispatches `auth-changed`.
5. `node --test public/src/profile.test.js` passes.
6. CSS lives only in `public/css/profile.css`.
7. No files outside allowlist touched.

## How the integrator uses your work

- **Integrator I2:** ensures `<section id="profile" class="screen hidden">` exists in `index.html`, links `css/profile.css`, calls `mountProfile(...)` from `main.js`.
- **Agent E (header):** dispatches `open-profile` event when the user clicks Profile in the dropdown.
- **Agent F (auth modal):** dispatches `auth-changed` after auth transitions; profile listens to refresh data.

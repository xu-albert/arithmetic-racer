# Users + Auth + Stats — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase A of the users feature: login (Google OAuth + email/password), per-race stats persistence, anonymous→registered claim flow, and a personal profile screen — all on Cloudflare Workers + D1 + better-auth.

**Architecture:** All-Cloudflare. Static assets + Worker on the same domain. better-auth handles auth + sessions; D1 stores users, sessions, race results. Resend sends welcome + password-reset emails. Pure-function username validator runs both client- and server-side.

**Tech Stack:** Cloudflare Workers, D1, wrangler, better-auth, obscenity, Resend, vitest-pool-workers (Miniflare-backed integration tests), vanilla JS frontend.

**Spec:** `docs/superpowers/specs/2026-05-06-users-auth-stats-design.md`

---

## How this plan is executed

The plan splits into three phases:

1. **Phase 1 — Foundation (sequential, single executor):** sets up dependencies, D1, migrations, type contracts, route stubs. Detailed in this file.
2. **Phase 2 — Parallel build (7 agents, independent):** each agent owns a small set of files and implements one slice. Detailed in `docs/superpowers/tasks/agent-{a..g}-*.md`.
3. **Phase 3 — Integration (sequential, single executor):** wires the slices into the entry points (`worker/index.js`, `public/index.html`), runs full integration tests, and verifies the auth flows on `wrangler dev`. Detailed in this file.

The user has explicitly asked that no agents be launched yet — these instructions are written to file only.

---

## File ownership map

The Foundation phase scaffolds these files. Phase 2 agents fill them in. Phase 3 wires the entry points. **No two agents own the same file** — entry points are owned by Foundation/Integration, not by parallel agents.

```
arithmetic-racer/
├── package.json                                  Foundation (deps), Integrator (scripts)
├── wrangler.jsonc                                Foundation
├── vitest.config.js                              Foundation
├── .dev.vars                                     Foundation (gitignored)
├── .gitignore                                    Foundation (append .dev.vars)
├── migrations/
│   ├── 0001_better_auth.sql                      Foundation (generated)
│   └── 0002_username_and_race_results.sql        Foundation (hand-written)
├── docs/
│   ├── superpowers/specs/...                     (already written)
│   ├── superpowers/plans/...                     (this file)
│   └── superpowers/tasks/...                     (per-agent briefs)
├── worker/
│   ├── index.js                                  Foundation (skeleton), Integrator (final routing)
│   ├── api-contracts.js                          Foundation (frozen types/JSDoc)
│   ├── db.js                                     Foundation (D1 helpers)
│   ├── auth.js                                   Agent D
│   ├── email.js                                  Agent D
│   ├── username-validator.js                     Agent A
│   └── routes/
│       ├── race-result.js                        Agent B
│       ├── me.js                                 Agent C
│       ├── race-result.test.js                   Agent B
│       ├── me.test.js                            Agent C
│       └── username-validator.test.js            Agent A
└── public/
    ├── index.html                                Integrator (already exists; modal/header injection points only)
    ├── style-a.css                               Integrator (existing styles only)
    ├── reset-password.html                       Agent D
    ├── css/
    │   ├── header.css                            Agent E
    │   ├── auth-modal.css                        Agent F
    │   ├── profile.css                           Agent G
    │   └── reset-password.css                    Agent D
    └── src/
        ├── main.js                               Integrator (already exists; minor wiring)
        ├── ui.js                                 Integrator (existing race UI)
        ├── runner.js                             Integrator (POSTs race-result)
        ├── auth.js                               Agent F (better-auth client wrapper)
        ├── stats-api.js                          Foundation (skeleton), Agent G owns final shape
        ├── header.js                             Agent E
        ├── profile.js                            Agent G
        ├── username-validator-client.js          Agent A
        └── username-validator-client.test.js     Agent A
```

**Forbidden zone for parallel agents:** `worker/index.js`, `public/index.html`, `public/style-a.css`, `public/main.js`, `public/src/ui.js`, `public/src/runner.js`. These are entry points; only Foundation and Integration touch them.

---

## Phase 1 — Foundation (sequential)

Goal: produce a working `wrangler dev` with D1 attached, all migrations applied, and stub routes returning mock data that matches the contracts in `worker/api-contracts.js`. After Phase 1, all 7 parallel agents can start simultaneously without blocking each other.

### Task F1: Add dependencies

**Files:** Modify `package.json`.

- [ ] **Step 1: Install runtime + dev deps**

Run:
```bash
npm install better-auth obscenity uuid
npm install -D wrangler vitest @cloudflare/vitest-pool-workers @cloudflare/workers-types
```

- [ ] **Step 2: Verify `package.json` contains the deps**

`cat package.json` and confirm all six entries appear under `dependencies` / `devDependencies`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "Add better-auth, obscenity, wrangler, vitest deps"
```

### Task F2: Create D1 database

**Files:** Modify `wrangler.jsonc`.

- [ ] **Step 1: Create the D1 database**

Run: `npx wrangler d1 create arithmetic-racer`

Capture the resulting `database_id` from stdout — needed in `wrangler.jsonc`.

- [ ] **Step 2: Update `wrangler.jsonc`**

Replace contents with:
```jsonc
{
  "name": "arithmetic-racer",
  "main": "worker/index.js",
  "compatibility_date": "2026-05-06",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "./public",
    "binding": "ASSETS"
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "arithmetic-racer",
      "database_id": "<paste-id-from-step-1>"
    }
  ]
}
```

- [ ] **Step 3: Commit**

```bash
git add wrangler.jsonc
git commit -m "Wire wrangler.jsonc to Worker entry + D1 binding"
```

### Task F3: Generate better-auth schema migration

**Files:** Create `worker/auth-config-stub.js`, `migrations/0001_better_auth.sql`.

- [ ] **Step 1: Write a minimal config stub** that better-auth's CLI can read to generate the schema. (Agent D will replace this with the real config later.)

Create `worker/auth-config-stub.js`:
```js
import { betterAuth } from "better-auth";

export const auth = betterAuth({
  database: { provider: "sqlite" },
  emailAndPassword: { enabled: true },
  socialProviders: {
    google: { clientId: "stub", clientSecret: "stub" },
  },
});
```

- [ ] **Step 2: Run better-auth's schema generator**

Run: `npx @better-auth/cli generate --output migrations/0001_better_auth.sql --config worker/auth-config-stub.js`

(If the CLI command name differs in the installed version, use `npx @better-auth/cli --help` to find the right subcommand. The output must be a SQL file at `migrations/0001_better_auth.sql`.)

- [ ] **Step 3: Verify the migration file** contains `CREATE TABLE` statements for `user`, `account`, `session`, `verification`.

- [ ] **Step 4: Commit**

```bash
git add migrations/0001_better_auth.sql worker/auth-config-stub.js
git commit -m "Generate better-auth schema migration"
```

### Task F4: Write race_results + username migration

**Files:** Create `migrations/0002_username_and_race_results.sql`.

- [ ] **Step 1: Write the migration**

```sql
-- Add username column to user table
ALTER TABLE user ADD COLUMN username TEXT UNIQUE;

-- Race results table
CREATE TABLE race_results (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
  device_id TEXT NOT NULL,
  difficulty TEXT NOT NULL CHECK (difficulty IN ('easy','medium','hard')),
  finished INTEGER NOT NULL CHECK (finished IN (0,1)),
  finish_time_ms INTEGER,
  problems_total INTEGER NOT NULL DEFAULT 20,
  problems_correct INTEGER NOT NULL,
  problems_attempted INTEGER NOT NULL,
  avg_time_per_problem_ms INTEGER NOT NULL,
  accuracy_pct REAL NOT NULL,
  longest_streak INTEGER NOT NULL,
  played_at INTEGER NOT NULL
);

CREATE INDEX idx_race_results_user_played ON race_results (user_id, played_at DESC);
CREATE INDEX idx_race_results_anon_device ON race_results (device_id) WHERE user_id IS NULL;
```

- [ ] **Step 2: Apply migrations locally**

Run:
```bash
npx wrangler d1 migrations apply arithmetic-racer --local
```

Expected: both migrations applied successfully.

- [ ] **Step 3: Verify schema with a SELECT**

Run:
```bash
npx wrangler d1 execute arithmetic-racer --local --command="SELECT name FROM sqlite_master WHERE type='table';"
```

Expected: list includes `user`, `account`, `session`, `verification`, `race_results`.

- [ ] **Step 4: Commit**

```bash
git add migrations/0002_username_and_race_results.sql
git commit -m "Add username column and race_results table"
```

### Task F5: Write API contracts file

**Files:** Create `worker/api-contracts.js`.

This file is **read-only after Foundation.** Both backend route handlers and frontend code import these JSDoc types so the contract is authoritative. Any contract change requires an integrator review.

- [ ] **Step 1: Write the contracts file**

```js
// API contracts. DO NOT MODIFY without coordinating with all consumers.
// All endpoints are mounted under the same origin as the static assets.

/**
 * @typedef {'easy'|'medium'|'hard'} Difficulty
 */

/**
 * POST /api/race-result
 * Body: RaceResultInput
 * Response: { id: string, claimed: boolean }
 *
 * @typedef {Object} RaceResultInput
 * @property {string} device_id        UUID v4 from localStorage
 * @property {Difficulty} difficulty
 * @property {boolean} finished
 * @property {number|null} finish_time_ms
 * @property {number} problems_total   default 20
 * @property {number} problems_correct
 * @property {number} problems_attempted
 * @property {number} avg_time_per_problem_ms
 * @property {number} accuracy_pct      0..100
 * @property {number} longest_streak
 */

/**
 * GET /api/me  (requires session cookie)
 * Response: MeResponse
 *
 * @typedef {Object} MeResponse
 * @property {string} username
 * @property {string} email
 * @property {string} created_at         ISO 8601
 * @property {DifficultyAggregates[]} aggregates
 * @property {RaceListItem[]} recent
 *
 * @typedef {Object} DifficultyAggregates
 * @property {Difficulty} difficulty
 * @property {number} races_played
 * @property {number} races_finished
 * @property {number|null} best_time_ms
 * @property {number} avg_accuracy
 * @property {number} avg_problem_time_ms
 *
 * @typedef {Object} RaceListItem
 * @property {number} race_seq
 * @property {Difficulty} difficulty
 * @property {number|null} finish_time_ms
 * @property {number} accuracy_pct
 * @property {number} avg_time_per_problem_ms
 * @property {string} played_at          ISO 8601
 */

/**
 * POST /api/me/username  (requires session cookie)
 * Body: { username: string }
 * Response (200): { username: string }
 * Response (400): { error: 'taken' | 'banned' | 'invalid_format' }
 */

/**
 * GET /api/stats/by-device/:device_id   (no auth)
 * Response: ByDeviceStats
 *
 * @typedef {Object} ByDeviceStats
 * @property {number} total_races
 * @property {number|null} best_time_ms
 * @property {Difficulty|null} best_difficulty
 */

export {};
```

- [ ] **Step 2: Commit**

```bash
git add worker/api-contracts.js
git commit -m "Freeze API contracts for Phase A"
```

### Task F6: Worker entry skeleton with stub routes

**Files:** Create `worker/index.js`, `worker/db.js`.

The skeleton mounts a router that returns hardcoded mock data matching the contracts. Frontend agents can dev against this without any backend agent finishing.

- [ ] **Step 1: Write `worker/db.js`**

```js
// Tiny D1 helper layer used by all routes.
export function db(env) {
  return env.DB;
}
```

- [ ] **Step 2: Write `worker/index.js` skeleton**

```js
// Worker entry. Stub routes return mock data shaped per worker/api-contracts.js.
// Replace stubs with real handlers in Phase 3 (Integration).

const STUB_ME = {
  username: "BraveOtter",
  email: "demo@example.com",
  created_at: "2026-01-01T00:00:00.000Z",
  aggregates: [
    { difficulty: "easy",   races_played: 4, races_finished: 4, best_time_ms: 23400, avg_accuracy: 98, avg_problem_time_ms: 1100 },
    { difficulty: "medium", races_played: 2, races_finished: 2, best_time_ms: 48100, avg_accuracy: 91, avg_problem_time_ms: 2400 },
    { difficulty: "hard",   races_played: 1, races_finished: 1, best_time_ms: 72000, avg_accuracy: 84, avg_problem_time_ms: 3600 },
  ],
  recent: [
    { race_seq: 7, difficulty: "hard",   finish_time_ms: 72000, accuracy_pct: 84, avg_time_per_problem_ms: 3600, played_at: "2026-05-06T19:00:00.000Z" },
  ],
};

const STUB_BY_DEVICE = { total_races: 0, best_time_ms: null, best_difficulty: null };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/api/race-result" && request.method === "POST") {
      return Response.json({ id: crypto.randomUUID(), claimed: false });
    }
    if (pathname === "/api/me" && request.method === "GET") {
      return Response.json(STUB_ME);
    }
    if (pathname === "/api/me/username" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      return Response.json({ username: body.username ?? "BraveOtter" });
    }
    if (pathname.startsWith("/api/stats/by-device/") && request.method === "GET") {
      return Response.json(STUB_BY_DEVICE);
    }
    if (pathname.startsWith("/api/auth/")) {
      // Auth routes will be mounted by Agent D's worker/auth.js. Until then, 501.
      return new Response("auth not yet wired", { status: 501 });
    }

    // Fall through to static assets.
    return env.ASSETS.fetch(request);
  },
};
```

- [ ] **Step 3: Verify `wrangler dev` boots**

Run: `npx wrangler dev`

In another terminal:
```bash
curl http://localhost:8787/api/me
```
Expected: returns the STUB_ME JSON.
```bash
curl http://localhost:8787/
```
Expected: returns the existing `index.html`.

- [ ] **Step 4: Commit**

```bash
git add worker/index.js worker/db.js
git commit -m "Worker entry skeleton with stub routes per api-contracts"
```

### Task F7: stats-api.js skeleton

**Files:** Create `public/src/stats-api.js`.

A minimal client wrapper so frontend agents can call the API. Agent G may extend this; the function names and return shapes are frozen by `worker/api-contracts.js`.

- [ ] **Step 1: Write the skeleton**

```js
// Wrapper for /api/* endpoints. Shapes match worker/api-contracts.js.

export async function postRaceResult(input) {
  const res = await fetch("/api/race-result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`race-result ${res.status}`);
  return res.json();
}

export async function getMe() {
  const res = await fetch("/api/me", { credentials: "include" });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`me ${res.status}`);
  return res.json();
}

export async function setUsername(username) {
  const res = await fetch("/api/me/username", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ username }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(`username ${res.status}`);
    err.code = body.error;
    throw err;
  }
  return res.json();
}

export async function getStatsByDevice(deviceId) {
  const res = await fetch(`/api/stats/by-device/${encodeURIComponent(deviceId)}`);
  if (!res.ok) throw new Error(`by-device ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: Commit**

```bash
git add public/src/stats-api.js
git commit -m "Add stats-api client wrapper"
```

### Task F8: Test runner config

**Files:** Create `vitest.config.js`. Modify `package.json` (test script).

- [ ] **Step 1: Write `vitest.config.js`**

```js
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
      },
    },
  },
});
```

- [ ] **Step 2: Update `package.json` scripts**

Replace `scripts` block:
```jsonc
{
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "node --test public/src/*.test.js && vitest run"
  }
}
```

- [ ] **Step 3: Verify both test runners pass with no tests yet**

Run: `npm test`

Expected: existing node:test tests pass; vitest reports "No test files found" but exits 0 (or use a placeholder if it errors).

- [ ] **Step 4: Commit**

```bash
git add vitest.config.js package.json
git commit -m "Add vitest-pool-workers config and unify npm test"
```

### Task F9: Local secrets file

**Files:** Create `.dev.vars`. Modify `.gitignore`.

- [ ] **Step 1: Add `.dev.vars` to .gitignore**

Append to `.gitignore`:
```
.dev.vars
```

- [ ] **Step 2: Create `.dev.vars` with placeholders**

```
GOOGLE_CLIENT_ID=replace_me
GOOGLE_CLIENT_SECRET=replace_me
RESEND_API_KEY=replace_me
BETTER_AUTH_SECRET=$(openssl rand -base64 32 -- generate one and paste)
```

(User will fill in real values before testing auth flows.)

- [ ] **Step 3: Commit (only the gitignore change)**

```bash
git add .gitignore
git commit -m "Ignore local .dev.vars secrets file"
```

---

## Phase 2 — Parallel agents

Once Foundation completes, dispatch the following 7 agents. Each has its own brief in `docs/superpowers/tasks/`. Agents have **no shared file ownership** — all coordination happens through `worker/api-contracts.js` (frozen) and the contracts in their briefs.

| Agent | Brief | Owns |
|-------|-------|------|
| A | `tasks/agent-a-username-validator.md` | `worker/username-validator.js`, `public/src/username-validator-client.js`, both `.test.js` files |
| B | `tasks/agent-b-race-result-api.md` | `worker/routes/race-result.js`, `worker/routes/race-result.test.js` |
| C | `tasks/agent-c-profile-api.md` | `worker/routes/me.js`, `worker/routes/me.test.js` |
| D | `tasks/agent-d-auth-email.md` | `worker/auth.js`, `worker/email.js`, `public/reset-password.html`, `public/css/reset-password.css` |
| E | `tasks/agent-e-header-ui.md` | `public/src/header.js`, `public/css/header.css` |
| F | `tasks/agent-f-auth-modal.md` | `public/src/auth.js`, `public/css/auth-modal.css` |
| G | `tasks/agent-g-profile-screen.md` | `public/src/profile.js`, `public/css/profile.css` |

**Dependency note:** Agents A-G are written to depend only on the Foundation outputs. None depend on each other's code. Each writes a small README-shaped section in its commit messages so the integrator can verify outputs.

---

## Phase 3 — Integration (sequential)

After all agents have committed their work, the integrator runs through this phase. Each step assumes the agent slices exist on the same branch.

### Task I1: Replace `worker/index.js` stubs with real routes

**Files:** Modify `worker/index.js`.

- [ ] **Step 1: Import the real handlers**

```js
import { handleRaceResult } from "./routes/race-result.js";
import { handleGetMe, handlePostUsername, handleByDevice } from "./routes/me.js";
import { auth } from "./auth.js";
```

- [ ] **Step 2: Replace stubs with real calls**

```js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname.startsWith("/api/auth/")) {
      return auth.handler(request, env);
    }
    if (pathname === "/api/race-result" && request.method === "POST") {
      return handleRaceResult(request, env);
    }
    if (pathname === "/api/me" && request.method === "GET") {
      return handleGetMe(request, env);
    }
    if (pathname === "/api/me/username" && request.method === "POST") {
      return handlePostUsername(request, env);
    }
    if (pathname.startsWith("/api/stats/by-device/") && request.method === "GET") {
      return handleByDevice(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
```

- [ ] **Step 3: Run integration tests**

Run: `npm test`
Expected: all tests from agents A, B, C pass against the real routes.

- [ ] **Step 4: Commit**

```bash
git add worker/index.js
git commit -m "Wire real handlers into Worker entry"
```

### Task I2: Wire `index.html` for header, modals, profile

**Files:** Modify `public/index.html`. Modify `public/main.js`.

- [ ] **Step 1: Add CSS links to `<head>`**

```html
<link rel="stylesheet" href="css/header.css" />
<link rel="stylesheet" href="css/auth-modal.css" />
<link rel="stylesheet" href="css/profile.css" />
```

- [ ] **Step 2: Add header injection point** (replace the existing `<header>` content):

```html
<header class="app-header" id="app-header">
  <!-- header.js renders into here -->
</header>
```

- [ ] **Step 3: Add modal + profile section shells before `</main>`**

```html
<section id="profile" class="screen hidden">
  <!-- profile.js renders into here -->
</section>
<div id="auth-modal-root"></div>
```

- [ ] **Step 4: Update `public/main.js` to wire the new modules**

```js
import { mountHeader } from "./src/header.js";
import { mountAuthModal } from "./src/auth.js";
import { mountProfile } from "./src/profile.js";

mountHeader(document.getElementById("app-header"));
mountAuthModal(document.getElementById("auth-modal-root"));
mountProfile(document.getElementById("profile"));
```

(Existing race/lobby imports stay as they are.)

- [ ] **Step 5: Smoke test on `wrangler dev`**

Run: `npx wrangler dev`
Open http://localhost:8787/. Verify header renders with logged-out state.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/main.js
git commit -m "Wire header, auth modal, profile screen into main entry"
```

### Task I3: POST race-result from runner

**Files:** Modify `public/src/runner.js`.

- [ ] **Step 1: Import the API client**

```js
import { postRaceResult } from "./stats-api.js";
```

- [ ] **Step 2: Ensure a device_id exists**

Add at module top:
```js
function getDeviceId() {
  let id = localStorage.getItem("deviceId");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("deviceId", id);
  }
  return id;
}
```

- [ ] **Step 3: At race finish, call postRaceResult**

After the race completes (find the existing finish handler):
```js
postRaceResult({
  device_id: getDeviceId(),
  difficulty,
  finished: true,
  finish_time_ms: elapsed,
  problems_total: 20,
  problems_correct: stats.correct,
  problems_attempted: stats.attempted,
  avg_time_per_problem_ms: Math.round(elapsed / Math.max(1, stats.attempted)),
  accuracy_pct: stats.attempted ? (stats.correct / stats.attempted) * 100 : 0,
  longest_streak: stats.longestStreak,
}).catch((err) => console.warn("race-result post failed", err));
```

(Add a similar block in the quit handler with `finished: false, finish_time_ms: null`.)

- [ ] **Step 4: Verify on `wrangler dev`**

Race once. Check `npx wrangler d1 execute arithmetic-racer --local --command="SELECT * FROM race_results"`.
Expected: one row, `user_id NULL`, `device_id` set.

- [ ] **Step 5: Commit**

```bash
git add public/src/runner.js
git commit -m "POST race-result from runner on finish/quit"
```

### Task I4: Manual auth flow E2E

This is **manual testing**, not a code task. Run on `wrangler dev` with real Google OAuth + Resend keys.

- [ ] **Step 1: Configure Google OAuth**

- Create OAuth 2.0 Client ID at `console.cloud.google.com`, app type Web.
- Authorized redirect URIs: `http://localhost:8787/api/auth/callback/google` and the production URL once known.
- Copy client ID + secret into `.dev.vars`.

- [ ] **Step 2: Configure Resend**

- Generate API key at `resend.com`.
- Paste into `.dev.vars` as `RESEND_API_KEY`.
- For local dev, the unverified-domain restriction (sender = onboarding@resend.dev) is fine.

- [ ] **Step 3: Walk every flow on `wrangler dev`**

- [ ] Anonymous race → POST visible in D1.
- [ ] Sign up email/password → confirm email field works → welcome email arrives → claim updates anon race.
- [ ] Sign up with Google → username modal blocks lobby → claim runs after username set.
- [ ] Log out → log in (email/password) → session restored.
- [ ] Forgot password → reset email arrives → reset page works → logged in.
- [ ] Profile screen renders all sections, recent races correct.
- [ ] Username rename → uniqueness, profanity, success cases.

- [ ] **Step 4: Capture issues** in a follow-up TODO list. Fix or escalate.

### Task I5: Deploy to production

- [ ] **Step 1: Set production secrets**

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put BETTER_AUTH_SECRET
```

- [ ] **Step 2: Apply migrations remotely**

```bash
npx wrangler d1 migrations apply arithmetic-racer --remote
```

- [ ] **Step 3: Deploy**

```bash
npx wrangler deploy
```

- [ ] **Step 4: Smoke test production URL**

Walk the same flows as I4 on the deployed URL. Update Google OAuth redirect URIs to include the prod domain.

---

## Self-review

**Spec coverage:**
- §1 In/out of scope → covered by phase split (Phase A only)
- §2 Stack decision → Foundation tasks F1-F2
- §3 Architecture → Worker entry F6 + Integration I1
- §4 Schema → Foundation F3-F4
- §5 Auth flows → Agent D + Integration I4 manual
- §6 UI → Agents E, F, G + Integration I2
- §7 Testing → F8 + agent test files + I4 manual
- §9 Future work → not in plan (correct; deferred)

**Placeholders:** Resend API key step instructs the user to paste in their key — that's expected runtime config, not a plan placeholder. better-auth's exact CLI subcommand is verified at run time (F3 step 2 calls out `--help` if it differs). No "TBD" / "TODO" / "fill in details" in the plan.

**Type consistency:** `MeResponse.aggregates` and `MeResponse.recent` shapes are referenced by agent C and agent G — consistent. `RaceResultInput` is referenced by agent B's contract and runner.js step in I3 — consistent.

---

## Execution mode

The user has explicitly said: prepare instructions, do not launch agents. Skipping the standard "subagent-driven vs inline" prompt. When the user gives the go-ahead, the recommended path is:

1. Create the worktree per `superpowers:using-git-worktrees`.
2. Inside the worktree, complete Phase 1 (Foundation) sequentially.
3. Dispatch Phase 2 agents in parallel using `superpowers:dispatching-parallel-agents`.
4. After all agents merge, the main session executes Phase 3 (Integration) sequentially.

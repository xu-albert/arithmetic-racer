# Agent C — Profile API

**Spec:** `docs/superpowers/specs/2026-05-06-users-auth-stats-design.md`
**Plan:** `docs/superpowers/plans/2026-05-06-users-auth-stats-implementation.md`
**API contracts:** `worker/api-contracts.js` (frozen)

---

## Mission

Implement three read/write endpoints that power the profile screen and the logged-out header pills:

- `GET /api/me` — own profile (aggregates per difficulty + last 10 races).
- `POST /api/me/username` — rename, with full validation.
- `GET /api/stats/by-device/:device_id` — anonymous header stats.

## Files you own

- `worker/routes/me.js`
- `worker/routes/me.test.js`

## Files you must NOT touch

Anything else. Specifically: `worker/index.js`, `worker/routes/race-result.js`, `worker/auth.js`, anything in `public/`.

## Contract

From `worker/api-contracts.js`:

**`GET /api/me`** — requires session cookie. Returns `MeResponse`:

```js
{
  username: string,
  email: string,
  created_at: string,           // ISO 8601
  aggregates: [
    {
      difficulty: 'easy'|'medium'|'hard',
      races_played: number,
      races_finished: number,
      best_time_ms: number | null,
      avg_accuracy: number,            // 0..100
      avg_problem_time_ms: number,
    },
  ],
  recent: [
    {
      race_seq: number,                 // 1-based per-user counter
      difficulty: 'easy'|'medium'|'hard',
      finish_time_ms: number | null,
      accuracy_pct: number,
      avg_time_per_problem_ms: number,
      played_at: string,                // ISO 8601
    },
  ],
}
```

- Returns 401 if no session.
- `aggregates` always contains exactly 3 entries (one per difficulty), even if no races for that difficulty (zeros / null best_time).

**`POST /api/me/username`** — requires session.
- Body: `{ username: string }`
- 200: `{ username: string }`
- 400: `{ error: 'banned' | 'reserved' | 'invalid_format' | 'taken' }`
- 401: no session.

**`GET /api/stats/by-device/:device_id`** — no auth.
Returns `ByDeviceStats`:
```js
{ total_races: number, best_time_ms: number | null, best_difficulty: 'easy'|'medium'|'hard' | null }
```
- 200 always (a device with no rows returns zeros).
- Only counts rows where `user_id IS NULL` (post-claim, the device has handed off its history; the pills should show what the *current anonymous* session has accumulated).

## Implementation sketch

```js
// worker/routes/me.js
import { db } from "../db.js";
import { validateUsernameSync } from "../username-validator.js";

const DIFFICULTIES = ["easy", "medium", "hard"];

async function readUserId(request, env) {
  // INTEGRATION NOTE: replace with `auth.api.getSession({ headers: request.headers })`.
  // For Phase 2, returns null so tests can pass an explicit user via a helper.
  return null;
}

export async function handleGetMe(request, env) {
  const userId = await readUserId(request, env);
  if (!userId) return new Response("unauthorized", { status: 401 });

  const userRow = await db(env)
    .prepare("SELECT username, email, created_at FROM user WHERE id = ?")
    .bind(userId)
    .first();
  if (!userRow) return new Response("not found", { status: 404 });

  const { results: aggRows } = await db(env)
    .prepare(
      `SELECT difficulty,
              COUNT(*) AS races_played,
              SUM(CASE WHEN finished = 1 THEN 1 ELSE 0 END) AS races_finished,
              MIN(CASE WHEN finished = 1 THEN finish_time_ms END) AS best_time_ms,
              AVG(accuracy_pct) AS avg_accuracy,
              AVG(avg_time_per_problem_ms) AS avg_problem_time_ms
         FROM race_results
        WHERE user_id = ?
        GROUP BY difficulty`
    )
    .bind(userId)
    .all();

  const byDifficulty = new Map(aggRows.map((r) => [r.difficulty, r]));
  const aggregates = DIFFICULTIES.map((d) => {
    const r = byDifficulty.get(d);
    if (!r) return { difficulty: d, races_played: 0, races_finished: 0, best_time_ms: null, avg_accuracy: 0, avg_problem_time_ms: 0 };
    return {
      difficulty: d,
      races_played: r.races_played,
      races_finished: r.races_finished,
      best_time_ms: r.best_time_ms ?? null,
      avg_accuracy: r.avg_accuracy ?? 0,
      avg_problem_time_ms: Math.round(r.avg_problem_time_ms ?? 0),
    };
  });

  const { results: recentRows } = await db(env)
    .prepare(
      `SELECT difficulty, finish_time_ms, accuracy_pct,
              avg_time_per_problem_ms, played_at,
              ROW_NUMBER() OVER (ORDER BY played_at) AS race_seq
         FROM race_results
        WHERE user_id = ?
        ORDER BY played_at DESC
        LIMIT 10`
    )
    .bind(userId)
    .all();

  const recent = recentRows.map((r) => ({
    race_seq: r.race_seq,
    difficulty: r.difficulty,
    finish_time_ms: r.finish_time_ms,
    accuracy_pct: r.accuracy_pct,
    avg_time_per_problem_ms: r.avg_time_per_problem_ms,
    played_at: new Date(r.played_at).toISOString(),
  }));

  return Response.json({
    username: userRow.username ?? "",
    email: userRow.email,
    created_at: new Date(userRow.created_at).toISOString(),
    aggregates,
    recent,
  });
}

export async function handlePostUsername(request, env) {
  const userId = await readUserId(request, env);
  if (!userId) return new Response("unauthorized", { status: 401 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid_format" }, { status: 400 }); }
  const { username } = body ?? {};

  const result = validateUsernameSync(username);
  if (!result.valid) {
    return Response.json({ error: result.reason }, { status: 400 });
  }

  // Uniqueness check (case-insensitive)
  const collision = await db(env)
    .prepare("SELECT id FROM user WHERE LOWER(username) = LOWER(?) AND id != ?")
    .bind(username, userId)
    .first();
  if (collision) return Response.json({ error: "taken" }, { status: 400 });

  await db(env)
    .prepare("UPDATE user SET username = ? WHERE id = ?")
    .bind(username, userId)
    .run();

  return Response.json({ username });
}

export async function handleByDevice(request, env) {
  const url = new URL(request.url);
  const deviceId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  if (!deviceId) return Response.json({ total_races: 0, best_time_ms: null, best_difficulty: null });

  const row = await db(env)
    .prepare(
      `SELECT COUNT(*) AS total_races,
              MIN(CASE WHEN finished = 1 THEN finish_time_ms END) AS best_time_ms,
              (SELECT difficulty FROM race_results
                WHERE user_id IS NULL AND device_id = ? AND finished = 1
                ORDER BY finish_time_ms ASC LIMIT 1) AS best_difficulty
         FROM race_results
        WHERE user_id IS NULL AND device_id = ?`
    )
    .bind(deviceId, deviceId)
    .first();

  return Response.json({
    total_races: row?.total_races ?? 0,
    best_time_ms: row?.best_time_ms ?? null,
    best_difficulty: row?.best_difficulty ?? null,
  });
}
```

## Testing

Use `vitest-pool-workers`. Foundation has D1 wired into the test env. To inject a user_id without a real session, expose a test override:

```js
// worker/routes/me.js, near the readUserId stub:
let TEST_USER_ID_OVERRIDE = null;
export function _setTestUserId(id) { TEST_USER_ID_OVERRIDE = id; } // INTEGRATION NOTE: remove when auth.js is wired
async function readUserId(request, env) {
  if (TEST_USER_ID_OVERRIDE !== null) return TEST_USER_ID_OVERRIDE;
  return null;
}
```

The integrator removes this override and the export when wiring real auth. Until then, tests can set it.

**Required test cases:**

1. **GET /api/me unauthorized** — no override → 401.
2. **GET /api/me empty** — user exists, no race_results → aggregates has 3 entries with zeros, recent is `[]`.
3. **GET /api/me with mixed history** — seed 5 races (mix of difficulties, mix of finished/quit), assert aggregate counts, best times only count finished races, recent returns 10-or-fewer ordered by played_at DESC.
4. **POST /api/me/username happy path** — valid name → 200, DB row updated.
5. **POST /api/me/username taken** — seed another user with that name → 400 `taken`.
6. **POST /api/me/username banned** — pass a name the validator rejects → 400 `banned`.
7. **GET /api/stats/by-device empty** — never raced → `{ total_races: 0, best_time_ms: null, best_difficulty: null }`.
8. **GET /api/stats/by-device with rows** — seed 3 anon races on `dev-1`, 1 on `dev-2`. Query `dev-1` → returns 3 + best time + best difficulty. Query `dev-2` → returns 1.
9. **GET /api/stats/by-device claimed** — seed an anon race, then UPDATE to set user_id. Re-query → returns zeros (claimed rows excluded).

Helper to seed users + races:

```js
async function seedUser(env, { id, email, username }) {
  await env.DB.prepare(
    "INSERT INTO user (id, email, email_verified, created_at, updated_at, username) VALUES (?,?,0,?,?,?)"
  ).bind(id, email, Date.now(), Date.now(), username).run();
}

async function seedRace(env, overrides = {}) {
  const r = {
    id: crypto.randomUUID(), user_id: null, device_id: "dev-1",
    difficulty: "medium", finished: 1, finish_time_ms: 48000,
    problems_total: 20, problems_correct: 18, problems_attempted: 20,
    avg_time_per_problem_ms: 2400, accuracy_pct: 90, longest_streak: 7,
    played_at: Date.now(), ...overrides,
  };
  await env.DB.prepare(
    `INSERT INTO race_results VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    r.id, r.user_id, r.device_id, r.difficulty, r.finished, r.finish_time_ms,
    r.problems_total, r.problems_correct, r.problems_attempted,
    r.avg_time_per_problem_ms, r.accuracy_pct, r.longest_streak, r.played_at
  ).run();
}
```

## Milestones

- [ ] **M1 — GET /api/me + tests.** Commit: `M1: agent C — GET /api/me with aggregates and recent races`.
- [ ] **M2 — POST /api/me/username + tests.** Commit: `M2: agent C — POST /api/me/username with validation`.
- [ ] **M3 — GET /api/stats/by-device + tests.** Commit: `M3: agent C — GET /api/stats/by-device for anon header pills`.

## Definition of done

1. All three handlers exported from `worker/routes/me.js`.
2. `vitest run worker/routes/me.test.js` passes all 9 cases.
3. `INTEGRATION NOTE:` comments on the auth stub and the test override.
4. No files outside your allowlist were touched.
5. Imports `validateUsernameSync` from `../username-validator.js` (Agent A's module). If Agent A hasn't merged yet, write the import anyway — your test will fail with a clear "module not found" until the merge, which is the right signal.

## How the integrator uses your work

- **Integrator (I1):** imports `handleGetMe`, `handlePostUsername`, `handleByDevice` from your file and routes them.
- **Integrator (post-Agent D):** replaces the `readUserId` stub with `auth.api.getSession`, removes `_setTestUserId` and the override variable.

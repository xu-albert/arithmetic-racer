# Agent B — Race Result API

**Spec:** `docs/superpowers/specs/2026-05-06-users-auth-stats-design.md`
**Plan:** `docs/superpowers/plans/2026-05-06-users-auth-stats-implementation.md`
**API contracts:** `worker/api-contracts.js` (frozen)

---

## Mission

Implement the `POST /api/race-result` handler that persists a single race result to D1. Both anonymous (no session cookie) and logged-in users hit this endpoint with the same body shape; the handler decides whether to set `user_id` based on the session.

**Critical clarification:** This handler does NOT run the anon→registered claim. The claim runs once at signup, owned by Agent D. This handler only inserts a single row.

## Files you own

- `worker/routes/race-result.js`
- `worker/routes/race-result.test.js`

## Files you must NOT touch

`worker/index.js` (the integrator wires you in later), `worker/auth.js` (Agent D), any other route, anything in `public/`.

## Contract

From `worker/api-contracts.js`:

**Input** (`RaceResultInput`):
```js
{
  device_id: string,            // UUID v4
  difficulty: 'easy'|'medium'|'hard',
  finished: boolean,
  finish_time_ms: number | null,  // null if not finished
  problems_total: number,         // default 20
  problems_correct: number,
  problems_attempted: number,
  avg_time_per_problem_ms: number,
  accuracy_pct: number,           // 0..100
  longest_streak: number,
}
```

**Response**: `{ id: string, claimed: false }` — the `claimed` field is always `false` here (claim happens at signup, not per-race). It's in the response shape so the contract stays stable when Agent D's signup flow returns the same shape.

**HTTP behavior:**
- 200 on success.
- 400 with `{ error: 'invalid_body' }` on malformed JSON, missing required fields, or out-of-range values (e.g., `difficulty` not one of the enum values).
- 500 on DB errors.

## Implementation sketch

```js
// worker/routes/race-result.js
import { db } from "../db.js";

const DIFFICULTIES = new Set(["easy", "medium", "hard"]);

function isValidBody(b) {
  return (
    b &&
    typeof b.device_id === "string" && b.device_id.length > 0 &&
    DIFFICULTIES.has(b.difficulty) &&
    typeof b.finished === "boolean" &&
    (b.finish_time_ms === null || (typeof b.finish_time_ms === "number" && b.finish_time_ms >= 0)) &&
    Number.isInteger(b.problems_total) && b.problems_total > 0 &&
    Number.isInteger(b.problems_correct) && b.problems_correct >= 0 &&
    Number.isInteger(b.problems_attempted) && b.problems_attempted >= 0 &&
    Number.isFinite(b.avg_time_per_problem_ms) && b.avg_time_per_problem_ms >= 0 &&
    Number.isFinite(b.accuracy_pct) && b.accuracy_pct >= 0 && b.accuracy_pct <= 100 &&
    Number.isInteger(b.longest_streak) && b.longest_streak >= 0
  );
}

/**
 * Read the user_id from the session cookie.
 * Returns null if no valid session.
 *
 * Implementation note: better-auth provides `auth.api.getSession({ headers })` as
 * the canonical way to read the session. The integrator wires this up. For now,
 * accept a `getUserId` parameter so tests can inject a stub. Default: null.
 */
async function readUserId(request, env) {
  // Replaced at integration time with: const session = await auth.api.getSession({ headers: request.headers });
  // For Phase 2, stub returns null (anonymous). Agent D + integrator finish the wiring.
  return null;
}

export async function handleRaceResult(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }
  if (!isValidBody(body)) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  const userId = await readUserId(request, env);
  const id = crypto.randomUUID();
  const playedAt = Date.now();

  try {
    await db(env)
      .prepare(
        `INSERT INTO race_results (
           id, user_id, device_id, difficulty, finished, finish_time_ms,
           problems_total, problems_correct, problems_attempted,
           avg_time_per_problem_ms, accuracy_pct, longest_streak, played_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        id, userId, body.device_id, body.difficulty,
        body.finished ? 1 : 0, body.finish_time_ms,
        body.problems_total, body.problems_correct, body.problems_attempted,
        body.avg_time_per_problem_ms, body.accuracy_pct, body.longest_streak, playedAt
      )
      .run();
  } catch (err) {
    return Response.json({ error: "db_error", detail: String(err) }, { status: 500 });
  }

  return Response.json({ id, claimed: false });
}
```

**Important:** `readUserId` is intentionally stubbed to return `null` in your handoff. Agent D ships `worker/auth.js` with `auth.api.getSession`. The integrator (Phase 3) replaces your `readUserId` body with the real call. Document this in a `// INTEGRATION NOTE:` comment on the function so it's easy to find.

## Testing

Use `vitest-pool-workers`. The Foundation phase already configured Miniflare with the D1 binding. A test file pattern:

```js
// worker/routes/race-result.test.js
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { handleRaceResult } from "./race-result.js";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM race_results");
});

function makeBody(overrides = {}) {
  return {
    device_id: "device-123",
    difficulty: "medium",
    finished: true,
    finish_time_ms: 48000,
    problems_total: 20,
    problems_correct: 18,
    problems_attempted: 20,
    avg_time_per_problem_ms: 2400,
    accuracy_pct: 90,
    longest_streak: 7,
    ...overrides,
  };
}

describe("POST /api/race-result", () => {
  it("inserts an anonymous race result", async () => {
    const req = new Request("http://x/api/race-result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeBody()),
    });
    const res = await handleRaceResult(req, env);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(json.claimed).toBe(false);

    const { results } = await env.DB.prepare(
      "SELECT user_id, device_id, difficulty FROM race_results"
    ).all();
    expect(results).toHaveLength(1);
    expect(results[0].user_id).toBeNull();
    expect(results[0].device_id).toBe("device-123");
  });

  it("rejects malformed body", async () => {
    const req = new Request("http://x/api/race-result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...makeBody(), difficulty: "extreme" }),
    });
    const res = await handleRaceResult(req, env);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_body");
  });

  it("accepts unfinished races (quit)", async () => {
    const req = new Request("http://x/api/race-result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeBody({ finished: false, finish_time_ms: null })),
    });
    const res = await handleRaceResult(req, env);
    expect(res.status).toBe(200);
    const { results } = await env.DB.prepare(
      "SELECT finished, finish_time_ms FROM race_results"
    ).all();
    expect(results[0].finished).toBe(0);
    expect(results[0].finish_time_ms).toBeNull();
  });
});
```

**Required test cases:**
1. Anonymous insert — happy path, `user_id NULL`.
2. Malformed body — every field violates one rule (write a parameterized test or a few targeted ones for: bad difficulty, missing field, out-of-range accuracy, negative streak).
3. Unfinished race — `finished: false, finish_time_ms: null`.
4. JSON parse error — body is `"not json"` → 400.

**Logged-in case:** since `readUserId` is stubbed to null in your handoff, you can't yet test the logged-in path end-to-end. Add a TODO comment in the test file and a stub helper that the integrator can fill in:
```js
// TODO(integrator): once auth.js is wired, add a test that creates a session
// via auth.api.signUpEmail(...) and verifies the resulting race_result has user_id set.
```

## Milestones

- [ ] **M1 — Handler implemented + happy-path tests pass.** Commit: `M1: agent B — race-result handler with anon insert + happy path tests`.
- [ ] **M2 — All required test cases pass.** Commit: `M2: agent B — race-result validation + edge case tests`.

## Definition of done

1. `vitest run worker/routes/race-result.test.js` passes.
2. `INTEGRATION NOTE:` comment on `readUserId` is present.
3. No edits outside your allowlist.
4. Handler follows the contract exactly (response shape, status codes).

## How a subsequent agent / integrator uses your work

- **Integrator (I1):** imports `handleRaceResult` from your file and routes `POST /api/race-result` to it.
- **Integrator (post-Agent D):** replaces the `readUserId` stub body with `await auth.api.getSession({ headers: request.headers })` and adds the logged-in test case.
- **`public/src/runner.js`** (Integrator I3): calls `postRaceResult` from `stats-api.js` which targets this endpoint.

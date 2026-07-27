// Tests for POST /api/race-result. Runs under @cloudflare/vitest-pool-workers,
// which gives us a real D1 binding via `import { env } from "cloudflare:test"`.
//
// vitest-pool-workers ships an ephemeral in-memory D1 per test file, so we
// create the race_results table once with `beforeAll` (mirroring
// migrations/0002_race_results.sql) and clear it between tests. Keeping the
// schema inline avoids reaching into vitest.config.js (outside this agent's
// allowlist). The integrator can later replace this with `applyD1Migrations`
// driven from the migrations directory once a shared test setup exists.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { handleRaceResult } from "./race-result.js";

beforeAll(async () => {
  // Mirror of migrations/0002_race_results.sql. If that migration changes,
  // update this block to match.
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS race_results (" +
      "id TEXT PRIMARY KEY, " +
      "user_id TEXT, " +
      "device_id TEXT NOT NULL, " +
      "difficulty TEXT NOT NULL CHECK (difficulty IN ('easy','medium','hard')), " +
      "finished INTEGER NOT NULL CHECK (finished IN (0,1)), " +
      "finish_time_ms INTEGER, " +
      "problems_total INTEGER NOT NULL DEFAULT 20, " +
      "problems_correct INTEGER NOT NULL, " +
      "problems_attempted INTEGER NOT NULL, " +
      "avg_time_per_problem_ms INTEGER NOT NULL, " +
      "accuracy_pct REAL NOT NULL, " +
      "longest_streak INTEGER NOT NULL, " +
      "played_at INTEGER NOT NULL, " +
      "room_id TEXT, " +
      "suspect INTEGER NOT NULL DEFAULT 0, " +
      "suspect_reason TEXT" +
      ")"
  );
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM race_results");
});

function makeBody(overrides = {}) {
  return {
    // Unique per call: the endpoint rate-limits per device, and a shared id
    // would make tests fail depending on how many ran before them.
    device_id: `device-${crypto.randomUUID()}`,
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

function makeRequest(body) {
  return new Request("http://x/api/race-result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/race-result — happy path", () => {
  it("inserts an anonymous race result with user_id NULL and device_id set", async () => {
    const res = await handleRaceResult(
      makeRequest(makeBody({ device_id: "device-123" })),
      env
    );
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(json.claimed).toBe(false);

    const { results } = await env.DB.prepare(
      "SELECT id, user_id, device_id, difficulty, finished, finish_time_ms, " +
        "problems_total, problems_correct, problems_attempted, " +
        "avg_time_per_problem_ms, accuracy_pct, longest_streak, played_at, room_id " +
        "FROM race_results"
    ).all();

    expect(results).toHaveLength(1);
    const row = results[0];
    expect(row.id).toBe(json.id);
    expect(row.user_id).toBeNull();
    expect(row.device_id).toBe("device-123");
    expect(row.difficulty).toBe("medium");
    expect(row.finished).toBe(1);
    expect(row.finish_time_ms).toBe(48000);
    expect(row.problems_total).toBe(20);
    expect(row.problems_correct).toBe(18);
    expect(row.problems_attempted).toBe(20);
    expect(row.avg_time_per_problem_ms).toBe(2400);
    expect(row.accuracy_pct).toBe(90);
    expect(row.longest_streak).toBe(7);
    expect(typeof row.played_at).toBe("number");
    expect(row.played_at).toBeGreaterThan(0);
    expect(row.room_id).toBeNull();
  });

  it("accepts unfinished races (quit) with finish_time_ms NULL", async () => {
    const res = await handleRaceResult(
      makeRequest(makeBody({ finished: false, finish_time_ms: null })),
      env
    );
    expect(res.status).toBe(200);

    const { results } = await env.DB.prepare(
      "SELECT finished, finish_time_ms FROM race_results"
    ).all();
    expect(results).toHaveLength(1);
    expect(results[0].finished).toBe(0);
    expect(results[0].finish_time_ms).toBeNull();
  });
});

describe("POST /api/race-result — rate limiting", () => {
  it("accepts a burst up to the per-device limit and 429s past it", async () => {
    const device_id = `device-${crypto.randomUUID()}`;
    const statuses = [];
    for (let i = 0; i < 8; i++) {
      const res = await handleRaceResult(makeRequest(makeBody({ device_id })), env);
      statuses.push(res.status);
    }
    // 6/min/device — roughly 3x the ~2 races/min a real player can produce.
    expect(statuses.slice(0, 6)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(statuses.slice(6)).toEqual([429, 429]);
  });

  it("returns a retry-after header with the 429 so a client can back off", async () => {
    const device_id = `device-${crypto.randomUUID()}`;
    let res;
    for (let i = 0; i < 7; i++) {
      res = await handleRaceResult(makeRequest(makeBody({ device_id })), env);
    }
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(res.headers.get("retry-after")).toBe("60");
  });

  it("does not persist a race it rate-limited", async () => {
    const device_id = `device-${crypto.randomUUID()}`;
    for (let i = 0; i < 7; i++) {
      await handleRaceResult(makeRequest(makeBody({ device_id })), env);
    }
    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM race_results WHERE device_id = ?"
    ).bind(device_id).all();
    expect(results[0].n).toBe(6);
  });

  it("limits each device independently", async () => {
    const busy = `device-${crypto.randomUUID()}`;
    for (let i = 0; i < 7; i++) {
      await handleRaceResult(makeRequest(makeBody({ device_id: busy })), env);
    }
    // A second player must not be punished for the first one's traffic.
    const res = await handleRaceResult(
      makeRequest(makeBody({ device_id: `device-${crypto.randomUUID()}` })),
      env
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /api/race-result — plausibility", () => {
  it("stores an ordinary race unflagged", async () => {
    const res = await handleRaceResult(makeRequest(makeBody()), env);
    expect(res.status).toBe(200);

    const { results } = await env.DB.prepare(
      "SELECT suspect, suspect_reason FROM race_results"
    ).all();
    expect(results[0].suspect).toBe(0);
    expect(results[0].suspect_reason).toBeNull();
  });

  it("flags an impossibly fast race but still persists it with 200", async () => {
    // Rejecting would delete the one row worth examining, so this must be a
    // normal successful write that merely carries a mark.
    const res = await handleRaceResult(
      makeRequest(makeBody({
        problems_total: 10, problems_attempted: 10, problems_correct: 10,
        accuracy_pct: 100, longest_streak: 10, finish_time_ms: 500,
      })),
      env
    );
    expect(res.status).toBe(200);

    const { results } = await env.DB.prepare(
      "SELECT suspect, suspect_reason, finish_time_ms FROM race_results"
    ).all();
    expect(results).toHaveLength(1);
    expect(results[0].suspect).toBe(1);
    expect(results[0].suspect_reason).toBe("impossibly_fast");
    expect(results[0].finish_time_ms).toBe(500);
  });

  it("flags a race that ran implausibly long", async () => {
    const res = await handleRaceResult(
      makeRequest(makeBody({ finish_time_ms: 31 * 60_000 })),
      env
    );
    expect(res.status).toBe(200);

    const { results } = await env.DB.prepare(
      "SELECT suspect, suspect_reason FROM race_results"
    ).all();
    expect(results[0].suspect).toBe(1);
    expect(results[0].suspect_reason).toBe("implausibly_slow");
  });
});

describe("POST /api/race-result — validation", () => {
  it("rejects an invalid difficulty value", async () => {
    const res = await handleRaceResult(
      makeRequest(makeBody({ difficulty: "extreme" })),
      env
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });

  it("rejects a missing required field (device_id)", async () => {
    const body = makeBody();
    delete body.device_id;
    const res = await handleRaceResult(makeRequest(body), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });

  it("rejects an empty device_id string", async () => {
    const res = await handleRaceResult(
      makeRequest(makeBody({ device_id: "" })),
      env
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });

  it("rejects accuracy_pct above 100", async () => {
    const res = await handleRaceResult(
      makeRequest(makeBody({ accuracy_pct: 150 })),
      env
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });

  it("rejects accuracy_pct below 0", async () => {
    const res = await handleRaceResult(
      makeRequest(makeBody({ accuracy_pct: -1 })),
      env
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });

  it("rejects a negative longest_streak", async () => {
    const res = await handleRaceResult(
      makeRequest(makeBody({ longest_streak: -3 })),
      env
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });

  it("rejects a non-integer problems_total", async () => {
    const res = await handleRaceResult(
      makeRequest(makeBody({ problems_total: 19.5 })),
      env
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });

  it("rejects finished=true with a non-numeric finish_time_ms", async () => {
    const res = await handleRaceResult(
      makeRequest(makeBody({ finish_time_ms: "fast" })),
      env
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });

  it("rejects a non-boolean finished flag", async () => {
    const res = await handleRaceResult(
      makeRequest(makeBody({ finished: "yes" })),
      env
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });

  it("rejects malformed JSON with 400 invalid_body", async () => {
    const res = await handleRaceResult(makeRequest("not json"), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });

  // Each field below is individually in range; only the relationship between
  // them is impossible. Range checks in isolation cannot catch these.
  describe("cross-field consistency", () => {
    it("rejects problems_correct greater than problems_total", async () => {
      const res = await handleRaceResult(
        makeRequest(makeBody({
          problems_total: 1, problems_attempted: 1,
          problems_correct: 999, accuracy_pct: 100,
        })),
        env
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_body" });
    });

    it("rejects problems_attempted greater than problems_total", async () => {
      const res = await handleRaceResult(
        makeRequest(makeBody({
          problems_total: 10, problems_attempted: 11,
          problems_correct: 10, accuracy_pct: 90.9,
        })),
        env
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_body" });
    });

    it("rejects problems_correct greater than problems_attempted", async () => {
      const res = await handleRaceResult(
        makeRequest(makeBody({
          problems_total: 20, problems_attempted: 5,
          problems_correct: 10, accuracy_pct: 100,
        })),
        env
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_body" });
    });

    it("rejects accuracy_pct that contradicts the correct/attempted counts", async () => {
      const res = await handleRaceResult(
        makeRequest(makeBody({
          problems_total: 20, problems_attempted: 20,
          problems_correct: 0, accuracy_pct: 100,
        })),
        env
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_body" });
    });

    it("rejects a non-zero accuracy_pct when nothing was attempted", async () => {
      const res = await handleRaceResult(
        makeRequest(makeBody({
          finished: false, finish_time_ms: null,
          problems_total: 20, problems_attempted: 0,
          problems_correct: 0, accuracy_pct: 75,
        })),
        env
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_body" });
    });

    it("rejects longest_streak greater than problems_correct", async () => {
      const res = await handleRaceResult(
        makeRequest(makeBody({
          problems_total: 20, problems_attempted: 20,
          problems_correct: 5, accuracy_pct: 25, longest_streak: 20,
        })),
        env
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_body" });
    });

    it("accepts a rounded accuracy_pct within tolerance of the counts", async () => {
      // 2/3 = 66.666...%, and the client rounds for display. Tolerance has to
      // absorb that or honest results get thrown away.
      const res = await handleRaceResult(
        makeRequest(makeBody({
          problems_total: 3, problems_attempted: 3,
          problems_correct: 2, accuracy_pct: 66.7, longest_streak: 2,
        })),
        env
      );
      expect(res.status).toBe(200);
    });

    it("accepts a quit mid-race where attempted is below total", async () => {
      const res = await handleRaceResult(
        makeRequest(makeBody({
          finished: false, finish_time_ms: null,
          problems_total: 20, problems_attempted: 7,
          problems_correct: 6, accuracy_pct: 85.7, longest_streak: 4,
        })),
        env
      );
      expect(res.status).toBe(200);
    });
  });

  it("rejects an empty body with 400 invalid_body", async () => {
    const res = await handleRaceResult(makeRequest(""), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });

  it("does not insert a row when validation fails", async () => {
    await handleRaceResult(
      makeRequest(makeBody({ difficulty: "extreme" })),
      env
    );
    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM race_results"
    ).all();
    expect(results[0].c).toBe(0);
  });
});

// TODO(integrator): once auth.js is wired, replace the readUserId stub in
// race-result.js with `auth.api.getSession({ headers: request.headers })`
// and add a test here that creates a session via auth.api.signUpEmail(...)
// then verifies the resulting race_result row has user_id set to the new
// user's id (and device_id still recorded).

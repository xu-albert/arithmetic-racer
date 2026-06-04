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
      "played_at INTEGER NOT NULL" +
      ")"
  );
});

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

function makeRequest(body) {
  return new Request("http://x/api/race-result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/race-result — happy path", () => {
  it("inserts an anonymous race result with user_id NULL and device_id set", async () => {
    const res = await handleRaceResult(makeRequest(makeBody()), env);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(json.claimed).toBe(false);

    const { results } = await env.DB.prepare(
      "SELECT id, user_id, device_id, difficulty, finished, finish_time_ms, " +
        "problems_total, problems_correct, problems_attempted, " +
        "avg_time_per_problem_ms, accuracy_pct, longest_streak, played_at " +
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

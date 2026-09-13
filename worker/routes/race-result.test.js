// Tests for POST /api/race-result. Runs under @cloudflare/vitest-pool-workers,
// which gives us a real D1 binding via `import { env } from "cloudflare:test"`.
//
// vitest-pool-workers ships an ephemeral in-memory D1 per test file; the schema
// is applied from migrations/ by worker/test-setup.js.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleRaceResult } from "./race-result.js";
import { KINDS } from "../logger.js";

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
    problems_correct: 20,
    problems_attempted: 20,
    avg_time_per_problem_ms: 2400,
    accuracy_pct: 100,
    longest_streak: 7,
    ...overrides,
  };
}

function makeRequest(body) {
  // Isolate the IP budget; per-device rate-limit tests still share their device.
  return new Request("http://x/api/race-result", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": crypto.randomUUID() },
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
        "avg_time_per_problem_ms, accuracy_pct, longest_streak, played_at, room_id, points " +
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
    expect(row.problems_correct).toBe(20);
    expect(row.problems_attempted).toBe(20);
    expect(row.avg_time_per_problem_ms).toBe(2400);
    expect(row.accuracy_pct).toBe(100);
    expect(row.longest_streak).toBe(7);
    expect(typeof row.played_at).toBe("number");
    expect(row.played_at).toBeGreaterThan(0);
    expect(row.room_id).toBeNull();
    // Scored on the way in: 20 correct in 48s = 25 ppm -> 20 x 25/60.
    expect(row.points).toBeCloseTo(25 / 3, 6);
  });

  it("accepts unfinished races (quit) with finish_time_ms NULL", async () => {
    const res = await handleRaceResult(
      makeRequest(makeBody({
        finished: false, finish_time_ms: null, avg_time_per_problem_ms: 0,
        problems_correct: 0, problems_attempted: 0, accuracy_pct: 0, longest_streak: 0,
      })),
      env
    );
    expect(res.status).toBe(200);

    const { results } = await env.DB.prepare(
      "SELECT finished, finish_time_ms, points FROM race_results"
    ).all();
    expect(results).toHaveLength(1);
    expect(results[0].finished).toBe(0);
    expect(results[0].finish_time_ms).toBeNull();
    // A quit race is unscored, not scored zero.
    expect(results[0].points).toBeNull();
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
        accuracy_pct: 100, longest_streak: 10, finish_time_ms: 500, avg_time_per_problem_ms: 50,
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
      makeRequest(makeBody({ finish_time_ms: 31 * 60_000, avg_time_per_problem_ms: 93000 })),
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
          finished: false, finish_time_ms: null, avg_time_per_problem_ms: 0,
          problems_total: 10, problems_attempted: 12,
          problems_correct: 12, accuracy_pct: 100, longest_streak: 0,
        })),
        env
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_body" });
    });

    it("accepts an honest race whose wrong-answer retries push attempted past total", async () => {
      const res = await handleRaceResult(
        makeRequest(makeBody({
          problems_total: 10, problems_attempted: 11,
          problems_correct: 10, accuracy_pct: 90.9, avg_time_per_problem_ms: 4800,
        })),
        env
      );
      expect(res.status).toBe(200);
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
          finished: false, finish_time_ms: null, avg_time_per_problem_ms: 0,
          problems_total: 20, problems_attempted: 20,
          problems_correct: 5, accuracy_pct: 100, longest_streak: 0,
        })),
        env
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_body" });
    });

    it("rejects a non-zero accuracy_pct when nothing was attempted", async () => {
      const res = await handleRaceResult(
        makeRequest(makeBody({
          finished: false, finish_time_ms: null, avg_time_per_problem_ms: 0,
          problems_total: 20, problems_attempted: 0,
          problems_correct: 0, accuracy_pct: 75, longest_streak: 0,
        })),
        env
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_body" });
    });

    it("rejects longest_streak greater than problems_correct", async () => {
      const res = await handleRaceResult(
        makeRequest(makeBody({
          finished: false, finish_time_ms: null, avg_time_per_problem_ms: 0,
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
          finished: false, finish_time_ms: null, avg_time_per_problem_ms: 0,
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
          finished: false, finish_time_ms: null, avg_time_per_problem_ms: 0,
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

// Not covered here: a signed-in POST (a real better-auth session, e.g. via
// auth.api.signUpEmail) stamping user_id on the row while device_id is still
// recorded. readUserId in worker/session.js is what resolves the cookie.

describe("POST /api/race-result — bounded solo contract", () => {
  // An unfinished race is the one shape no other rule rejects, so a bound under
  // test here is the only thing that can turn the body away.
  const quit = {
    finished: false, finish_time_ms: null, avg_time_per_problem_ms: 0,
    problems_correct: 0, problems_attempted: 0, accuracy_pct: 0, longest_streak: 0,
  };

  it.each([
    ["finished with a null finish time", { finish_time_ms: null, avg_time_per_problem_ms: 0, longest_streak: 0 }],
    ["missing finish time", { finish_time_ms: undefined }],
    ["zero finish time", { finish_time_ms: 0 }],
    ["unfinished with time", { finished: false }],
    ["finished before all problems solved", { problems_correct: 18, accuracy_pct: 90 }],
    ["huge race", { ...quit, problems_total: 1e100 }],
    ["race above maximum", { ...quit, problems_total: 51 }],
    ["oversized device id", { device_id: "x".repeat(129) }],
    ["too many attempts", { problems_attempted: 10001, accuracy_pct: 0.2 }],
    ["unbounded time", { finish_time_ms: 86400001, avg_time_per_problem_ms: 4320000 }],
    ["contradictory average", { avg_time_per_problem_ms: 100 }],
    ["quit with nonzero average", { finished: false, finish_time_ms: null, problems_correct: 0, accuracy_pct: 0, longest_streak: 0 }],
  ])("rejects %s without inserting", async (_name, overrides) => {
    const res = await handleRaceResult(makeRequest(makeBody(overrides)), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM race_results").first("n")).toBe(0);
  });

  it("accepts a rounded client average and bounded device/race sizes", async () => {
    const res = await handleRaceResult(makeRequest(makeBody({
      device_id: "x".repeat(128), problems_total: 50, problems_correct: 50,
      problems_attempted: 50, finish_time_ms: 100023, avg_time_per_problem_ms: 2000,
    })), env);
    expect(res.status).toBe(200);
  });

  it("logs an insert failure while returning only an opaque error", async () => {
    const failure = new Error("D1 private schema and query details");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await handleRaceResult(makeRequest(makeBody()), {
        ...env, DB: { prepare() { throw failure; } },
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "db_error" });
      expect(log).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(log.mock.calls[0][0]);
      expect(logged.kind).toBe(KINDS.RACE_RESULT_DB);
      expect(logged.context).toEqual({ path: "solo", phase: "insert" });
      expect(logged.err.message).toBe(failure.message);
    } finally {
      log.mockRestore();
    }
  });
});

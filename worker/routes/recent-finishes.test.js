// Tests for GET /api/recent-finishes — the lobby's "who's racing" strip.
//
// Runs under @cloudflare/vitest-pool-workers against a real D1 binding; the
// schema is applied from migrations/ by worker/test-setup.js.
//
// The eligibility rule is the thing under test. It is a public claim about who
// just raced, so each exclusion gets its own case rather than being covered
// incidentally by a happy path.

import { describe, it, expect, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import { handleRecentFinishes, parseFeedLimit } from "./recent-finishes.js";
import { computePoints } from "../race-score.js";

// --- helpers ---------------------------------------------------------------

beforeEach(async () => {
  // race_results.user_id has an FK to user.id, so clear the child table first.
  await env.DB.exec("DELETE FROM race_results");
  await env.DB.exec(`DELETE FROM "user"`);
});

async function seedUser({ id, username }) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", username)
     VALUES (?,?,?,?,?,?,?)`
  )
    .bind(id, username ?? id, `${id}@example.test`, 0, now, now, username ?? null)
    .run();
}

/**
 * One race row. Defaults are an eligible room finish, so a case only states the
 * field it is testing.
 */
async function seedRace(overrides = {}) {
  const r = {
    id: crypto.randomUUID(),
    user_id: null,
    device_id: "dev-1",
    difficulty: "medium",
    finished: 1,
    finish_time_ms: 60000,
    problems_total: 20,
    problems_correct: 20,
    problems_attempted: 20,
    avg_time_per_problem_ms: 3000,
    accuracy_pct: 100,
    longest_streak: 20,
    played_at: Date.now(),
    room_id: "brave-otter-eel",
    suspect: 0,
    suspect_reason: null,
    ...overrides,
  };
  // Score the row the way the real writer does (worker/race-result-store.js)
  // unless the case is deliberately simulating an unscored row.
  if (!("points" in overrides)) {
    r.points = computePoints({
      finished: r.finished === 1,
      finish_time_ms: r.finish_time_ms,
      problems_correct: r.problems_correct,
    });
  }
  await env.DB.prepare(
    `INSERT INTO race_results (
       id, user_id, device_id, difficulty, finished, finish_time_ms,
       problems_total, problems_correct, problems_attempted,
       avg_time_per_problem_ms, accuracy_pct, longest_streak, played_at,
       room_id, suspect, suspect_reason, points
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      r.id,
      r.user_id,
      r.device_id,
      r.difficulty,
      r.finished,
      r.finish_time_ms,
      r.problems_total,
      r.problems_correct,
      r.problems_attempted,
      r.avg_time_per_problem_ms,
      r.accuracy_pct,
      r.longest_streak,
      r.played_at,
      r.room_id,
      r.suspect,
      r.suspect_reason,
      r.points ?? null
    )
    .run();
  return r;
}

async function getFeed(query = "") {
  const res = await handleRecentFinishes(
    new Request(`https://example.test/api/recent-finishes${query}`),
    env
  );
  expect(res.status).toBe(200);
  return res.json();
}

// --- eligibility -----------------------------------------------------------

describe("eligibility", () => {
  it("lists a plausible finished room race", async () => {
    await seedUser({ id: "u1", username: "speedy" });
    await seedRace({ user_id: "u1", device_id: "dev-u1" });

    const body = await getFeed();
    expect(body.finishes).toHaveLength(1);
    expect(body.finishes[0].username).toBe("speedy");
    expect(body.finishes[0].difficulty).toBe("medium");
    expect(body.finishes[0].ppm).toBeCloseTo(20, 6);
    expect(body.finishes[0].points).toBeCloseTo((20 * 20) / 60, 6);
  });

  it("excludes solo races (room_id IS NULL)", async () => {
    await seedRace({ room_id: null });
    const body = await getFeed();
    expect(body.finishes).toEqual([]);
  });

  it("excludes suspect races", async () => {
    await seedRace({ suspect: 1, suspect_reason: "impossibly_fast" });
    const body = await getFeed();
    expect(body.finishes).toEqual([]);
  });

  it("excludes unfinished races", async () => {
    await seedRace({ finished: 0, finish_time_ms: null, points: null });
    const body = await getFeed();
    expect(body.finishes).toEqual([]);
  });

  it("excludes a race claiming to be finished with no usable finish time", async () => {
    await seedRace({ finished: 1, finish_time_ms: 0, points: null });
    const body = await getFeed();
    expect(body.finishes).toEqual([]);
  });

  it("includes an anonymous racer, with a null username and no device id", async () => {
    await seedRace({ user_id: null, device_id: "dev-anon" });

    const body = await getFeed();
    expect(body.finishes).toHaveLength(1);
    expect(body.finishes[0].username).toBeNull();
    expect(JSON.stringify(body)).not.toContain("dev-anon");
  });

  it("treats a signed-in account with no username as unnamed", async () => {
    await seedUser({ id: "u-nameless", username: null });
    await seedRace({ user_id: "u-nameless", device_id: "dev-nameless" });

    const body = await getFeed();
    expect(body.finishes).toHaveLength(1);
    expect(body.finishes[0].username).toBeNull();
  });

  it("never returns the room id — a private room slug is its invite credential", async () => {
    await seedRace({ room_id: "secret-badger-mole" });
    const body = await getFeed();
    expect(body.finishes).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("secret-badger-mole");
  });
});

// --- ordering and bounds ---------------------------------------------------

describe("ordering", () => {
  it("returns newest first", async () => {
    const now = Date.now();
    await seedUser({ id: "old", username: "older" });
    await seedUser({ id: "new", username: "newer" });
    await seedRace({ user_id: "old", device_id: "d-old", played_at: now - 60_000 });
    await seedRace({ user_id: "new", device_id: "d-new", played_at: now - 1_000 });

    const body = await getFeed();
    expect(body.finishes.map((f) => f.username)).toEqual(["newer", "older"]);
  });

  it("orders by recency, not by speed", async () => {
    const now = Date.now();
    await seedUser({ id: "fast", username: "fast" });
    await seedUser({ id: "slow", username: "slow" });
    // The fast race is older, so a speed-ordered board would put it first.
    await seedRace({
      user_id: "fast",
      device_id: "d-fast",
      played_at: now - 60_000,
      finish_time_ms: 20_000,
    });
    await seedRace({
      user_id: "slow",
      device_id: "d-slow",
      played_at: now - 1_000,
      finish_time_ms: 120_000,
    });

    const body = await getFeed();
    expect(body.finishes.map((f) => f.username)).toEqual(["slow", "fast"]);
  });

  it("breaks a same-millisecond tie deterministically", async () => {
    const at = Date.now();
    await seedRace({ id: "aaa", played_at: at });
    await seedRace({ id: "bbb", played_at: at });

    const first = await getFeed();
    const second = await getFeed();
    expect(first.finishes.map((f) => f.played_at))
      .toEqual(second.finishes.map((f) => f.played_at));
    expect(first.finishes).toHaveLength(2);
  });
});

describe("limit", () => {
  it("defaults to 8 rows", async () => {
    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      await seedRace({ played_at: now - i * 1000 });
    }
    const body = await getFeed();
    expect(body.limit).toBe(8);
    expect(body.finishes).toHaveLength(8);
  });

  it("honors ?limit= below the ceiling", async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) await seedRace({ played_at: now - i * 1000 });
    const body = await getFeed("?limit=3");
    expect(body.limit).toBe(3);
    expect(body.finishes).toHaveLength(3);
  });

  it("caps a crafted ?limit= at 25 rather than scanning", () => {
    expect(parseFeedLimit("100000")).toBe(25);
    expect(parseFeedLimit("25")).toBe(25);
  });

  it("falls back to the default for unreadable sizes", () => {
    expect(parseFeedLimit(null)).toBe(8);
    expect(parseFeedLimit("")).toBe(8);
    expect(parseFeedLimit("banana")).toBe(8);
    expect(parseFeedLimit("0")).toBe(8);
    expect(parseFeedLimit("-4")).toBe(8);
  });

  it("returns an empty feed rather than an error when nothing qualifies", async () => {
    const body = await getFeed();
    expect(body.finishes).toEqual([]);
    expect(typeof body.generated_at).toBe("string");
  });
});

// --- degrading when the database is a migration behind ---------------------

describe("points column fallback", () => {
  it("reports a row the 0009 backfill left NULL as unscored, not zero", async () => {
    await seedRace({ points: null });
    const body = await getFeed();
    expect(body.finishes).toHaveLength(1);
    expect(body.finishes[0].points).toBeNull();
    // PPM is derived from columns that predate 0009, so it still lands.
    expect(body.finishes[0].ppm).toBeCloseTo(20, 6);
  });

  it("keeps 0 points distinct from unscored", async () => {
    await seedRace({ problems_correct: 0, points: 0 });
    const body = await getFeed();
    expect(body.finishes[0].points).toBe(0);
  });

  it("still serves the feed when race_results.points does not exist", async () => {
    // Simulates the window where the Worker has deployed but 0009 has not been
    // applied by hand yet (migrations/README.md). Unguarded, this read is a
    // public 500 on every lobby load.
    await seedUser({ id: "u1", username: "speedy" });
    await seedRace({ user_id: "u1", device_id: "dev-u1" });
    await env.DB.exec("ALTER TABLE race_results DROP COLUMN points");
    try {
      const body = await getFeed();
      expect(body.finishes).toHaveLength(1);
      expect(body.finishes[0].username).toBe("speedy");
      expect(body.finishes[0].points).toBeNull();
      expect(body.finishes[0].ppm).toBeCloseTo(20, 6);
    } finally {
      // The D1 for this file is shared by every test in it, so a case that
      // mutates the schema has to put it back.
      await env.DB.exec("ALTER TABLE race_results ADD COLUMN points REAL");
    }
  });

  it("does not swallow a real database error", async () => {
    // A missing *table* is not a missing column, so it must propagate rather
    // than degrade — the fallback exists for one narrow migration window, not
    // as a blanket catch. Renamed rather than dropped so it can be restored.
    await env.DB.exec("ALTER TABLE race_results RENAME TO race_results_away");
    try {
      await expect(
        handleRecentFinishes(new Request("https://example.test/api/recent-finishes"), env)
      ).rejects.toThrow();
    } finally {
      await env.DB.exec("ALTER TABLE race_results_away RENAME TO race_results");
    }
  });
});

// --- route wiring ----------------------------------------------------------

describe("route registration", () => {
  it("is reachable at GET /api/recent-finishes without a session", async () => {
    // The handler tests above call the function directly, so they would still
    // pass if server.js never mounted it. This one goes through the Worker
    // entry, which is the only place that mistake shows up.
    await seedUser({ id: "u1", username: "speedy" });
    await seedRace({ user_id: "u1", device_id: "dev-u1" });

    const res = await SELF.fetch("https://example.test/api/recent-finishes");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.finishes.map((f) => f.username)).toEqual(["speedy"]);
  });
});

// Tests for the profile API.
//
// Runs under @cloudflare/vitest-pool-workers. We get a real D1 binding via
// `import { env } from "cloudflare:test"` and reset both `race_results` and
// `user` between tests so each case starts from a clean slate.
//
// vitest-pool-workers ships an ephemeral in-memory D1 per test file, so we
// create both tables once in `beforeAll` (mirroring migrations/0001 and
// migrations/0002) and clear them between tests. Keeping schema inline keeps
// this file self-contained without touching vitest.config.js (out of scope).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { handleGetMe, _setTestUserId } from "./me.js";

// --- schema bootstrap & helpers --------------------------------------------

beforeAll(async () => {
  // Mirror of migrations/0001_better_auth.sql (user table only — we don't
  // exercise account/session/verification here).
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS "user" (` +
      `"id" text not null primary key, ` +
      `"name" text not null, ` +
      `"email" text not null unique, ` +
      `"emailVerified" integer not null, ` +
      `"image" text, ` +
      `"createdAt" date not null, ` +
      `"updatedAt" date not null, ` +
      `"username" text unique` +
      `)`
  );

  // Mirror of migrations/0002_race_results.sql.
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS race_results (" +
      "id TEXT PRIMARY KEY, " +
      `user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL, ` +
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
  // Order matters: race_results.user_id has an FK to user.id, so clear the
  // child table first.
  await env.DB.exec("DELETE FROM race_results");
  await env.DB.exec(`DELETE FROM "user"`);
  _setTestUserId(null);
});

async function seedUser(env, { id, email, username, name }) {
  // The `user` table is owned by better-auth; columns are camelCase and
  // `name` is NOT NULL. See migrations/0001_better_auth.sql.
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", username)
     VALUES (?,?,?,?,?,?,?)`
  )
    .bind(id, name ?? username ?? email, email, 0, now, now, username ?? null)
    .run();
}

async function seedRace(env, overrides = {}) {
  const r = {
    id: crypto.randomUUID(),
    user_id: null,
    device_id: "dev-1",
    difficulty: "medium",
    finished: 1,
    finish_time_ms: 48000,
    problems_total: 20,
    problems_correct: 18,
    problems_attempted: 20,
    avg_time_per_problem_ms: 2400,
    accuracy_pct: 90,
    longest_streak: 7,
    played_at: Date.now(),
    ...overrides,
  };
  await env.DB.prepare(
    `INSERT INTO race_results (
       id, user_id, device_id, difficulty, finished, finish_time_ms,
       problems_total, problems_correct, problems_attempted,
       avg_time_per_problem_ms, accuracy_pct, longest_streak, played_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
      r.played_at
    )
    .run();
  return r;
}

function makeRequest(url, init) {
  return new Request(url, init);
}

// --- GET /api/me ------------------------------------------------------------

describe("GET /api/me", () => {
  it("returns 401 when there is no session", async () => {
    // _setTestUserId(null) is the default after beforeEach.
    const res = await handleGetMe(makeRequest("http://x/api/me"), env);
    expect(res.status).toBe(401);
  });

  it("returns 3-entry aggregates (zeroed) and empty recent for a user with no races", async () => {
    await seedUser(env, { id: "u1", email: "u1@example.com", username: "Alice" });
    _setTestUserId("u1");

    const res = await handleGetMe(makeRequest("http://x/api/me"), env);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.username).toBe("Alice");
    expect(body.email).toBe("u1@example.com");
    expect(typeof body.created_at).toBe("string");
    expect(body.created_at).toMatch(/T.*Z$/); // ISO 8601

    expect(body.aggregates).toHaveLength(3);
    const diffs = body.aggregates.map((a) => a.difficulty);
    expect(diffs).toEqual(["easy", "medium", "hard"]);
    for (const a of body.aggregates) {
      expect(a.races_played).toBe(0);
      expect(a.races_finished).toBe(0);
      expect(a.best_time_ms).toBeNull();
      expect(a.avg_accuracy).toBe(0);
      expect(a.avg_problem_time_ms).toBe(0);
    }

    expect(body.recent).toEqual([]);
  });

  it("aggregates correctly across mixed difficulties and finished/quit, recent is DESC ordered", async () => {
    await seedUser(env, { id: "u1", email: "u1@example.com", username: "Alice" });
    _setTestUserId("u1");

    // 5 races: 2 easy (one finished, one quit), 2 medium (both finished),
    // 1 hard (finished). Played-at timestamps are spaced so recent ordering
    // is unambiguous.
    const t0 = 1_700_000_000_000;
    await seedRace(env, {
      user_id: "u1",
      difficulty: "easy",
      finished: 1,
      finish_time_ms: 20000,
      accuracy_pct: 100,
      avg_time_per_problem_ms: 1000,
      played_at: t0 + 1,
    });
    await seedRace(env, {
      user_id: "u1",
      difficulty: "easy",
      finished: 0,
      finish_time_ms: null,
      accuracy_pct: 50,
      avg_time_per_problem_ms: 1500,
      played_at: t0 + 2,
    });
    await seedRace(env, {
      user_id: "u1",
      difficulty: "medium",
      finished: 1,
      finish_time_ms: 50000,
      accuracy_pct: 90,
      avg_time_per_problem_ms: 2400,
      played_at: t0 + 3,
    });
    await seedRace(env, {
      user_id: "u1",
      difficulty: "medium",
      finished: 1,
      finish_time_ms: 45000,
      accuracy_pct: 95,
      avg_time_per_problem_ms: 2200,
      played_at: t0 + 4,
    });
    await seedRace(env, {
      user_id: "u1",
      difficulty: "hard",
      finished: 1,
      finish_time_ms: 80000,
      accuracy_pct: 75,
      avg_time_per_problem_ms: 4000,
      played_at: t0 + 5,
    });

    // A race belonging to a different user must NOT leak in.
    await seedUser(env, { id: "u2", email: "u2@example.com", username: "Bob" });
    await seedRace(env, {
      user_id: "u2",
      difficulty: "easy",
      finished: 1,
      finish_time_ms: 1,
      played_at: t0 + 999,
    });

    const res = await handleGetMe(makeRequest("http://x/api/me"), env);
    expect(res.status).toBe(200);
    const body = await res.json();

    const easy = body.aggregates.find((a) => a.difficulty === "easy");
    const medium = body.aggregates.find((a) => a.difficulty === "medium");
    const hard = body.aggregates.find((a) => a.difficulty === "hard");

    expect(easy.races_played).toBe(2);
    expect(easy.races_finished).toBe(1);
    expect(easy.best_time_ms).toBe(20000); // only the finished race counts
    expect(easy.avg_accuracy).toBe(75); // (100 + 50) / 2

    expect(medium.races_played).toBe(2);
    expect(medium.races_finished).toBe(2);
    expect(medium.best_time_ms).toBe(45000); // min of finished
    expect(medium.avg_accuracy).toBeCloseTo(92.5, 5);

    expect(hard.races_played).toBe(1);
    expect(hard.races_finished).toBe(1);
    expect(hard.best_time_ms).toBe(80000);

    // Recent: DESC by played_at, only the 5 races we seeded for u1.
    expect(body.recent).toHaveLength(5);
    const playedAts = body.recent.map((r) => Date.parse(r.played_at));
    for (let i = 1; i < playedAts.length; i++) {
      expect(playedAts[i - 1]).toBeGreaterThanOrEqual(playedAts[i]);
    }
    // race_seq should be 1..5 in chronological (ASC) order — the latest
    // played race is seq 5 and appears first in the DESC recent list.
    expect(body.recent[0].race_seq).toBe(5);
    expect(body.recent[body.recent.length - 1].race_seq).toBe(1);

    // None of u2's races should appear.
    for (const r of body.recent) {
      expect(r.finish_time_ms).not.toBe(1);
    }
  });

  it("limits recent to 10 entries when the user has more than 10 races", async () => {
    await seedUser(env, { id: "u1", email: "u1@example.com", username: "Alice" });
    _setTestUserId("u1");

    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 12; i++) {
      await seedRace(env, {
        user_id: "u1",
        difficulty: "easy",
        finished: 1,
        finish_time_ms: 20000 + i,
        played_at: t0 + i,
      });
    }

    const res = await handleGetMe(makeRequest("http://x/api/me"), env);
    const body = await res.json();
    expect(body.recent).toHaveLength(10);
    // First entry is the most recently played (seq 12).
    expect(body.recent[0].race_seq).toBe(12);
  });
});

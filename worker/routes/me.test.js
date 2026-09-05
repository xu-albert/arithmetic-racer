// Tests for the profile API.
//
// Runs under @cloudflare/vitest-pool-workers. We get a real D1 binding via
// `import { env } from "cloudflare:test"` and reset both `race_results` and
// `user` between tests so each case starts from a clean slate.
//
// vitest-pool-workers ships an ephemeral in-memory D1 per test file; the schema
// is applied from migrations/ by worker/test-setup.js.

import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  handleGetMe,
  handleGetMyRaces,
  handlePostUsername,
  handleByDevice,
} from "./me.js";
import { _setTestUserId } from "../session.js";
import { computePoints } from "../race-score.js";

// --- helpers ---------------------------------------------------------------

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
  // Seed `points` the way the real writer does (worker/race-result-store.js),
  // so these rows behave like rows the app actually wrote. Pass an explicit
  // `points` override to simulate a row the 0007 backfill left NULL.
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
       avg_time_per_problem_ms, accuracy_pct, longest_streak, played_at, points
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
      r.points ?? null
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
      expect(a.total_points).toBe(0);
      // No finished race means no pace to report — null, not a slow 0.
      expect(a.avg_ppm).toBeNull();
      expect(a.best_ppm).toBeNull();
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

// --- points and PPM ---------------------------------------------------------

describe("GET /api/me — points and PPM", () => {
  beforeEach(async () => {
    await seedUser(env, { id: "u1", email: "u1@example.com", username: "Alice" });
    _setTestUserId("u1");
  });

  const aggFor = (body, difficulty) =>
    body.aggregates.find((a) => a.difficulty === difficulty);

  it("keeps points and PPM in separate per-difficulty pools", async () => {
    // Identical races in each tier. Each tier reports its own totals, and
    // nothing anywhere in the response adds them together.
    for (const difficulty of ["easy", "medium", "hard"]) {
      await seedRace(env, {
        user_id: "u1",
        difficulty,
        finished: 1,
        finish_time_ms: 60_000,
        problems_correct: 20,
      });
    }

    const body = await (await handleGetMe(makeRequest("http://x/api/me"), env)).json();
    for (const difficulty of ["easy", "medium", "hard"]) {
      const agg = aggFor(body, difficulty);
      expect(agg.avg_ppm).toBeCloseTo(20, 6);
      expect(agg.best_ppm).toBeCloseTo(20, 6);
      expect(agg.total_points).toBeCloseTo(6.6667, 4); // 20 x 20/60
    }
    // No cross-difficulty total, rank, or weighted score is exposed.
    const keys = Object.keys(body);
    expect(keys).not.toContain("points");
    expect(keys).not.toContain("total_points");
    expect(keys).not.toContain("ppm");
  });

  it("sums points and averages PPM within a difficulty", async () => {
    const t0 = 1_700_000_000_000;
    // 20 correct in 60s -> 20 ppm, 6.667 points.
    await seedRace(env, {
      user_id: "u1", difficulty: "medium", finished: 1,
      finish_time_ms: 60_000, problems_correct: 20, played_at: t0 + 1,
    });
    // 20 correct in 30s -> 40 ppm, 13.333 points.
    await seedRace(env, {
      user_id: "u1", difficulty: "medium", finished: 1,
      finish_time_ms: 30_000, problems_correct: 20, played_at: t0 + 2,
    });

    const body = await (await handleGetMe(makeRequest("http://x/api/me"), env)).json();
    const medium = aggFor(body, "medium");
    expect(medium.total_points).toBeCloseTo(20, 4); // 6.667 + 13.333
    expect(medium.avg_ppm).toBeCloseTo(30, 6); // (20 + 40) / 2
    expect(medium.best_ppm).toBeCloseTo(40, 6);
  });

  it("excludes DNFs from the PPM average instead of scoring them 0", async () => {
    const t0 = 1_700_000_000_000;
    await seedRace(env, {
      user_id: "u1", difficulty: "easy", finished: 1,
      finish_time_ms: 60_000, problems_correct: 30, played_at: t0 + 1,
    });
    // Quit part-way: the 0007 backfill leaves points NULL for exactly this row.
    await seedRace(env, {
      user_id: "u1", difficulty: "easy", finished: 0, finish_time_ms: null,
      problems_correct: 5, played_at: t0 + 2,
    });

    const body = await (await handleGetMe(makeRequest("http://x/api/me"), env)).json();
    const easy = aggFor(body, "easy");
    expect(easy.races_played).toBe(2);
    expect(easy.races_finished).toBe(1);
    // A DNF must not halve the average — 30, not 15.
    expect(easy.avg_ppm).toBeCloseTo(30, 6);
    expect(easy.best_ppm).toBeCloseTo(30, 6);
    expect(easy.total_points).toBeCloseTo(15, 4); // 30 x 30/60, DNF adds nothing
  });

  it("reports total_points 0 for a difficulty whose only races are unscored", async () => {
    // Pre-backfill history is impossible by construction (0007 backfills), but
    // a DNF-only tier is not: SUM over all-NULL must surface as 0, not null.
    await seedRace(env, {
      user_id: "u1", difficulty: "hard", finished: 0,
      finish_time_ms: null, problems_correct: 2,
    });

    const body = await (await handleGetMe(makeRequest("http://x/api/me"), env)).json();
    const hard = aggFor(body, "hard");
    expect(hard.total_points).toBe(0);
    expect(hard.avg_ppm).toBeNull();
    expect(hard.best_ppm).toBeNull();
  });

  it("returns per-race points and ppm on recent races, null for a DNF", async () => {
    const t0 = 1_700_000_000_000;
    await seedRace(env, {
      user_id: "u1", difficulty: "medium", finished: 1,
      finish_time_ms: 30_000, problems_correct: 20, played_at: t0 + 1,
    });
    await seedRace(env, {
      user_id: "u1", difficulty: "medium", finished: 0, finish_time_ms: null,
      problems_correct: 3, played_at: t0 + 2,
    });

    const body = await (await handleGetMe(makeRequest("http://x/api/me"), env)).json();
    const [dnf, finished] = body.recent; // DESC by played_at
    expect(dnf.points).toBeNull();
    expect(dnf.ppm).toBeNull();
    expect(finished.ppm).toBeCloseTo(40, 6);
    expect(finished.points).toBeCloseTo(13.3333, 4);
  });

  it("serves points from the stored column, not recomputed at read time", async () => {
    // The stored value is the record of what that race was worth. A later
    // formula change must not silently rewrite it, so the read path reports
    // whatever is in the column.
    await seedRace(env, {
      user_id: "u1", difficulty: "easy", finished: 1,
      finish_time_ms: 60_000, problems_correct: 20, points: 999,
    });

    const body = await (await handleGetMe(makeRequest("http://x/api/me"), env)).json();
    expect(body.recent[0].points).toBe(999);
    expect(aggFor(body, "easy").total_points).toBe(999);
    // PPM *is* derived, so it still reflects the raw columns.
    expect(body.recent[0].ppm).toBeCloseTo(20, 6);
  });
});

// --- POST /api/me/username --------------------------------------------------

describe("POST /api/me/username", () => {
  it("returns 401 when there is no session", async () => {
    const res = await handlePostUsername(
      new Request("http://x/api/me/username", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "Alice" }),
      }),
      env
    );
    expect(res.status).toBe(401);
  });

  it("updates the row on a valid name (happy path)", async () => {
    await seedUser(env, { id: "u1", email: "u1@example.com", username: "OldName" });
    _setTestUserId("u1");

    const res = await handlePostUsername(
      new Request("http://x/api/me/username", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "NewName" }),
      }),
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ username: "NewName" });

    const row = await env.DB.prepare(
      `SELECT username FROM "user" WHERE id = ?`
    )
      .bind("u1")
      .first();
    expect(row.username).toBe("NewName");
  });

  it("rejects a name that another user already holds (case-insensitive)", async () => {
    await seedUser(env, { id: "u1", email: "u1@example.com", username: "Alice" });
    await seedUser(env, { id: "u2", email: "u2@example.com", username: "Taken" });
    _setTestUserId("u1");

    const res = await handlePostUsername(
      new Request("http://x/api/me/username", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Different casing — uniqueness must be case-insensitive.
        body: JSON.stringify({ username: "taken" }),
      }),
      env
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "taken" });

    // u1's username should be unchanged.
    const row = await env.DB.prepare(
      `SELECT username FROM "user" WHERE id = ?`
    )
      .bind("u1")
      .first();
    expect(row.username).toBe("Alice");
  });

  it("rejects a name flagged by the validator (banned/reserved/invalid_format)", async () => {
    await seedUser(env, { id: "u1", email: "u1@example.com", username: "Alice" });
    _setTestUserId("u1");

    // "admin" is on the RESERVED set in worker/username-validator.js.
    const res = await handlePostUsername(
      new Request("http://x/api/me/username", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin" }),
      }),
      env
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    // The validator may classify reserved names as "reserved"; banned names
    // hit the obscenity matcher. Either is a valid validator rejection — we
    // assert it's one of the four documented error codes.
    expect(["banned", "reserved", "invalid_format"]).toContain(body.error);
    // For "admin" specifically the validator returns reserved.
    expect(body.error).toBe("reserved");
  });
});

// --- GET /api/stats/by-device/:device_id ------------------------------------

describe("GET /api/stats/by-device/:device_id", () => {
  it("returns zeros for a device that has never raced", async () => {
    const res = await handleByDevice(
      makeRequest("http://x/api/stats/by-device/never-seen"),
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      total_races: 0,
      best_time_ms: null,
      best_difficulty: null,
    });
  });

  it("counts only the requested device's anon rows", async () => {
    await seedRace(env, {
      device_id: "dev-1",
      difficulty: "easy",
      finished: 1,
      finish_time_ms: 20000,
    });
    await seedRace(env, {
      device_id: "dev-1",
      difficulty: "medium",
      finished: 1,
      finish_time_ms: 40000,
    });
    await seedRace(env, {
      device_id: "dev-1",
      difficulty: "hard",
      finished: 0,
      finish_time_ms: null,
    });
    await seedRace(env, {
      device_id: "dev-2",
      difficulty: "easy",
      finished: 1,
      finish_time_ms: 30000,
    });

    const res1 = await handleByDevice(
      makeRequest("http://x/api/stats/by-device/dev-1"),
      env
    );
    const body1 = await res1.json();
    expect(body1.total_races).toBe(3);
    expect(body1.best_time_ms).toBe(20000);
    expect(body1.best_difficulty).toBe("easy");

    const res2 = await handleByDevice(
      makeRequest("http://x/api/stats/by-device/dev-2"),
      env
    );
    const body2 = await res2.json();
    expect(body2.total_races).toBe(1);
    expect(body2.best_time_ms).toBe(30000);
    expect(body2.best_difficulty).toBe("easy");
  });

  it("excludes claimed rows (user_id IS NOT NULL)", async () => {
    await seedUser(env, { id: "u1", email: "u1@example.com", username: "Alice" });

    // Seed an anon race on dev-1, then UPDATE it to claim it for u1.
    const r = await seedRace(env, {
      device_id: "dev-1",
      difficulty: "medium",
      finished: 1,
      finish_time_ms: 40000,
    });
    await env.DB.prepare(
      `UPDATE race_results SET user_id = ? WHERE id = ?`
    )
      .bind("u1", r.id)
      .run();

    const res = await handleByDevice(
      makeRequest("http://x/api/stats/by-device/dev-1"),
      env
    );
    expect(await res.json()).toEqual({
      total_races: 0,
      best_time_ms: null,
      best_difficulty: null,
    });
  });
});


// --- GET /api/me/races ------------------------------------------------------

describe("GET /api/me/races", () => {
  const t0 = 1_700_000_000_000;

  /** Seed `n` finished races for u1, oldest first, cycling through `difficulties`. */
  async function seedHistory(n, difficulties = ["easy"]) {
    for (let i = 0; i < n; i++) {
      await seedRace(env, {
        user_id: "u1",
        difficulty: difficulties[i % difficulties.length],
        finished: 1,
        finish_time_ms: 20000 + i,
        played_at: t0 + i,
      });
    }
  }

  async function getRaces(query = "") {
    const res = await handleGetMyRaces(makeRequest(`http://x/api/me/races${query}`), env);
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const seqs = (body) => body.races.map((r) => r.race_seq);

  it("returns 401 when there is no session", async () => {
    const res = await handleGetMyRaces(makeRequest("http://x/api/me/races"), env);
    expect(res.status).toBe(401);
  });

  describe("signed in", () => {
    beforeEach(async () => {
      await seedUser(env, { id: "u1", email: "u1@example.com", username: "Alice" });
      _setTestUserId("u1");
    });

    it("returns an empty page with no cursor for a user with no races", async () => {
      const { status, body } = await getRaces();
      expect(status).toBe(200);
      expect(body).toEqual({ difficulty: null, limit: 20, races: [], next_cursor: null });
    });

    it("fits exactly one page in one response and reports no further page", async () => {
      await seedHistory(20);
      const { body } = await getRaces();
      expect(body.races).toHaveLength(20);
      expect(seqs(body)[0]).toBe(20);
      expect(seqs(body)[19]).toBe(1);
      // A page that lands exactly on the last row must not advertise an
      // empty page after it.
      expect(body.next_cursor).toBeNull();
    });

    it("pages newest-first through `before`, ending on a short last page", async () => {
      await seedHistory(25);

      const first = (await getRaces()).body;
      expect(seqs(first)).toEqual(Array.from({ length: 20 }, (_, i) => 25 - i));
      // The cursor is the oldest race on the page: pass it back as `before`.
      expect(first.next_cursor).toBe(6);

      const second = (await getRaces(`?before=${first.next_cursor}`)).body;
      expect(seqs(second)).toEqual([5, 4, 3, 2, 1]);
      expect(second.next_cursor).toBeNull();

      // Nothing is shared between the two pages and nothing fell through.
      const all = [...seqs(first), ...seqs(second)];
      expect(new Set(all).size).toBe(25);
    });

    it("rows carry the same fields as /api/me's `recent`", async () => {
      await seedHistory(1);
      const { body } = await getRaces();
      const me = await (await handleGetMe(makeRequest("http://x/api/me"), env)).json();
      expect(body.races).toEqual(me.recent);
      expect(Object.keys(body.races[0]).sort()).toEqual(
        [
          "accuracy_pct",
          "avg_time_per_problem_ms",
          "difficulty",
          "finish_time_ms",
          "played_at",
          "points",
          "ppm",
          "race_seq",
        ].sort()
      );
    });

    it("/api/me `recent` is exactly the first ten-row page, unchanged", async () => {
      await seedHistory(12, ["easy", "medium", "hard"]);
      const me = await (await handleGetMe(makeRequest("http://x/api/me"), env)).json();
      const { body } = await getRaces("?limit=10");
      expect(me.recent).toEqual(body.races);
      expect(me.recent).toHaveLength(10);
    });

    it("rejects a cursor that is not a positive integer", async () => {
      await seedHistory(3);
      for (const bad of ["abc", "0", "-1", "1.5", "1e2", " 2", ""]) {
        const { status, body } = await getRaces(`?before=${encodeURIComponent(bad)}`);
        expect(status, `before=${JSON.stringify(bad)}`).toBe(400);
        expect(body).toEqual({ error: "invalid_cursor" });
      }
    });

    it("a cursor past the oldest race yields an empty page, not an error", async () => {
      await seedHistory(3);
      const { status, body } = await getRaces("?before=1");
      expect(status).toBe(200);
      expect(body.races).toEqual([]);
      expect(body.next_cursor).toBeNull();
    });

    it("filters by difficulty while keeping each race's global race_seq", async () => {
      // seq 1 easy, 2 medium, 3 hard, 4 easy, 5 medium, 6 hard, 7 easy.
      await seedHistory(7, ["easy", "medium", "hard"]);

      const { status, body } = await getRaces("?difficulty=medium");
      expect(status).toBe(200);
      expect(body.difficulty).toBe("medium");
      expect(body.races.every((r) => r.difficulty === "medium")).toBe(true);
      // Race #5 is still race #5 when you look at medium alone: the counter
      // is the user's whole history, not a per-difficulty one.
      expect(seqs(body)).toEqual([5, 2]);
      expect(body.next_cursor).toBeNull();
    });

    it("paginates within a difficulty filter", async () => {
      // 9 hard races interleaved with others: hard is seq 3, 6, 9, ..., 27.
      await seedHistory(27, ["easy", "medium", "hard"]);

      const first = (await getRaces("?difficulty=hard&limit=4")).body;
      expect(seqs(first)).toEqual([27, 24, 21, 18]);
      expect(first.next_cursor).toBe(18);

      const second = (await getRaces(`?difficulty=hard&limit=4&before=${first.next_cursor}`)).body;
      expect(seqs(second)).toEqual([15, 12, 9, 6]);
      expect(second.next_cursor).toBe(6);

      const third = (await getRaces(`?difficulty=hard&limit=4&before=${second.next_cursor}`)).body;
      expect(seqs(third)).toEqual([3]);
      expect(third.next_cursor).toBeNull();
    });

    it("returns an empty page when the filter matches nothing", async () => {
      await seedHistory(5, ["easy", "medium"]);
      const { status, body } = await getRaces("?difficulty=hard");
      expect(status).toBe(200);
      expect(body).toEqual({ difficulty: "hard", limit: 20, races: [], next_cursor: null });
    });

    it("rejects an unknown difficulty", async () => {
      const { status, body } = await getRaces("?difficulty=extreme");
      expect(status).toBe(400);
      expect(body).toEqual({ error: "invalid_difficulty" });
    });

    it("treats an empty difficulty as no filter", async () => {
      await seedHistory(2, ["easy", "hard"]);
      const { body } = await getRaces("?difficulty=");
      expect(body.difficulty).toBeNull();
      expect(body.races).toHaveLength(2);
    });

    it("clamps `limit` to [1, 100] and falls back to 20 when unreadable", async () => {
      await seedHistory(3);
      expect((await getRaces("?limit=2")).body.races).toHaveLength(2);
      expect((await getRaces("?limit=2")).body.limit).toBe(2);
      expect((await getRaces("?limit=abc")).body.limit).toBe(20);
      expect((await getRaces("?limit=0")).body.limit).toBe(20);
      expect((await getRaces("?limit=5000")).body.limit).toBe(100);
    });

    it("never lists another user's races", async () => {
      await seedUser(env, { id: "u2", email: "u2@example.com", username: "Bob" });
      await seedRace(env, { user_id: "u2", difficulty: "easy", finished: 1, played_at: t0 + 50 });
      await seedHistory(2);
      const { body } = await getRaces();
      expect(seqs(body)).toEqual([2, 1]);
    });

    it("orders races stamped in the same millisecond by id, so race_seq is stable", async () => {
      // One multiplayer race persists every player in the same tick, and a
      // solo race can land on the same clock value. Without a tiebreak
      // ROW_NUMBER() is free to swap them between two queries, and a cursor
      // of `race_seq < n` would then skip or repeat a row.
      await seedRace(env, { id: "b-race", user_id: "u1", difficulty: "easy", finished: 1, played_at: t0 });
      await seedRace(env, { id: "a-race", user_id: "u1", difficulty: "hard", finished: 1, played_at: t0 });
      const { body } = await getRaces();
      expect(body.races.map((r) => [r.race_seq, r.difficulty])).toEqual([
        [2, "easy"], // b-race
        [1, "hard"], // a-race
      ]);
      const me = await (await handleGetMe(makeRequest("http://x/api/me"), env)).json();
      expect(me.recent).toEqual(body.races);
    });
  });
});

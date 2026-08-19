// Tests for GET /api/leaderboard.
//
// Runs under @cloudflare/vitest-pool-workers against a real D1 whose schema
// comes from migrations/ (worker/test-setup.js).
//
// The period cases are the reason this file exists. The handler reads
// Date.now() itself, so every expectation here is *computed* from
// periodStartMs against the same clock rather than hardcoded to a date — a
// test that only passes on a Tuesday, or only west of UTC, would be worse than
// no test at all. Rows are seeded at exactly the boundary and one millisecond
// before it, which is the only place an off-by-one can hide.

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { handleLeaderboard, parseLimit, CANONICAL_RACE_LENGTH } from "./leaderboard.js";
import { freshState } from "../../server/room.js";
import { computePoints, computePpm } from "../race-score.js";
import { periodStartMs } from "../leaderboard-period.js";
import { logWarn, KINDS } from "../logger.js";

// --- helpers ---------------------------------------------------------------

// Unlike D1, `caches.default` is not rolled back between tests in this pool —
// one board stored here outlives the test that stored it and would answer the
// next test's request against data that test never seeded. The host is part of
// the cache key, so each test gets its own: two calls *inside* a test still
// share an entry exactly as two requests in production would, and no test can
// see another's. Every request built here goes through `boardUrl`.
//
// LEADERBOARD_IP_LIMIT is the same shape of problem: the binding is real here
// (vitest-pool-workers reads wrangler.jsonc) and its counters are not rolled
// back either, so every test gets its own client IP as well. Two clients
// genuinely do get separate budgets; sharing one across the whole file would
// make a test's result depend on how many ran before it.
let originSeq = 0;
let origin = "";
let clientIp = "";

beforeEach(async () => {
  origin = `https://board-${++originSeq}.test`;
  clientIp = `203.0.113.${originSeq}`;
  // race_results.user_id has an FK to user.id; clear the child table first.
  await env.DB.exec("DELETE FROM race_results");
  await env.DB.exec(`DELETE FROM "user"`);
});

/** A request from this test's client, the way the Worker would receive it. */
function boardRequest(params) {
  return new Request(boardUrl(params), {
    headers: { "cf-connecting-ip": clientIp },
  });
}

function boardUrl({ difficulty, period, limit } = {}) {
  const u = new URL("/api/leaderboard", origin);
  if (difficulty != null) u.searchParams.set("difficulty", difficulty);
  if (period != null) u.searchParams.set("period", period);
  if (limit != null) u.searchParams.set("limit", String(limit));
  return u.toString();
}

let seq = 0;

/**
 * The only race length a board ranks, taken from the route rather than copied.
 * Every seeded row uses it unless the test is specifically about the length
 * rule, and expectations derive PPM from it rather than hardcoding a number
 * that silently means "20 problems".
 */
const CANONICAL = CANONICAL_RACE_LENGTH;

/** PPM a canonical race posts when it finishes in `finishMs`. */
function ppmFor(finishMs) {
  return (CANONICAL * 60_000) / finishMs;
}

/** Columns every writer supplies, in the order seedRace binds them. */
const RACE_COLUMNS = [
  "id", "user_id", "device_id", "difficulty", "finished", "finish_time_ms",
  "problems_total", "problems_correct", "problems_attempted",
  "avg_time_per_problem_ms", "accuracy_pct", "longest_streak",
  "played_at", "room_id", "suspect", "suspect_reason",
];

async function seedUser({ id, username }) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", username)
     VALUES (?,?,?,?,?,?,?)`
  )
    .bind(id, username ?? id, `${id}@example.test`, 0, now, now, username ?? null)
    .run();
  return id;
}

/**
 * Seed one race_results row the way the real writers do. Defaults describe a
 * clean, eligible room race; every test overrides only the field it is about.
 *
 * `withPoints: false` writes the pre-0009 column set, for the suite that
 * rebuilds the table without that column.
 */
async function seedRace(overrides = {}, { withPoints = true } = {}) {
  const r = {
    id: `race-${++seq}`,
    user_id: null,
    device_id: `dev-${seq}`,
    difficulty: "medium",
    finished: 1,
    finish_time_ms: 60_000,
    problems_total: CANONICAL,
    problems_correct: CANONICAL,
    problems_attempted: CANONICAL,
    avg_time_per_problem_ms: 3000,
    accuracy_pct: 100,
    longest_streak: 20,
    played_at: Date.now(),
    room_id: "brave-otter-eel",
    suspect: 0,
    suspect_reason: null,
    ...overrides,
  };
  if (!("points" in overrides)) {
    r.points = computePoints({
      finished: r.finished === 1,
      finish_time_ms: r.finish_time_ms,
      problems_correct: r.problems_correct,
    });
  }
  const cols = withPoints ? [...RACE_COLUMNS, "points"] : RACE_COLUMNS;
  await env.DB.prepare(
    `INSERT INTO race_results (${cols.join(", ")})
     VALUES (${cols.map(() => "?").join(",")})`
  )
    .bind(...cols.map((c) => r[c]))
    .run();
  return r;
}

/**
 * Call the handler the way the Worker does — with an execution context, so the
 * cache write it defers actually happens before the assertion looks.
 * `dbEnv` is a seam for the suites that need to watch or break D1.
 */
async function board({ difficulty = "medium", period = "all", limit, dbEnv = env } = {}) {
  const ctx = createExecutionContext();
  const res = await handleLeaderboard(
    boardRequest({ difficulty, period, limit }),
    dbEnv,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return { res, body: await res.json() };
}

/** An `env` whose D1 counts how many statements were prepared through it. */
function countingEnv() {
  let prepares = 0;
  const real = env.DB;
  return {
    env: { ...env, DB: { prepare: (sql) => (prepares++, real.prepare(sql)) } },
    prepares: () => prepares,
  };
}

/**
 * Count the cache interactions `fn` provokes, then put the real methods back.
 *
 * This is what makes "a rejection is never cached" a claim about *our* code.
 * Looking for an absent entry afterwards proves nothing here: this Cache
 * implementation silently declines to store a 4xx or 429 whatever the
 * Cache-Control says, so the entry would be missing even if the handler had
 * tried. Counting the calls tests the ordering we actually control.
 */
async function withCacheSpy(fn) {
  const cache = caches.default;
  const realMatch = cache.match;
  const realPut = cache.put;
  const calls = { match: 0, put: 0 };
  cache.match = function (...args) { calls.match++; return realMatch.apply(this, args); };
  cache.put = function (...args) { calls.put++; return realPut.apply(this, args); };
  try {
    await fn();
  } finally {
    cache.match = realMatch;
    cache.put = realPut;
  }
  return calls;
}

/** Racers on a board, in rank order. */
function names(body) {
  return body.entries.map((e) => e.username);
}

// --- request validation ----------------------------------------------------

describe("request validation", () => {
  it("400s without a difficulty — there is no combined board", async () => {
    const res = await handleLeaderboard(
      boardRequest(),
      env
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_difficulty" });
  });

  it("400s on an unknown difficulty", async () => {
    const { res, body } = await board({ difficulty: "expert" });
    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "invalid_difficulty" });
  });

  it("400s on an unknown period rather than falling back to all-time", async () => {
    const { res, body } = await board({ period: "decade" });
    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "invalid_period" });
  });

  it("defaults to the all-time board when period is omitted", async () => {
    const res = await handleLeaderboard(
      boardRequest({ difficulty: "easy" }),
      env
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.period).toBe("all");
    expect(body.period_start).toBeNull();
  });

  it("returns an empty board rather than an error when nothing qualifies", async () => {
    const { res, body } = await board();
    expect(res.status).toBe(200);
    expect(body.entries).toEqual([]);
    expect(body.difficulty).toBe("medium");
  });
});

// --- eligibility -----------------------------------------------------------

describe("eligibility", () => {
  it("lists a clean room race by a signed-in racer", async () => {
    await seedUser({ id: "u1", username: "ada" });
    await seedRace({ user_id: "u1" });
    const { body } = await board();
    expect(names(body)).toEqual(["ada"]);
  });

  it("excludes solo races (room_id IS NULL) — those numbers are client-reported", async () => {
    await seedUser({ id: "u1", username: "ada" });
    await seedUser({ id: "u2", username: "grace" });
    await seedRace({ user_id: "u1", room_id: null, finish_time_ms: 10_000 });
    await seedRace({ user_id: "u2" });
    const { body } = await board();
    // ada's solo race is three times faster and still does not appear.
    expect(names(body)).toEqual(["grace"]);
  });

  it("excludes suspect rows", async () => {
    await seedUser({ id: "u1", username: "ada" });
    await seedRace({
      user_id: "u1",
      finish_time_ms: 1_000,
      suspect: 1,
      suspect_reason: "impossibly_fast",
    });
    const { body } = await board();
    expect(body.entries).toEqual([]);
  });

  it("keeps a racer's clean race when another of their races is suspect", async () => {
    await seedUser({ id: "u1", username: "ada" });
    await seedRace({ user_id: "u1", finish_time_ms: 60_000 });
    await seedRace({
      user_id: "u1",
      finish_time_ms: 1_000,
      suspect: 1,
      suspect_reason: "impossibly_fast",
    });
    const { body } = await board();
    expect(body.entries).toHaveLength(1);
    // The 1s race would be 600 PPM; the clean 60s race is 10.
    expect(body.entries[0].ppm).toBeCloseTo(ppmFor(60_000), 6);
  });

  it("excludes anonymous races — an anon row has no name to publish", async () => {
    await seedRace({ user_id: null });
    const { body } = await board();
    expect(body.entries).toEqual([]);
  });

  it("excludes accounts that have not chosen a username yet", async () => {
    await seedUser({ id: "u1", username: null });
    await seedUser({ id: "u2", username: "" });
    await seedUser({ id: "u3", username: "grace" });
    await seedRace({ user_id: "u1" });
    await seedRace({ user_id: "u2" });
    await seedRace({ user_id: "u3" });
    const { body } = await board();
    expect(names(body)).toEqual(["grace"]);
  });

  it("excludes unfinished races — a quit race set no pace", async () => {
    await seedUser({ id: "u1", username: "ada" });
    await seedRace({ user_id: "u1", finished: 0, finish_time_ms: null, points: null });
    const { body } = await board();
    expect(body.entries).toEqual([]);
  });

  it("excludes a finished race with a zero finish time instead of dividing by zero", async () => {
    await seedUser({ id: "u1", username: "ada" });
    await seedRace({ user_id: "u1", finish_time_ms: 0, points: null });
    const { body } = await board();
    expect(body.entries).toEqual([]);
  });

  it("never reveals device_id or user_id on the wire", async () => {
    await seedUser({ id: "u1", username: "ada" });
    await seedRace({ user_id: "u1", device_id: "secret-device" });
    const { body } = await board();
    const wire = JSON.stringify(body);
    expect(wire).not.toContain("secret-device");
    expect(wire).not.toContain("u1");
    expect(Object.keys(body.entries[0]).sort()).toEqual(
      ["played_at", "points", "ppm", "rank", "username"].sort()
    );
  });
});

// --- difficulty silo -------------------------------------------------------

describe("difficulty silo", () => {
  it("never mixes difficulties, even when another tier is faster", async () => {
    await seedUser({ id: "u1", username: "ada" });
    await seedUser({ id: "u2", username: "grace" });
    // ada is much faster — on easy. She must not appear on the hard board.
    await seedRace({ user_id: "u1", difficulty: "easy", finish_time_ms: 20_000 });
    await seedRace({ user_id: "u2", difficulty: "hard", finish_time_ms: 120_000 });

    const easy = await board({ difficulty: "easy" });
    const hard = await board({ difficulty: "hard" });
    const medium = await board({ difficulty: "medium" });

    expect(names(easy.body)).toEqual(["ada"]);
    expect(names(hard.body)).toEqual(["grace"]);
    expect(medium.body.entries).toEqual([]);
    expect(easy.body.difficulty).toBe("easy");
  });

  it("ranks the same racer separately in each tier", async () => {
    await seedUser({ id: "u1", username: "ada" });
    await seedRace({ user_id: "u1", difficulty: "easy", finish_time_ms: 30_000 });
    await seedRace({ user_id: "u1", difficulty: "hard", finish_time_ms: 90_000 });

    const easy = await board({ difficulty: "easy" });
    const hard = await board({ difficulty: "hard" });
    expect(easy.body.entries[0].ppm).toBeCloseTo(ppmFor(30_000), 6);
    expect(hard.body.entries[0].ppm).toBeCloseTo(ppmFor(90_000), 6);
  });
});

// --- race length -----------------------------------------------------------

describe("the canonical length constant", () => {
  it("equals the race length rooms actually create", async () => {
    // The coupling that a comment cannot hold. Every board-eligible row takes
    // its problems_total from freshState().raceLength — buildRaceResultPayload
    // copies it, publicFreshState inherits it, and handleSetConfig refuses to
    // change it on a public room. If that number moved and the predicate did
    // not, every board would answer 200 with zero rows: no error, no log, just
    // the empty state. This is the assertion that turns that into a red suite.
    expect(freshState("any-room").raceLength).toBe(CANONICAL_RACE_LENGTH);
  });

  it("is the length the query actually filters on", async () => {
    // Ties the constant to observable behaviour rather than to itself: a race
    // at exactly this length lists, one problem either side does not.
    await seedUser({ id: "u1", username: "canonical" });
    await seedUser({ id: "u2", username: "shorter" });
    await seedUser({ id: "u3", username: "longer" });
    const at = CANONICAL_RACE_LENGTH;
    for (const [user, n] of [["u1", at], ["u2", at - 1], ["u3", at + 1]]) {
      await seedRace({
        user_id: user,
        problems_total: n,
        problems_correct: n,
        problems_attempted: n,
        finish_time_ms: 30_000,
      });
    }

    expect(names((await board()).body)).toEqual(["canonical"]);
  });
});

// --- race length -----------------------------------------------------------

// PPM is only comparable between races of the same length, and length is
// caller-chosen in a private room. These are the rows that would otherwise sit
// at rank 1 forever without anyone racing faster.
describe("canonical race length", () => {
  it("excludes a five-problem sprint even though it posts the highest PPM", async () => {
    await seedUser({ id: "u1", username: "sprinter" });
    await seedUser({ id: "u2", username: "grace" });
    // The exploit: 5 problems in 2.5s is 500ms each — clean by the plausibility
    // floor, server-counted in a real private room, and 120 PPM.
    await seedRace({
      user_id: "u1",
      problems_total: 5,
      problems_correct: 5,
      problems_attempted: 5,
      finish_time_ms: 2_500,
    });
    await seedRace({ user_id: "u2", finish_time_ms: 30_000 });

    const { body } = await board();
    expect(names(body)).toEqual(["grace"]);
    expect(body.entries[0].ppm).toBeCloseTo(ppmFor(30_000), 6);
  });

  it("excludes a longer race too — the rule is exactly canonical, not at most", async () => {
    await seedUser({ id: "u1", username: "marathon" });
    await seedRace({
      user_id: "u1",
      problems_total: 20,
      problems_correct: 20,
      problems_attempted: 20,
      finish_time_ms: 30_000,
    });
    expect((await board()).body.entries).toEqual([]);
  });

  it("admits the canonical race and ranks it normally", async () => {
    await seedUser({ id: "u1", username: "ada" });
    await seedUser({ id: "u2", username: "grace" });
    await seedRace({ user_id: "u1", finish_time_ms: 30_000 });
    await seedRace({ user_id: "u2", finish_time_ms: 60_000 });

    const { body } = await board();
    expect(names(body)).toEqual(["ada", "grace"]);
    expect(body.entries[0].ppm).toBeCloseTo(ppmFor(30_000), 6);
  });

  it("keeps a racer's canonical race when their other race was a sprint", async () => {
    await seedUser({ id: "u1", username: "ada" });
    await seedRace({
      user_id: "u1",
      problems_total: 5,
      problems_correct: 5,
      problems_attempted: 5,
      finish_time_ms: 2_500,
    });
    await seedRace({ user_id: "u1", finish_time_ms: 60_000 });

    const { body } = await board();
    // One row, and it is the canonical race — not the sprint's 120 PPM.
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].ppm).toBeCloseTo(ppmFor(60_000), 6);
  });

  it("applies inside every period, not only all-time", async () => {
    const now = Date.now();
    await seedUser({ id: "u1", username: "sprinter" });
    await seedRace({
      user_id: "u1",
      problems_total: 5,
      problems_correct: 5,
      problems_attempted: 5,
      finish_time_ms: 2_500,
      played_at: now,
    });

    for (const period of ["all", "day", "week", "month", "year"]) {
      expect((await board({ period })).body.entries).toEqual([]);
    }
  });
});

// --- ranking ---------------------------------------------------------------

describe("ranking", () => {
  it("orders by PPM descending and numbers ranks from 1", async () => {
    await seedUser({ id: "u1", username: "slow" });
    await seedUser({ id: "u2", username: "mid" });
    await seedUser({ id: "u3", username: "fast" });
    await seedRace({ user_id: "u1", finish_time_ms: 120_000 });
    await seedRace({ user_id: "u2", finish_time_ms: 60_000 });
    await seedRace({ user_id: "u3", finish_time_ms: 30_000 });

    const { body } = await board();
    expect(names(body)).toEqual(["fast", "mid", "slow"]);
    expect(body.entries.map((e) => e.rank)).toEqual([1, 2, 3]);
  });

  it("shows one row per racer — their best race, not every race", async () => {
    await seedUser({ id: "u1", username: "ada" });
    await seedUser({ id: "u2", username: "grace" });
    // ada raced three times; her second run is the fastest on the board.
    await seedRace({ user_id: "u1", finish_time_ms: 90_000 });
    await seedRace({ user_id: "u1", finish_time_ms: 30_000 });
    await seedRace({ user_id: "u1", finish_time_ms: 75_000 });
    await seedRace({ user_id: "u2", finish_time_ms: 40_000 });

    const { body } = await board();
    expect(names(body)).toEqual(["ada", "grace"]);
    expect(body.entries[0].ppm).toBeCloseTo(ppmFor(30_000), 6);
  });

  it("reports points from the one race that earned the rank, not a sum", async () => {
    await seedUser({ id: "u1", username: "ada" });
    // Three canonical races. Points and PPM collapse into one number on an
    // eligible row — boardSql's comment works through why — so no seeding can
    // separate them, and the claim left to test is that the cell holds the
    // ranked race's points rather than a total over all three.
    const slow = await seedRace({ user_id: "u1", finish_time_ms: 60_000 });
    const best = await seedRace({ user_id: "u1", finish_time_ms: 20_000 });
    const middling = await seedRace({ user_id: "u1", finish_time_ms: 40_000 });

    const { body } = await board();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].ppm).toBeCloseTo(
      computePpm({
        finished: true,
        finish_time_ms: 20_000,
        problems_correct: CANONICAL,
      }),
      6
    );
    expect(body.entries[0].points).toBeCloseTo(best.points, 6);
    // A sum would be strictly larger than any single race's points.
    expect(body.entries[0].points).toBeLessThan(
      slow.points + best.points + middling.points
    );
  });

  it("breaks a PPM tie toward the race that happened first", async () => {
    const now = Date.now();
    await seedUser({ id: "u1", username: "later" });
    await seedUser({ id: "u2", username: "earlier" });
    await seedRace({ user_id: "u1", finish_time_ms: 60_000, played_at: now - 1_000 });
    await seedRace({ user_id: "u2", finish_time_ms: 60_000, played_at: now - 9_000 });

    const { body } = await board();
    expect(names(body)).toEqual(["earlier", "later"]);
  });

  it("lists a row whose points are NULL (a database behind migration 0009)", async () => {
    await seedUser({ id: "u1", username: "ada" });
    await seedRace({ user_id: "u1", points: null });
    const { body } = await board();
    expect(body.entries[0].points).toBeNull();
    expect(body.entries[0].ppm).toBeCloseTo(ppmFor(60_000), 6);
  });

  it("stamps played_at of the ranked race as ISO 8601", async () => {
    const when = Date.UTC(2026, 4, 4, 12, 30, 15, 500);
    await seedUser({ id: "u1", username: "ada" });
    await seedRace({ user_id: "u1", played_at: when });
    const { body } = await board();
    expect(body.entries[0].played_at).toBe("2026-05-04T12:30:15.500Z");
  });
});

// --- limits ----------------------------------------------------------------

describe("limits", () => {
  async function seedRacers(n) {
    for (let i = 0; i < n; i++) {
      await seedUser({ id: `u${i}`, username: `racer${i}` });
      await seedRace({ user_id: `u${i}`, finish_time_ms: 20_000 + i * 100 });
    }
  }

  // The ceiling is asserted on parseLimit directly rather than by seeding 51+
  // racers: a row-count assertion under the cap passes whatever the cap is (or
  // if there is none), so it cannot fail when the bound is raised or dropped —
  // and the bound is what stops a crafted `?limit=` becoming a table scan.
  describe("parseLimit", () => {
    it("clamps anything above the ceiling to 50", () => {
      expect(parseLimit("5000")).toBe(50);
      expect(parseLimit("51")).toBe(50);
      expect(parseLimit(String(Number.MAX_SAFE_INTEGER))).toBe(50);
    });

    it("passes through a size at or under the ceiling", () => {
      expect(parseLimit("50")).toBe(50);
      expect(parseLimit("3")).toBe(3);
      expect(parseLimit("1")).toBe(1);
    });

    it("falls back to 10 when there is no readable size", () => {
      expect(parseLimit(null)).toBe(10);
      expect(parseLimit("")).toBe(10);
      expect(parseLimit("abc")).toBe(10);
      expect(parseLimit("0")).toBe(10);
      expect(parseLimit("-5")).toBe(10);
      expect(parseLimit("NaN")).toBe(10);
    });
  });

  it("returns 10 rows by default", async () => {
    await seedRacers(14);
    const { body } = await board();
    expect(body.entries).toHaveLength(10);
    expect(body.entries[0].username).toBe("racer0");
  });

  it("honours an explicit smaller limit", async () => {
    await seedRacers(14);
    const { body } = await board({ limit: 3 });
    expect(body.entries).toHaveLength(3);
  });

  it("serves an oversized limit rather than erroring", async () => {
    await seedRacers(14);
    const { res, body } = await board({ limit: 5_000 });
    expect(res.status).toBe(200);
    expect(body.entries).toHaveLength(14);
  });

  it("falls back to the default on junk, zero, or negative limits", async () => {
    await seedRacers(14);
    for (const bad of ["abc", "0", "-5", ""]) {
      const { body } = await board({ limit: bad });
      expect(body.entries).toHaveLength(10);
    }
  });
});

// --- caching ---------------------------------------------------------------

// What these prove: the handler's own cache-interaction logic — look before
// doing work, store on a miss, key on the normalized parameters, and never
// store a rejection. What they do NOT prove is that anything is cached in
// production. They run against Miniflare's Cache implementation, whose
// admission rules are not Cloudflare's (Miniflare reads `s-maxage` ahead of
// `max-age` and only refuses `no-store`/`no-cache`/`private`), and the
// deployed Worker is on workers.dev where `caches.default` may be inert
// entirely — see the CACHE_CONTROL comment in leaderboard.js.
describe("caching", () => {
  it("the cache spy observes a real board's lookup and store", async () => {
    await seedUser({ id: "u1", username: "ada" });
    await seedRace({ user_id: "u1" });
    // Positive control for withCacheSpy. Every other use of it asserts zero
    // calls, which an inert patch would satisfy for the wrong reason; this is
    // the one that fails if the methods stop being observable.
    expect(await withCacheSpy(() => board())).toEqual({ match: 1, put: 1 });
  });

  it("lets a shared cache hold a board briefly, but not a private one", async () => {
    const { res } = await board();
    const cc = res.headers.get("cache-control");
    // Shared cache only: `s-maxage` bounded to the agreed staleness window,
    // `max-age=0` so a racer's own browser always asks again.
    const sMaxAge = Number(/s-maxage=(\d+)/.exec(cc)?.[1]);
    expect(sMaxAge).toBeGreaterThanOrEqual(30);
    expect(sMaxAge).toBeLessThanOrEqual(60);
    expect(cc).toMatch(/(^|,\s*)max-age=0(\s*,|$)/);
    expect(cc).toMatch(/public/);
    expect(cc).not.toMatch(/private|no-store/);
  });

  it("serves a repeat of the same board without touching D1 again", async () => {
    await seedUser({ id: "u1", username: "ada" });
    await seedRace({ user_id: "u1", finish_time_ms: 30_000 });

    const spy = countingEnv();
    const first = await board({ dbEnv: spy.env });
    const second = await board({ dbEnv: spy.env });

    expect(spy.prepares()).toBe(1);
    expect(second.body).toEqual(first.body);
    expect(names(second.body)).toEqual(["ada"]);
  });

  it("collapses junk and clamped limits onto the entry the default made", async () => {
    await seedUser({ id: "u1", username: "ada" });
    await seedRace({ user_id: "u1", finish_time_ms: 30_000 });

    const spy = countingEnv();
    await board({ dbEnv: spy.env });
    // Every one of these normalizes to the default 10 that the first call
    // already stored, so none of them may reach D1.
    for (const same of ["abc", "0", "-5", "10", ""]) {
      const { body } = await board({ dbEnv: spy.env, limit: same });
      expect(names(body)).toEqual(["ada"]);
    }
    expect(spy.prepares()).toBe(1);

    // A limit that really is a different board still costs a read.
    await board({ dbEnv: spy.env, limit: 3 });
    expect(spy.prepares()).toBe(2);
  });

  it("keys each difficulty and period separately — a cached board never answers for another", async () => {
    await seedUser({ id: "u1", username: "ada" });
    await seedUser({ id: "u2", username: "grace" });
    await seedRace({ user_id: "u1", difficulty: "easy", finish_time_ms: 30_000 });
    await seedRace({ user_id: "u2", difficulty: "hard", finish_time_ms: 30_000 });

    const spy = countingEnv();
    expect(names((await board({ dbEnv: spy.env, difficulty: "easy" })).body)).toEqual(["ada"]);
    expect(names((await board({ dbEnv: spy.env, difficulty: "hard" })).body)).toEqual(["grace"]);
    expect(names((await board({ dbEnv: spy.env, difficulty: "easy", period: "day" })).body)).toEqual(["ada"]);
    expect((await board({ dbEnv: spy.env, difficulty: "medium" })).body.entries).toEqual([]);
    expect(spy.prepares()).toBe(4);

    // ...and the repeats still come back from the cache.
    expect(names((await board({ dbEnv: spy.env, difficulty: "easy" })).body)).toEqual(["ada"]);
    expect(names((await board({ dbEnv: spy.env, difficulty: "hard" })).body)).toEqual(["grace"]);
    expect(spy.prepares()).toBe(4);
  });

  it("never stores a rejected request", async () => {
    const spy = countingEnv();
    const bad = await board({ dbEnv: spy.env, difficulty: "expert" });
    expect(bad.res.status).toBe(400);
    expect(spy.prepares()).toBe(0);

    // "No second D1 read" cannot carry this on its own — an invalid request is
    // never repeated and its key can never collide with a valid one. This is
    // the assertion that fails if the lookup were moved above validation.
    const calls = await withCacheSpy(() => board({ difficulty: "expert" }));
    expect(calls).toEqual({ match: 0, put: 0 });

    // The 400 must not have poisoned anything: a valid board still queries.
    await seedUser({ id: "u1", username: "ada" });
    await seedRace({ user_id: "u1" });
    expect(names((await board({ dbEnv: spy.env })).body)).toEqual(["ada"]);
    expect(spy.prepares()).toBe(1);
  });

  it("serves the board without an execution context, and stores nothing", async () => {
    await seedUser({ id: "u1", username: "ada" });
    await seedRace({ user_id: "u1", finish_time_ms: 30_000 });

    const spy = countingEnv();
    const call = async () => {
      const res = await handleLeaderboard(
        boardRequest({ difficulty: "medium" }),
        spy.env
      );
      return res.json();
    };

    expect(names(await call())).toEqual(["ada"]);
    expect(names(await call())).toEqual(["ada"]);
    // No ctx, no place to defer the write to — so every call is a fresh read
    // rather than a silently dropped or response-delaying put.
    expect(spy.prepares()).toBe(2);
  });
});

// --- period windows --------------------------------------------------------

describe("period windows", () => {
  const BOUNDED = ["day", "week", "month", "year"];

  it("reports period_start as the UTC boundary, and null for all-time", async () => {
    const before = Date.now();
    for (const period of BOUNDED) {
      const { body } = await board({ period });
      const after = Date.now();
      // The handler reads its own clock, so accept either boundary the clock
      // could have produced across this call.
      const candidates = [periodStartMs(period, before), periodStartMs(period, after)]
        .map((ms) => new Date(ms).toISOString());
      expect(candidates).toContain(body.period_start);
      expect(body.period).toBe(period);
    }
    const all = await board({ period: "all" });
    expect(all.body.period_start).toBeNull();
  });

  it.each(BOUNDED)("includes a race at exactly the %s boundary and excludes the millisecond before", async (period) => {
    const start = periodStartMs(period, Date.now());
    await seedUser({ id: "u1", username: "inside" });
    await seedUser({ id: "u2", username: "outside" });
    // The excluded race is the faster one, so a leaking boundary is loud.
    await seedRace({ user_id: "u1", played_at: start, finish_time_ms: 60_000 });
    await seedRace({ user_id: "u2", played_at: start - 1, finish_time_ms: 20_000 });

    const { body } = await board({ period });
    expect(names(body)).toEqual(["inside"]);

    // Both races are on the all-time board, and the faster one leads it.
    const all = await board({ period: "all" });
    expect(names(all.body)).toEqual(["outside", "inside"]);
  });

  it("widens as the window widens: yesterday's race is out of the day board and on the all-time board", async () => {
    const now = Date.now();
    const dayStart = periodStartMs("day", now);
    // Midway through the previous UTC day. Widening is asserted against
    // all-time rather than the year board on purpose: on Jan 1 UTC the year
    // starts at the same instant as the day, so "yesterday" is last year and a
    // day-vs-year comparison is a test that fails once a calendar. All-time
    // contains every instant, on every date, in every timezone.
    const yesterday = dayStart - 43_200_000;

    await seedUser({ id: "u1", username: "today" });
    await seedUser({ id: "u2", username: "yesterday" });
    await seedRace({ user_id: "u1", played_at: now, finish_time_ms: 60_000 });
    await seedRace({ user_id: "u2", played_at: yesterday, finish_time_ms: 30_000 });

    expect(names((await board({ period: "day" })).body)).toEqual(["today"]);
    expect(names((await board({ period: "all" })).body)).toEqual(["yesterday", "today"]);
  });

  it("picks each racer's best race *within* the window, not their best ever", async () => {
    const now = Date.now();
    const dayStart = periodStartMs("day", now);
    await seedUser({ id: "u1", username: "ada" });
    // Career best, but it was set before today.
    await seedRace({ user_id: "u1", played_at: dayStart - 1, finish_time_ms: 20_000 });
    // Today's run is slower.
    await seedRace({ user_id: "u1", played_at: now, finish_time_ms: 60_000 });

    const day = await board({ period: "day" });
    expect(day.body.entries[0].ppm).toBeCloseTo(ppmFor(60_000), 6);
    const all = await board({ period: "all" });
    expect(all.body.entries[0].ppm).toBeCloseTo(ppmFor(20_000), 6);
  });

  it("keeps the difficulty silo inside every period", async () => {
    const now = Date.now();
    await seedUser({ id: "u1", username: "ada" });
    await seedUser({ id: "u2", username: "grace" });
    await seedRace({ user_id: "u1", difficulty: "easy", played_at: now, finish_time_ms: 20_000 });
    await seedRace({ user_id: "u2", difficulty: "hard", played_at: now, finish_time_ms: 90_000 });

    for (const period of ["all", ...BOUNDED]) {
      expect(names((await board({ period, difficulty: "easy" })).body)).toEqual(["ada"]);
      expect(names((await board({ period, difficulty: "hard" })).body)).toEqual(["grace"]);
    }
  });

  it("applies the same eligibility rules inside a period as all-time", async () => {
    const now = Date.now();
    await seedUser({ id: "u1", username: "solo" });
    await seedUser({ id: "u2", username: "suspicious" });
    await seedRace({ user_id: "u1", played_at: now, room_id: null, finish_time_ms: 10_000 });
    await seedRace({ user_id: "u2", played_at: now, suspect: 1, finish_time_ms: 10_000 });

    for (const period of ["all", ...BOUNDED]) {
      expect((await board({ period })).body.entries).toEqual([]);
    }
  });
});

// --- a database one migration behind --------------------------------------

// `points` arrives in 0009, and migrations here go on by hand while the Worker
// deploys from a push — so a build can serve the public lobby against a
// database that does not have the column. Run against 0008's table shape
// verbatim: the board must still rank, completely and in the same order,
// because PPM comes from columns that have been there since 0002.
describe("without race_results.points (a database at 0008)", () => {
  const COLUMNS_0008 =
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
    "played_at INTEGER NOT NULL, " +
    "room_id TEXT, " +
    "suspect INTEGER NOT NULL DEFAULT 0, " +
    "suspect_reason TEXT";

  const INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_race_results_user_played ON race_results (user_id, played_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_race_results_anon_device ON race_results (device_id) WHERE user_id IS NULL",
    "CREATE INDEX IF NOT EXISTS idx_race_results_played_at ON race_results (played_at DESC, id DESC)",
    "CREATE INDEX IF NOT EXISTS idx_race_results_room ON race_results (room_id) WHERE room_id IS NOT NULL",
  ];

  const rebuild = async (columns) => {
    await env.DB.exec("DROP TABLE IF EXISTS race_results");
    await env.DB.exec(`CREATE TABLE race_results (${columns})`);
    for (const sql of INDEXES) await env.DB.exec(sql);
  };

  beforeAll(() => rebuild(COLUMNS_0008));
  afterAll(() => rebuild(`${COLUMNS_0008}, points REAL`));

  const seedOld = (overrides) => seedRace(overrides, { withPoints: false });

  it("still ranks by PPM, reporting every points cell as null", async () => {
    await seedUser({ id: "u1", username: "slow" });
    await seedUser({ id: "u2", username: "mid" });
    await seedUser({ id: "u3", username: "fast" });
    await seedOld({ user_id: "u1", finish_time_ms: 120_000 });
    await seedOld({ user_id: "u2", finish_time_ms: 60_000 });
    await seedOld({ user_id: "u3", finish_time_ms: 30_000 });

    const { res, body } = await board();
    expect(res.status).toBe(200);
    // Proof the rows really landed in the old shape rather than a migrated one.
    const [row] = (await env.DB.prepare("SELECT * FROM race_results LIMIT 1").all()).results;
    expect(row).not.toHaveProperty("points");

    expect(names(body)).toEqual(["fast", "mid", "slow"]);
    expect(body.entries.map((e) => e.rank)).toEqual([1, 2, 3]);
    expect(body.entries.map((e) => e.points)).toEqual([null, null, null]);
    expect(body.entries[0].ppm).toBeCloseTo(ppmFor(30_000), 6);
  });

  it("keeps every other eligibility rule while degraded", async () => {
    await seedUser({ id: "u1", username: "solo" });
    await seedUser({ id: "u2", username: "grace" });
    // The excluded race is the fastest, so a rule dropped by the fallback path
    // would show up at rank 1.
    await seedOld({ user_id: "u1", room_id: null, finish_time_ms: 10_000 });
    await seedOld({ user_id: null, finish_time_ms: 12_000 });
    await seedOld({ user_id: "u2", finish_time_ms: 60_000 });

    const { body } = await board();
    expect(names(body)).toEqual(["grace"]);
  });

  it("still excludes a non-canonical race — one template, both queries", async () => {
    await seedUser({ id: "u1", username: "sprinter" });
    await seedUser({ id: "u2", username: "grace" });
    await seedOld({
      user_id: "u1",
      problems_total: 5,
      problems_correct: 5,
      problems_attempted: 5,
      finish_time_ms: 2_500,
    });
    await seedOld({ user_id: "u2", finish_time_ms: 30_000 });

    const { body } = await board();
    // The eligibility rules must not loosen in the window the fallback exists
    // for — that would be the board quietly changing what it claims.
    expect(names(body)).toEqual(["grace"]);
    expect(body.entries[0].points).toBeNull();
  });

  it("serves the period boards too, not only all-time", async () => {
    const start = periodStartMs("day", Date.now());
    await seedUser({ id: "u1", username: "today" });
    await seedUser({ id: "u2", username: "yesterday" });
    await seedOld({ user_id: "u1", played_at: start, finish_time_ms: 60_000 });
    await seedOld({ user_id: "u2", played_at: start - 1, finish_time_ms: 20_000 });

    expect(names((await board({ period: "day" })).body)).toEqual(["today"]);
    expect(names((await board({ period: "all" })).body)).toEqual(["yesterday", "today"]);
  });
});

describe("database failures other than a missing column", () => {
  it("propagates rather than silently retrying the degraded query", async () => {
    const boom = new Error("D1_ERROR: no such table: race_results");
    let prepares = 0;
    const failingEnv = {
      DB: {
        prepare: () => {
          prepares++;
          return { bind: () => ({ all: async () => { throw boom; } }) };
        },
      },
    };
    await expect(
      handleLeaderboard(
        boardRequest({ difficulty: "medium" }),
        failingEnv
      )
    ).rejects.toThrow(/no such table/);
    // The count is the half of this the rejection cannot prove: the stub
    // throws the same error every time, so a fallback that ran anyway would
    // still reject with it. Exactly one attempt means the missing-column
    // guard actually gated the retry.
    expect(prepares).toBe(1);
  });
});

// --- rate limiting ---------------------------------------------------------

// A stub rather than a burst against the real binding: the policy under test
// is what the handler does with a denial, not the limiter's own counting, and
// a stub says so in one call instead of 301.
function limiterEnv(success) {
  let keys = [];
  return {
    env: { ...env, LEADERBOARD_IP_LIMIT: { limit: async ({ key }) => (keys.push(key), { success }) } },
    keys: () => keys,
  };
}

describe("rate limiting", () => {
  it("is wired to a limiter that wrangler.jsonc actually declares", async () => {
    // Miniflare builds `env` from wrangler.jsonc, so this is the real consumer
    // resolving the real config: it fails if the binding is renamed on one
    // side only, which allowRequest would otherwise swallow by failing open.
    // Only the top-level environment — vitest does not load env.preview, whose
    // copy of the binding is a separate edit (see AGENTS.md).
    expect(typeof env.LEADERBOARD_IP_LIMIT?.limit).toBe("function");
  });

  it("429s with a retry-after when the limiter denies the client", async () => {
    await seedUser({ id: "u1", username: "ada" });
    await seedRace({ user_id: "u1" });

    const denied = limiterEnv(false);
    const { res, body } = await board({ dbEnv: denied.env });

    expect(res.status).toBe(429);
    expect(body).toEqual({ error: "rate_limited" });
    expect(res.headers.get("retry-after")).toBe("60");
    // Keyed on the caller's IP, which is all this endpoint has to key on.
    expect(denied.keys()).toEqual([clientIp]);
  });

  it("serves the board when the limiter allows it", async () => {
    await seedUser({ id: "u1", username: "ada" });
    await seedRace({ user_id: "u1" });

    const allowed = limiterEnv(true);
    const { res, body } = await board({ dbEnv: allowed.env });
    expect(res.status).toBe(200);
    expect(names(body)).toEqual(["ada"]);
  });

  it("never stores a 429, so a lifted limit is not served the rejection", async () => {
    await seedUser({ id: "u1", username: "ada" });
    await seedRace({ user_id: "u1" });

    const calls = await withCacheSpy(async () => {
      const { res } = await board({ dbEnv: limiterEnv(false).env });
      expect(res.status).toBe(429);
    });
    // The limiter returns before the cache exists to the handler at all.
    expect(calls).toEqual({ match: 0, put: 0 });

    // Same client, same board, limiter no longer denying: a real board, not
    // the stored 429 that a cache-before-limit ordering would have kept.
    const after = await board({ dbEnv: limiterEnv(true).env });
    expect(after.res.status).toBe(200);
    expect(names(after.body)).toEqual(["ada"]);
  });

  it("logs that the limit is being hit, but not once per rejected request", async () => {
    const seen = [];
    const realWarn = console.warn;
    console.warn = (line) => { seen.push(String(line)); };
    try {
      // Positive control: prove the spy is live before reading anything into
      // a low count. Without this, an inert patch would "pass" the bound.
      logWarn(KINDS.LEADERBOARD_RATE_LIMITED, "probe", {});
      expect(seen).toHaveLength(1);

      const denied = limiterEnv(false);
      for (let i = 0; i < 5; i++) {
        expect((await board({ dbEnv: denied.env })).res.status).toBe(429);
      }
    } finally {
      console.warn = realWarn;
    }

    // Five denials, at most one line. The latch is module-level and a window
    // is 60s, so an earlier test in this file may already hold it — zero is a
    // legitimate outcome and five is not, which is exactly the bound.
    const lines = seen.slice(1).filter((l) => l.includes("leaderboard_rate_limited"));
    expect(lines.length).toBeLessThanOrEqual(1);
  });

  it("costs a token even when the board comes back from the cache", async () => {
    await seedUser({ id: "u1", username: "ada" });
    await seedRace({ user_id: "u1" });

    const allowed = limiterEnv(true);
    const spy = countingEnv();
    const dbEnv = { ...allowed.env, DB: spy.env.DB };
    await board({ dbEnv });
    await board({ dbEnv });
    // Two limiter consultations, one D1 read: the second call really was a
    // cache hit, and it was charged anyway. A sweep that is cheap to serve is
    // still a sweep. Without the D1 count the title's second half would hold
    // even if the cache lookup were deleted.
    expect(allowed.keys()).toEqual([clientIp, clientIp]);
    expect(spy.prepares()).toBe(1);
  });

  it("serves the board when no limiter is configured at all", async () => {
    await seedUser({ id: "u1", username: "ada" });
    await seedRace({ user_id: "u1" });

    const { res, body } = await board({ dbEnv: { ...env, LEADERBOARD_IP_LIMIT: undefined } });
    // allowRequest fails open by design — a missing binding must not take the
    // public lobby down.
    expect(res.status).toBe(200);
    expect(names(body)).toEqual(["ada"]);
  });
});

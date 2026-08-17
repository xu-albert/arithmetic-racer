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
import { env } from "cloudflare:test";
import { handleLeaderboard, parseLimit } from "./leaderboard.js";
import { computePoints, computePpm } from "../race-score.js";
import { periodStartMs } from "../leaderboard-period.js";

// --- helpers ---------------------------------------------------------------

beforeEach(async () => {
  // race_results.user_id has an FK to user.id; clear the child table first.
  await env.DB.exec("DELETE FROM race_results");
  await env.DB.exec(`DELETE FROM "user"`);
});

let seq = 0;

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

async function board({ difficulty = "medium", period = "all", limit } = {}) {
  const params = new URLSearchParams({ difficulty, period });
  if (limit != null) params.set("limit", String(limit));
  const res = await handleLeaderboard(
    new Request(`https://x.test/api/leaderboard?${params}`),
    env
  );
  return { res, body: await res.json() };
}

/** Racers on a board, in rank order. */
function names(body) {
  return body.entries.map((e) => e.username);
}

// --- request validation ----------------------------------------------------

describe("request validation", () => {
  it("400s without a difficulty — there is no combined board", async () => {
    const res = await handleLeaderboard(
      new Request("https://x.test/api/leaderboard"),
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
      new Request("https://x.test/api/leaderboard?difficulty=easy"),
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
    // The 1s race would be 1200 PPM; the clean 60s race is 20.
    expect(body.entries[0].ppm).toBeCloseTo(20, 6);
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
    expect(easy.body.entries[0].ppm).toBeCloseTo(40, 6);
    expect(hard.body.entries[0].ppm).toBeCloseTo(20 / 1.5, 6);
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
    expect(body.entries[0].ppm).toBeCloseTo(40, 6);
  });

  it("reports points from the same race that earned the rank", async () => {
    await seedUser({ id: "u1", username: "ada" });
    // A long steady race and a short blistering one. PPM picks the short one;
    // points must be the short one's points, not the long one's larger total.
    const short = await seedRace({
      user_id: "u1",
      problems_total: 10,
      problems_correct: 10,
      problems_attempted: 10,
      finish_time_ms: 20_000,
    });
    await seedRace({
      user_id: "u1",
      problems_total: 40,
      problems_correct: 40,
      problems_attempted: 40,
      finish_time_ms: 120_000,
    });

    const { body } = await board();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].ppm).toBeCloseTo(
      computePpm({ finished: true, finish_time_ms: 20_000, problems_correct: 10 }),
      6
    );
    expect(body.entries[0].points).toBeCloseTo(short.points, 6);
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
    expect(body.entries[0].ppm).toBeCloseTo(20, 6);
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

describe("cache headers", () => {
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

  it("widens as the window widens: yesterday's race is out of the day board and in the year board", async () => {
    const now = Date.now();
    const dayStart = periodStartMs("day", now);
    const yearStart = periodStartMs("year", now);
    // Midway through the previous UTC day — inside the year, outside the day.
    const yesterday = dayStart - 43_200_000;
    // Guard: only meaningful if that instant is still inside the current year.
    expect(yesterday).toBeGreaterThanOrEqual(yearStart);

    await seedUser({ id: "u1", username: "today" });
    await seedUser({ id: "u2", username: "yesterday" });
    await seedRace({ user_id: "u1", played_at: now, finish_time_ms: 60_000 });
    await seedRace({ user_id: "u2", played_at: yesterday, finish_time_ms: 30_000 });

    expect(names((await board({ period: "day" })).body)).toEqual(["today"]);
    expect(names((await board({ period: "year" })).body)).toEqual(["yesterday", "today"]);
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
    expect(day.body.entries[0].ppm).toBeCloseTo(20, 6);
    const all = await board({ period: "all" });
    expect(all.body.entries[0].ppm).toBeCloseTo(60, 6);
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
    expect(body.entries[0].ppm).toBeCloseTo(40, 6);
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
    const failingEnv = {
      DB: {
        prepare: () => ({ bind: () => ({ all: async () => { throw boom; } }) }),
      },
    };
    await expect(
      handleLeaderboard(
        new Request("https://x.test/api/leaderboard?difficulty=medium"),
        failingEnv
      )
    ).rejects.toThrow(/no such table/);
  });
});

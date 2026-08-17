// GET /api/leaderboard — public best-PPM boards.
//
// Contract: see worker/api-contracts.js.
//
// One board is one (difficulty, period) pair. There is no combined board and
// never will be: easy/medium/hard are separate pools, and mixing them would
// rank "who played easy" rather than "who is fast" — see
// migrations/0009_race_results_points.sql and worker/race-score.js.
//
// ── What counts (the eligibility rule) ──────────────────────────────────────
//
// A row reaches a board only if all of these hold:
//
//   room_id IS NOT NULL   — the race happened in a Durable Object.
//   suspect = 0           — plausibility bounds cleared (worker/plausibility.js).
//   user_id IS NOT NULL   — and the account has a username to display.
//   finished = 1 AND finish_time_ms > 0 — there is a rate to rank.
//
// `room_id IS NOT NULL` is the load-bearing one, so it is worth stating why.
// Solo / Quickplay results are *self-reported*: POST /api/race-result stores
// whatever the browser sends, bounded only by the plausibility floor. Room
// results are *counted by the server*: RaceRoom.handleAnswer validates each
// answer against the room's own problem sequence and stamps `finishMs` from
// the server clock, and the row is written by the DO, not by the client. A
// leaderboard is a public claim about who is fastest; it should be built only
// from numbers the server itself observed.
//
// The lobby button for the excluded mode says "Solo vs Bots", which is the
// other half of the argument: a podium made of practice bots is not a
// standing. Bots never produce rows at all (persistResults skips `p.isBot`),
// so a Quick Match that backfilled empty lanes with bots still contributes
// only its humans — the bot backfill is not a reason to drop Quick Match.
//
// Anonymous racers are excluded for a different reason: there is nothing to
// put in the name column. `device_id` is the only handle an anon row carries
// and it is a private identifier that must never reach the wire. Signing in is
// how a racer opts into being listed.

import { db, isMissingColumnError } from "../db.js";
import { logWarn, KINDS } from "../logger.js";
import { isPeriod, periodStartMs } from "../leaderboard-period.js";

const DIFFICULTIES = new Set(["easy", "medium", "hard"]);

/** Rows returned when the caller does not ask for a size. */
const DEFAULT_LIMIT = 10;

/**
 * Hard ceiling on rows. D1 bills by rows read and this endpoint is public and
 * unauthenticated. The cache below blunts a repeat of the *same* board, but a
 * caller who varies the query is asking for fresh reads every time, so the
 * LIMIT is not a UI preference — it is the bound that keeps a crafted
 * `?limit=` from turning a page load into a table scan's worth of output.
 */
const MAX_LIMIT = 50;

/**
 * How long one stored board stays servable. This is not decoration for a CDN
 * edge — nothing on a workers.dev subdomain would honour it — it is the TTL
 * the Workers Cache API reads off the response `caches.default.put()` stores,
 * so it is what actually decides when the next request re-reads D1.
 *
 * 30s rather than the longer end of the useful range: a racer who has just set
 * a mark reloads the lobby to look for themselves, and half a minute is about
 * the longest that reads as "the board hasn't caught up" rather than "the
 * board is wrong". `max-age=0` is for the browser, which has no business
 * holding a public board privately — every reload asks the Worker, and the
 * Worker answers from its own cache until the 30s is up.
 */
const CACHE_CONTROL = "public, max-age=0, s-maxage=30";

/**
 * The stored identity of one board.
 *
 * Built from the *validated, normalized* parameters rather than the request
 * URL, because the URL carries noise the answer does not depend on: `?limit=`
 * absent, `?limit=abc`, `?limit=0` and `?limit=5000` are three defaults and a
 * clamp, i.e. two distinct boards, not four. Keying on the raw URL would let
 * any caller walk straight past the cache by varying a parameter that changes
 * nothing.
 */
function boardCacheKey(url, { difficulty, period, limit }) {
  const key = new URL("/api/leaderboard", url.origin);
  key.searchParams.set("difficulty", difficulty);
  key.searchParams.set("period", period);
  key.searchParams.set("limit", String(limit));
  return new Request(key.toString(), { method: "GET" });
}

/**
 * One row per racer — their single best race in the window — rather than one
 * row per race. Without the PARTITION BY, one fast racer having a good evening
 * fills every slot and the board stops being a board.
 *
 * PPM is derived (problems_correct / minutes) rather than stored; `points` is
 * read from the column because it accumulates and must not be recomputed by a
 * later formula. Both come from the *same* race: the row shown is the one that
 * earned the rank.
 *
 * Ties break toward the earlier race, so a racer who has already set a mark
 * does not get bumped by someone matching it later. `user_id` is the last
 * tiebreak purely so the order is total and the response is deterministic.
 *
 * `pointsExpr` is the one thing that varies: `points` normally, `NULL` against
 * a database that has not had migration 0009 applied yet. See the fallback in
 * `fetchBoard`.
 */
function boardSql(pointsExpr) {
  return `
  WITH eligible AS (
    SELECT user_id,
           ${pointsExpr} AS points,
           played_at,
           problems_correct * 60000.0 / finish_time_ms AS ppm
      FROM race_results
     WHERE difficulty = ?1
       AND played_at >= ?2
       AND room_id IS NOT NULL
       AND suspect = 0
       AND user_id IS NOT NULL
       AND finished = 1
       AND finish_time_ms > 0
  ),
  best AS (
    SELECT user_id, points, played_at, ppm,
           ROW_NUMBER() OVER (
             PARTITION BY user_id ORDER BY ppm DESC, played_at ASC
           ) AS rn
      FROM eligible
  )
  SELECT u.username AS username, b.ppm AS ppm, b.points AS points,
         b.played_at AS played_at
    FROM best b
    JOIN "user" u ON u.id = b.user_id
   WHERE b.rn = 1
     AND u.username IS NOT NULL
     AND u.username <> ''
   ORDER BY b.ppm DESC, b.played_at ASC, b.user_id ASC
   LIMIT ?3
`;
}

const BOARD_SQL = boardSql("points");
const BOARD_SQL_WITHOUT_POINTS = boardSql("NULL");

/**
 * Read one board, degrading to a points-less board rather than failing when
 * the column is not there yet.
 *
 * `race_results.points` arrives in migration 0009, and migrations here are
 * applied by hand while the Worker deploys from a push — so a build can run
 * against a database one migration behind (migrations/README.md). This is the
 * public lobby's first screen, and the ranking does not depend on the column:
 * PPM is derived from problems_correct and finish_time_ms, both of which have
 * been there since 0002. So the board still ranks, completely and in the same
 * order, with the points column reported as null.
 *
 * Only a genuinely missing column takes the fallback; every other D1 failure
 * propagates, so a real database error still surfaces as one.
 */
async function fetchBoard(env, { difficulty, since, limit, period }) {
  const run = (sql) => db(env).prepare(sql).bind(difficulty, since, limit).all();
  try {
    const { results } = await run(BOARD_SQL);
    return results ?? [];
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    warnSchemaBehind(err, { difficulty, period });
    const { results } = await run(BOARD_SQL_WITHOUT_POINTS);
    return results ?? [];
  }
}

/**
 * Whether the missing-column warning has already been emitted by this isolate.
 *
 * The thing worth knowing is that *the deployment* is ahead of the database,
 * which is true of every request or none — so one line says it, and a second
 * line says nothing new. Without the latch this is a warn per board read on
 * the lobby's first screen, at `head_sampling_rate: 1`, for as long as the
 * migration is unapplied. (The response cache thins those reads out but does
 * not bound them: every isolate, board and 30s window is another miss.)
 */
let warnedSchemaBehind = false;

function warnSchemaBehind(err, context) {
  if (warnedSchemaBehind) return;
  warnedSchemaBehind = true;
  logWarn(KINDS.LEADERBOARD_SCHEMA_BEHIND, err, context);
}

/**
 * Parse `?limit=`. Anything unreadable falls back to the default rather than
 * 400-ing: a board is a read-only view and a bad size is not worth an error
 * page.
 */
export function parseLimit(raw) {
  if (raw == null || raw === "") return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/**
 * @param {Request} request
 * @param {object} env
 * @param {{waitUntil?: (p: Promise<unknown>) => void}} [ctx] Worker execution
 *   context. Optional: without one the board is still served, just never
 *   stored, so the handler stays callable on its own.
 */
export async function handleLeaderboard(request, env, ctx) {
  const url = new URL(request.url);
  const difficulty = url.searchParams.get("difficulty") ?? "";
  const period = url.searchParams.get("period") ?? "all";

  // Both rejections return before the cache is touched: a 400 is a statement
  // about the request, not a board, and storing one would be storing garbage
  // under a key no valid request can produce anyway.
  if (!DIFFICULTIES.has(difficulty)) {
    return Response.json({ error: "invalid_difficulty" }, { status: 400 });
  }
  if (!isPeriod(period)) {
    return Response.json({ error: "invalid_period" }, { status: 400 });
  }

  const limit = parseLimit(url.searchParams.get("limit"));
  const cache = caches.default;
  const cacheKey = boardCacheKey(url, { difficulty, period, limit });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const now = Date.now();
  const since = periodStartMs(period, now);

  const results = await fetchBoard(env, { difficulty, since, limit, period });

  const entries = results.map((r, i) => ({
    rank: i + 1,
    username: r.username,
    ppm: Number(r.ppm),
    // A finished race always has points (the writer computes them from the
    // same two columns PPM comes from), but the row can still carry NULL: an
    // unscored row, or every row when the column itself is missing and
    // `fetchBoard` fell back. Null, not 0 — 0 is a score a racer can
    // genuinely earn.
    points: r.points == null ? null : Number(r.points),
    played_at: new Date(Number(r.played_at)).toISOString(),
  }));

  const response = Response.json(
    {
      difficulty,
      period,
      // NULL for the all-time board: it has no start, and sending 1970 would
      // invite the UI to print it.
      period_start: period === "all" ? null : new Date(since).toISOString(),
      generated_at: new Date(now).toISOString(),
      entries,
    },
    { headers: { "cache-control": CACHE_CONTROL } }
  );

  // Stored behind waitUntil so the racer waiting on this board never pays for
  // the write, and cloned because put() consumes the body it is handed.
  if (ctx?.waitUntil) ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

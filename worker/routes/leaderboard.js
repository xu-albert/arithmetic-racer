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
//   suspect = 0           — not flagged: the passive bounds cleared and, if the
//                           room asked for active verification, it passed
//                           (worker/plausibility.js, server/captcha.js).
//   user_id IS NOT NULL   — and the account has a username to display.
//   finished = 1 AND finish_time_ms > 0 — there is a rate to rank.
//   problems_total = 10   — it was the standard race (CANONICAL_RACE_LENGTH).
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
//
// `problems_total = 10` is a third axis again, and specifically *not* the
// provenance one above: a private room set to five problems is genuinely
// server-counted, so provenance has nothing to say about it. What rules it out
// is comparability. Race length is caller-chosen — Quick Match is fixed at ten,
// but a private-room host may set anything in [5, 50] (server/room.js) — and it
// moves PPM exactly the way difficulty does. A finished race has
// problems_correct = problems_total, so PPM is 60000 * n / finish_time, and the
// per-problem pace needed to top the board falls as n rises: five problems in
// 2.5s is 120 PPM, a rate no ten- or twenty-problem race can reach, from a
// racer who was not going faster. Ranking across lengths would rank "who picked
// the shortest race". That is the same argument the difficulty silo rests on,
// so it gets the same answer — one canonical length, stated in the lobby copy
// so nobody sets up a five-problem room expecting to appear.

import { CANONICAL_RACE_LENGTH } from "../race-constants.js";
import { db, isMissingColumnError } from "../db.js";
import { logWarn, KINDS } from "../logger.js";
import { allowRequest } from "../rate-limit.js";
import { logThrottleDecision, FRESH_THROTTLE } from "../log-throttle.js";
import { isPeriod, periodStartMs } from "../../public/src/leaderboard-period.js";

export { CANONICAL_RACE_LENGTH };

const DIFFICULTIES = new Set(["easy", "medium", "hard"]);

/** Matches LEADERBOARD_IP_LIMIT's `period` in wrangler.jsonc. */
const RATE_LIMIT_WINDOW_S = 60;

/** Rows returned when the caller does not ask for a size. */
const DEFAULT_LIMIT = 10;

/**
 * Hard ceiling on rows. D1 bills by rows read and this endpoint is public and
 * unauthenticated, so the LIMIT is not a UI preference — it is the bound that
 * keeps a crafted `?limit=` from turning a page load into a table scan's worth
 * of output. It holds on its own: the cache below may be a no-op on this
 * deployment (see CACHE_CONTROL), and a caller who varies the query would walk
 * past it anyway. What bounds *rate* rather than size is LEADERBOARD_IP_LIMIT.
 */
const MAX_LIMIT = 50;

/**
 * How long a stored board *would* stay servable. Read this as intent, not as a
 * description of what happens today.
 *
 * The cache layer below is best-effort. Cloudflare documents functional cache
 * operations for Workers on custom domains, and for Pages functions on either
 * a custom domain or `*.pages.dev`; workers.dev is absent from that list, and
 * this Worker is deployed to `arithmetic-racer.albertwxu.workers.dev` with no
 * `routes` in wrangler.jsonc. `cache.put()` resolves to undefined either way,
 * so on the current deployment it may silently store nothing and every
 * `cache.match()` may miss — i.e. assume the whole layer is a no-op in
 * production until the Worker gets a custom domain or route, or Workers
 * Caching is enabled for it. Both are deploy-topology changes, deliberately
 * out of scope here; the code is kept because it costs nothing and starts
 * working the moment either lands. The real ceiling on abuse in the meantime
 * is LEADERBOARD_IP_LIMIT, which does not depend on any of this.
 *
 * The number, for when it does apply: 30s rather than the longer end of the
 * useful range, because a racer who has just set a mark reloads the lobby to
 * look for themselves, and half a minute is about the longest that reads as
 * "the board hasn't caught up" rather than "the board is wrong". `max-age=0`
 * is for the browser, which has no business holding a public board privately.
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
 * On these boards the two columns are the same number twice, and that is known
 * and deliberate rather than an oversight to be rediscovered. Eligibility pins
 * `finished = 1` and `problems_total = ?4`, and a finished room race has
 * `problems_correct = problems_total` (`handleAnswer` stops accepting answers
 * at the race length), so every listed row has problems_correct = 10. Points
 * is `problems_correct * ppm / 60` (migrations/0009, worker/race-score.js),
 * which on those rows is exactly `ppm / 6` — 34.1 PPM always renders 5.7
 * points. The column stays because points is the unit this feature was
 * specified in and the one the profile screen speaks; it stops being a
 * restatement the moment the canonical-length rule loosens, which is the only
 * thing making the two collapse.
 *
 * Ties break toward the earlier race, so a racer who has already set a mark
 * does not get bumped by someone matching it later. `user_id` is the last
 * tiebreak purely so the order is total and the response is deterministic.
 *
 * `pointsExpr` is the one thing that varies between the two compiled forms:
 * `points` normally, `NULL` against a database that has not had migration 0009
 * applied yet (see the fallback in `fetchBoard`). Everything else — every
 * eligibility predicate included — is written once here precisely so the
 * degraded board cannot drift into admitting rows the normal one rejects.
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
       AND problems_total = ?4
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
  const run = (sql) =>
    db(env)
      .prepare(sql)
      .bind(difficulty, since, limit, CANONICAL_RACE_LENGTH)
      .all();
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

/** Test seam: the latch outlives a request, so a suite must be able to clear it. */
export function _resetSchemaBehindWarning() {
  warnedSchemaBehind = false;
}

function warnSchemaBehind(err, context) {
  if (warnedSchemaBehind) return;
  warnedSchemaBehind = true;
  logWarn(KINDS.LEADERBOARD_SCHEMA_BEHIND, err, context);
}

/**
 * Should this denial produce a log line?
 *
 * race-result.js logs nothing when it turns a request away, and for a POST
 * that is fine — the client that sent it sees the 429. This endpoint is the
 * lobby's first screen, so a limit sized wrong shows a stranger "Couldn't load
 * the leaderboard" and tells the operator nothing. Hence the divergence.
 *
 * Bounded to one line per window by the shared throttle in worker/log-throttle.js
 * — a line per denial would scale exactly with the flood the limiter exists to
 * absorb. Read that module's comment before reading a `denials` figure: the
 * first line of a burst is a first-denial notice, not a census, and `since_ms`
 * is what tells the two apart.
 */
let rateLimitLogState = FRESH_THROTTLE;

/** Test seam: the latch outlives a request, so a suite must be able to clear it. */
export function _resetRateLimitLog() {
  rateLimitLogState = FRESH_THROTTLE;
}

function warnRateLimited() {
  const decision = logThrottleDecision(
    rateLimitLogState,
    Date.now(),
    RATE_LIMIT_WINDOW_S * 1000
  );
  rateLimitLogState = decision.state;
  if (!decision.emit) return;
  logWarn(KINDS.LEADERBOARD_RATE_LIMITED, "per-IP board limit denied a request", {
    denials: decision.count,
    since_ms: decision.sinceMs,
    window_s: RATE_LIMIT_WINDOW_S,
  });
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
  // Before anything else, including the cache lookup: the limiter bounds
  // *requests*, and a sweep that is being served cheaply is still a sweep.
  // Keyed on IP because there is nothing else to key on — no session, no
  // device id, no body. `allowRequest` fails open where no binding is
  // configured, which is the same call every other limiter here makes.
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await allowRequest(env.LEADERBOARD_IP_LIMIT, ip, "LEADERBOARD_IP_LIMIT"))) {
    warnRateLimited();
    return Response.json(
      { error: "rate_limited" },
      { status: 429, headers: { "retry-after": String(RATE_LIMIT_WINDOW_S) } }
    );
  }

  const url = new URL(request.url);
  const difficulty = url.searchParams.get("difficulty") ?? "";
  const period = url.searchParams.get("period") ?? "all";

  // Both rejections return before the cache is touched: a 400 is a statement
  // about the request, not a board, and storing one would be storing garbage
  // under a key no valid request can produce anyway. The 429 above returns
  // earlier still, so neither rejection can ever be stored.
  if (!DIFFICULTIES.has(difficulty)) {
    return Response.json({ error: "invalid_difficulty" }, { status: 400 });
  }
  if (!isPeriod(period)) {
    return Response.json({ error: "invalid_period" }, { status: 400 });
  }

  const limit = parseLimit(url.searchParams.get("limit"));
  const cache = caches.default;
  const cacheKey = boardCacheKey(url, { difficulty, period, limit });
  // Guarded the way the store below is, and for the same reason: this file
  // declares the whole cache layer best-effort and unverifiable in production,
  // so it must not become something the board can fail on. No path is known
  // where match() rejects rather than resolving undefined — this is symmetry
  // with that posture, not a fixed bug. A swallowed lookup just misses, and a
  // miss is the D1 read the handler was about to do anyway.
  const cached = await cache.match(cacheKey).catch(() => undefined);
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
  // the write, and cloned because put() consumes the body it is handed. The
  // rejection is swallowed to make "best-effort" true: the board has already
  // been returned, a failed store has nothing to tell the caller, and an
  // unhandled waitUntil rejection would attach an exception to every board
  // request — whether the Cache API refuses this Cache-Control quietly or by
  // throwing is exactly what the block above says we cannot assert.
  if (ctx?.waitUntil) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => {}));
  }
  return response;
}

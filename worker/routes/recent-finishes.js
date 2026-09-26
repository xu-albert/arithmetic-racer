// GET /api/recent-finishes — the lobby's "who's racing" strip.
//
// Contract: see worker/api-contracts.js.
//
// This is an *activity* feed, not a standing. It answers "is anyone racing
// right now?", so it is ordered by recency and never by speed, and it carries
// no rank. That distinction is what makes its eligibility rule differ from a
// leaderboard's in one place — see "Anonymous racers" below.
//
// ── What counts (the eligibility rule) ──────────────────────────────────────
//
// A row reaches the feed only if all of these hold:
//
//   room_id IS NOT NULL                  — the race happened in a room.
//   suspect = 0                          — not flagged (bounds cleared, and any
//                                          captcha challenge passed).
//   finished = 1 AND finish_time_ms > 0  — there is a finish to report.
//
// `room_id IS NOT NULL` is the load-bearing one. Solo / Quickplay results are
// *self-reported*: POST /api/race-result stores whatever the browser sends,
// bounded only by the plausibility floor. Room results are *counted by the
// server*: RaceRoom.handleAnswer validates each answer against the room's own
// problem sequence and stamps `finishMs` from the server clock, and the row is
// written by the Durable Object rather than the client. A public feed of who
// just raced should only report races the server itself observed.
//
// The excluded mode is the one the lobby labels "Solo vs Bots", which is the
// other half of the argument: a feed is a claim that there are *people* here,
// and a podium made of practice bots is not people. Bots never produce rows at
// all (`queueRaceResults` skips `p.isBot`), so a Quick Match that backfilled
// empty lanes with bots still contributes only its humans — the bot backfill is
// not a reason to drop Quick Match, which is where most of the liveness is.
//
// `suspect = 0` per migrations/0007_race_results_suspect.sql: an implausible
// race — or one whose racer failed or ignored the superhuman-pace captcha
// (worker/plausibility.js, server/captcha.js) — is kept as evidence but must
// not be shown as a finish.
//
// ── Anonymous racers ARE included ───────────────────────────────────────────
//
// A leaderboard excludes them: there is nothing to put in the name column, and
// signing in is how a racer opts into being *ranked*. A liveness feed is the
// opposite case. Most alpha traffic is anonymous, so excluding anon rows would
// make the feed report far less activity than actually happened — it would lie
// in the exact direction the feed exists to answer. So an anon finish is listed
// with no name and the client prints "Guest", which is already how the game
// labels an anon racer in a lane (see public/main.js).
//
// Nothing identifying rides along: `device_id` is the only handle an anon row
// carries and it never leaves the database. `room_id` is likewise never
// returned — a private room slug is its invite credential.

import { db, isMissingColumnError } from "../db.js";

/** Rows returned when the caller does not ask for a size. */
const DEFAULT_LIMIT = 8;

/**
 * Hard ceiling on rows. D1 bills by rows read and this endpoint is public,
 * uncached, and polled on a timer, so the LIMIT is not a UI preference — it is
 * the bound that keeps a crafted `?limit=` from multiplying every poll.
 */
const MAX_LIMIT = 25;

/**
 * Newest eligible finishes.
 *
 * `ORDER BY played_at DESC, id DESC` matches idx_race_results_played_at
 * (migration 0004), so this walks that index newest-first and stops at LIMIT
 * rather than scanning the table; no new index is needed for the feed. `id` is
 * the tiebreak purely so two races stamped in the same millisecond come back
 * in a stable order.
 *
 * PPM is derived (problems_correct / minutes) from columns that predate 0009,
 * so the headline number survives even when `points` does not — see
 * `selectFinishes`.
 *
 * LEFT JOIN, not JOIN: an anonymous row has no `user` to join to and must
 * still be listed.
 *
 * @param {string} pointsExpr How to source the `points` column.
 */
const feedSql = (pointsExpr) => `
  SELECT r.difficulty AS difficulty,
         r.played_at AS played_at,
         r.problems_correct AS problems_correct,
         r.problems_correct * 60000.0 / r.finish_time_ms AS ppm,
         ${pointsExpr} AS points,
         u.username AS username
    FROM race_results r
    LEFT JOIN "user" u ON u.id = r.user_id
   WHERE r.room_id IS NOT NULL
     AND r.suspect = 0
     AND r.finished = 1
     AND r.finish_time_ms > 0
   ORDER BY r.played_at DESC, r.id DESC
   LIMIT ?
`;

/**
 * Read the feed, degrading if `race_results.points` is not there yet.
 *
 * Migrations are applied by hand while the Worker deploys from a push, so a
 * build can briefly run against a database one migration behind
 * (migrations/README.md). `points` arrives in 0009; an unguarded read of it
 * would turn every lobby load into a 500 for that window. The fallback selects
 * NULL for the column instead, which the response already models as "not
 * scored", so the feed keeps showing names, difficulties, PPM and timestamps.
 */
async function selectFinishes(env, limit) {
  const run = (pointsExpr) =>
    db(env).prepare(feedSql(pointsExpr)).bind(limit).all();
  try {
    const { results } = await run("r.points");
    return results ?? [];
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    const { results } = await run("NULL");
    return results ?? [];
  }
}

/**
 * Parse `?limit=`. Anything unreadable falls back to the default rather than
 * 400-ing: the feed is a read-only view and a bad size is not worth an error
 * from a page that is only trying to render a strip.
 */
export function parseFeedLimit(raw) {
  if (raw == null || raw === "") return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export async function handleRecentFinishes(request, env) {
  const url = new URL(request.url);
  const limit = parseFeedLimit(url.searchParams.get("limit"));

  const rows = await selectFinishes(env, limit);

  const finishes = rows.map((r) => ({
    // NULL for an anonymous racer, and also for a signed-in account that has
    // not picked a username yet — both have no name to print, which is the
    // only thing this field is for.
    username: r.username == null || r.username === "" ? null : r.username,
    difficulty: r.difficulty,
    problems_correct: Number(r.problems_correct),
    ppm: Number(r.ppm),
    // Null, not 0 — 0 is a score a racer can genuinely earn (finished, nothing
    // correct), so the two must stay distinguishable. Null here means either a
    // pre-0009 row the backfill missed or a database that has not reached 0009.
    points: r.points == null ? null : Number(r.points),
    played_at: new Date(Number(r.played_at)).toISOString(),
  }));

  return Response.json({
    // The client computes "3m ago" against this rather than its own clock, so a
    // skewed device does not print a finish from the future.
    generated_at: new Date(Date.now()).toISOString(),
    limit,
    finishes,
  });
}

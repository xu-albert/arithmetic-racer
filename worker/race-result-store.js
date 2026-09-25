// Shared race-result writer. Both the POST /api/race-result route and the
// RaceRoom Durable Object call this so the insert lives in exactly one place.
//
// Payload shape mirrors the validated body of POST /api/race-result plus two
// fields the route handler resolves itself: `user_id` (from session cookie)
// and `room_id` (NULL for solo, room slug for room races).

import { db } from "./db.js";
import { assessPlausibility } from "./plausibility.js";
import { computePoints } from "./race-score.js";

export async function insertRaceResult(env, payload, plausibilityOverride) {
  const id = crypto.randomUUID();
  const playedAt = Date.now();

  // Assessed here rather than in the route so every writer is covered — the
  // solo POST and the RaceRoom DO both land on this function, and a bound that
  // only one path applies is a bound with a hole in it.
  //
  // A room's captcha (server/captcha.js) may override the passive assessment:
  // failing or timing out the challenge stores the row as suspect with a
  // captcha_* reason so leaderboards and feeds exclude it. Passing stores
  // normally — the passive bounds still apply, so a sub-200ms/problem time
  // that passes the captcha is still flagged impossibly_fast.
  //
  // It is a separate argument rather than a payload field on purpose: `payload`
  // is populated from a request body on the solo path, and an override read off
  // that object would be one `{...body}` away from letting a client clear its
  // own suspect flag. Only a caller that names it can set it.
  const { suspect, reason } = plausibilityOverride ?? assessPlausibility(payload);

  // Scored here for the same reason. It is stored rather than derived at read
  // time so the formula can change without silently rewriting what past races
  // were worth — see migrations/0009_race_results_points.sql. NULL for an
  // unfinished race. PPM is left derived (problems_correct / minutes); it is a
  // rate, not an earning, so nothing accumulates from it.
  const points = computePoints(payload);

  // A room-counted row is written from the room's durable outbox
  // (server/room.js), which retries until the insert lands — and a retry can
  // follow a write that actually succeeded, when the DO crashed between the
  // D1 response and recording the settle. A replayed race end rebuilds a
  // bit-identical payload, so the (room, device, result) fingerprint of the
  // earlier row identifies it and the retry stands down instead of
  // double-counting the race. Solo rows (room_id NULL) are one-shot client
  // POSTs with no retry loop behind them and skip the check.
  //
  // The fingerprint cannot tell a replay apart from two genuinely identical
  // races: same room, same device, same finish time to the millisecond, same
  // score. For a finisher that coincidence is effectively impossible; a
  // zero-attempt DNF can repeat across a rematch, and then costs the player
  // one indistinguishable row in their own history. Accepted — the
  // alternative (a stored dedupe key under a unique index) is a migration
  // plus a census of pre-existing duplicates.
  if (payload.room_id != null) {
    const existing = await db(env)
      .prepare(
        `SELECT id FROM race_results
         WHERE room_id = ? AND device_id = ? AND finished = ?
           AND problems_total = ? AND problems_correct = ? AND problems_attempted = ?
           AND longest_streak = ?
           AND (finish_time_ms = ? OR (finish_time_ms IS NULL AND ? IS NULL))
         LIMIT 1`
      )
      .bind(
        payload.room_id,
        payload.device_id,
        payload.finished ? 1 : 0,
        payload.problems_total,
        payload.problems_correct,
        payload.problems_attempted,
        payload.longest_streak ?? 0,
        payload.finish_time_ms,
        payload.finish_time_ms
      )
      .first();
    if (existing) {
      return { id: existing.id, played_at: null, suspect, suspect_reason: reason, points, duplicate: true };
    }
  }

  await db(env)
    .prepare(
      `INSERT INTO race_results (
         id, user_id, device_id, difficulty, finished, finish_time_ms,
         problems_total, problems_correct, problems_attempted,
         avg_time_per_problem_ms, accuracy_pct, longest_streak,
         played_at, room_id, suspect, suspect_reason, points
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      id,
      payload.user_id,
      payload.device_id,
      payload.difficulty,
      payload.finished ? 1 : 0,
      payload.finish_time_ms,
      payload.problems_total,
      payload.problems_correct,
      payload.problems_attempted,
      payload.avg_time_per_problem_ms,
      payload.accuracy_pct,
      payload.longest_streak,
      playedAt,
      payload.room_id ?? null,
      suspect,
      reason,
      points
    )
    .run();
  return { id, played_at: playedAt, suspect, suspect_reason: reason, points };
}

// Shared race-result writer. Both the POST /api/race-result route and the
// RaceRoom Durable Object call this so the insert lives in exactly one place.
//
// Payload shape mirrors the validated body of POST /api/race-result plus two
// fields the route handler resolves itself: `user_id` (from session cookie)
// and `room_id` (NULL for solo, room slug for room races).

import { db } from "./db.js";
import { assessPlausibility } from "./plausibility.js";
import { computePoints } from "./race-score.js";

export async function insertRaceResult(env, payload) {
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
  const { suspect, reason } = payload.plausibility_override ?? assessPlausibility(payload);

  // Scored here for the same reason. It is stored rather than derived at read
  // time so the formula can change without silently rewriting what past races
  // were worth — see migrations/0009_race_results_points.sql. NULL for an
  // unfinished race. PPM is left derived (problems_correct / minutes); it is a
  // rate, not an earning, so nothing accumulates from it.
  const points = computePoints(payload);

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

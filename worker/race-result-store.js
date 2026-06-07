// Shared race-result writer. Both the POST /api/race-result route and the
// RaceRoom Durable Object call this so the insert lives in exactly one place.
//
// Payload shape mirrors the validated body of POST /api/race-result plus two
// fields the route handler resolves itself: `user_id` (from session cookie)
// and `room_id` (NULL for solo, room slug for room races).

import { db } from "./db.js";

export async function insertRaceResult(env, payload) {
  const id = crypto.randomUUID();
  const playedAt = Date.now();
  await db(env)
    .prepare(
      `INSERT INTO race_results (
         id, user_id, device_id, difficulty, finished, finish_time_ms,
         problems_total, problems_correct, problems_attempted,
         avg_time_per_problem_ms, accuracy_pct, longest_streak,
         played_at, room_id
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
      payload.room_id ?? null
    )
    .run();
  return { id, played_at: playedAt };
}

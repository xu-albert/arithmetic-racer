// Shared race-result writer. Both the POST /api/race-result route and the
// RaceRoom Durable Object call this so the insert lives in exactly one place.
//
// Payload shape mirrors the validated body of POST /api/race-result plus two
// fields the route handler resolves itself: `user_id` (from session cookie)
// and `room_id` (NULL for solo, room slug for room races).

import { db } from "./db.js";
import { assessPlausibility } from "./plausibility.js";
import { computePoints } from "./race-score.js";

export async function insertRaceResult(env, payload, plausibilityOverride, raceAt) {
  const id = crypto.randomUUID();
  // A room row lands from the room's durable outbox (server/room.js), and a
  // retry can land it up to RESULT_OUTBOX_TTL_MS after the race — past a UTC
  // midnight, into the next leaderboard window. So the room hands over the
  // race's own time, and the row is dated to that rather than to the write.
  // A separate argument for the same reason as the override below: a solo
  // row's payload is a request body, and a date read off it would be the
  // client's to choose. Solo rows are dated here, as they land.
  const playedAt = raceAt ?? Date.now();

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

  // The outbox retries until the insert lands — and a retry can follow a write
  // that actually succeeded, when the DO crashed between the D1 response and
  // recording the settle. The retry replays the stored entry, so it carries
  // the same payload and the same race time, and the (room, device, race
  // time, result) fingerprint of the earlier row identifies it: the retry
  // inserts nothing instead of double-counting the race. The race time is
  // what keeps two genuinely different races apart — a racer who idles
  // through two rematches posts the same counts twice, but not from the same
  // millisecond. The check rides inside the INSERT, so it and the write are
  // one statement: one round trip, and no gap for another write to land in.
  // Solo rows (no race time) are one-shot client POSTs with no retry loop
  // behind them and skip the check.
  const insert = `INSERT INTO race_results (
       id, user_id, device_id, difficulty, finished, finish_time_ms,
       problems_total, problems_correct, problems_attempted,
       avg_time_per_problem_ms, accuracy_pct, longest_streak,
       played_at, room_id, suspect, suspect_reason, points
     )`;
  const row = "?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17";
  const sql = raceAt == null
    ? `${insert} VALUES (${row})`
    : `${insert} SELECT ${row}
       WHERE NOT EXISTS (
         SELECT 1 FROM race_results
         WHERE played_at = ?13 AND room_id = ?14 AND device_id = ?3 AND finished = ?5
           AND problems_total = ?7 AND problems_correct = ?8 AND problems_attempted = ?9
           AND longest_streak = ?12 AND finish_time_ms IS ?6
       )`;
  const { meta } = await db(env)
    .prepare(sql)
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
  if (meta.changes === 0) {
    return { id: null, played_at: playedAt, suspect, suspect_reason: reason, points, duplicate: true };
  }
  return { id, played_at: playedAt, suspect, suspect_reason: reason, points };
}

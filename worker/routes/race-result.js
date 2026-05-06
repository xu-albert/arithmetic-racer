// POST /api/race-result handler.
//
// Persists a single race result row to D1. The same endpoint serves both
// anonymous clients (no session cookie) and logged-in users; the handler
// decides whether to set user_id by reading the session.
//
// This handler does NOT run the anon -> registered claim flow. That logic
// is owned by Agent D and runs once at signup (see worker/auth.js when
// it lands). Per-race inserts simply record device_id alongside an
// optional user_id; the claim job rewrites user_id later.
//
// Contract: see worker/api-contracts.js (frozen).

import { db } from "../db.js";
import { readUserId } from "../session.js";

const DIFFICULTIES = new Set(["easy", "medium", "hard"]);

/**
 * Validate the parsed JSON body against RaceResultInput.
 * Returns true only if every required field is present and within range.
 */
function isValidBody(b) {
  return (
    b &&
    typeof b === "object" &&
    typeof b.device_id === "string" && b.device_id.length > 0 &&
    DIFFICULTIES.has(b.difficulty) &&
    typeof b.finished === "boolean" &&
    (b.finish_time_ms === null ||
      (typeof b.finish_time_ms === "number" && Number.isFinite(b.finish_time_ms) && b.finish_time_ms >= 0)) &&
    Number.isInteger(b.problems_total) && b.problems_total > 0 &&
    Number.isInteger(b.problems_correct) && b.problems_correct >= 0 &&
    Number.isInteger(b.problems_attempted) && b.problems_attempted >= 0 &&
    Number.isFinite(b.avg_time_per_problem_ms) && b.avg_time_per_problem_ms >= 0 &&
    Number.isFinite(b.accuracy_pct) && b.accuracy_pct >= 0 && b.accuracy_pct <= 100 &&
    Number.isInteger(b.longest_streak) && b.longest_streak >= 0
  );
}

export async function handleRaceResult(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  if (!isValidBody(body)) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  const userId = await readUserId(request, env);
  const id = crypto.randomUUID();
  const playedAt = Date.now();

  try {
    await db(env)
      .prepare(
        `INSERT INTO race_results (
           id, user_id, device_id, difficulty, finished, finish_time_ms,
           problems_total, problems_correct, problems_attempted,
           avg_time_per_problem_ms, accuracy_pct, longest_streak, played_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        id,
        userId,
        body.device_id,
        body.difficulty,
        body.finished ? 1 : 0,
        body.finish_time_ms,
        body.problems_total,
        body.problems_correct,
        body.problems_attempted,
        body.avg_time_per_problem_ms,
        body.accuracy_pct,
        body.longest_streak,
        playedAt
      )
      .run();
  } catch (err) {
    return Response.json(
      { error: "db_error", detail: String(err) },
      { status: 500 }
    );
  }

  // `claimed` is always false here; the field exists in the response shape
  // so the contract stays stable when Agent D's signup flow returns the
  // same shape with a true value after running the claim job.
  return Response.json({ id, claimed: false });
}

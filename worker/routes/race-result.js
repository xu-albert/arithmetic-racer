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

import { readUserId } from "../session.js";
import { insertRaceResult } from "../race-result-store.js";

const DIFFICULTIES = new Set(["easy", "medium", "hard"]);

// accuracy_pct is computed and rounded client-side, so an exact match against
// the counts would reject honest results (2/3 races report 66.7, not
// 66.666...). One percentage point absorbs any sane rounding while still
// catching a fabricated value, which is off by tens of points, not tenths.
const ACCURACY_TOLERANCE_PCT = 1;

/**
 * Cross-field checks. Every field can be individually in range while the
 * combination is impossible — `{problems_correct: 999, problems_total: 1}`
 * passed every range check and persisted before this existed.
 */
function isSelfConsistent(b) {
  // correct <= attempted <= total. Transitively bounds correct by total too.
  if (b.problems_correct > b.problems_attempted) return false;
  if (b.problems_attempted > b.problems_total) return false;

  // You cannot have a run of correct answers longer than your correct answers.
  if (b.longest_streak > b.problems_correct) return false;

  // Nothing attempted means nothing to be accurate about.
  const expected =
    b.problems_attempted === 0
      ? 0
      : (b.problems_correct / b.problems_attempted) * 100;
  return Math.abs(b.accuracy_pct - expected) <= ACCURACY_TOLERANCE_PCT;
}

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
    Number.isInteger(b.longest_streak) && b.longest_streak >= 0 &&
    // Runs last: it reads several fields at once and assumes each is already
    // known to be a number of the right kind.
    isSelfConsistent(b)
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

  let id;
  try {
    ({ id } = await insertRaceResult(env, {
      user_id: userId,
      device_id: body.device_id,
      difficulty: body.difficulty,
      finished: body.finished,
      finish_time_ms: body.finish_time_ms,
      problems_total: body.problems_total,
      problems_correct: body.problems_correct,
      problems_attempted: body.problems_attempted,
      avg_time_per_problem_ms: body.avg_time_per_problem_ms,
      accuracy_pct: body.accuracy_pct,
      longest_streak: body.longest_streak,
      room_id: null,
    }));
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

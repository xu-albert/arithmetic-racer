// POST /api/race-result handler.
//
// Persists a single finished race result row to D1. The same endpoint serves both
// anonymous clients (no session cookie) and logged-in users; the handler
// decides whether to set user_id by reading the session.
//
// This handler does NOT run the anon -> registered claim flow. That is
// runClaim in worker/auth.js, run once at email/password signup. Per-race
// inserts simply record device_id alongside an optional user_id; the claim
// job rewrites user_id later.
//
// Contract: see worker/api-contracts.js (frozen).

import { readUserId } from "../session.js";
import { insertRaceResult } from "../race-result-store.js";
import { allowRequest } from "../rate-limit.js";
import { logError, KINDS } from "../logger.js";

// Matches the `period` on both limiters in wrangler.jsonc. The binding only
// permits 10 or 60, so this is a fixed window, not a rolling one.
const RATE_LIMIT_WINDOW_S = 60;

function rateLimited() {
  return Response.json(
    { error: "rate_limited" },
    { status: 429, headers: { "retry-after": String(RATE_LIMIT_WINDOW_S) } }
  );
}

// Solo uses ten problems today; retain small custom/older race lengths while
// bounding storage inputs. Attempts include retries, not just solved problems.
const MAX_PROBLEMS = 50;
const MAX_ATTEMPTS = 10_000;
const MAX_DEVICE_ID_LENGTH = 128;
// Generous hard ceiling for an abandoned tab; the existing 30-minute soft
// plausibility threshold still flags long races below this boundary.
const MAX_RESULT_TIME_MS = 24 * 60 * 60_000;
const AVG_TIME_TOLERANCE_MS = 0.5; // Math.round(finishTime / correct) in public/main.js

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
  // A wrong answer increments attempts without advancing the problem.
  if (b.problems_correct > b.problems_attempted) return false;
  if (b.problems_correct > b.problems_total) return false;

  if (b.finished) {
    if (b.problems_correct !== b.problems_total) return false;
    const expectedAverage = b.finish_time_ms / b.problems_correct;
    if (Math.abs(b.avg_time_per_problem_ms - expectedAverage) > AVG_TIME_TOLERANCE_MS) return false;
  } else {
    // The client reports no elapsed time or average for a quit.
    if (b.problems_correct === b.problems_total || b.avg_time_per_problem_ms !== 0) return false;
  }

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
    typeof b.device_id === "string" && b.device_id.length > 0 && b.device_id.length <= MAX_DEVICE_ID_LENGTH &&
    DIFFICULTIES.has(b.difficulty) &&
    typeof b.finished === "boolean" &&
    (b.finished
      ? (Number.isFinite(b.finish_time_ms) && b.finish_time_ms > 0 && b.finish_time_ms <= MAX_RESULT_TIME_MS)
      : b.finish_time_ms === null) &&
    Number.isInteger(b.problems_total) && b.problems_total > 0 && b.problems_total <= MAX_PROBLEMS &&
    Number.isInteger(b.problems_correct) && b.problems_correct >= 0 &&
    Number.isInteger(b.problems_attempted) && b.problems_attempted >= 0 && b.problems_attempted <= MAX_ATTEMPTS &&
    Number.isFinite(b.avg_time_per_problem_ms) && b.avg_time_per_problem_ms >= 0 &&
    Number.isFinite(b.accuracy_pct) && b.accuracy_pct >= 0 && b.accuracy_pct <= 100 &&
    Number.isInteger(b.longest_streak) && b.longest_streak >= 0 &&
    // Runs last: it reads several fields at once and assumes each is already
    // known to be a number of the right kind.
    isSelfConsistent(b)
  );
}

export async function handleRaceResult(request, env) {
  // IP ceiling first, before reading the body: it needs no parsing, so it is
  // the only check that can absorb a flood of malformed requests. The device
  // limit below cannot — its key lives inside the body.
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await allowRequest(env.RACE_RESULT_IP_LIMIT, ip, "RACE_RESULT_IP_LIMIT"))) {
    return rateLimited();
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  if (!isValidBody(body)) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  // Only a finished solo race is stored: current clients stop sending quits
  // (public/src/solo-result.js) and older ones are refused here. The profile's
  // race count, accuracy and history therefore cover finished solo races only,
  // and its finish rate reads multiplayer rows alone (worker/routes/me.js).
  // Checked after validation, so a malformed quit still reads as invalid, and
  // before the device limit, so a refused quit does not spend its budget.
  // Rows already stored stay as they are, and room races, which a Durable
  // Object writes directly, are untouched.
  if (!body.finished) {
    return Response.json({ error: "unfinished_not_stored" }, { status: 422 });
  }

  // Device is the primary key for limiting — see wrangler.jsonc for why IP
  // alone is too coarse. Checked after validation so a client cannot burn
  // another device's budget by sending its id in a body we reject anyway.
  if (!(await allowRequest(env.RACE_RESULT_LIMIT, body.device_id, "RACE_RESULT_LIMIT"))) {
    return rateLimited();
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
    logError(KINDS.RACE_RESULT_DB, err, { path: "solo", phase: "insert" });
    return Response.json(
      { error: "db_error" },
      { status: 500 }
    );
  }

  // `claimed` is always false here: this handler never runs the claim. The
  // field stays because the frozen contract (worker/api-contracts.js) has it.
  return Response.json({ id, claimed: false });
}

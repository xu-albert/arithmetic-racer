// Race plausibility bounds.
//
// Policy: **flag, never reject.** A race that looks impossible is exactly the
// record you want to keep and examine — rejecting it deletes the evidence and
// tells whoever sent it precisely where the threshold sits. Suspect rows are
// persisted normally; leaderboards filter on `suspect = 0`.
//
// This is integrity, not cost control. Rate limiting (worker/rate-limit.js) is
// the thing that stops a script hammering D1; these bounds only decide whether
// a stored result is allowed to count. Keeping the two separate is what makes
// each number obvious.

/**
 * Floor on time-per-problem. A race is 10 problems (RACE_LENGTH in
 * public/src/runner.js), and the game's own human-speed model tops out at
 * 35 problems/min on easy — 1,714ms each. 200ms is 5 answers per second
 * including reading and typing, which is deliberately far below any human
 * ceiling: this should flag the impossible, not the merely excellent.
 * There could be a genuinely superhuman racer out there, and they should
 * still get a clean row.
 */
export const MIN_MS_PER_PROBLEM = 200;

/** Half an hour. Beyond this the tab was left open, not raced. */
export const MAX_RACE_MS = 30 * 60_000;

/**
 * @param {{finished: boolean, finish_time_ms: number|null, problems_total: number}} race
 * @returns {{suspect: 0|1, reason: string|null}}
 */
export function assessPlausibility(race) {
  const ms = race?.finish_time_ms;

  // Nothing to judge: an unfinished race has no finish time by construction,
  // and a finished one missing its time is the caller's bug, not the racer's.
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return { suspect: 0, reason: null };
  }

  if (ms < race.problems_total * MIN_MS_PER_PROBLEM) {
    return { suspect: 1, reason: "impossibly_fast" };
  }
  if (ms > MAX_RACE_MS) {
    return { suspect: 1, reason: "implausibly_slow" };
  }
  return { suspect: 0, reason: null };
}

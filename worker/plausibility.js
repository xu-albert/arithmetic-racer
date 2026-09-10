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

// Active verification (server/captcha.js). The passive floor above stays as it
// is — the captain chose active verification over tighter passive bounds. When
// a server-timed race finishes faster than a human can plausibly sustain, the
// room issues a short arithmetic captcha before recording the result; failing
// or ignoring it stores the row as suspect (unverified), never a ban.
//
// Threshold evidence: the best documented human on a comparable game is the
// Zetamac mixed-operation world record, which works out to roughly
// 638 ms/problem — and Zetamac auto-submits, one keystroke cheaper per problem
// than this game. A racer who sustains under 500 ms/problem over a whole
// 10-problem race is past that rate on the harder input mechanic, so they get
// asked to prove it. The consequence is a 3-question check, not a flag, so the
// trigger can sit far tighter than a reject threshold could.
//
// That evidence is a rate over a full ten-problem set, so the trigger applies
// to exactly that race — needsCaptchaTrigger (server/captcha.js) gates on
// CANONICAL_RACE_LENGTH. A private room set to five easy problems is both
// outside the evidence and outside every leaderboard, so there is nothing to
// verify there.
export const CAPTCHA_TRIGGER_MS_PER_PROBLEM = 500;

// How many fresh problems a triggered racer must answer. Small enough to be
// over in seconds, large enough that a script replaying race answers (which is
// what this catches — a human-speed thinker does not need it) cannot luck
// through.
export const CAPTCHA_PROBLEM_COUNT = 3;

// Time budget per captcha problem. Reading a problem, typing an answer and
// hitting Enter runs ~1.7s (easy operands) to ~2.6s (hard), so 4s is generous
// for a genuinely human solver and useless for automation that cannot do
// arithmetic. The challenge deadline is count × this.
export const CAPTCHA_MS_PER_PROBLEM = 4000;

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

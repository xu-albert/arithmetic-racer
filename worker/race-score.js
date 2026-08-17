// Per-race score and speed.
//
// Points are the structural analogue of TypeRacer's `words × words-per-second`:
// **volume × rate**, so a long race at a moderate pace can out-earn a short one
// at a blistering pace. That property is the whole reason for the shape — it is
// what stops the score collapsing into "who picked the shortest race".
//
//   points = problems_correct × (problems_correct / minutes) / 60
//   ppm    = problems_correct / minutes            (minutes = finish_time_ms / 60000)
//
// Difficulty deliberately does NOT enter either number. easy/medium/hard are
// separate point pools that are never compared or combined — see
// migrations/0009_race_results_points.sql and every `GROUP BY difficulty` in
// worker/routes/me.js. A per-difficulty weight was considered and rejected:
// README.md flags the difficulty calibration as provisional, and a weight would
// make that provisional number load-bearing for who wins.

/** Milliseconds in a minute — the unit the stored `finish_time_ms` converts to. */
const MS_PER_MINUTE = 60_000;

/**
 * Can this race be scored at all?
 *
 * Only a finished race with a positive finish time can: an unfinished race has
 * no finish time by construction (see worker/plausibility.js), and a race
 * claiming to be finished without one is a caller bug, not a zero-second race.
 * Both score NULL rather than 0 — 0 is a real result a racer can earn, and
 * conflating "did not finish" with "finished and earned nothing" would corrupt
 * every average built on top.
 *
 * @param {{finished?: boolean|number, finish_time_ms?: number|null, problems_correct?: number}} race
 */
function isScorable(race) {
  if (!race) return false;
  if (!race.finished) return false;
  const ms = race.finish_time_ms;
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return false;
  const correct = race.problems_correct;
  return typeof correct === "number" && Number.isFinite(correct) && correct >= 0;
}

/**
 * Problems per minute — the headline speed number. Bigger is better, which is
 * the point: it is the number a racer watches go up.
 *
 * @param {{finished?: boolean|number, finish_time_ms?: number|null, problems_correct?: number}} race
 * @returns {number|null} NULL for an unfinished/untimed race.
 */
export function computePpm(race) {
  if (!isScorable(race)) return null;
  return race.problems_correct / (race.finish_time_ms / MS_PER_MINUTE);
}

/**
 * Race score. Stored unrounded (`race_results.points` is REAL) so that sums
 * over many races stay exact; rounding is a display concern.
 *
 * @param {{finished?: boolean|number, finish_time_ms?: number|null, problems_correct?: number}} race
 * @returns {number|null} NULL for an unfinished/untimed race, 0 for a finished
 *   race with nothing correct.
 */
export function computePoints(race) {
  const ppm = computePpm(race);
  if (ppm === null) return null;
  return (race.problems_correct * ppm) / 60;
}

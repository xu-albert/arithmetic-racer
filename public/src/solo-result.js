// The row a finished solo race reports to POST /api/race-result
// (RaceResultInput in worker/api-contracts.js), built from the solo runner's
// state at its `finish` event.
//
// A quit reports nothing: only finished solo races are stored, and the route
// refuses unfinished solo bodies (worker/routes/race-result.js). So solo quits
// never reach the profile — its race count, accuracy and history cover the
// solo races that were finished, and its finish rate counts multiplayer races
// only. Room races are not reported here at all — their rooms write their own
// rows, quits included.
export function soloResultPayload({ runner, difficulty, deviceId }) {
  const player = runner.racers.find((r) => !r.isBot);
  if (!player || player.score < runner.raceLength) return null;
  const finishTime = player.finishMs;
  const attempts = player.attempts || 0;
  const correct = player.score;
  const accuracy = attempts > 0 ? (correct / attempts) * 100 : 0;
  const avgPerProblem = finishTime != null && correct > 0
    ? Math.round(finishTime / correct)
    : 0;
  return {
    device_id: deviceId,
    difficulty,
    finished: true,
    finish_time_ms: finishTime,
    problems_total: runner.raceLength,
    problems_correct: correct,
    problems_attempted: attempts,
    avg_time_per_problem_ms: avgPerProblem,
    accuracy_pct: accuracy,
    longest_streak: player.longestStreak || 0,
  };
}

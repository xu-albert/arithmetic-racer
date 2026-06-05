// Pure helpers that turn a Player + RoomState into the payload the
// race-result store accepts. Kept separate from room.js so we can test
// the payload math under node:test without booting the Workers runtime.

/**
 * Build the insertRaceResult payload for one player at race-end.
 * `player` is a Player from RoomState.players (post-finishRace).
 * `state` is RoomState (only id, difficulty, raceLength are read).
 */
export function buildRaceResultPayload(player, state) {
  const finished = player.score >= state.raceLength && !player.dropped && !player.dnf;
  const finishTime = finished ? player.finishMs : null;
  const attempts = player.attempts ?? 0;
  const correct = player.score;
  const accuracy = attempts > 0 ? (correct / attempts) * 100 : 0;
  const avgPerProblem = (finished && correct > 0) ? Math.round(finishTime / correct) : 0;
  return {
    user_id: player.userId ?? null,
    device_id: player.deviceId,
    difficulty: state.difficulty,
    finished,
    finish_time_ms: finishTime,
    problems_total: state.raceLength,
    problems_correct: correct,
    problems_attempted: attempts,
    avg_time_per_problem_ms: avgPerProblem,
    accuracy_pct: accuracy,
    longest_streak: player.longestStreak ?? 0,
    room_id: state.id,
  };
}

// Pure auto-start timer rule for public quickmatch lobbies.
//
// Semantics (from design spec §4.3):
//   - First player arrives          → set deadline = now + LONE_TIMEOUT_MS
//   - Second player arrives         → set deadline = now + GATHER_WINDOW_MS,
//                                      mark gather as triggered
//   - 3rd / 4th / 5th player join   → no change (let gather countdown run)
//   - MAX_PLAYERS-th player joins   → fire immediately (deadline = now)
//
// Caller mutates state with the returned { deadline, gatherTriggered }.

export const MAX_PLAYERS = 6;
export const LONE_TIMEOUT_MS = 5000;
export const GATHER_WINDOW_MS = 5000;

/**
 * @returns {{ deadline: number|null, gatherTriggered: boolean }}
 * `deadline=null` means "do not change the existing deadline".
 */
export function computeAutoStartDeadline({ playerCount, gatherTriggered, now }) {
  if (playerCount === MAX_PLAYERS) {
    return { deadline: now, gatherTriggered };
  }
  if (playerCount === 1) {
    return { deadline: now + LONE_TIMEOUT_MS, gatherTriggered };
  }
  if (playerCount === 2 && !gatherTriggered) {
    return { deadline: now + GATHER_WINDOW_MS, gatherTriggered: true };
  }
  return { deadline: null, gatherTriggered };
}

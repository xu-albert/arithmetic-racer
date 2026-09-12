// Race order, shared by every race runner: the podium draws it, and ui.js's
// finish banner takes the local player's place from it.
//
// Three tiers, best first:
//   1. finished  — has a finishMs; faster first.
//   2. racing    — no finish yet; higher score first.
//   3. out       — dropped or dnf; kept in arrival order.
//
// The room server (server/room.js rankPlayers) sorts by the same rule so the
// podium a client draws from its own racers matches the one the server
// broadcasts in `finish`. Pure: returns a new array, never reorders the input,
// and relies on Array.prototype.sort being stable for the within-tier ties.

function tierOf(r) {
  if (r.dropped || r.dnf) return 3;
  return r.finishMs != null ? 1 : 2;
}

/**
 * @template {{finishMs?: number|null, score?: number, dropped?: boolean, dnf?: boolean}} R
 * @param {R[]} racers
 * @returns {R[]} a new array, best first
 */
export function rankRacers(racers) {
  return [...racers].sort((a, b) => {
    const ta = tierOf(a);
    const tb = tierOf(b);
    if (ta !== tb) return ta - tb;
    if (ta === 1) return a.finishMs - b.finishMs;
    if (ta === 2) return b.score - a.score;
    return 0;
  });
}

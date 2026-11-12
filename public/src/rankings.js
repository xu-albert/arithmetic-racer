// Race order, shared by every race runner: the podium draws it, and ui.js's
// finish banner takes the local player's place from it.
//
// Four tiers, best first:
//   1. finished  — has a finishMs; faster first.
//   2. racing    — no finish yet; higher score first.
//   3. dnf       — stayed to the end without finishing; higher score first.
//   4. dropped   — left mid-race; higher score first.
// Racers who are out used to keep arrival order, so a solo quit (which marks
// every bot dnf beside the dropped player) left the quitter on top with the
// winner's star, and a room podium could list 8/10 above 9/10.
//
// The room server (server/room.js rankPlayers) sorts by the same rule so the
// podium a client draws from its own racers matches the one the server
// broadcasts in `finish`. Pure: returns a new array, never reorders the input,
// and relies on Array.prototype.sort being stable for the within-tier ties.

function tierOf(r) {
  if (r.dropped) return 4;
  if (r.dnf) return 3;
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
    return b.score - a.score;
  });
}

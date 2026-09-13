// Shared race constants used by code that must not pull in an HTTP route or
// Durable Object module just to read a number. server/captcha.js is why this
// file exists: it is bundled into the room DO *and* imported by a `node --test`
// file, so reading the length off worker/routes/leaderboard.js dragged
// worker/db.js, rate-limit.js and log-throttle.js into both graphs. Nothing
// here may import `cloudflare:*` or run a top-level side effect, or the same
// hazard simply moves in here.

/**
 * The one race length a public leaderboard ranks and a captcha challenge gates
 * on. See worker/routes/leaderboard.js for the board eligibility argument and
 * server/captcha.js for the active-verification gating.
 *
 * The constant this must stay equal to is `freshState().raceLength` in
 * server/room.js. That is where every board-eligible row's `problems_total`
 * actually comes from: `buildRaceResultPayload` copies it (server/room-stats.js),
 * `publicFreshState` inherits it unchanged, and `PublicRaceRoom.handleSetConfig`
 * refuses config edits — which is why Quick Match is fixed at ten and why a
 * private room starts there (the lobby's length input is seeded from
 * `currentState.raceLength` off the wire, not from any client constant).
 * `worker/routes/leaderboard.test.js` asserts the two are equal, because a
 * comment saying so is exactly what failed before: if `freshState` moved and
 * this did not, every board would quietly return zero rows with no error and
 * no log.
 *
 * `RACE_LENGTH` in public/src/runner.js is a different ten. It is the solo
 * race, which is excluded on provenance anyway (`room_id IS NULL`), so it can
 * neither break nor fix a board in either direction.
 */
export const CANONICAL_RACE_LENGTH = 10;

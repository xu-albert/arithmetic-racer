// Single source of truth for the reconnect catch-up batch's size cap.
//
// This lives under public/src/ so both halves of the room import the same
// number: the RaceRoom Durable Object rejects a batch over it, and the
// remote runner's outbox stops holding answers at it. A client allowed to
// hold more than the room accepts would lose its whole batch as `oversize`.

// Bound on a single catch-up batch (the answers one seat typed while its
// socket was down), independent of the socket limiter: the batch is one
// message, so one limiter tick, and without its own cap it would be the one
// way to make the room grade unbounded work per tick. 4x raceLength covers
// honest wrong-answer retries at every seat size (hard ceiling 200 entries,
// ~8 KB at MAX_RACE_LENGTH); anything larger is rejected whole, never
// truncated — a truncated batch would silently strand the tail's answers.
export const CATCHUP_MAX_ENTRIES_PER_PROBLEM = 4;

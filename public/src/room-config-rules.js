// Single source of truth for "when may race config (difficulty, length) change".
//
// This lives under public/src/ so both halves of the room import the same rule:
// the lobby UI (which decides whether to enable the controls) and the RaceRoom
// Durable Object (which decides whether to accept `set-config`). They drifted
// apart once already — the UI disabled the controls in every non-'lobby' phase
// and the server rejected them there too, which left a host who had just
// finished a race with no way to change difficulty short of making a new room.

/**
 * Room phases in which the host may change difficulty / race length.
 *
 * - 'lobby'    — before the first race, and after a rematch reset.
 * - 'finished' — between races. The next race hasn't been seeded yet, so a
 *                change here takes effect on the following 'Race Again'.
 *
 * Deliberately excluded:
 * - 'countdown' — `problemSequence` is generated when the race is started, so a
 *                 difficulty change during the countdown would silently do
 *                 nothing. Rejecting is honest.
 * - 'racing'    — changing the problems out from under players mid-race.
 */
export const CONFIGURABLE_STATES = Object.freeze(['lobby', 'finished']);

/** True when `roomState` is a phase where race config may change. */
export function isConfigurableState(roomState) {
  return CONFIGURABLE_STATES.includes(roomState);
}

/**
 * True when this player may change race config right now.
 * Config is host-only, matching how the room already gates `start-race` and
 * `rematch`.
 */
export function canEditConfig({ roomState, isCreator }) {
  return Boolean(isCreator) && isConfigurableState(roomState);
}

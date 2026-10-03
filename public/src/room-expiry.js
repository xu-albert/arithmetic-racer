// The wire contract for a wound-down private room, shared by the Durable
// Object that writes it (server/room.js) and the lobby client that reacts to
// it (public/src/lobby.js). Keeping the literal in one place is the point:
// a client that misses this message sits on a socket into a room that no
// longer exists, which is the failure mode the expired screen replaces.

/** `state.state` of a room whose storage has been replaced by a tombstone. */
export const EXPIRED_ROOM_STATE = 'expired';

/** Message type pushed at winddown, and to anyone who connects afterwards. */
export const ROOM_EXPIRED_TYPE = 'room-expired';

/**
 * `reason` on a ROOM_EXPIRED_TYPE message refusing a socket to a room that is
 * gone, which only a fresh pass may create or revive (RaceRoom.fetch in
 * server/room.js). An expired pass still opens a room that is alive.
 */
export const INVITE_EXPIRED_REASON = 'invite';

/**
 * `reason` on a ROOM_EXPIRED_TYPE message refusing a socket that neither holds
 * a seat in the room nor carries a pass signed for it (server/room.js).
 */
export const INVITE_INVALID_REASON = 'invalid-invite';

/**
 * Which copy and which way out the expired screen shows for `msg` in a room of
 * `mode`. A Quick Match has no invite to have expired and no room of its own to
 * create, so whatever the reason it gets its own copy and the Find Another
 * Match exit; a private room's copy follows the reason, 'idle' when none is
 * given (a tombstone snapshot).
 *
 * @returns {{ copy: string, exit: 'new-room' | 'find-match' }}
 */
export function expiredScreen(msg, mode) {
  if (mode === 'public') return { copy: 'quick-match', exit: 'find-match' };
  const known = [INVITE_EXPIRED_REASON, INVITE_INVALID_REASON].includes(msg?.reason);
  return { copy: known ? msg.reason : 'idle', exit: 'new-room' };
}

/**
 * True for either shape that means "this room is gone": the explicit
 * `room-expired` push, or a state snapshot carrying the tombstone. Both are
 * accepted because the state snapshot is what an older client — or any future
 * caller that reads state before messages — would see.
 */
export function isRoomExpiredMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.type === ROOM_EXPIRED_TYPE) return true;
  return msg.type === 'state' && msg.state?.state === EXPIRED_ROOM_STATE;
}

/**
 * One-shot handler for the winddown message.
 *
 * Order matters: the socket is closed *before* the screen switch. The server
 * closes its side too, and PartySocket reconnects on any server-initiated
 * close — so without closing from here the client would reconnect into the
 * tombstone, be told "expired" again, and loop. Latched because both the
 * pushed message and the state snapshot can arrive.
 *
 * @param {object} opts
 * @param {function} opts.close     - close the room socket
 * @param {function} [opts.onExpired] - show the expired screen; receives the
 *   message, whose `reason` tells an expired invite from an idle room
 * @returns {(msg: object) => boolean} true when the message was the winddown
 */
export function createExpiryLatch({ close, onExpired }) {
  let handled = false;
  return function handle(msg) {
    if (!isRoomExpiredMessage(msg)) return false;
    if (handled) return true;
    handled = true;
    close();
    onExpired?.(msg);
    return true;
  };
}

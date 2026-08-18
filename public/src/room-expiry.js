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
 * @param {function} [opts.onExpired] - show the expired screen
 * @returns {(msg: object) => boolean} true when the message was the winddown
 */
export function createExpiryLatch({ close, onExpired }) {
  let handled = false;
  return function handle(msg) {
    if (!isRoomExpiredMessage(msg)) return false;
    if (handled) return true;
    handled = true;
    close();
    onExpired?.();
    return true;
  };
}

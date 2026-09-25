import PartySocket from 'partysocket';
import { getOrCreateRacerId, getStoredHandle, setStoredHandle, getOrCreateDeviceId } from './identity.js';

// The room reads at most 20 messages per socket per second and drops the rest
// unread (MAX_MESSAGES_PER_WINDOW / WINDOW_MS in server/socket-limit.js, which
// the browser cannot import). A reconnect is the one burst this client makes:
// everything sent while the socket was down goes out at once. So every send is
// paced here, on the same fixed-window rule, at half the room's budget — two of
// our windows can land in one of the room's when latency shifts, and twice
// this still fits.
export const SEND_BUDGET = 10;
export const SEND_WINDOW_MS = 1000;

/**
 * @param {object} opts
 * @param {string} opts.roomId
 * @param {string} [opts.mode]        - 'public' routes to public-race-room party
 * @param {string} [opts.difficulty]  - included in hello for public mode
 * @param {string} [opts.deviceId]    - included in hello for public mode
 */
export function createRoomClient({ roomId, mode, difficulty, deviceId } = {}) {
  const party = mode === 'public' ? 'public-race-room' : 'race-room';

  const ws = new PartySocket({
    host: location.host,
    party,
    room: roomId,
  });
  const listeners = new Set();
  // The server's ephemeral, per-room id for this player, learned from
  // hello-ack. Every `playerId` the server puts on the wire is one of these —
  // the racerId we send in `hello` is a secret and never comes back out.
  let myPlayerId = null;

  // Everything not yet handed to an open socket, oldest first. Held here rather
  // than in PartySocket's own queue, which flushes on open ahead of `hello` and
  // all at once: the room drops a message that arrives before `hello` has
  // seated its socket, and one past the rate limit.
  const outbox = [];
  let windowStart = -Infinity;
  let sentInWindow = 0;
  let flushTimer = null;

  function flush() {
    flushTimer = null;
    while (outbox.length > 0 && ws.readyState === PartySocket.OPEN) {
      const now = Date.now();
      if (now - windowStart >= SEND_WINDOW_MS) {
        windowStart = now;
        sentInWindow = 0;
      }
      if (sentInWindow >= SEND_BUDGET) {
        flushTimer = setTimeout(flush, windowStart + SEND_WINDOW_MS - now);
        return;
      }
      sentInWindow += 1;
      ws.send(outbox.shift());
    }
  }

  ws.addEventListener('open', () => {
    const helloMsg = {
      type: 'hello',
      // The racerId doubles as the reconnect credential: presenting it is what
      // proves this browser owns its seat in the room. Client → server only.
      playerId: getOrCreateRacerId(),
      handle: getStoredHandle(),
      // deviceId is stamped onto every hello so DOs (private + public) can
      // attribute race_results. Fall back to the local helper if the caller
      // didn't pass one through the constructor.
      deviceId: deviceId ?? getOrCreateDeviceId(),
      ...(mode === 'public' && { difficulty }),
    };
    // A new socket is a new budget on the room's side, and `hello` leads it.
    clearTimeout(flushTimer);
    windowStart = -Infinity;
    outbox.unshift(JSON.stringify(helloMsg));
    flush();
  });

  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'hello-ack') {
      if (typeof msg.playerId === 'string') myPlayerId = msg.playerId;
      if (msg.handle) setStoredHandle(msg.handle);
    }
    if (msg.type === 'handle-changed') {
      if (myPlayerId != null && msg.playerId === myPlayerId) setStoredHandle(msg.handle);
    }
    for (const l of listeners) l(msg);
  });

  return {
    on(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    send(msg) {
      outbox.push(JSON.stringify(msg));
      if (flushTimer == null) flush();
    },
    close() {
      clearTimeout(flushTimer);
      flushTimer = null;
      ws.close();
    },
    get readyState() {
      return ws.readyState;
    },
  };
}

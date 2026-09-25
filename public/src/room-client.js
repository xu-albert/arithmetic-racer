import PartySocket from 'partysocket';
import { getOrCreateRacerId, getStoredHandle, setStoredHandle, getOrCreateDeviceId } from './identity.js';

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
    ws.send(JSON.stringify(helloMsg));
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
      ws.send(JSON.stringify(msg));
    },
    close() {
      ws.close();
    },
    get readyState() {
      return ws.readyState;
    },
  };
}

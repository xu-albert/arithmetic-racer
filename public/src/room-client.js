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

  ws.addEventListener('open', () => {
    const helloMsg = {
      type: 'hello',
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
    if (msg.type === 'hello-ack' && msg.handle) setStoredHandle(msg.handle);
    if (msg.type === 'handle-changed') {
      const myId = getOrCreateRacerId();
      if (msg.playerId === myId) setStoredHandle(msg.handle);
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

import PartySocket from 'partysocket';
import { getOrCreateRacerId, getStoredHandle, setStoredHandle, getOrCreateDeviceId } from './identity.js';

export function createRoomClient(roomId) {
  const ws = new PartySocket({
    host: location.host,
    party: 'race-room',
    room: roomId,
  });
  const listeners = new Set();

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({
      type: 'hello',
      playerId: getOrCreateRacerId(),
      handle: getStoredHandle(),
      deviceId: getOrCreateDeviceId(),
    }));
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

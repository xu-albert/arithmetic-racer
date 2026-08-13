// racerId is a secret, not a public handle: the room DO accepts it in `hello`
// as proof that this browser owns its seat (see server/room.js handleHello),
// so it must never be rendered, logged, or sent anywhere but that message.
const KEY_ID = 'racerId';
const KEY_HANDLE = 'racerHandle';
const KEY_DEVICE = 'deviceId';

export function getOrCreateRacerId() {
  let id = localStorage.getItem(KEY_ID);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY_ID, id);
  }
  return id;
}

export function getStoredHandle() {
  return localStorage.getItem(KEY_HANDLE);
}

export function setStoredHandle(handle) {
  if (typeof handle === 'string' && handle.length > 0) {
    localStorage.setItem(KEY_HANDLE, handle);
  }
}

export function getOrCreateDeviceId() {
  let id = localStorage.getItem(KEY_DEVICE);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY_DEVICE, id);
  }
  return id;
}

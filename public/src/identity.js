// racerId is a secret, not a public handle: the room DO accepts it in `hello`
// as proof that this browser owns its seat (see server/room.js handleHello),
// so it must never be rendered, logged, or sent anywhere but that message.
//
// Every localStorage identity the app carries lives here — racerId (room
// credential), racerHandle (room display name), deviceId (anonymous race
// attribution and the signup claim), anonHandle (solo guest display name) —
// so no caller reads or writes those keys directly.
import { generateHandle } from './handles.js';

const KEY_ID = 'racerId';
const KEY_HANDLE = 'racerHandle';
const KEY_DEVICE = 'deviceId';
const KEY_ANON_HANDLE = 'anonHandle';

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

/**
 * The persistent guest display name for solo races — rooms instead use the
 * server-issued racerHandle above. Signed-in players race under their
 * username; this is what a guest's own lane is labelled with.
 */
export function getOrCreateAnonHandle() {
  let h = localStorage.getItem(KEY_ANON_HANDLE);
  if (!h) {
    h = generateHandle(Math.random);
    localStorage.setItem(KEY_ANON_HANDLE, h);
  }
  return h;
}

// racerId is a secret, not a public handle: the room DO accepts it in `hello`
// as proof that this browser owns its seat (see server/room.js handleHello),
// so it must never be rendered, logged, or sent anywhere but that message.
//
// Every localStorage identity the app carries lives here — racerId (room
// credential), racerHandle (room-issued guest handle), deviceId (anonymous
// race attribution and the signup claim), anonHandle (fallback guest handle
// before a room issues one; getGuestHandle() unifies the two for solo and
// rooms) — so no caller reads or writes those keys directly.
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
 * Read-only: the deviceId this browser already has, or null. For pages that
 * attach it to what they send (bug reports, contact messages) but must never
 * mint one. Takes the storage so a caller holding a window can pass its own.
 */
export function getDeviceId(storage) {
  return storage.getItem(KEY_DEVICE);
}

/**
 * The persistent guest display name, minted for whichever mode a guest plays
 * first. Signed-in players race under their username instead, in solo and in
 * rooms alike. Prefer getGuestHandle(), which follows a room's renames.
 */
export function getOrCreateAnonHandle() {
  let h = localStorage.getItem(KEY_ANON_HANDLE);
  if (!h) {
    h = generateHandle(Math.random);
    localStorage.setItem(KEY_ANON_HANDLE, h);
  }
  return h;
}

/**
 * The one name a guest races under, solo and in rooms: the room handle when a
 * room has issued one (it may have renamed this guest, or been renamed by
 * them), else the persistent anonHandle. A room's hello offers it as the
 * handle to seat, so a guest who starts solo keeps that name in a room.
 */
export function getGuestHandle() {
  return getStoredHandle() ?? getOrCreateAnonHandle();
}

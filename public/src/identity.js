const KEY_ID = 'racerId';
const KEY_HANDLE = 'racerHandle';

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

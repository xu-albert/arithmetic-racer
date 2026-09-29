// identity.js is the single home of every localStorage identity the app
// carries (CLI-08): the racerId reconnect secret, the room handle, the
// deviceId behind anonymous attribution and the signup claim, and the solo
// guest handle. These tests pin the key names (other modules, the room DO's
// `hello` contract, and stored user data all depend on them) and the
// get-or-create semantics.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const {
  getOrCreateRacerId,
  getStoredHandle,
  setStoredHandle,
  getOrCreateDeviceId,
  getOrCreateAnonHandle,
} = await import("./identity.js");

beforeEach(() => store.clear());

test("deviceId: created once under the 'deviceId' key, then stable", () => {
  const a = getOrCreateDeviceId();
  assert.match(a, /^[0-9a-f-]{36}$/);
  assert.equal(store.get("deviceId"), a);
  assert.equal(getOrCreateDeviceId(), a);
});

test("racerId: created once under the 'racerId' key, then stable", () => {
  const a = getOrCreateRacerId();
  assert.match(a, /^[0-9a-f-]{36}$/);
  assert.equal(getOrCreateRacerId(), a);
});

test("handle: unset until stored, empty strings ignored", () => {
  assert.equal(getStoredHandle(), null);
  setStoredHandle("");
  assert.equal(getStoredHandle(), null);
  setStoredHandle("SwiftFox");
  assert.equal(getStoredHandle(), "SwiftFox");
});

test("anon handle: created once under the 'anonHandle' key, then stable", () => {
  const a = getOrCreateAnonHandle();
  assert.equal(typeof a, "string");
  assert.ok(a.length > 0);
  assert.equal(store.get("anonHandle"), a);
  assert.equal(getOrCreateAnonHandle(), a);
});

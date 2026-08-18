// The client half of the private-room winddown.
//
// The server replaces a wound-down room's state with a tombstone and closes
// every socket. What the client owes the player at that moment is a screen
// that says so and two ways out — not a spinner, and not a socket that keeps
// reconnecting into a room that no longer exists.
//
// This is the shared half of that contract: the predicate that recognizes a
// wound-down room and the latch that closes the socket before handing over to
// the screen. The DOM wiring around it is exercised by the manual smoke rows
// in docs/testing.md — public/ has no build step and no DOM harness.

import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPIRED_ROOM_STATE,
  ROOM_EXPIRED_TYPE,
  isRoomExpiredMessage,
  createExpiryLatch,
} from "./room-expiry.js";

// ---------- isRoomExpiredMessage ----------

test("recognizes the pushed winddown message", () => {
  assert.equal(isRoomExpiredMessage({ type: ROOM_EXPIRED_TYPE, reason: "idle" }), true);
});

test("recognizes a state snapshot carrying the tombstone", () => {
  assert.equal(
    isRoomExpiredMessage({ type: "state", state: { state: EXPIRED_ROOM_STATE } }),
    true,
  );
});

test("leaves every ordinary room message alone", () => {
  const ordinary = [
    { type: "state", state: { state: "lobby", players: [] } },
    { type: "state", state: { state: "racing" } },
    { type: "hello-ack", playerId: "p-1" },
    { type: "error", code: "BAD_STATE" },
    { type: "finish", rankings: [] },
  ];
  for (const msg of ordinary) {
    assert.equal(isRoomExpiredMessage(msg), false, `${msg.type} misread as expired`);
  }
});

test("tolerates junk without throwing", () => {
  for (const junk of [null, undefined, 0, "room-expired", [], { type: "state" }]) {
    assert.equal(isRoomExpiredMessage(junk), false);
  }
});

// ---------- createExpiryLatch ----------

function spyLatch() {
  const calls = [];
  const handle = createExpiryLatch({
    close: () => calls.push("close"),
    onExpired: () => calls.push("expired"),
  });
  return { handle, calls };
}

test("closes the socket before showing the screen", () => {
  // Both happen, in this order: the server closes its side too, and
  // PartySocket reconnects on a server-initiated close. Closing first is what
  // stops the client bouncing back into the tombstone.
  const { handle, calls } = spyLatch();
  assert.equal(handle({ type: ROOM_EXPIRED_TYPE }), true);
  assert.deepEqual(calls, ["close", "expired"]);
});

test("fires once even though both shapes can arrive", () => {
  const { handle, calls } = spyLatch();
  handle({ type: ROOM_EXPIRED_TYPE });
  handle({ type: "state", state: { state: EXPIRED_ROOM_STATE } });
  handle({ type: ROOM_EXPIRED_TYPE });
  assert.deepEqual(calls, ["close", "expired"]);
});

test("reports the message as consumed on repeats so the caller stops rendering it", () => {
  const { handle } = spyLatch();
  handle({ type: ROOM_EXPIRED_TYPE });
  assert.equal(handle({ type: "state", state: { state: EXPIRED_ROOM_STATE } }), true);
});

test("passes ordinary messages through untouched", () => {
  const { handle, calls } = spyLatch();
  assert.equal(handle({ type: "state", state: { state: "lobby" } }), false);
  assert.deepEqual(calls, []);
});

test("works without an onExpired callback", () => {
  const calls = [];
  const handle = createExpiryLatch({ close: () => calls.push("close") });
  assert.equal(handle({ type: ROOM_EXPIRED_TYPE }), true);
  assert.deepEqual(calls, ["close"]);
});

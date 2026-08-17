// The client half of the private-room winddown.
//
// The server replaces a wound-down room's state with a tombstone and closes
// every socket. What the client owes the player at that moment is a screen
// that says so and two ways out — not a spinner, and not a socket that keeps
// reconnecting into a room that no longer exists.
//
// The latch is unit-tested directly; the screen and its two actions are
// checked against the shipped files, since public/ has no build step and no
// DOM test harness (see AGENTS.md).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPIRED_ROOM_STATE,
  ROOM_EXPIRED_TYPE,
  isRoomExpiredMessage,
  createExpiryLatch,
} from "./room-expiry.js";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..");
const read = (rel) => readFileSync(join(publicDir, rel), "utf8");

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

// ---------- the screen the latch leads to ----------

test("index.html ships the expired screen with both ways out", () => {
  const html = read("index.html");
  assert.match(html, /id="room-expired"[^>]*class="screen hidden"/);
  assert.match(html, /id="expired-home-btn"/);
  assert.match(html, /id="expired-new-room-btn"/);
});

test("main.js registers the expired screen and wires both actions", () => {
  const main = read("main.js");
  // Registered in `screens`, or showScreen would never hide it again.
  assert.match(main, /'room-expired':\s*document\.getElementById\('room-expired'\)/);
  assert.match(main, /onRoomExpired:\s*handleRoomExpired/);
  assert.match(main, /showScreen\('room-expired'\)/);
  // Home leaves via a real navigation: the URL still carries ?room=<dead id>,
  // so an in-page screen swap would come straight back on reload.
  assert.match(main, /expiredHomeBtn[\s\S]{0,200}location\.assign\('\/'\)/);
  assert.match(main, /expiredNewRoomBtn[\s\S]{0,400}createRoom\(\)/);
});

test("the lobby tears the room down before handing over to the screen", () => {
  const lobby = read("src/lobby.js");
  assert.match(lobby, /createExpiryLatch\(\{[\s\S]{0,200}client\.close\(\)/);
  const main = read("main.js");
  assert.match(main, /function handleRoomExpired\(\)[\s\S]{0,400}lobbyHandle\.detach\(\)/);
  assert.match(main, /function handleRoomExpired\(\)[\s\S]{0,400}cleanupRace\(\)/);
});

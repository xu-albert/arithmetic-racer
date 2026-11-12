// A signed-in racer races under their username, in private rooms and Quick
// Match alike. The leaderboard and the recent-finishes feed name a room race by
// "user".username, so a random room handle made the car, the podium and the
// board row three different names for one race, with no way to tie them
// together. Guests keep the handle they asked for, or a random one.
//
// The username comes from connection state that onConnect stamped from the
// Worker's header (server.test.js covers the header gate), never from `hello`.

import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { accountHandle, publicPlayer } from "./room.js";

function makeConn(identity = {}) {
  return {
    id: "sock-" + crypto.randomUUID(),
    sent: [],
    // What onConnect leaves for a socket the Worker let through with a pass.
    state: { hasAdmissionPass: true, userId: null, username: null, ...identity },
    send(s) { this.sent.push(JSON.parse(s)); },
    setState(s) { this.state = s; },
  };
}

const SIGNED_IN = { userId: "u-racer", username: "RealRacer" };

/**
 * Run `fn` inside a fresh room, with each state broadcast recorded as the
 * public snapshot a client would have been sent at that moment.
 */
async function withRoom(binding, name, fn) {
  const stub = binding.get(binding.idFromName(name));
  return runInDurableObject(stub, async (room) => {
    if (!room.state) await room.onStart();
    const snapshots = [];
    room.broadcast = () => {};
    room.broadcastState = () => snapshots.push(structuredClone(room.publicState()));
    room.getConnections = () => [][Symbol.iterator]();
    room.releaseLobby = async () => {};
    return fn(room, snapshots);
  });
}

const privateRoom = (fn) => withRoom(env.RaceRoom, `acct-${crypto.randomUUID()}`, fn);
const quickMatch = (fn) => withRoom(env.PublicRaceRoom, `m-acct-${crypto.randomUUID()}`, fn);

function hello(room, conn, { racerId = crypto.randomUUID(), handle = "GuestName" } = {}) {
  return room.handleHello(conn, { type: "hello", playerId: racerId, handle, deviceId: "dev-1", difficulty: "medium" })
    .then(() => racerId);
}

const seatOf = (room, racerId) => room.state.players.find((p) => p.racerId === racerId);
const ackOf = (conn) => conn.sent.find((m) => m.type === "hello-ack");

describe("accountHandle", () => {
  it("is the username for a signed-in socket, null for a guest or an account without one", () => {
    expect(accountHandle(SIGNED_IN, new Set())).toBe("RealRacer");
    expect(accountHandle({ userId: null, username: "RealRacer" }, new Set())).toBeNull();
    expect(accountHandle({ userId: "u-1", username: null }, new Set())).toBeNull();
  });

  it("steps aside when another seat already holds the name", () => {
    expect(accountHandle(SIGNED_IN, new Set(["RealRacer"]))).toBeNull();
  });
});

describe("a private room seats a signed-in racer under their username", () => {
  it("ignores the guest handle the client offered, and says so in hello-ack", async () => {
    await privateRoom(async (room) => {
      const conn = makeConn(SIGNED_IN);
      const racerId = await hello(room, conn, { handle: "LuckyStoat" });

      expect(seatOf(room, racerId).handle).toBe("RealRacer");
      expect(ackOf(conn)).toMatchObject({ handle: "RealRacer", handleFromAccount: true });
      expect(publicPlayer(seatOf(room, racerId))).toMatchObject({ handle: "RealRacer", handleFromAccount: true, isGuest: false });
    });
  });

  it("a guest keeps the handle they offered", async () => {
    await privateRoom(async (room) => {
      const conn = makeConn();
      const racerId = await hello(room, conn, { handle: "ZestyHare" });
      expect(seatOf(room, racerId).handle).toBe("ZestyHare");
      expect(ackOf(conn)).toMatchObject({ handle: "ZestyHare", handleFromAccount: false });
    });
  });

  it("falls back to the guest rules when a guest in the room already took the name", async () => {
    await privateRoom(async (room) => {
      await hello(room, makeConn(), { handle: "RealRacer" });
      const racerId = await hello(room, makeConn(SIGNED_IN), { handle: "LuckyStoat" });
      expect(seatOf(room, racerId).handle).toBe("LuckyStoat");
      expect(seatOf(room, racerId).handleFromAccount).toBe(false);
    });
  });

  it("refuses to rename an account-named seat", async () => {
    await privateRoom(async (room) => {
      const conn = makeConn(SIGNED_IN);
      const racerId = await hello(room, conn);
      await room.handleSetHandle(conn, { type: "set-handle", handle: "Someone" });

      expect(seatOf(room, racerId).handle).toBe("RealRacer");
      expect(conn.sent.filter((m) => m.type === "error").map((m) => m.message))
        .toEqual(["Signed-in racers race under their username"]);
    });
  });

  it("signing in while seated takes the username on the reconnect; signing out gives it back", async () => {
    // main.js reconnects the room socket on auth-changed, and onConnect stamps
    // the new session onto the new socket before its hello.
    await privateRoom(async (room) => {
      const racerId = await hello(room, makeConn(), { handle: "ZestyHare" });
      expect(seatOf(room, racerId).handle).toBe("ZestyHare");

      const signedIn = makeConn(SIGNED_IN);
      await hello(room, signedIn, { racerId, handle: "ZestyHare" });
      expect(seatOf(room, racerId)).toMatchObject({ handle: "RealRacer", handleFromAccount: true, userId: "u-racer" });
      expect(ackOf(signedIn)).toMatchObject({ handle: "RealRacer", handleFromAccount: true });

      const signedOut = makeConn();
      await hello(room, signedOut, { racerId, handle: "ZestyHare" });
      expect(seatOf(room, racerId)).toMatchObject({ handle: "ZestyHare", handleFromAccount: false, userId: null });
    });
  });

  it("a signed-out reconnect with no guest handle to offer gets a fresh one, not the username", async () => {
    await privateRoom(async (room) => {
      const racerId = await hello(room, makeConn(SIGNED_IN));
      await room.handleHello(makeConn(), { type: "hello", playerId: racerId, handle: null, deviceId: "dev-1" });
      const seat = seatOf(room, racerId);
      expect(seat.handle).not.toBe("RealRacer");
      expect(seat.handleFromAccount).toBe(false);
    });
  });

  it("a signed-out reconnect whose stored guest handle was taken in the meantime gets a fresh one", async () => {
    await privateRoom(async (room) => {
      const racerId = await hello(room, makeConn(SIGNED_IN), { handle: "ZestyHare" });
      await hello(room, makeConn(), { handle: "ZestyHare" });

      const signedOut = makeConn();
      await hello(room, signedOut, { racerId, handle: "ZestyHare" });
      const seat = seatOf(room, racerId);
      expect(seat.handle).not.toBe("ZestyHare");
      expect(seat.handle).not.toBe("RealRacer");
      expect(seat.handleFromAccount).toBe(false);
      expect(ackOf(signedOut)).toMatchObject({ handle: seat.handle, handleFromAccount: false });
    });
  });
});

describe("Quick Match", () => {
  it("seats a signed-in racer under their username too", async () => {
    await quickMatch(async (room) => {
      const racerId = await hello(room, makeConn(SIGNED_IN), { handle: "LuckyStoat" });
      expect(seatOf(room, racerId).handle).toBe("RealRacer");
    });
  });

  it("never shows the first joiner a host badge, not even in the snapshot sent on joining", async () => {
    // The base handler used to mark the first joiner host and broadcast that,
    // and PublicRaceRoom cleared the flag only afterwards without
    // re-broadcasting: a lone player saw "(host)" and live config controls.
    await quickMatch(async (room, snapshots) => {
      const racerId = await hello(room, makeConn());
      expect(seatOf(room, racerId).isCreator).toBe(false);
      expect(snapshots.length).toBeGreaterThan(0);
      for (const snap of snapshots) {
        expect(snap.players.some((p) => p.isCreator)).toBe(false);
      }
    });
  });
});

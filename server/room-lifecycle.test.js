// Room lifecycle honesty: creator succession for departed hosts, and the
// abandoned-countdown cancel.
//
// Succession rule (owner): when the host leaves, the earliest-joined player
// still in the room becomes host. "Leaves" is a seat that is spliced (lobby /
// finished departure) or marked departed (mid-race, where the seat is kept for
// its result row) — not a socket inside its 30s reconnect grace, which keeps
// everything about the seat, badge included. A mid-race departure succeeds at
// removePlayer, and at the latest by finishRace: a finished room whose only
// creator is gone can never rematch (NOT_CREATOR), the dead-end the ten-seat
// re-review found on main. Succession is final: a reconnecting ex-host returns
// as an ordinary player.
//
// Harness mirrors server/room-race-deadline.test.js: fake connections, handlers
// called directly, real D1 via cloudflare:test.

import { describe, it, expect, beforeEach } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";

function makeConn(label) {
  return {
    label,
    id: "sock-" + crypto.randomUUID(),
    sent: [],
    state: undefined,
    send(s) { this.sent.push(JSON.parse(s)); },
    setState(s) { this.state = s; },
    lastOf(type) { return [...this.sent].reverse().find((m) => m.type === type) ?? null; },
    errors() { return this.sent.filter((m) => m.type === "error"); },
  };
}

/** getConnections() is an iterator under `hibernate: true`, never an array. */
function connectionIterator(conns) {
  let i = 0;
  const it = {
    [Symbol.iterator]() { return it; },
    next() {
      return i < conns.length ? { done: false, value: conns[i++] } : { done: true, value: undefined };
    },
  };
  return it;
}

async function withRoom(conns, fn) {
  const stub = env.RaceRoom.get(env.RaceRoom.idFromName("lc-" + crypto.randomUUID()));
  return runInDurableObject(stub, async (room) => {
    if (!room.state) await room.onStart();
    room.getConnections = () => connectionIterator(conns);
    room.broadcast = (s) => { for (const c of conns) c.send(s); };
    return fn(room);
  });
}

async function join(room, conn, handle) {
  const racerId = crypto.randomUUID();
  await room.handleHello(conn, {
    type: "hello", playerId: racerId, handle, deviceId: "dev-" + handle,
  });
  return racerId;
}

async function runCountdown(room) {
  for (let i = 0; i < 8 && room.state.state === "countdown"; i++) {
    room.state.countdownAt = Date.now() - 1;
    await room.onAlarm();
  }
}

async function answerCorrectly(room, conn) {
  const player = room.playerFor(conn);
  const problem = room.state.problemSequence[player.score];
  await room.handleAnswer(conn, { type: "answer", value: String(problem.answer) });
}

/** Finish `conns` at a human pace so no captcha challenge holds their rows. */
async function raceToFinish(room, conns, elapsedMs = 8000) {
  room.state.raceStartedAt = Date.now() - elapsedMs;
  for (let i = 0; i < room.state.raceLength; i++) {
    for (const conn of conns) await answerCorrectly(room, conn);
  }
}

/** Close a seat's socket and let its 30s reconnection grace run out. */
async function expireReconnectGrace(room, conn) {
  const playerId = room.playerFor(conn).id;
  await room.onClose(conn);
  expect(room.state.disconnectDeadlines[playerId]).toBeGreaterThan(Date.now());
  room.state.disconnectDeadlines[playerId] = Date.now() - 1;
  await room.onAlarm();
  expect(room.state.disconnectDeadlines[playerId]).toBeUndefined();
}

function creators(room) {
  return room.state.players.filter((p) => p.isCreator);
}

function seatOf(room, racerId) {
  return room.state.players.find((p) => p.racerId === racerId) ?? null;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM race_results");
});

describe("creator succession — the next-longest-present player inherits the host flag", () => {
  it("a host who quits the lobby is succeeded by the earliest-joined guest", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    const other = makeConn("other");
    await withRoom([host, guest, other], async (room) => {
      await join(room, host, "Host");
      await join(room, guest, "Guest");
      await join(room, other, "Other");
      expect(seatOf(room, room.playerFor(host).racerId).isCreator).toBe(true);

      await room.handleQuit(host);

      expect(room.state.players).toHaveLength(2);
      expect(creators(room).map((p) => p.handle)).toEqual(["Guest"]);
      // The wire carries the handover: the guest's client can now offer Start.
      const state = guest.lastOf("state");
      expect(state.state.players.find((p) => p.handle === "Guest").isCreator).toBe(true);

      // And the powers work: the new host can start the race.
      await room.handleStartRace(guest);
      expect(room.state.state).toBe("countdown");
      expect(guest.errors()).toEqual([]);
    });
  });

  it("a host whose socket dies keeps the flag through grace, then loses it at expiry", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      const hostRacer = await join(room, host, "Host");
      await join(room, guest, "Guest");

      await room.onClose(host);
      // Inside the grace the seat is intact — a reconnect must hand the room
      // back exactly as it was.
      expect(seatOf(room, hostRacer).isCreator).toBe(true);

      room.state.disconnectDeadlines[seatOf(room, hostRacer).id] = Date.now() - 1;
      await room.onAlarm();

      expect(creators(room).map((p) => p.handle)).toEqual(["Guest"]);
    });
  });

  it("chains onward when the successor has also left", async () => {
    const host = makeConn("host");
    const second = makeConn("second");
    const third = makeConn("third");
    const fourth = makeConn("fourth");
    await withRoom([host, second, third, fourth], async (room) => {
      await join(room, host, "Host");
      const secondRacer = await join(room, second, "Second");
      await join(room, third, "Third");
      await join(room, fourth, "Fourth");

      // Second's socket dies but its grace is still open when the host quits:
      // the seat is still in the room, so it inherits first...
      await room.onClose(second);
      await room.handleQuit(host);
      expect(creators(room).map((p) => p.handle)).toEqual(["Second"]);

      // ...and when Second never comes back, the flag moves again rather than
      // dying with the departed seat.
      room.state.disconnectDeadlines[seatOf(room, secondRacer).id] = Date.now() - 1;
      await room.onAlarm();
      expect(creators(room).map((p) => p.handle)).toEqual(["Third"]);

      await room.handleStartRace(third);
      expect(room.state.state).toBe("countdown");
    });
  });

  it("a mid-race departure succeeds by finishRace, so the finished room can rematch (E1)", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      const hostRacer = await join(room, host, "Host");
      await join(room, guest, "Guest");
      await room.handleStartRace(host);
      await runCountdown(room);
      expect(room.state.state).toBe("racing");

      // The host's socket dies mid-race and the grace runs out. The seat stays
      // for its result row — but not the flag.
      await expireReconnectGrace(room, host);
      expect(seatOf(room, hostRacer).departed).toBe(true);
      expect(creators(room).map((p) => p.handle)).toEqual(["Guest"]);

      await raceToFinish(room, [guest]);
      expect(room.state.state).toBe("finished");
      expect(creators(room).map((p) => p.handle)).toEqual(["Guest"]);

      // The E1 dead-end: this rematch was NOT_CREATOR on main.
      await room.handleRematch(guest);
      expect(guest.errors()).toEqual([]);
      expect(room.state.state).toBe("lobby");
    });
  });

  it("a host still in grace when the race ends keeps the flag until the grace decides", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      const hostRacer = await join(room, host, "Host");
      await join(room, guest, "Guest");
      await room.handleStartRace(host);
      await runCountdown(room);

      // The host finishes, then their socket drops. The race ends on the
      // guest's finish while the host's grace is still open: the seat is not
      // departed, so there is nothing to succeed yet.
      room.state.raceStartedAt = Date.now() - 8000;
      await raceToFinish(room, [host]);
      await room.onClose(host);
      await raceToFinish(room, [guest]);
      expect(room.state.state).toBe("finished");
      expect(seatOf(room, hostRacer).isCreator).toBe(true);

      // The grace expiring is the departure; succession happens there.
      room.state.disconnectDeadlines[seatOf(room, hostRacer).id] = Date.now() - 1;
      await room.onAlarm();
      expect(creators(room).map((p) => p.handle)).toEqual(["Guest"]);
      await room.handleRematch(guest);
      expect(room.state.state).toBe("lobby");
    });
  });

  it("is final: a reconnecting ex-host comes back as an ordinary player", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      const hostRacer = await join(room, host, "Host");
      await join(room, guest, "Guest");
      await room.handleQuit(host);
      expect(creators(room).map((p) => p.handle)).toEqual(["Guest"]);

      // The old host's racerId no longer resolves to a seat — it quit — so it
      // rejoins as a brand new player at the back of the succession order.
      const hostBack = makeConn("host-back");
      await room.handleHello(hostBack, { type: "hello", playerId: hostRacer, handle: "Host", deviceId: "dev-Host" });
      expect(creators(room).map((p) => p.handle)).toEqual(["Guest"]);
      expect(seatOf(room, hostRacer).isCreator).toBe(false);
    });
  });

  it("keeps the flag on the departed seat when nobody is present to receive it", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    const conns = [host, guest];
    await withRoom(conns, async (room) => {
      const hostRacer = await join(room, host, "Host");
      const guestRacer = await join(room, guest, "Guest");
      await room.handleStartRace(host);
      await runCountdown(room);

      // Both sockets die. The guest's grace expires first — the host's seat is
      // still present (in grace), so nothing moves. Then the host's expires
      // with nobody left to succeed: the flag stays on the departed seat,
      // because the only way back into this room is one of these seats
      // reconnecting, and the room must not lose its only host to the vacuum.
      await expireReconnectGrace(room, guest);
      await expireReconnectGrace(room, host);
      expect(room.state.state).toBe("finished");
      expect(seatOf(room, hostRacer).isCreator).toBe(true);

      // Whoever comes back first inherits: the host seat is departed, so the
      // returning guest is the next-longest-present player.
      const guestBack = makeConn("guest-back");
      conns.push(guestBack);
      await room.handleHello(guestBack, { type: "hello", playerId: guestRacer, handle: "Guest", deviceId: "dev-Guest" });
      expect(creators(room).map((p) => p.handle)).toEqual(["Guest"]);

      // And succession is final — the host's own reconnect changes nothing.
      const hostBack = makeConn("host-back");
      conns.push(hostBack);
      await room.handleHello(hostBack, { type: "hello", playerId: hostRacer, handle: "Host", deviceId: "dev-Host" });
      expect(creators(room).map((p) => p.handle)).toEqual(["Guest"]);

      await room.handleRematch(guestBack);
      expect(guestBack.errors()).toEqual([]);
      expect(room.state.state).toBe("lobby");
    });
  });

  it("a fresh join into a finished room whose host is gone inherits the flag", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    const conns = [host, guest];
    await withRoom(conns, async (room) => {
      await join(room, host, "Host");
      await join(room, guest, "Guest");
      await room.handleStartRace(host);
      await runCountdown(room);
      await expireReconnectGrace(room, host);
      await expireReconnectGrace(room, guest);
      await room.onAlarm();
      expect(room.state.state).toBe("finished");
      expect(room.state.players.every((p) => p.departed)).toBe(true);

      // A newcomer (invite link still open) is the first live seat since the
      // race ended — without the handover this room could never race again.
      const fresh = makeConn("fresh");
      conns.push(fresh);
      await join(room, fresh, "Fresh");
      expect(creators(room).map((p) => p.handle)).toEqual(["Fresh"]);

      await room.handleRematch(fresh);
      expect(fresh.errors()).toEqual([]);
      expect(room.state.state).toBe("lobby");
    });
  });
});

describe("an abandoned countdown cancels instead of ghost-racing", () => {
  it("empties back to the lobby and never reaches racing", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await join(room, host, "Host");
      await join(room, guest, "Guest");
      await room.handleStartRace(host);
      expect(room.state.state).toBe("countdown");

      // One leaver is not an abandonment: the countdown keeps going.
      await room.handleQuit(guest);
      expect(room.state.state).toBe("countdown");

      // The last one out cancels it.
      await room.handleQuit(host);
      expect(room.state.state).toBe("lobby");
      expect(room.state.countdownAt).toBeNull();
      expect(room.state.countdownN).toBeNull();
      expect(room.state.idleCleanupAt).toBeGreaterThan(Date.now());

      // No amount of alarm ticks turns it into a race.
      for (let i = 0; i < 6; i++) {
        room.state.countdownAt = null;
        await room.onAlarm();
      }
      expect(room.state.state).toBe("lobby");
      expect(host.sent.filter((m) => m.type === "race-start")).toEqual([]);
    });
  });

  it("leaves the room immediately reusable by the next arrivals", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    const conns = [host, guest];
    await withRoom(conns, async (room) => {
      await join(room, host, "Host");
      await join(room, guest, "Guest");
      await room.handleStartRace(host);
      await room.handleQuit(host);
      await room.handleQuit(guest);
      expect(room.state.state).toBe("lobby");

      const a = makeConn("a");
      const b = makeConn("b");
      conns.push(a, b);
      await join(room, a, "A");
      await join(room, b, "B");
      expect(seatOf(room, room.playerFor(a).racerId).isCreator).toBe(true);

      await room.handleStartRace(a);
      await runCountdown(room);
      expect(room.state.state).toBe("racing");
      expect(a.lastOf("race-start")).toBeTruthy();
    });
  });
});

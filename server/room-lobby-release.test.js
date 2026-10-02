// Quickmatch lane repair: a lobby must never wedge on one hiccup.
//
// Three behaviors, all against the real room DO (and, where noted, the real
// LobbyRouter DO):
//   1. releaseLobby() retries a failed router RPC from the room's alarm,
//      bounded — it neither drops the release after one failure nor retries
//      an unreachable router forever.
//   2. A new join routed into a dead-end room (full, started, or finished) is
//      refused, and the refusal re-attempts the router release so the next
//      pick mints a fresh room. Reconnects still seat — a finisher reloading
//      the page keeps the scoreboard — and re-attempt the release too,
//      without holding their hello-ack on the router.
//   3. publicState() never carries the pending-release bookkeeping.
//
// Harness mirrors server/room-result-outbox.test.js: fake connections,
// handlers called directly, real bindings via cloudflare:test. The router
// outage is a Proxy on room.env whose LobbyRouter binding throws on release.

import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";

import { LOBBY_RELEASE_RETRY_MS, LOBBY_RELEASE_MAX_ATTEMPTS } from "./public-room.js";

function makeConn(label) {
  return {
    label,
    id: "sock-" + crypto.randomUUID(),
    sent: [],
    state: undefined,
    send(s) { this.sent.push(JSON.parse(s)); },
    setState(s) { this.state = s; },
    lastOf(type) { return [...this.sent].reverse().find((m) => m.type === type) ?? null; },
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

/**
 * A public room with the WS plumbing stubbed but the REAL releaseLobby —
 * that method is the subject under test. Test rooms carry the m- prefix so
 * the difficulty derivation from the room name works.
 */
async function withRoom(name, fn, conns = []) {
  const prefixed = name.startsWith("m-") ? name : `m-${name}`;
  const stub = env.PublicRaceRoom.get(env.PublicRaceRoom.idFromName(prefixed));
  return runInDurableObject(stub, async (room) => {
    if (!room.state) await room.onStart();
    room.getConnections = () => connectionIterator(conns);
    room.broadcast = () => {};
    room.broadcastState = () => {};
    return fn(room);
  });
}

async function join(room, conn, handle) {
  const playerId = crypto.randomUUID();
  await room.handleHello(conn, {
    type: "hello", playerId, handle, deviceId: "dev-" + handle, difficulty: "medium",
  });
  return playerId;
}

/**
 * Make this room's LobbyRouter binding fail every release, returning the
 * attempted room names and a restore function. Storage (persist, alarms) and
 * the real router keep working — exactly the split the retry relies on.
 */
function breakLobbyRouter(room) {
  const realEnv = room.env;
  const calls = [];
  const failing = {
    idFromName: (n) => realEnv.LobbyRouter.idFromName(n),
    get: () => ({
      release: async (name) => {
        calls.push(name);
        throw new Error("router unavailable (test)");
      },
    }),
  };
  room.env = new Proxy(realEnv, { get: (target, key) => (key === "LobbyRouter" ? failing : target[key]) });
  return { calls, restore: () => { room.env = realEnv; } };
}

/** Count release calls while letting them through to the real router. */
function spyLobbyRouter(room) {
  const realEnv = room.env;
  const real = realEnv.LobbyRouter;
  const calls = [];
  const spy = {
    idFromName: (n) => real.idFromName(n),
    get: (id) => {
      const stub = real.get(id);
      return {
        release: async (name) => {
          calls.push(name);
          return stub.release(name);
        },
      };
    },
  };
  room.env = new Proxy(realEnv, { get: (target, key) => (key === "LobbyRouter" ? spy : target[key]) });
  return { calls, restore: () => { room.env = realEnv; } };
}

/**
 * Hold every release open until `open()` — proves a caller does not wait on
 * the router. Calls are recorded as they are issued.
 */
function holdLobbyRouter(room) {
  const realEnv = room.env;
  const calls = [];
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const held = {
    idFromName: (n) => realEnv.LobbyRouter.idFromName(n),
    get: () => ({
      release: async (name) => {
        calls.push(name);
        await gate;
      },
    }),
  };
  room.env = new Proxy(realEnv, { get: (target, key) => (key === "LobbyRouter" ? held : target[key]) });
  return { calls, open: () => open(), restore: () => { room.env = realEnv; } };
}

describe("PublicRaceRoom.releaseLobby — bounded retry", () => {
  it("a failed release is parked in state, coalesced into the alarm, and stripped from the snapshot", async () => {
    await withRoom("lr-park-" + crypto.randomUUID(), async (room) => {
      const router = breakLobbyRouter(room);
      const before = Date.now();
      await room.releaseLobby();

      expect(router.calls).toEqual([room.name]);
      const pending = room.state.pendingLobbyRelease;
      expect(pending.attempts).toBe(1);
      expect(pending.nextAttemptAt).toBeGreaterThanOrEqual(before + LOBBY_RELEASE_RETRY_MS);
      // The retry must wake the room — a deadline nothing schedules never fires.
      expect(room.extraAlarmDeadlines()).toContain(pending.nextAttemptAt);
      // ...and the bookkeeping is server-only.
      expect(room.publicState().pendingLobbyRelease).toBeUndefined();
      router.restore();
    });
  });

  it("the alarm retries a due release; a healed router clears the pending state", async () => {
    await withRoom("lr-heal-" + crypto.randomUUID(), async (room) => {
      const router = breakLobbyRouter(room);
      await room.releaseLobby();
      expect(room.state.pendingLobbyRelease.attempts).toBe(1);
      router.restore();

      room.state.pendingLobbyRelease.nextAttemptAt = Date.now() - 1;
      await room.onAlarm();

      expect(room.state.pendingLobbyRelease).toBeNull();
      // The retry really reached the router: it answers a release for this
      // room's name without error (idempotent whether or not it points here).
    });
  });

  it("a retry that fails again re-arms with the attempts count carried forward", async () => {
    await withRoom("lr-rearm-" + crypto.randomUUID(), async (room) => {
      const router = breakLobbyRouter(room);
      await room.releaseLobby();
      room.state.pendingLobbyRelease.nextAttemptAt = Date.now() - 1;
      await room.onAlarm();

      expect(router.calls.length).toBe(2);
      expect(room.state.pendingLobbyRelease.attempts).toBe(2);
      expect(room.state.pendingLobbyRelease.nextAttemptAt).toBeGreaterThan(Date.now());
      router.restore();
    });
  });

  it("a lobby that refilled before the retry drops the release without calling the router", async () => {
    await withRoom("lr-refill-" + crypto.randomUUID(), async (room) => {
      const router = breakLobbyRouter(room);
      await room.releaseLobby();
      expect(router.calls.length).toBe(1);

      await join(room, makeConn("B"), "B");
      room.state.autoStartDeadline = null;
      room.state.pendingLobbyRelease.nextAttemptAt = Date.now() - 1;
      await room.onAlarm();

      expect(router.calls.length).toBe(1);
      expect(room.state.pendingLobbyRelease).toBeNull();
      expect(room.state.players.length).toBe(1);
      router.restore();
    });
  });

  for (const shape of ["empty", "full", "finished"]) {
    it(`a room still ${shape} at the retry fires the release`, async () => {
      await withRoom(`lr-owed-${shape}-` + crypto.randomUUID(), async (room) => {
        const router = breakLobbyRouter(room);
        if (shape === "full") {
          for (let i = 0; i < 6; i++) await join(room, makeConn("p" + i), "p" + i);
        } else if (shape === "finished") {
          await join(room, makeConn("A"), "A");
          room.state.state = "racing";
          room.state.raceStartedAt = 1000;
          room.finishRace(1100);
        }
        if (!room.state.pendingLobbyRelease) await room.releaseLobby();
        const before = router.calls.length;

        room.state.autoStartDeadline = null;
        room.state.pendingLobbyRelease.nextAttemptAt = Date.now() - 1;
        await room.onAlarm();

        expect(router.calls.length).toBe(before + 1);
        expect(room.state.pendingLobbyRelease.attempts).toBe(2);
        router.restore();
      });
    });
  }

  it("gives up after LOBBY_RELEASE_MAX_ATTEMPTS instead of retrying forever", async () => {
    await withRoom("lr-giveup-" + crypto.randomUUID(), async (room) => {
      const router = breakLobbyRouter(room);
      for (let i = 0; i < LOBBY_RELEASE_MAX_ATTEMPTS; i++) {
        await room.releaseLobby();
      }
      expect(router.calls.length).toBe(LOBBY_RELEASE_MAX_ATTEMPTS);
      expect(room.state.pendingLobbyRelease).toBeNull();

      // Disarmed for good: the alarm no longer spends attempts on it. The
      // backstop from here is the dead-end join gate re-attempting the
      // release as it turns a routed joiner away.
      await room.onAlarm();
      expect(router.calls.length).toBe(LOBBY_RELEASE_MAX_ATTEMPTS);
      router.restore();
    });
  });
});

describe("PublicRaceRoom.handleHello — dead-end seating", () => {
  it("refuses a new join into a finished room, but seats the reconnecting finisher", async () => {
    await withRoom("lr-finished-" + crypto.randomUUID(), async (room) => {
      const connA = makeConn("A");
      const racerA = await join(room, connA, "A");

      // Drive the room to finished without the auto-start path (which would
      // release the router itself — not what is under test here).
      room.state.state = "racing";
      room.state.raceStartedAt = 1000;
      room.finishRace(1100);
      expect(room.state.state).toBe("finished");

      // A new joiner routed here by a stale pointer is turned away, not
      // seated in front of a dead scoreboard.
      const connB = makeConn("B");
      await join(room, connB, "B");
      const err = connB.lastOf("error");
      expect(err?.code).toBe("MATCH_OVER");
      expect(room.state.players.some((p) => !p.isBot && p.handle === "B")).toBe(false);

      // The finisher reloading the page reconnects into the scoreboard.
      const connA2 = makeConn("A2");
      await room.handleHello(connA2, {
        type: "hello", playerId: racerA, handle: "A", deviceId: "dev-A", difficulty: "medium",
      });
      expect(connA2.lastOf("hello-ack")).toBeTruthy();
      expect(connA2.lastOf("error")).toBeNull();
    });
  });

  it("refuses a new join into a room already racing", async () => {
    await withRoom("lr-racing-" + crypto.randomUUID(), async (room) => {
      await join(room, makeConn("A"), "A");
      room.state.state = "racing";
      room.state.raceStartedAt = Date.now();

      const connB = makeConn("B");
      await join(room, connB, "B");
      const err = connB.lastOf("error");
      expect(err?.code).toBe("MATCH_OVER");
      expect(room.state.players.filter((p) => !p.isBot).length).toBe(1);
    });
  });

  it("a rejected full-room hello re-attempts the router release", async () => {
    await withRoom("lr-full-" + crypto.randomUUID(), async (room) => {
      const router = spyLobbyRouter(room);
      for (let i = 0; i < 6; i++) await join(room, makeConn("p" + i), "p" + i);
      // The 6th join's own release fired already.
      expect(router.calls).toEqual([room.name]);

      const conn7 = makeConn("p7");
      await join(room, conn7, "p7");
      expect(conn7.lastOf("error")?.code).toBe("ROOM_FULL");
      // The refusal is the backstop release: the pointer must stop naming a
      // room that cannot seat anyone.
      expect(router.calls).toEqual([room.name, room.name]);
      expect(room.state.players.filter((p) => !p.isBot).length).toBe(6);
      router.restore();
    });
  });

  for (const phase of ["racing", "finished"]) {
    it(`a reconnect into a ${phase} room re-attempts the release without waiting on it`, async () => {
      await withRoom(`lr-rc-${phase}-` + crypto.randomUUID(), async (room) => {
        const racerA = await join(room, makeConn("A"), "A");
        room.state.state = "racing";
        room.state.raceStartedAt = 1000;
        if (phase === "finished") room.finishRace(1100);
        expect(room.state.state).toBe(phase);

        const router = holdLobbyRouter(room);
        const connA2 = makeConn("A2");
        await room.handleHello(connA2, {
          type: "hello", playerId: racerA, handle: "A", deviceId: "dev-A", difficulty: "medium",
        });

        // Seated while the router is still answering...
        expect(connA2.lastOf("hello-ack")).toBeTruthy();
        expect(connA2.lastOf("error")).toBeNull();
        // ...and the backstop release was issued all the same.
        expect(router.calls).toEqual([room.name]);

        router.open();
        await new Promise((r) => setTimeout(r, 0));
        expect(room.state.pendingLobbyRelease).toBeNull();
        router.restore();
      });
    });
  }

  it("a burst of hellos into a dead-end room reaches the router once", async () => {
    await withRoom("lr-burst-" + crypto.randomUUID(), async (room) => {
      const racerA = await join(room, makeConn("A"), "A");
      room.state.state = "racing";
      room.state.raceStartedAt = Date.now();
      const router = spyLobbyRouter(room);

      const refused = [];
      for (let i = 0; i < 5; i++) {
        const conn = makeConn("x" + i);
        await join(room, conn, "x" + i);
        refused.push(conn.lastOf("error")?.code);
      }
      const connA2 = makeConn("A2");
      await room.handleHello(connA2, {
        type: "hello", playerId: racerA, handle: "A", deviceId: "dev-A", difficulty: "medium",
      });

      expect(refused).toEqual(Array(5).fill("MATCH_OVER"));
      expect(connA2.lastOf("hello-ack")).toBeTruthy();
      expect(router.calls).toEqual([room.name]);
      router.restore();
    });
  });

  it("a finished room the router still names is unpinned by the refused join (real router)", async () => {
    // XC-04 end to end: the pointer outlived the room's own release. The
    // next matchmake after the refusal must mint a fresh room. Router calls
    // stay OUTSIDE runInDurableObject — cross-DO I/O cannot be issued from
    // inside another DO's context.
    const routerStub = env.LobbyRouter.get(env.LobbyRouter.idFromName("medium"));
    const { roomId } = await routerStub.pick("medium");
    const connB = makeConn("B");
    await withRoom(roomId, async (room) => {
      await join(room, makeConn("A"), "A");
      room.state.state = "racing";
      room.state.raceStartedAt = 1000;
      room.finishRace(1100);
      // A lobby join never releases, and this direct drive to finished never
      // went through auto-start's release either — so the pointer still
      // names this room when the refusal below fires the backstop release.
      await join(room, connB, "B");
      expect(connB.lastOf("error")?.code).toBe("MATCH_OVER");
    });
    expect((await routerStub.pick("medium")).roomId).not.toBe(roomId);
  });
});

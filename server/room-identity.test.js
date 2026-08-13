// Seat ownership and broadcast hygiene for RaceRoom.
//
// Two identifiers are deliberately kept apart:
//   - racerId  — the client's localStorage secret, sent only in `hello`. It is
//                the sole proof that a socket owns an existing seat.
//   - player.id — an ephemeral, per-room broadcast id. Public by design: every
//                other client keys the roster, lanes, and events off it.
//
// The bug these tests lock down: player.id used to BE the racerId, and every
// state push handed it to every socket in the room — including one that had not
// said `hello` yet. Reading it off the wire was enough to send `hello` as the
// victim and inherit their seat, their answers, and their persisted results.

import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { adoptBroadcastIds, nextBroadcastId, publicPlayer, freshState } from "./room.js";

// Distinct per socket, like the real Connection.id — the seat records which
// socket owns it, and an ownership check that two undefineds satisfy would be
// no check at all.
let connSeq = 0;
const connIds = [];

// Keeps the raw JSON so tests can scan exactly what went over the wire,
// not a re-serialization of it.
function makeConn(state) {
  const id = `sock-${++connSeq}-${crypto.randomUUID()}`;
  connIds.push(id);
  return {
    id,
    raw: [],
    state,
    send(s) { this.raw.push(s); },
    setState(s) { this.state = s; },
    messages() { return this.raw.map((s) => JSON.parse(s)); },
  };
}

async function withRoom(name, fn) {
  const stub = env.RaceRoom.get(env.RaceRoom.idFromName(name));
  return runInDurableObject(stub, async (room) => {
    if (!room.state) await room.onStart();
    const broadcasts = [];
    const conns = [];
    room.broadcast = (s) => broadcasts.push(s);
    room.getConnections = () => conns;
    // Every raw payload the room emitted, however it was addressed.
    const wire = () => [...broadcasts, ...conns.flatMap((c) => c.raw)];
    return fn(room, { conns, wire });
  });
}

async function join(room, conns, { secret, handle, deviceId, userId = null }) {
  const conn = makeConn({ userId });
  conns.push(conn);
  await room.handleHello(conn, { type: "hello", playerId: secret, handle, deviceId });
  return conn;
}

describe("RaceRoom — the racerId is a reconnect secret, not a wire identity", () => {
  it("hands out an ephemeral broadcast id and keeps the racerId server-side", async () => {
    await withRoom("id-split-" + crypto.randomUUID(), async (room, { conns }) => {
      const secret = crypto.randomUUID();
      const conn = await join(room, conns, { secret, handle: "Alice", deviceId: "dev-a" });

      const player = room.state.players[0];
      expect(player.racerId).toBe(secret);
      expect(player.id).not.toBe(secret);
      // Non-UUID by construction, so a broadcast id can never be replayed as a
      // credential — handleHello's UUID gate rejects it before any lookup.
      expect(player.id).toMatch(/^p-\d+$/);

      const ack = conn.messages().find((m) => m.type === "hello-ack");
      expect(ack.playerId).toBe(player.id);
      expect(publicPlayer(player).racerId).toBeUndefined();
    });
  });

  it("a hello replaying another player's broadcast id cannot take over the seat", async () => {
    await withRoom("hijack-broadcast-id-" + crypto.randomUUID(), async (room, { conns, wire }) => {
      const victimSecret = crypto.randomUUID();
      await join(room, conns, { secret: victimSecret, handle: "Victim", deviceId: "victim-device", userId: "victim-user" });
      const victim = room.state.players[0];

      // This is the whole attack surface a stranger has: the ids they can read
      // out of the state push they receive before saying hello.
      const readable = wire()
        .map((s) => JSON.parse(s))
        .flatMap((m) => (m.type === "state" ? m.state.players.map((p) => p.id) : []));
      expect(readable).toContain(victim.id);

      const attacker = makeConn({ userId: "attacker-user" });
      conns.push(attacker);
      await room.handleHello(attacker, {
        type: "hello", playerId: victim.id, handle: "Attacker", deviceId: "attacker-device",
      });

      expect(attacker.messages().find((m) => m.type === "error")?.code).toBe("INVALID_INPUT");
      expect(room.state.players.length).toBe(1);
      expect(victim.deviceId).toBe("victim-device");
      expect(victim.userId).toBe("victim-user");
      expect(attacker.state.playerId).toBeUndefined();
    });
  });

  it("a hello with a wrong secret joins as a new player instead of overwriting one", async () => {
    await withRoom("hijack-wrong-secret-" + crypto.randomUUID(), async (room, { conns }) => {
      await join(room, conns, { secret: crypto.randomUUID(), handle: "Victim", deviceId: "victim-device", userId: "victim-user" });
      const victim = room.state.players[0];

      const attacker = makeConn({ userId: "attacker-user" });
      conns.push(attacker);
      await room.handleHello(attacker, {
        type: "hello", playerId: crypto.randomUUID(), handle: "Attacker", deviceId: "attacker-device",
      });

      expect(room.state.players.length).toBe(2);
      expect(victim.deviceId).toBe("victim-device");
      expect(victim.userId).toBe("victim-user");
      expect(attacker.state.playerId).not.toBe(victim.id);
      // The victim keeps the seat that carries isCreator (host powers).
      expect(victim.isCreator).toBe(true);
      expect(room.state.players[1].isCreator).toBe(false);
    });
  });

  it("mid-race, a stranger cannot ride the reconnect branch into a closed room", async () => {
    await withRoom("hijack-midrace-" + crypto.randomUUID(), async (room, { conns }) => {
      await join(room, conns, { secret: crypto.randomUUID(), handle: "Victim", deviceId: "victim-device", userId: "victim-user" });
      const victim = room.state.players[0];
      room.state.state = "racing";

      const attacker = makeConn({ userId: "attacker-user" });
      conns.push(attacker);
      await room.handleHello(attacker, {
        type: "hello", playerId: crypto.randomUUID(), handle: "Attacker", deviceId: "attacker-device",
      });

      // No matching secret ⇒ new joiner ⇒ blocked by the in-progress gate.
      expect(attacker.messages().find((m) => m.type === "error")?.code).toBe("BAD_STATE");
      expect(room.state.players.length).toBe(1);
      expect(victim.deviceId).toBe("victim-device");
    });
  });

  it("a legitimate reconnect presenting the secret reattaches to the same seat", async () => {
    await withRoom("reconnect-ok-" + crypto.randomUUID(), async (room, { conns }) => {
      const secret = crypto.randomUUID();
      const first = await join(room, conns, { secret, handle: "Alice", deviceId: "dev-a", userId: "user-a" });
      const player = room.state.players[0];
      const broadcastId = player.id;
      player.score = 4;
      player.attempts = 6;
      player.longestStreak = 3;

      // Drop: the 30s grace window opens, the seat is held.
      await room.onClose(first);
      expect(room.state.disconnectDeadlines[broadcastId]).toBeGreaterThan(Date.now());

      const second = makeConn({ userId: "user-a" });
      conns.push(second);
      await room.handleHello(second, { type: "hello", playerId: secret, handle: "Alice", deviceId: "dev-a2" });

      expect(room.state.players.length).toBe(1);
      // Stable for the life of the presence — other clients' lanes keep working.
      expect(room.state.players[0].id).toBe(broadcastId);
      expect(room.state.players[0].score).toBe(4);
      expect(room.state.players[0].attempts).toBe(6);
      expect(room.state.disconnectDeadlines[broadcastId]).toBeUndefined();
      expect(second.state.playerId).toBe(broadcastId);
      expect(second.messages().find((m) => m.type === "hello-ack").playerId).toBe(broadcastId);
      // Identity is refreshed from the reconnecting socket, as before.
      expect(room.state.players[0].deviceId).toBe("dev-a2");
    });
  });

  it("a mid-race reconnect still reattaches even though new joins are closed", async () => {
    await withRoom("reconnect-midrace-" + crypto.randomUUID(), async (room, { conns }) => {
      const secret = crypto.randomUUID();
      const first = await join(room, conns, { secret, handle: "Alice", deviceId: "dev-a" });
      const broadcastId = room.state.players[0].id;
      room.state.state = "racing";
      room.state.players[0].score = 7;
      await room.onClose(first);

      const second = makeConn({});
      conns.push(second);
      await room.handleHello(second, { type: "hello", playerId: secret, handle: "Alice", deviceId: "dev-a" });

      expect(second.messages().some((m) => m.type === "error")).toBe(false);
      expect(second.state.playerId).toBe(broadcastId);
      expect(room.state.players[0].score).toBe(7);
    });
  });
});

describe("RaceRoom — a recycled broadcast id is not proof of ownership", () => {
  it("a stale socket cannot act as, or evict, whoever later occupies its old id", async () => {
    // Broadcast ids are only unique within one incarnation of room state, but a
    // socket's connection state outlives that: nothing clears it when the seat
    // goes away. An idle-cleanup reset restarts the counter at p-1, so the next
    // arrival inherits the id a long-lived socket is still holding.
    await withRoom("recycled-id-" + crypto.randomUUID(), async (room, { conns }) => {
      const attacker = await join(room, conns, {
        secret: crypto.randomUUID(), handle: "Attacker", deviceId: "attacker-device", userId: "attacker-user",
      });
      const recycledId = room.state.players[0].id;

      // Quit in the lobby, but keep the socket open — a real client closes it
      // ~100ms later; an attacker's client simply does not.
      await room.handleQuit(attacker);
      expect(room.state.players).toEqual([]);
      expect(attacker.state.playerId).toBe(recycledId);

      // Idle cleanup re-mints the state, restarting the broadcast-id counter.
      room.state.idleCleanupAt = Date.now() - 1;
      await room.onAlarm();
      expect(room.state.nextPid).toBe(1);

      const victimSecret = crypto.randomUUID();
      const victimConn = await join(room, conns, {
        secret: victimSecret, handle: "Victim", deviceId: "victim-device", userId: "victim-user",
      });
      const victim = room.state.players[0];
      expect(victim.id).toBe(recycledId);
      expect(victim.isCreator).toBe(true);

      // The stale socket presents a matching broadcast id but not the secret
      // behind it, so it resolves to nobody at the one shared chokepoint…
      expect(room.playerFor(attacker)).toBeNull();

      // …and therefore none of the seat-owning actions land on the victim.
      await room.handleSetHandle(attacker, { type: "set-handle", handle: "Pwned" });
      expect(victim.handle).toBe("Victim");

      await room.handleSetConfig(attacker, { type: "set-config", difficulty: "hard", raceLength: 5 });
      expect(room.state.difficulty).toBe("medium");

      await room.handleStartRace(attacker);
      expect(room.state.state).toBe("lobby");

      room.state.raceLength = 2;
      room.state.problemSequence = [{ problem: "1 + 1", answer: 2 }, { problem: "2 + 2", answer: 4 }];
      room.state.raceStartedAt = Date.now();
      room.state.state = "racing";
      await room.handleAnswer(attacker, { type: "answer", value: 2 });
      expect(victim.score).toBe(0);
      await room.handleQuit(attacker);
      expect(victim.dropped).toBe(false);
      room.state.state = "lobby";

      // Closing the stale socket must not open a 30s grace on the live seat —
      // onAlarm would evict the victim when it expired.
      await room.onClose(attacker);
      expect(room.state.disconnectDeadlines).toEqual({});
      expect(room.state.players.length).toBe(1);
      expect(victim.deviceId).toBe("victim-device");
      expect(victim.userId).toBe("victim-user");

      // The seat's real owner is unaffected: they can still act…
      await room.handleSetHandle(victimConn, { type: "set-handle", handle: "Victoria" });
      expect(victim.handle).toBe("Victoria");

      // …and still reconnect on the secret after a genuine drop.
      await room.onClose(victimConn);
      expect(room.state.disconnectDeadlines[recycledId]).toBeGreaterThan(Date.now());
      const rejoin = makeConn({ userId: "victim-user" });
      conns.push(rejoin);
      await room.handleHello(rejoin, {
        type: "hello", playerId: victimSecret, handle: "Victoria", deviceId: "victim-device",
      });
      expect(room.state.disconnectDeadlines[recycledId]).toBeUndefined();
      await room.handleSetHandle(rejoin, { type: "set-handle", handle: "Vee" });
      expect(room.state.players[0].id).toBe(recycledId);
      expect(room.state.players[0].handle).toBe("Vee");
    });
  });

  it("tells a stale socket it owns nobody, and the seat holder who they are", async () => {
    await withRoom("recycled-id-youare-" + crypto.randomUUID(), async (room, { conns }) => {
      const attacker = await join(room, conns, { secret: crypto.randomUUID(), handle: "Attacker", deviceId: "a" });
      await room.handleQuit(attacker);
      room.state.idleCleanupAt = Date.now() - 1;
      await room.onAlarm();

      const victimConn = await join(room, conns, { secret: crypto.randomUUID(), handle: "Victim", deviceId: "v" });
      const victim = room.state.players[0];
      attacker.raw.length = 0;
      victimConn.raw.length = 0;
      room.broadcastState();

      expect(attacker.messages().at(-1).youAre).toBeNull();
      expect(victimConn.messages().at(-1).youAre).toBe(victim.id);
    });
  });
});

describe("RaceRoom — a seat has one current owner", () => {
  it("a stale socket's close does not evict the live socket that took the seat over", async () => {
    // Same racerId on two sockets: a second tab, or PartySocket's auto-reconnect
    // landing before the DO noticed the old socket died. Both satisfy the
    // racerId check, so without an owner the older close schedules an eviction
    // against a player who is sitting right there.
    await withRoom("two-tab-" + crypto.randomUUID(), async (room, { conns }) => {
      const secret = crypto.randomUUID();
      const tabA = await join(room, conns, { secret, handle: "Alice", deviceId: "dev-a", userId: "user-a" });
      const player = room.state.players[0];
      const broadcastId = player.id;
      player.score = 5;

      const tabB = makeConn({ userId: "user-a" });
      conns.push(tabB);
      await room.handleHello(tabB, { type: "hello", playerId: secret, handle: "Alice", deviceId: "dev-a" });
      expect(room.state.players.length).toBe(1);
      expect(tabB.state.playerId).toBe(broadcastId);

      // Both sockets still resolve to the seat — the secret is the same.
      expect(room.playerFor(tabA)?.id).toBe(broadcastId);
      expect(room.playerFor(tabB)?.id).toBe(broadcastId);

      await room.onClose(tabA);
      expect(room.state.disconnectDeadlines[broadcastId]).toBeUndefined();

      // Drive the alarm well past the grace window: nothing to expire.
      room.state.idleCleanupAt = null;
      await room.onAlarm();
      expect(room.state.players.length).toBe(1);
      expect(room.state.players[0].id).toBe(broadcastId);
      expect(room.state.players[0].score).toBe(5);

      // The live socket still owns the seat and can still act.
      await room.handleSetHandle(tabB, { type: "set-handle", handle: "Alicia" });
      expect(room.state.players[0].handle).toBe("Alicia");
    });
  });

  it("the owning socket's close still opens the grace, and onAlarm still evicts", async () => {
    await withRoom("owner-close-" + crypto.randomUUID(), async (room, { conns }) => {
      const secret = crypto.randomUUID();
      const tabA = await join(room, conns, { secret, handle: "Alice", deviceId: "dev-a" });
      const broadcastId = room.state.players[0].id;

      const tabB = makeConn({});
      conns.push(tabB);
      await room.handleHello(tabB, { type: "hello", playerId: secret, handle: "Alice", deviceId: "dev-a" });

      // tabB is the owner now, so its close is the seat's real departure.
      await room.onClose(tabB);
      expect(room.state.disconnectDeadlines[broadcastId]).toBeGreaterThan(Date.now());

      room.state.disconnectDeadlines[broadcastId] = Date.now() - 1;
      await room.onAlarm();
      expect(room.state.players).toEqual([]);
      expect(room.state.disconnectDeadlines[broadcastId]).toBeUndefined();
      // The displaced socket resolved to the seat by secret, but never owned it.
      expect(room.playerFor(tabA)).toBeNull();
    });
  });

  it("ownership never falls back to comparing two unknowns", async () => {
    await withRoom("owner-unknown-" + crypto.randomUUID(), async (room, { conns }) => {
      const secret = crypto.randomUUID();
      const conn = await join(room, conns, { secret, handle: "Alice", deviceId: "dev-a" });
      const player = room.state.players[0];
      expect(player.connId).toBe(conn.id);

      // A seat carried over from a build that recorded no owner, reached by a
      // socket the runtime gave no id: unknown must not equal unknown.
      delete player.connId;
      delete conn.id;
      // The seat still resolves by secret — only the eviction path is gated.
      expect(room.playerFor(conn)?.id).toBe(player.id);
      await room.onClose(conn);
      expect(room.state.disconnectDeadlines).toEqual({});
    });
  });
});

describe("RaceRoom — broadcast hygiene", () => {
  it("never puts the racerId secret (or deviceId/userId) on the wire", async () => {
    await withRoom("wire-hygiene-" + crypto.randomUUID(), async (room, { conns, wire }) => {
      // finishRace writes race_results; the DB round-trip is covered elsewhere.
      room.persistRaceResults = async () => {};

      const aliceSecret = crypto.randomUUID();
      const bobSecret = crypto.randomUUID();
      const alice = await join(room, conns, { secret: aliceSecret, handle: "Alice", deviceId: "dev-alice", userId: "user-alice" });
      await join(room, conns, { secret: bobSecret, handle: "Bob", deviceId: "dev-bob" });

      // A late socket that has not said hello yet still gets the roster — the
      // original leak path, and the one an attacker uses.
      const lurker = makeConn({});
      conns.push(lurker);
      await room.onConnect(lurker, {});

      // Exercise every message type that carries a player identifier.
      await room.handleSetHandle(alice, { type: "set-handle", handle: "Alicia" });
      room.state.raceLength = 2;
      room.state.problemSequence = [{ problem: "1 + 1", answer: 2 }, { problem: "2 + 2", answer: 4 }];
      room.state.raceStartedAt = Date.now();
      room.state.state = "racing";
      await room.handleAnswer(alice, { type: "answer", value: 99 });   // wrong
      await room.handleAnswer(alice, { type: "answer", value: 2 });    // advance
      await room.handleQuit(alice);                                    // drop
      await room.finishRace();                                         // finish

      const payloads = wire();
      const kinds = new Set(payloads.map((s) => JSON.parse(s).type));
      for (const expected of ["state", "player-joined", "handle-changed", "wrong", "advance", "drop", "finish"]) {
        expect(kinds, `missing ${expected} in the sampled traffic`).toContain(expected);
      }

      for (const raw of payloads) {
        expect(raw).not.toMatch(/"racerId"/);
        expect(raw).not.toMatch(/"deviceId"/);
        expect(raw).not.toMatch(/"userId"/);
        // Seat bookkeeping naming the owning socket is server-only too — it
        // rides ...rest in publicPlayer unless explicitly stripped.
        expect(raw).not.toMatch(/"connId"/);
        expect(raw).not.toContain(aliceSecret);
        expect(raw).not.toContain(bobSecret);
        expect(raw).not.toMatch(/dev-alice|dev-bob|user-alice/);
        for (const id of connIds) expect(raw).not.toContain(id);
      }

      // …and the roster is still usable: broadcast ids are present and stable.
      const lastState = payloads.map((s) => JSON.parse(s)).filter((m) => m.type === "state").at(-1);
      expect(lastState.state.players.map((p) => p.id)).toEqual(room.state.players.map((p) => p.id));
      expect(lastState.state.players.map((p) => p.handle).sort()).toEqual(["Alicia", "Bob"]);
    });
  });

  it("keeps the grace-window bookkeeping keyed on broadcast ids, not secrets", async () => {
    // disconnectDeadlines is spread wholesale into every state push, so its
    // KEYS are on the wire too — they used to be racerIds.
    await withRoom("wire-deadlines-" + crypto.randomUUID(), async (room, { conns, wire }) => {
      const secret = crypto.randomUUID();
      const conn = await join(room, conns, { secret, handle: "Alice", deviceId: "dev-a" });
      await room.onClose(conn);
      room.broadcastState();

      const pushed = wire().map((s) => JSON.parse(s)).filter((m) => m.type === "state").at(-1);
      expect(Object.keys(pushed.state.disconnectDeadlines)).toEqual([room.state.players[0].id]);
      expect(JSON.stringify(pushed)).not.toContain(secret);
    });
  });
});

describe("adoptBroadcastIds — rooms persisted before the split", () => {
  it("re-keys legacy players so their racerId stops riding the wire", () => {
    const state = freshState("legacy-room");
    delete state.nextPid; // persisted by a build that had no counter
    const secret = crypto.randomUUID();
    state.players = [
      { id: secret, handle: "Alice", score: 3, deviceId: "dev-a", userId: null },
      { id: "bot-1", handle: "Zed", isBot: true, score: 0 },
    ];
    state.disconnectDeadlines = { [secret]: 1234 };

    expect(adoptBroadcastIds(state)).toBe(true);

    const [alice, bot] = state.players;
    expect(alice.racerId).toBe(secret);
    expect(alice.id).toBe("p-1");
    expect(alice.score).toBe(3);
    expect(state.disconnectDeadlines).toEqual({ "p-1": 1234 });
    // Bots never hold a secret and keep their well-known ids.
    expect(bot.id).toBe("bot-1");
    expect(bot.racerId).toBeUndefined();
    expect(JSON.stringify(state.players.map(publicPlayer))).not.toContain(secret);
  });

  it("is a no-op on state that already uses broadcast ids", () => {
    const state = freshState("current-room");
    state.players = [{ id: nextBroadcastId(state), racerId: crypto.randomUUID(), handle: "Alice" }];
    const before = JSON.stringify(state);
    expect(adoptBroadcastIds(state)).toBe(false);
    expect(JSON.stringify(state)).toBe(before);
  });
});

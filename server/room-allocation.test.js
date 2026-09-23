// Private room-id allocation.
//
// Room ids are three words from a 13,248-name list (24 adjectives × 24 × 23
// ordered distinct animal pairs), so a draw landing on a name somebody is
// already using is a birthday problem in the number of live rooms rather than a
// rarity: ~8.8% at 50 live rooms, ~31.2% at 100. `POST /api/rooms` used to
// sample once and return the name either way, which handed the caller somebody
// else's live lobby as their brand-new "private" room — a room they had not
// created and whose occupants they had never met.
//
// So creation reserves instead of sampling. The invariants under test:
//   - a name a live room owns is never returned; the route draws again
//   - the reservation is the room's, so the *next* creation cannot take it
//   - exhausting the retries is a visible failure, not a fallback to a live name
//   - the ordinary path (nothing in the way) still draws exactly once
//   - a reservation nobody joins releases its name on the short unjoined clock,
//     while a room somebody is in keeps the full private-room idle lifetime
//   - a name is never spent permanently by a request that merely minted room
//     state without joining it — a plain GET to /parties/race-room/<name> does
//     that, because partyserver initializes the room before it looks for an
//     Upgrade header
//
// The reservation is atomic because a Durable Object is single-threaded per
// name: reserveRoomName() reads and writes storage inside one RPC, so two
// creations that drew the same name serialize there. That is why the check
// cannot live in the Worker — both callers would see a free name and both
// return it.

import { describe, it, expect, vi, afterEach } from "vitest";
import { env, runInDurableObject, SELF } from "cloudflare:test";
import worker from "./server.js";
import { generateRoomId, allocateRoomId, ROOM_ID_ATTEMPTS } from "./room-id.js";
import { PRIVATE_ROOM_IDLE_MS, UNJOINED_ROOM_IDLE_MS } from "./room.js";
import { EXPIRED_ROOM_STATE } from "../public/src/room-expiry.js";

let connSeq = 0;

function makeConn(state = {}) {
  return {
    id: `sock-${++connSeq}-${crypto.randomUUID()}`,
    raw: [],
    closed: null,
    state,
    send(s) { this.raw.push(s); },
    setState(s) { this.state = s; },
    close(code, reason) { this.closed = { code, reason }; },
    messages() { return this.raw.map((s) => JSON.parse(s)); },
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

async function withPrivateRoom(name, fn) {
  const stub = env.RaceRoom.get(env.RaceRoom.idFromName(name));
  return runInDurableObject(stub, async (room) => {
    if (!room.state) await room.onStart();
    const conns = [];
    room.broadcast = (s) => { for (const c of conns) c.send(s); };
    room.getConnections = () => connectionIterator(conns);
    return fn(room, { conns, stub });
  });
}

/** A room with a seated creator in its lobby — the thing a collision hits. */
async function occupy(name, handle = "Alice") {
  return withPrivateRoom(name, async (room, { conns }) => {
    const conn = makeConn({ userId: null });
    conns.push(conn);
    await room.onConnect(conn, { request: { headers: new Headers() } });
    await room.onMessage(conn, JSON.stringify({
      type: "hello", playerId: crypto.randomUUID(), handle, deviceId: `dev-${handle}`,
    }));
    expect(room.state.players.length).toBe(1);
  });
}

const reserve = (name) => env.RaceRoom.get(env.RaceRoom.idFromName(name)).reserveRoomName();

/** A draw sequence the allocator consumes one name at a time. */
function drawsOf(...names) {
  const seen = [];
  const generate = () => {
    const next = names[seen.length] ?? names[names.length - 1];
    seen.push(next);
    return next;
  };
  return { generate, seen };
}

describe("allocateRoomId reserves a free name", () => {
  it("returns the drawn name and draws only once when nothing is in the way", async () => {
    const free = "alloc-free-" + crypto.randomUUID();
    const { generate, seen } = drawsOf(free);

    expect(await allocateRoomId(env, { generate })).toBe(free);
    expect(seen).toEqual([free]);
  });

  it("arms the short unjoined alarm, so an abandoned reservation releases its name", async () => {
    const name = "alloc-abandoned-" + crypto.randomUUID();
    expect(await allocateRoomId(env, { generate: () => name })).toBe(name);

    // The reservation writes live state; without an alarm nothing would ever
    // wake this never-joined room and the name would be spent for good. The
    // alarm it arms is the *short* one: creation is unauthenticated, so a
    // reservation nobody joins must not be able to hold a name out of a
    // 13,248-name namespace for the full idle window.
    await withPrivateRoom(name, async (room) => {
      const alarm = await room.ctx.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm).toBeLessThanOrEqual(Date.now() + UNJOINED_ROOM_IDLE_MS);

      room.state.lastActivityAt = Date.now() - UNJOINED_ROOM_IDLE_MS - 1000;
      await room.onAlarm();
      expect(room.state.state).toBe(EXPIRED_ROOM_STATE);
    });

    // And a later creation drawing it gets it back.
    expect(await allocateRoomId(env, { generate: () => name })).toBe(name);
  });

  it("lets an abandoned reservation's alarm expire it on a wake whose id carries no name", async () => {
    // reserveRoomName() arrives as a bare DO RPC, which never runs partyserver's
    // initialization, and local workerd hands a later alarm a ctx.id without
    // .name. Unless the reservation left the name behind, that alarm throws
    // reading this.name in expireRoom() on every retry and the name is spent.
    const name = "alloc-nameless-wake-" + crypto.randomUUID();
    expect(await allocateRoomId(env, { generate: () => name })).toBe(name);

    await runInDurableObject(env.RaceRoom.get(env.RaceRoom.idFromName(name)), async (room) => {
      const stored = await room.ctx.storage.get("state");
      stored.lastActivityAt = Date.now() - UNJOINED_ROOM_IDLE_MS - 1000;
      await room.ctx.storage.put("state", stored);

      // A cold instance over the same storage, woken by its alarm alone, with
      // the id an alarm wake hands it: no name on it.
      const cold = new room.constructor(room.ctx, env);
      const namelessId = { name: undefined, toString: () => room.ctx.id.toString() };
      Object.defineProperty(cold, "ctx", {
        value: new Proxy(room.ctx, {
          get: (target, key) => {
            if (key === "id") return namelessId;
            const v = Reflect.get(target, key, target);
            return typeof v === "function" ? v.bind(target) : v;
          },
        }),
      });
      await cold.alarm();
      expect(cold.state.state).toBe(EXPIRED_ROOM_STATE);
    });

    expect(await allocateRoomId(env, { generate: () => name })).toBe(name);
  });

  it("does not let a bare GET on a room name spend that name for good", async () => {
    const name = "alloc-bare-get-" + crypto.randomUUID();

    // Not an upgrade, so nobody joins anything — but partyserver initializes the
    // room (and onStart persists live state) before it ever reads the Upgrade
    // header, so the name is now held by a room with no players.
    const res = await SELF.fetch(`https://racer.test/parties/race-room/${name}`);
    expect(res.status).toBe(404);
    expect(await reserve(name)).toBe(false);

    await withPrivateRoom(name, async (room) => {
      expect(room.state.state).toBe("lobby");
      expect(room.state.players).toEqual([]);
      // The room has to be wakeable, or that state sits there forever and the
      // name can never be reserved again: nothing else will arm an alarm on a
      // room nobody connects to. It is the unjoined fuse, not the 30-minute one.
      const alarm = await room.ctx.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm).toBeLessThanOrEqual(Date.now() + UNJOINED_ROOM_IDLE_MS);

      room.state.lastActivityAt = Date.now() - UNJOINED_ROOM_IDLE_MS - 1000;
      await room.onAlarm();
      expect(room.state.state).toBe(EXPIRED_ROOM_STATE);
    });

    expect(await allocateRoomId(env, { generate: () => name })).toBe(name);
  });

  it("gives a reservation the full idle lifetime once somebody has joined", async () => {
    const name = "alloc-joined-" + crypto.randomUUID();
    expect(await allocateRoomId(env, { generate: () => name })).toBe(name);
    await occupy(name, "Creator");

    // Past the unjoined fuse and nowhere near the real one. The short clock
    // exists to release names nobody took; this room is somebody's lobby and
    // winds down on PRIVATE_ROOM_IDLE_MS like any other private room.
    await withPrivateRoom(name, async (room) => {
      const idleSince = Date.now() - UNJOINED_ROOM_IDLE_MS - 1000;
      room.state.lastActivityAt = idleSince;
      await room.persist();
      await room.onAlarm();

      expect(room.state.state).toBe("lobby");
      expect(room.state.players.length).toBe(1);
      expect(await room.ctx.storage.getAlarm()).toBe(idleSince + PRIVATE_ROOM_IDLE_MS);
    });
  });
});

describe("allocateRoomId refuses a name in use", () => {
  it("retries past an occupied name onto a fresh one", async () => {
    const taken = "alloc-taken-" + crypto.randomUUID();
    const free = "alloc-next-" + crypto.randomUUID();
    await occupy(taken);

    const { generate, seen } = drawsOf(taken, free);
    expect(await allocateRoomId(env, { generate })).toBe(free);
    expect(seen).toEqual([taken, free]);

    // The occupied room was not disturbed by the attempt on it.
    await withPrivateRoom(taken, async (room) => {
      expect(room.state.state).toBe("lobby");
      expect(room.state.players.length).toBe(1);
      expect(room.state.players[0].isCreator).toBe(true);
    });
  });

  it("refuses a name another creation already reserved but nobody has joined", async () => {
    // The window this closes: created, link not yet opened. The room has no
    // players, so anything keyed on occupancy would call it free.
    const name = "alloc-reserved-" + crypto.randomUUID();
    expect(await reserve(name)).toBe(true);

    const free = "alloc-reserved-next-" + crypto.randomUUID();
    const { generate } = drawsOf(name, free);
    expect(await allocateRoomId(env, { generate })).toBe(free);
  });

  it("gives up after the attempt budget rather than returning a live name", async () => {
    const taken = "alloc-exhausted-" + crypto.randomUUID();
    await occupy(taken);

    const { generate, seen } = drawsOf(taken);
    expect(await allocateRoomId(env, { generate })).toBeNull();
    expect(seen.length).toBe(ROOM_ID_ATTEMPTS);
  });

  it("counts a throwing reservation as taken and reports it", async () => {
    // An RPC that threw leaves the reservation unproven, so the name is not
    // ours to hand out — the same answer as "occupied", and the caller hears
    // about it.
    const errors = [];
    const boom = new Error("DO unreachable");
    const brokenEnv = {
      RaceRoom: {
        idFromName: (n) => n,
        get: () => ({ reserveRoomName: () => { throw boom; } }),
      },
    };

    const got = await allocateRoomId(brokenEnv, {
      generate: () => "alloc-broken",
      onError: (e, id) => errors.push([e, id]),
    });
    expect(got).toBeNull();
    // One report per attempt, over the real budget — nothing shortens the loop.
    expect(errors).toEqual(Array.from({ length: ROOM_ID_ATTEMPTS }, () => [boom, "alloc-broken"]));
  });
});

describe("POST /api/rooms never hands back a live room", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  /**
   * Pin the draw. generateRoomId() takes three rolls for an ordinary name, so
   * feeding it a repeating triple makes every draw the same id — the shape both
   * tests below want, one to collide on it and one to receive it.
   */
  function pinDraw(rolls) {
    let i = 0;
    vi.spyOn(Math, "random").mockImplementation(() => rolls[i++ % rolls.length]);
    return generateRoomId(() => rolls[(i++) % rolls.length]);
  }

  const createRoom = () => worker.fetch(
    new Request("https://racer.test/api/rooms", { method: "POST" }), env, {},
  );

  it("returns the drawn name on the ordinary path", async () => {
    const roomId = pinDraw([0.05, 0.41, 0.88]);

    const res = await createRoom();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ roomId });

    // And it is the caller's own room: their first connection reaches a lobby
    // where they are the creator.
    await withPrivateRoom(roomId, async (room, { conns }) => {
      const creator = makeConn({ userId: null });
      conns.push(creator);
      await room.onConnect(creator, { request: { headers: new Headers() } });
      expect(creator.closed).toBeNull();
      await room.onMessage(creator, JSON.stringify({
        type: "hello", playerId: crypto.randomUUID(), handle: "Creator", deviceId: "dev-creator",
      }));
      expect(room.state.players[0].isCreator).toBe(true);
    });
  });

  it("503s when every draw is a room somebody is already in", async () => {
    // Every draw is the same name and that name is occupied, so the retries
    // run out. The caller has to be told; returning the name would drop them
    // into Alice's lobby, where they are not the creator.
    const roomId = pinDraw([0.62, 0.62, 0.62]);
    await occupy(roomId, "Alice");

    const res = await createRoom();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "no room name available" });

    await withPrivateRoom(roomId, async (room) => {
      expect(room.state.players.length).toBe(1);
      expect(room.state.players[0].handle).toBe("Alice");
    });
  });
});

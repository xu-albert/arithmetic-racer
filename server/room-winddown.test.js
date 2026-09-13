// Idle winddown for PRIVATE rooms.
//
// A private room is reachable forever by its invite link, so an abandoned one
// is a Durable Object that never stops being wakeable. After
// PRIVATE_ROOM_IDLE_MS with no client touching it, the room replaces its state
// with a tombstone, drops its alarm, and sends anyone still attached to the
// "room expired" screen.
//
// "Inactivity" here means no client activity: no socket connecting or closing
// and no recognized room message. Alarm ticks are not activity — a race nobody
// is answering is idle. Empty rooms and rooms full of AFK tabs both qualify.
//
// The two behaviors worth locking down beyond the trigger itself:
//   - the alarm follows the clock. Every bump of lastActivityAt has to push the
//     winddown alarm out with it, or an active room dies mid-race.
//   - public quickmatch rooms are untouched. They are single-shot and nobody
//     holds a link to one, so an "expired" screen there is a dead end.

import { describe, it, expect, vi, afterEach } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import worker from "./server.js";
import { generateRoomId } from "./room-id.js";
import {
  PRIVATE_ROOM_IDLE_MS,
  EXPIRED_ROOM_TTL_MS,
  IDLE_CLEANUP_MS,
  RECONNECT_GRACE_MS,
  ALARM_SLOP_MS,
} from "./room.js";
import { EXPIRED_ROOM_STATE, ROOM_EXPIRED_TYPE } from "../public/src/room-expiry.js";

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

/**
 * Run against a real DO instance with broadcast/getConnections redirected to
 * a list the test controls, the same harness shape room-identity.test.js uses.
 */
async function withRoom(binding, name, fn) {
  const stub = binding.get(binding.idFromName(name));
  return runInDurableObject(stub, async (room) => {
    if (!room.state) await room.onStart();
    const broadcasts = [];
    const conns = [];
    room.broadcast = (s) => { broadcasts.push(s); for (const c of conns) c.send(s); };
    room.getConnections = () => conns;
    return fn(room, { conns, broadcasts, stub });
  });
}

const withPrivateRoom = (name, fn) => withRoom(env.RaceRoom, name, fn);
const withPublicRoom = (name, fn) => withRoom(env.PublicRaceRoom, name, fn);

async function join(room, conns, handle = "Alice") {
  const conn = makeConn({ userId: null });
  conns.push(conn);
  await room.onConnect(conn, { request: { headers: new Headers() } });
  await room.onMessage(conn, JSON.stringify({
    type: "hello", playerId: crypto.randomUUID(), handle, deviceId: `dev-${handle}`,
  }));
  return conn;
}

/** Pretend the room's last activity was `ms` ago. */
function ageRoom(room, ms) {
  room.state.lastActivityAt = Date.now() - ms;
  room.persistedActivityAt = null;
}

/**
 * The alarm enforces the winddown deadline derived from the current clock,
 * give or take ALARM_SLOP_MS. A pending alarm is allowed to lag behind the
 * newest activity bump (rewriting it on every frame is the storage write this
 * avoids), but never to sit past the deadline it exists to enforce.
 */
function expectAlarmEnforces(alarm, deadline) {
  expect(alarm).toBeLessThanOrEqual(deadline);
  expect(alarm).toBeGreaterThan(deadline - ALARM_SLOP_MS);
}

describe("private room — the winddown trigger", () => {
  it("expires after 30 minutes of inactivity and stops holding an alarm", async () => {
    await withPrivateRoom("winddown-" + crypto.randomUUID(), async (room, { conns }) => {
      const conn = await join(room, conns);
      expect(room.state.state).toBe("lobby");

      // One tick short of the deadline the room is still alive, alarm intact.
      ageRoom(room, PRIVATE_ROOM_IDLE_MS - 60_000);
      await room.scheduleNextAlarm();
      await room.onAlarm();
      expect(room.state.state).toBe("lobby");
      expect(room.state.players.length).toBe(1);
      expect(await room.ctx.storage.getAlarm()).not.toBeNull();

      // Past it, the room winds down.
      ageRoom(room, PRIVATE_ROOM_IDLE_MS + 1000);
      await room.onAlarm();

      expect(room.state.state).toBe(EXPIRED_ROOM_STATE);
      expect(room.state.players).toEqual([]);
      expect(room.state.expiredAt).toBeGreaterThan(0);

      // Nothing left to wake the DO for: no alarm, and the tombstone itself
      // never schedules one.
      expect(await room.ctx.storage.getAlarm()).toBeNull();
      await room.scheduleNextAlarm();
      expect(await room.ctx.storage.getAlarm()).toBeNull();
      expect(room.idleExpiryAt()).toBeNull();

      // The player watching the lobby is told, and their socket is closed
      // rather than left hanging on a room that no longer exists.
      const expired = conn.messages().filter((m) => m.type === ROOM_EXPIRED_TYPE);
      expect(expired.length).toBe(1);
      expect(expired[0].reason).toBe("idle");
      expect(conn.closed).not.toBeNull();
    });
  });

  it("winds down a room whose race stalled, not just an empty one", async () => {
    await withPrivateRoom("winddown-afk-" + crypto.randomUUID(), async (room, { conns }) => {
      await join(room, conns, "Alice");
      await join(room, conns, "Bob");
      room.state.state = "racing";
      room.state.raceStartedAt = Date.now();
      room.state.problemSequence = [{ problem: "1 + 1", answer: 2 }];

      // Two connected players, both AFK: no answers for 30 minutes.
      ageRoom(room, PRIVATE_ROOM_IDLE_MS + 1);
      await room.onAlarm();

      expect(room.state.state).toBe(EXPIRED_ROOM_STATE);
      for (const c of conns) {
        expect(c.messages().some((m) => m.type === ROOM_EXPIRED_TYPE)).toBe(true);
      }
    });
  });

  it("the countdown alarm is not activity — ticks alone cannot keep a room alive", async () => {
    await withPrivateRoom("winddown-ticks-" + crypto.randomUUID(), async (room, { conns }) => {
      await join(room, conns, "Alice");
      room.state.state = "countdown";
      room.state.countdownN = 3;
      room.state.countdownAt = Date.now();
      const before = room.state.lastActivityAt;

      await room.onAlarm();
      expect(room.state.lastActivityAt).toBe(before);
    });
  });
});

describe("private room — the alarm follows the activity clock", () => {
  it("schedules the winddown one idle window after the last activity", async () => {
    await withPrivateRoom("winddown-alarm-" + crypto.randomUUID(), async (room, { conns }) => {
      await join(room, conns);
      const alarm = await room.ctx.storage.getAlarm();
      expectAlarmEnforces(alarm, room.state.lastActivityAt + PRIVATE_ROOM_IDLE_MS);
    });
  });

  it("leaves a slightly-early alarm alone instead of rewriting it per frame", async () => {
    await withPrivateRoom("winddown-slop-" + crypto.randomUUID(), async (room, { conns }) => {
      await join(room, conns);
      const before = await room.ctx.storage.getAlarm();
      expect(before).not.toBeNull();

      // Ordinary traffic moves the clock by less than the slop window. The
      // alarm on disk is already close enough, so it is not rewritten.
      room.state.lastActivityAt += ALARM_SLOP_MS - 1000;
      await room.scheduleNextAlarm();
      expect(await room.ctx.storage.getAlarm()).toBe(before);

      // The early wake-up is self-correcting: the runtime consumes the alarm
      // before onAlarm runs, which finds the deadline unreached, leaves the
      // room alone, and rearms on the current clock.
      await room.ctx.storage.deleteAlarm();
      await room.onAlarm();
      expect(room.state.state).toBe("lobby");
      expect(await room.ctx.storage.getAlarm())
        .toBe(room.state.lastActivityAt + PRIVATE_ROOM_IDLE_MS);
    });
  });

  it("never lets that skip swallow an earlier deadline", async () => {
    await withPrivateRoom("winddown-slop-earlier-" + crypto.randomUUID(), async (room, { conns }) => {
      const conn = await join(room, conns);
      const winddown = await room.ctx.storage.getAlarm();

      // A grace deadline 30s out, against a winddown half an hour out.
      await room.onClose(conn);
      const pid = room.state.players[0].id;
      const grace = room.state.disconnectDeadlines[pid];
      expect(grace).toBeLessThan(winddown);
      expect(await room.ctx.storage.getAlarm()).toBe(grace);

      // Earlier is earlier however small the step: the skip is one-directional,
      // or a real timer would be missed rather than merely fired early.
      room.state.disconnectDeadlines[pid] = grace - 1;
      await room.scheduleNextAlarm();
      expect(await room.ctx.storage.getAlarm()).toBe(grace - 1);
    });
  });

  it("every message pushes the alarm out, and persists the clock behind it", async () => {
    await withPrivateRoom("winddown-reschedule-" + crypto.randomUUID(), async (room, { conns }) => {
      const conn = await join(room, conns);
      ageRoom(room, PRIVATE_ROOM_IDLE_MS - 5000);
      await room.scheduleNextAlarm();
      const early = await room.ctx.storage.getAlarm();

      // A handler that only replies with an error still counts as activity —
      // and those are exactly the ones that never reschedule on their own.
      await room.onMessage(conn, JSON.stringify({ type: "start-race" }));
      expect(conn.messages().at(-1).type).toBe("error");

      const later = await room.ctx.storage.getAlarm();
      expect(later).toBeGreaterThan(early);
      expectAlarmEnforces(later, room.state.lastActivityAt + PRIVATE_ROOM_IDLE_MS);

      // The alarm time is durable but the timestamp behind it is not, so the
      // bump has to reach storage or a cold wake would expire the room early.
      const stored = await room.ctx.storage.get("state");
      expect(stored.lastActivityAt).toBe(room.state.lastActivityAt);
    });
  });

  it("a reconnect after the room emptied revives it and pushes the winddown out", async () => {
    await withPrivateRoom("winddown-revive-" + crypto.randomUUID(), async (room, { conns }) => {
      const conn = await join(room, conns);
      await room.onClose(conn);
      room.state.disconnectDeadlines[room.state.players[0].id] = Date.now() - 1;
      await room.onAlarm();
      expect(room.state.players).toEqual([]);

      ageRoom(room, PRIVATE_ROOM_IDLE_MS - 1000);
      await room.scheduleNextAlarm();
      const before = await room.ctx.storage.getAlarm();

      await join(room, conns, "Carol");
      expect(room.state.state).toBe("lobby");
      expect(await room.ctx.storage.getAlarm()).toBeGreaterThan(before);
    });
  });

  it("an unrecognized message is not activity", async () => {
    await withPrivateRoom("winddown-junk-" + crypto.randomUUID(), async (room, { conns }) => {
      const conn = await join(room, conns);
      ageRoom(room, PRIVATE_ROOM_IDLE_MS - 1000);
      const aged = room.state.lastActivityAt;

      await room.onMessage(conn, JSON.stringify({ type: "keep-me-alive-please" }));
      expect(room.state.lastActivityAt).toBe(aged);
    });
  });

  it("the 5-minute empty-room reset keeps the idle clock instead of restarting it", async () => {
    // The reset re-mints state (and with it the broadcast-id counter). Handing
    // that fresh state a fresh lastActivityAt would mean an empty room got a
    // brand-new 30 minutes every five, and never wound down.
    await withPrivateRoom("winddown-cleanup-" + crypto.randomUUID(), async (room, { conns }) => {
      const conn = await join(room, conns);
      await room.onMessage(conn, JSON.stringify({ type: "quit" }));
      expect(room.state.players).toEqual([]);
      expect(room.state.idleCleanupAt).toBeGreaterThan(Date.now());

      const idleSince = Date.now() - (PRIVATE_ROOM_IDLE_MS - IDLE_CLEANUP_MS);
      room.state.lastActivityAt = idleSince;
      room.state.idleCleanupAt = Date.now() - 1;
      await room.onAlarm();

      expect(room.state.nextPid).toBe(1);
      expect(room.state.lastActivityAt).toBe(idleSince);
      expectAlarmEnforces(await room.ctx.storage.getAlarm(), idleSince + PRIVATE_ROOM_IDLE_MS);
    });
  });
});

describe("private room — what a client hitting an expired room gets", () => {
  it("answers a fresh connection with room-expired and closes it, never a lobby", async () => {
    await withPrivateRoom("expired-connect-" + crypto.randomUUID(), async (room, { conns }) => {
      await join(room, conns);
      ageRoom(room, PRIVATE_ROOM_IDLE_MS + 1);
      await room.onAlarm();

      const visitor = makeConn();
      conns.push(visitor);
      await room.onConnect(visitor, { request: { headers: new Headers() } });

      const msgs = visitor.messages();
      expect(msgs.length).toBe(1);
      expect(msgs[0].type).toBe(ROOM_EXPIRED_TYPE);
      expect(msgs.some((m) => m.type === "state")).toBe(false);
      expect(visitor.closed).not.toBeNull();
      // No seat was created for them, so the tombstone stays a tombstone.
      expect(room.state.state).toBe(EXPIRED_ROOM_STATE);
      expect(room.state.players).toEqual([]);
    });
  });

  it("refuses to act on messages into an expired room", async () => {
    await withPrivateRoom("expired-message-" + crypto.randomUUID(), async (room, { conns }) => {
      const conn = await join(room, conns);
      ageRoom(room, PRIVATE_ROOM_IDLE_MS + 1);
      await room.onAlarm();
      conn.raw.length = 0;

      await room.onMessage(conn, JSON.stringify({
        type: "hello", playerId: crypto.randomUUID(), handle: "Zombie", deviceId: "dev-z",
      }));

      expect(conn.messages().map((m) => m.type)).toEqual([ROOM_EXPIRED_TYPE]);
      expect(room.state.players).toEqual([]);
      expect(room.state.state).toBe(EXPIRED_ROOM_STATE);
    });
  });

  it("keeps answering 'expired' across a cold restart, then frees the name after a day", async () => {
    const name = "expired-restart-" + crypto.randomUUID();
    await withPrivateRoom(name, async (room, { conns }) => {
      await join(room, conns);
      ageRoom(room, PRIVATE_ROOM_IDLE_MS + 1);
      await room.onAlarm();
    });

    // Cold wake: onStart reloads the tombstone from storage.
    await withPrivateRoom(name, async (room) => {
      await room.onStart();
      expect(room.state.state).toBe(EXPIRED_ROOM_STATE);

      // Past the TTL, the name is ordinary again — otherwise a word-list room
      // id would be permanently stamped "expired" for whoever draws it next.
      room.state.expiredAt = Date.now() - EXPIRED_ROOM_TTL_MS - 1000;
      await room.ctx.storage.put("state", room.state);
      await room.onStart();
      expect(room.state.state).toBe("lobby");
      expect(room.state.lastActivityAt).toBeGreaterThan(0);
    });
  });

  it("reserveRoomName clears a tombstone when the name is handed out again", async () => {
    const name = "expired-claim-" + crypto.randomUUID();
    await withPrivateRoom(name, async (room, { conns }) => {
      await join(room, conns);
      ageRoom(room, PRIVATE_ROOM_IDLE_MS + 1);
      await room.onAlarm();
    });

    // Over RPC, the same path POST /api/rooms takes.
    const stub = env.RaceRoom.get(env.RaceRoom.idFromName(name));
    expect(await stub.reserveRoomName()).toBe(true);

    await withPrivateRoom(name, async (room) => {
      await room.onStart();
      expect(room.state.state).toBe("lobby");
      const visitor = makeConn();
      await room.onConnect(visitor, { request: { headers: new Headers() } });
      expect(visitor.messages()[0].type).toBe("state");
    });

    // The reservation now owns the name: a second creation drawing it is told
    // no rather than being handed this lobby. See server/room-allocation.test.js
    // for the retry that answer drives.
    expect(await stub.reserveRoomName()).toBe(false);
  });
});

describe("POST /api/rooms claims the name it hands out", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("clears a tombstone sitting on the id, so a new room is not born expired", async () => {
    // Room ids are three words from a ~13k-combination list, so a new room
    // really can draw the name of one that expired. Pin the draw so the test
    // can plant the tombstone the creator would otherwise land on.
    const rolls = [0.11, 0.37, 0.73];
    let i = 0;
    vi.spyOn(Math, "random").mockImplementation(() => rolls[i++ % rolls.length]);
    const roomId = generateRoomId(() => rolls[i++ % rolls.length]);
    i = 0;

    await withPrivateRoom(roomId, async (room, { conns }) => {
      await join(room, conns);
      ageRoom(room, PRIVATE_ROOM_IDLE_MS + 1);
      await room.onAlarm();
      expect(room.state.state).toBe(EXPIRED_ROOM_STATE);
    });

    const res = await worker.fetch(
      new Request("https://racer.test/api/rooms", { method: "POST" }), env, {},
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ roomId });

    // The creator's very first connection has to reach a lobby, not the
    // expired screen.
    await withPrivateRoom(roomId, async (room) => {
      await room.onStart();
      expect(room.state.state).toBe("lobby");
      const creator = makeConn();
      await room.onConnect(creator, { request: { headers: new Headers() } });
      expect(creator.messages()[0].type).toBe("state");
      expect(creator.closed).toBeNull();
    });
  });
});

describe("public quickmatch rooms are not wound down", () => {
  it("never schedules an idle expiry, however long it sits", async () => {
    await withPublicRoom("m-winddown-" + crypto.randomUUID(), async (room, { conns }) => {
      const conn = makeConn({ userId: null });
      conns.push(conn);
      await room.onConnect(conn, { request: { headers: new Headers() } });

      expect(room.expiresWhenIdle()).toBe(false);
      expect(room.idleExpiryAt()).toBeNull();

      room.state.lastActivityAt = Date.now() - PRIVATE_ROOM_IDLE_MS * 2;
      room.state.createdAt = Date.now() - PRIVATE_ROOM_IDLE_MS * 2;
      await room.onAlarm();

      expect(room.state.state).not.toBe(EXPIRED_ROOM_STATE);
      expect(conn.messages().some((m) => m.type === ROOM_EXPIRED_TYPE)).toBe(false);
    });
  });

  it("still reclaims itself through the unchanged 5-minute idle cleanup", async () => {
    await withPublicRoom("m-cleanup-" + crypto.randomUUID(), async (room) => {
      room.state.players = [];
      room.state.idleCleanupAt = Date.now() - 1;
      room.state.nextPid = 7;
      await room.ctx.storage.put("state", room.state);

      await room.onAlarm();

      expect(room.state.nextPid).toBe(1);
      expect(await room.ctx.storage.get("state")).toBeUndefined();
    });
  });

  it("schedules its deadlines exactly, without the winddown's slop window", async () => {
    // The slop exists for a clock that moves on every client frame. A room
    // with no idle clock moves its deadlines a handful of times per match, so
    // skipping the write there only buys a no-op wake-up on a stale alarm.
    await withPublicRoom("m-alarm-" + crypto.randomUUID(), async (room, { conns }) => {
      await join(room, conns, "Alice");
      const lone = await room.ctx.storage.getAlarm();
      expect(lone).toBe(room.state.autoStartDeadline);

      // The second joiner moves auto-start from now+LONE_TIMEOUT_MS to
      // now+GATHER_WINDOW_MS: later, but by far less than a slop window.
      await new Promise((r) => setTimeout(r, 20));
      await join(room, conns, "Bob");
      const gather = room.state.autoStartDeadline;
      expect(gather).toBeGreaterThan(lone);
      expect(gather - lone).toBeLessThan(ALARM_SLOP_MS);

      expect(await room.ctx.storage.getAlarm()).toBe(gather);
    });
  });
});

describe("private room — the winddown does not disturb the reconnect grace", () => {
  it("still evicts on the shorter grace deadline while the idle window runs", async () => {
    await withPrivateRoom("winddown-grace-" + crypto.randomUUID(), async (room, { conns }) => {
      const conn = await join(room, conns);
      const pid = room.state.players[0].id;
      await room.onClose(conn);

      // The grace deadline is far sooner than the winddown, so it wins.
      const alarm = await room.ctx.storage.getAlarm();
      expect(alarm).toBe(room.state.disconnectDeadlines[pid]);
      expect(alarm).toBeLessThan(room.state.lastActivityAt + PRIVATE_ROOM_IDLE_MS);
      expect(alarm).toBeLessThanOrEqual(Date.now() + RECONNECT_GRACE_MS);

      room.state.disconnectDeadlines[pid] = Date.now() - 1;
      await room.onAlarm();
      expect(room.state.players).toEqual([]);
      expect(room.state.state).toBe("lobby");
    });
  });
});

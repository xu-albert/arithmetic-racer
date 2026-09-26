// Race-result write integrity: the durable outbox + idempotent insert.
//
// Two failure shapes are covered here, both reproduced against the real room
// DO and a real D1:
//   1. D1 down at race end — rows sit in state.pendingResults (persisted
//      BEFORE the first insert attempt) and the alarm retries until they land,
//      dated to the race rather than to the retry.
//   2. A retry after a write that secretly landed — the insert's own (room,
//      device, race time, result) fingerprint keeps it from writing a second
//      row, while two races that happen to post the same counts both land.
//
// Harness mirrors server/room-race-deadline.test.js: fake connections,
// handlers called directly, real D1 via cloudflare:test. The D1 outage is a
// Proxy on room.env whose DB binding throws on every statement. Tests that
// need the race's time to be a particular one pin Date (only Date) to a
// moment after the real clock, so no alarm they arm comes due mid-test.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";

import { RESULT_OUTBOX_TTL_MS } from "./room.js";
import { periodStartMs } from "../public/src/leaderboard-period.js";

const DAY_MS = 24 * 60 * 60 * 1000;

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

async function withRoom(binding, name, conns, fn) {
  const stub = binding.get(binding.idFromName(name));
  return runInDurableObject(stub, async (room) => {
    if (!room.state) await room.onStart();
    room.getConnections = () => connectionIterator(conns);
    room.broadcast = (s) => { for (const c of conns) c.send(s); };
    room.releaseLobby = async () => {};

    // PublicRaceRoom settles its outbox fire-and-forget (finishRace must not
    // suspend on D1), so record each kick for the test to await.
    const writes = [];
    const originalPersist = room.persistResults?.bind(room);
    if (originalPersist) {
      room.persistResults = () => {
        const p = originalPersist();
        writes.push(p);
        return p;
      };
    }
    return fn(room, { settled: () => Promise.allSettled(writes) });
  });
}

const withPrivateRoom = (conns, fn) =>
  withRoom(env.RaceRoom, "ob-" + crypto.randomUUID(), conns, fn);
const withPublicRoom = (conns, fn) =>
  withRoom(env.PublicRaceRoom, "m-ob-" + crypto.randomUUID(), conns, fn);

async function join(room, conn, handle, extra = {}) {
  const playerId = crypto.randomUUID();
  await room.handleHello(conn, {
    type: "hello", playerId, handle, deviceId: "dev-" + handle, ...extra,
  });
  return playerId;
}

async function runCountdown(room) {
  for (let i = 0; i < 8 && room.state.state === "countdown"; i++) {
    room.state.countdownAt = Date.now() - 1;
    await room.onAlarm();
  }
  expect(room.state.state).toBe("racing");
}

async function answerCorrectly(room, conn) {
  const player = room.playerFor(conn);
  const problem = room.state.problemSequence[player.score];
  await room.handleAnswer(conn, { type: "answer", value: String(problem.answer) });
}

/** Finish `conns`, at a human pace (8s) so no captcha challenge holds rows. */
async function raceToFinish(room, conns, elapsedMs = 8000) {
  room.state.raceStartedAt = Date.now() - elapsedMs;
  for (let i = 0; i < room.state.raceLength; i++) {
    for (const conn of conns) await answerCorrectly(room, conn);
  }
}

function playerOf(room, racerId) {
  return room.state.players.find((p) => p.racerId === racerId) ?? null;
}

async function rowsForRoom(room) {
  const res = await env.DB.prepare(
    "SELECT * FROM race_results WHERE room_id = ? ORDER BY device_id"
  ).bind(room.state.id).all();
  return res.results;
}

/**
 * Make every D1 statement this room issues fail, returning a restore
 * function. Only the DB binding is swapped — storage (persist, alarms) keeps
 * working, which is exactly the split the outbox relies on.
 */
function breakD1(room) {
  const realEnv = room.env;
  const fail = async () => { throw new Error("D1 unavailable (test)"); };
  const broken = {
    prepare() {
      return { bind: () => ({ run: fail, all: fail, first: fail, raw: fail }) };
    },
  };
  room.env = new Proxy(realEnv, { get: (target, key) => (key === "DB" ? broken : target[key]) });
  return () => { room.env = realEnv; };
}

/**
 * Hold every D1 statement this room issues until `release()`, then let it
 * through to the real database — a D1 that is slow rather than down. `calls`
 * counts the statements started.
 */
function holdD1(room) {
  const realEnv = room.env;
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  let calls = 0;
  const held = {
    prepare(sql) {
      return {
        bind: (...args) => ({
          async run() {
            calls++;
            await gate;
            return realEnv.DB.prepare(sql).bind(...args).run();
          },
        }),
      };
    },
  };
  room.env = new Proxy(realEnv, { get: (target, key) => (key === "DB" ? held : target[key]) });
  return {
    calls: () => calls,
    release() { room.env = realEnv; open(); },
  };
}

/** Make every owed row due and let the alarm retry it. */
async function retryNow(room) {
  for (const e of room.state.pendingResults) e.nextAttemptAt = Date.now() - 1;
  await room.onAlarm();
}

/** Pin the clock the room reads to `at`. Undone after every test. */
function setClock(at) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM race_results");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("private room — durable outbox", () => {
  it("a D1 outage at race end loses nothing: the alarm retries until rows land", async () => {
    const a = makeConn("a");
    const b = makeConn("b");
    await withPrivateRoom([a, b], async (room) => {
      await join(room, a, "A");
      await join(room, b, "B");
      await room.handleStartRace(a);
      await runCountdown(room);

      const restore = breakD1(room);
      await raceToFinish(room, [a, b]);
      expect(room.state.state).toBe("finished");

      // Nothing landed, and the intent is durable — persisted state, not just
      // memory, carries the two owed rows.
      expect(await rowsForRoom(room)).toHaveLength(0);
      expect(room.state.pendingResults).toHaveLength(2);
      const stored = await room.ctx.storage.get("state");
      expect(stored.pendingResults).toHaveLength(2);

      // The outbox never reaches the wire.
      expect(room.publicState().pendingResults).toBeUndefined();

      // D1 recovers; the next alarm writes both rows and settles the queue.
      restore();
      await retryNow(room);
      expect(room.state.pendingResults).toHaveLength(0);
      const rows = await rowsForRoom(room);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.finished === 1)).toBe(true);
      const storedAfter = await room.ctx.storage.get("state");
      expect(storedAfter.pendingResults).toHaveLength(0);
    });
  });

  it("a retry whose earlier write landed does not write the row twice", async () => {
    const a = makeConn("a");
    const b = makeConn("b");
    await withPrivateRoom([a, b], async (room) => {
      await join(room, a, "A");
      await join(room, b, "B");
      await room.handleStartRace(a);
      await runCountdown(room);

      const restore = breakD1(room);
      await raceToFinish(room, [a, b]);
      // The outbox as storage holds it before any insert has landed.
      const owed = structuredClone(room.state.pendingResults);
      expect(owed).toHaveLength(2);

      restore();
      await retryNow(room);
      const rows = await rowsForRoom(room);
      expect(rows).toHaveLength(2);

      // A crash between D1's reply and the settle being persisted wakes the
      // room to the queue as it was: the same entries, owed again. Their
      // retry finds the rows already written and stands down.
      room.state.pendingResults = owed;
      await retryNow(room);
      expect(room.state.pendingResults).toHaveLength(0);
      const after = await rowsForRoom(room);
      expect(after).toHaveLength(2);
      expect(after.map((r) => r.id).sort()).toEqual(rows.map((r) => r.id).sort());
    });
  });

  it("an idle racer's identical DNFs from two races both land", async () => {
    const a = makeConn("a");
    const b = makeConn("b");
    const firstRaceAt = Date.now() + DAY_MS;
    setClock(firstRaceAt);
    await withPrivateRoom([a, b], async (room) => {
      await join(room, a, "A");
      await join(room, b, "B");

      // Each race: A finishes, B never answers, and the grace A's finish
      // armed ends the race with B on 0 of 0 both times.
      async function raceWithIdleB() {
        await room.handleStartRace(a);
        await runCountdown(room);
        await raceToFinish(room, [a]);
        room.state.graceDeadline = Date.now() - 1;
        await room.onAlarm();
        expect(room.state.state).toBe("finished");
      }

      await raceWithIdleB();
      await room.handleRematch(a);
      vi.setSystemTime(firstRaceAt + 5 * 60 * 1000);
      await raceWithIdleB();

      const rows = await rowsForRoom(room);
      const bRows = rows.filter((r) => r.device_id === "dev-B");
      expect(bRows).toHaveLength(2);
      expect(bRows.every((r) => r.finished === 0 && r.problems_attempted === 0)).toBe(true);
      expect(new Set(bRows.map((r) => r.played_at)).size).toBe(2);
      expect(rows.filter((r) => r.device_id === "dev-A")).toHaveLength(2);
    });
  });

  it("a row retried after UTC midnight keeps its race's date", async () => {
    const a = makeConn("a");
    const b = makeConn("b");
    // The first UTC midnight after the real clock, so nothing armed fires.
    const midnight = periodStartMs("day", Date.now()) + DAY_MS;
    const raceAt = midnight - 60 * 1000;
    setClock(raceAt);
    await withPrivateRoom([a, b], async (room) => {
      await join(room, a, "A");
      await join(room, b, "B");
      await room.handleStartRace(a);
      await runCountdown(room);

      // The race ends a minute before midnight, with D1 down until after it.
      const restore = breakD1(room);
      await raceToFinish(room, [a, b]);
      expect(room.state.pendingResults).toHaveLength(2);

      vi.setSystemTime(midnight + 2 * 60 * 1000);
      restore();
      await retryNow(room);
      expect(room.state.pendingResults).toHaveLength(0);

      // Written after midnight, dated before it: the rows stay on the day's
      // board they were raced on, not the next one.
      const rows = await rowsForRoom(room);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.played_at).toBe(raceAt);
        expect(row.played_at).toBeLessThan(periodStartMs("day", Date.now()));
      }
    });
  });

  it("a captcha-held row survives an outage at settle, override intact", async () => {
    const a = makeConn("a");
    const b = makeConn("b");
    await withPrivateRoom([a, b], async (room) => {
      const aId = await join(room, a, "A");
      await join(room, b, "B");
      await room.handleStartRace(a);
      await runCountdown(room);
      // No backdating: a single-digit-ms finish trips the superhuman trigger.
      room.state.raceStartedAt = Date.now();
      for (let i = 0; i < room.state.raceLength; i++) await answerCorrectly(room, a);
      const player = playerOf(room, aId);
      expect(player.resultHeld).toBe(true);

      // Let the grace deadline end the race with B still idle. B's DNF row
      // writes normally; the held seat's row is not written at race end.
      room.state.graceDeadline = Date.now() - 1;
      await room.onAlarm();
      expect(room.state.state).toBe("finished");
      expect(await rowsForRoom(room)).toHaveLength(1);

      // The challenge times out while D1 is down: the suspect row is owed,
      // not lost.
      const restore = breakD1(room);
      await room.resolveCaptchaChallenge(player.id, "timeout");
      expect(room.state.pendingResults).toHaveLength(1);
      expect(await rowsForRoom(room)).toHaveLength(1);

      restore();
      await retryNow(room);
      expect(room.state.pendingResults).toHaveLength(0);
      const rows = await rowsForRoom(room);
      expect(rows).toHaveLength(2);
      const held = rows.find((r) => r.device_id === "dev-A");
      expect(held.finished).toBe(1);
      expect(held.suspect).toBe(1);
      expect(held.suspect_reason).toBe("captcha_timeout");
    });
  });

  it("the 24h ceiling does not delete rows still owed to D1", async () => {
    const a = makeConn("a");
    const b = makeConn("b");
    await withPrivateRoom([a, b], async (room) => {
      await join(room, a, "A");
      await join(room, b, "B");
      await room.handleStartRace(a);
      await runCountdown(room);

      const restore = breakD1(room);
      await raceToFinish(room, [a, b]);
      expect(room.state.pendingResults).toHaveLength(2);

      // An empty room past its 24h ceiling, woken while D1 is still down and
      // before the owed rows' retry is due.
      room.state.players = [];
      room.state.createdAt = 0;
      await room.onAlarm();
      expect(room.state.pendingResults).toHaveLength(2);
      expect((await room.ctx.storage.get("state")).pendingResults).toHaveLength(2);

      restore();
      await retryNow(room);
      expect(room.state.pendingResults).toHaveLength(0);
      expect(await rowsForRoom(room)).toHaveLength(2);
    });
  });

  it("an undeliverable row is retired once the retry window closes", async () => {
    const a = makeConn("a");
    const b = makeConn("b");
    await withPrivateRoom([a, b], async (room) => {
      await join(room, a, "A");
      await join(room, b, "B");
      await room.handleStartRace(a);
      await runCountdown(room);

      const restore = breakD1(room);
      await raceToFinish(room, [a, b]);
      expect(room.state.pendingResults).toHaveLength(2);

      // The window closes with D1 still down: the entries are dropped rather
      // than retried forever, and the room stops waking for them.
      for (const e of room.state.pendingResults) {
        e.raceAt = Date.now() - RESULT_OUTBOX_TTL_MS - 1;
      }
      await retryNow(room);
      expect(room.state.pendingResults).toHaveLength(0);
      expect(await room.ctx.storage.getAlarm()).not.toBeNull(); // idle winddown still armed
      restore();
      expect(await rowsForRoom(room)).toHaveLength(0);
    });
  });
});

describe("public quickmatch — durable outbox", () => {
  it("finish broadcasts through an outage and the rows land on retry", async () => {
    const a = makeConn("a");
    const b = makeConn("b");
    await withPublicRoom([a, b], async (room, { settled }) => {
      await join(room, a, "A", { difficulty: "medium" });
      await join(room, b, "B", { difficulty: "medium" });
      room.state.autoStartDeadline = Date.now() - 1;
      await room.onAlarm();
      await runCountdown(room);

      const restore = breakD1(room);
      await raceToFinish(room, [a, b]);
      await settled();
      expect(room.state.state).toBe("finished");
      // The outage did not block the podium.
      expect(a.lastOf("finish")).toBeTruthy();

      expect(await rowsForRoom(room)).toHaveLength(0);
      // Two humans; the four bots never write rows.
      expect(room.state.pendingResults).toHaveLength(2);
      const stored = await room.ctx.storage.get("state");
      expect(stored.pendingResults).toHaveLength(2);

      restore();
      await retryNow(room);
      expect(room.state.pendingResults).toHaveLength(0);
      const rows = await rowsForRoom(room);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.finished === 1)).toBe(true);
    });
  });

  it("rows still being written never arm the alarm for now", async () => {
    const a = makeConn("a");
    const b = makeConn("b");
    await withPublicRoom([a, b], async (room, { settled }) => {
      await join(room, a, "A", { difficulty: "medium" });
      await join(room, b, "B", { difficulty: "medium" });
      room.state.autoStartDeadline = Date.now() - 1;
      await room.onAlarm();
      await runCountdown(room);

      // D1 is slow: the race end's inserts start and hang. finishRace settles
      // off the broadcast path, so the final answer returns while they are in
      // flight — and reschedules the alarm on its way out.
      const d1 = holdD1(room);
      await raceToFinish(room, [a, b]);
      expect(room.state.state).toBe("finished");
      expect(d1.calls()).toBe(1);
      expect(room.state.pendingResults).toHaveLength(2);
      expect(await room.ctx.storage.getAlarm()).toBeGreaterThan(Date.now());

      // An alarm that fires mid-write neither starts a second write of the
      // rows in flight nor re-arms itself for now.
      await room.onAlarm();
      expect(d1.calls()).toBe(1);
      expect(await room.ctx.storage.getAlarm()).toBeGreaterThan(Date.now());

      d1.release();
      await settled();
      expect(room.state.pendingResults).toHaveLength(0);
      expect(await rowsForRoom(room)).toHaveLength(2);
    });
  });

  it("idle cleanup carries owed rows instead of deleting them with the room", async () => {
    const a = makeConn("a");
    const b = makeConn("b");
    await withPublicRoom([a, b], async (room, { settled }) => {
      await join(room, a, "A", { difficulty: "medium" });
      await join(room, b, "B", { difficulty: "medium" });
      room.state.autoStartDeadline = Date.now() - 1;
      await room.onAlarm();
      await runCountdown(room);

      const restore = breakD1(room);
      await raceToFinish(room, [a, b]);
      await settled();
      expect(await rowsForRoom(room)).toHaveLength(0);

      // Everyone leaves; the cleanup alarm fires while D1 is still down.
      const aPid = room.playerFor(a).id;
      const bPid = room.playerFor(b).id;
      await room.removePlayer(aPid);
      await room.removePlayer(bPid);
      expect(room.state.players).toHaveLength(0);
      expect(room.state.idleCleanupAt).toBeGreaterThan(Date.now());

      room.state.idleCleanupAt = Date.now() - 1;
      await room.onAlarm();
      // Storage was NOT deleted: the stub state keeps the owed rows, with a
      // fresh cleanup deadline past the retry window.
      const stored = await room.ctx.storage.get("state");
      expect(stored).toBeTruthy();
      expect(stored.pendingResults).toHaveLength(2);
      expect(stored.idleCleanupAt).toBeGreaterThan(Date.now());

      // D1 recovers; the retry lands both rows even though the room is gone.
      restore();
      await retryNow(room);
      expect(await rowsForRoom(room)).toHaveLength(2);

      // And once nothing is owed, the next cleanup reclaims the room.
      room.state.idleCleanupAt = Date.now() - 1;
      await room.onAlarm();
      expect(await room.ctx.storage.get("state")).toBeUndefined();
    });
  });
});

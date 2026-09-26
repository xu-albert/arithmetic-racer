// Reconnect catch-up batches (Design C), end to end against the real room DO:
// positional grading, exactly-once delivery by batch id, the caps, the
// coalesced broadcast, the targeted ack, and the anti-cheat trigger on a
// catch-up finish.
//
// Harness mirrors server/room-captcha.test.js: fake connections, handlers
// called directly, real D1 via cloudflare:test.

import { describe, it, expect, beforeEach } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";

import { CATCHUP_MAX_ENTRIES_PER_PROBLEM } from "./room.js";

function makeConn(label) {
  return {
    label,
    id: "sock-" + crypto.randomUUID(),
    sent: [],
    state: undefined,
    send(s) { this.sent.push(JSON.parse(s)); },
    setState(s) { this.state = s; },
    lastOf(type) { return [...this.sent].reverse().find((m) => m.type === type) ?? null; },
    allOf(type) { return this.sent.filter((m) => m.type === type); },
  };
}

/**
 * What `getConnections()` actually hands back under `hibernate: true`: a plain
 * iterator with no array helpers (see server/room-captcha.test.js).
 */
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
  const stub = env.RaceRoom.get(env.RaceRoom.idFromName("cu-" + crypto.randomUUID()));
  return runInDurableObject(stub, async (room) => {
    if (!room.state) await room.onStart();
    room.getConnections = () => connectionIterator(conns);
    room.broadcast = (s) => { for (const c of conns) c.send(s); };
    return fn(room);
  });
}

async function join(room, conn, handle, deviceId = crypto.randomUUID()) {
  const playerId = crypto.randomUUID();
  await room.handleHello(conn, { type: "hello", playerId, handle, deviceId });
  return playerId;
}

async function runCountdown(room) {
  for (let i = 0; i < 8 && room.state.state === "countdown"; i++) {
    room.state.countdownAt = Date.now() - 1;
    await room.onAlarm();
  }
}

async function startRace(room, starter, raceLength = null) {
  if (raceLength != null) {
    await room.handleSetConfig(starter, {
      type: "set-config", difficulty: room.state.difficulty, raceLength,
    });
  }
  await room.handleStartRace(starter);
  await runCountdown(room);
  expect(room.state.state).toBe("racing");
}

/** The batch a client that answered every problem correctly would hold. */
function correctBatch(room, from = 0, to = room.state.raceLength) {
  const entries = [];
  for (let i = from; i < to; i++) {
    entries.push({ index: i, value: String(room.state.problemSequence[i].answer) });
  }
  return entries;
}

let lastBatchId = 0;

function catchUp(room, conn, entries, batchId = ++lastBatchId) {
  return room.handleCatchUp(conn, {
    type: "catch-up", batchId, raceStartedAt: room.state.raceStartedAt, entries,
  });
}

async function answerCorrectly(room, conn) {
  const player = room.playerFor(conn);
  const problem = room.state.problemSequence[player.score];
  await room.handleAnswer(conn, { type: "answer", value: String(problem.answer) });
}

async function rowsForRoom(room) {
  const res = await env.DB.prepare(
    "SELECT * FROM race_results WHERE room_id = ? ORDER BY device_id"
  ).bind(room.state.id).all();
  return res.results;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM race_results");
});

describe("catch-up grading", () => {
  it("grades a whole batch in order, with one coalesced advance broadcast", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await join(room, host, "Host");
      await join(room, guest, "Guest");
      await startRace(room, host);
      host.sent.length = 0;
      guest.sent.length = 0;

      await catchUp(room, guest, correctBatch(room, 0, 4));

      const player = room.playerFor(guest);
      expect(player.score).toBe(4);
      expect(player.attempts).toBe(4);
      expect(player.currentStreak).toBe(4);
      expect(player.finishMs).toBeNull();

      // One advance for the whole batch, carrying the final position.
      const advances = host.allOf("advance").filter((m) => m.playerId === player.id);
      expect(advances).toHaveLength(1);
      expect(advances[0]).toMatchObject({ score: 4, finishMs: null });

      const ack = guest.lastOf("catch-up-ack");
      expect(ack).toMatchObject({ applied: 4, skipped: 0, gaps: [], rejected: null, finalScore: 4 });
    });
  });

  it("a long offline queue beyond the old 20-per-second budget fully grades as one message", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await join(room, host, "Host");
      await join(room, guest, "Guest");
      await startRace(room, host, 50);
      const entries = correctBatch(room); // 50 answers — far past the 19 that survived a burst

      // Through onMessage, so the socket limiter is exercised: the batch is
      // one tick, however many entries it carries.
      await room.onMessage(guest, JSON.stringify({
        type: "catch-up", batchId: 1, raceStartedAt: room.state.raceStartedAt, entries,
      }));

      const player = room.playerFor(guest);
      expect(player.score).toBe(50);
      expect(player.finishMs).not.toBeNull();
      expect(guest.lastOf("catch-up-ack")).toMatchObject({ applied: 50, finalScore: 50 });
    });
  });

  it("a replayed batch after a second reconnect is a no-op", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    const conns = [host, guest];
    await withRoom(conns, async (room) => {
      await join(room, host, "Host");
      const guestRacerId = await join(room, guest, "Guest");
      await startRace(room, host);
      const entries = correctBatch(room, 0, 5);

      await catchUp(room, guest, entries, 1);
      const afterFirst = room.playerFor(guest);
      expect(afterFirst.score).toBe(5);
      expect(afterFirst.attempts).toBe(5);

      // The socket died mid-drain and the client re-helloed on a fresh one,
      // resending the batch it never saw acked.
      const guest2 = makeConn("guest-2");
      conns.push(guest2);
      await room.handleHello(guest2, { type: "hello", playerId: guestRacerId, handle: "Guest" });
      await catchUp(room, guest2, entries, 1);

      const player = room.playerFor(guest2);
      expect(player.score).toBe(5);
      expect(player.attempts).toBe(5);
      expect(guest2.lastOf("catch-up-ack")).toMatchObject({
        applied: 0, skipped: 5, finalScore: 5,
      });
    });
  });

  it("a resent batch ending in a wrong answer at the seat's position grades nothing", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    const conns = [host, guest];
    await withRoom(conns, async (room) => {
      await join(room, host, "Host");
      const guestRacerId = await join(room, guest, "Guest");
      await startRace(room, host);
      const seq = room.state.problemSequence;
      const wrongAtOne = { index: 1, value: String(seq[1].answer + 1) };
      const entries = [{ index: 0, value: String(seq[0].answer) }, wrongAtOne];
      const stats = (p) => ({
        score: p.score, attempts: p.attempts, currentStreak: p.currentStreak, longestStreak: p.longestStreak,
      });

      await catchUp(room, guest, entries, 7);
      const graded = { score: 1, attempts: 2, currentStreak: 0, longestStreak: 1 };
      expect(stats(room.playerFor(guest))).toEqual(graded);

      // The ack died with the socket, and the DO was evicted before the
      // resend: the replay is judged against what storage holds.
      room.state = await room.ctx.storage.get("state");
      const guest2 = makeConn("guest-2");
      conns.push(guest2);
      await room.handleHello(guest2, { type: "hello", playerId: guestRacerId, handle: "Guest" });
      await catchUp(room, guest2, entries, 7);

      expect(stats(room.playerFor(guest2))).toEqual(graded);
      expect(guest2.lastOf("catch-up-ack")).toMatchObject({ applied: 0, skipped: 2, finalScore: 1 });
      for (const p of guest2.lastOf("state").state.players) expect(p).not.toHaveProperty("catchUpBatchId");

      // A new batch carrying the same retry is a fresh attempt, and grades.
      await catchUp(room, guest2, [wrongAtOne], 8);
      expect(stats(room.playerFor(guest2))).toEqual({ ...graded, attempts: 3 });
    });
  });

  it("a gap is skipped and reported, and play resumes from the server's position", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await join(room, host, "Host");
      await join(room, guest, "Guest");
      await startRace(room, host);
      await answerCorrectly(room, guest);
      await answerCorrectly(room, guest);

      const seq = room.state.problemSequence;
      await catchUp(room, guest, [
        { index: 0, value: String(seq[0].answer) }, // already graded
        { index: 5, value: String(seq[5].answer) }, // gap
      ]);

      const player = room.playerFor(guest);
      expect(player.score).toBe(2);
      expect(player.attempts).toBe(2);
      expect(guest.lastOf("catch-up-ack")).toMatchObject({
        applied: 0, skipped: 2, gaps: [5], finalScore: 2,
      });

      // The next live answer grades against problem 2, not the gap's.
      await answerCorrectly(room, guest);
      expect(room.playerFor(guest).score).toBe(3);
    });
  });

  it("wrong-answer retries at one index cost attempts exactly as live play does", async () => {
    const host = makeConn("host");
    const live = makeConn("live");
    const offline = makeConn("offline");
    await withRoom([host, live, offline], async (room) => {
      await join(room, host, "Host");
      await join(room, live, "Live");
      await join(room, offline, "Offline");
      await startRace(room, host);

      const seq = room.state.problemSequence;
      // Live: wrong at 0, then correct at 0, 1, 2.
      await room.handleAnswer(live, { type: "answer", value: String(seq[0].answer + 1) });
      for (let i = 0; i < 3; i++) await answerCorrectly(room, live);

      // Offline: the same four submissions as one batch.
      await catchUp(room, offline, [
        { index: 0, value: String(seq[0].answer + 1) },
        { index: 0, value: String(seq[0].answer) },
        { index: 1, value: String(seq[1].answer) },
        { index: 2, value: String(seq[2].answer) },
      ]);

      const a = room.playerFor(live);
      const b = room.playerFor(offline);
      expect({ score: b.score, attempts: b.attempts, longestStreak: b.longestStreak, currentStreak: b.currentStreak })
        .toEqual({ score: a.score, attempts: a.attempts, longestStreak: a.longestStreak, currentStreak: a.currentStreak });
      expect(b.attempts).toBe(4);
      expect(b.score).toBe(3);
    });
  });

  it("a batch that finishes the race ends it like a live finish does", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await join(room, host, "Host");
      await join(room, guest, "Guest");
      await startRace(room, host);
      for (let i = 0; i < room.state.raceLength; i++) await answerCorrectly(room, host);
      expect(room.state.state).toBe("racing"); // host waits on the straggler

      room.state.raceStartedAt = Date.now() - 30000;
      await catchUp(room, guest, correctBatch(room));

      expect(room.state.state).toBe("finished");
      const player = room.playerFor(guest);
      expect(player.finishMs).not.toBeNull();
      expect(guest.lastOf("catch-up-ack")).toMatchObject({ finalScore: room.state.raceLength });
      expect(guest.lastOf("finish")).toBeTruthy();
    });
  });
});

describe("catch-up caps and stale batches", () => {
  it("rejects an oversize batch without grading any of it", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await join(room, host, "Host");
      await join(room, guest, "Guest");
      await startRace(room, host);
      const cap = CATCHUP_MAX_ENTRIES_PER_PROBLEM * room.state.raceLength;
      const entries = Array.from({ length: cap + 1 }, (_, i) => ({ index: i, value: "1" }));

      await catchUp(room, guest, entries);

      const player = room.playerFor(guest);
      expect(player.score).toBe(0);
      expect(player.attempts).toBe(0);
      expect(guest.lastOf("catch-up-ack")).toMatchObject({ rejected: "oversize", finalScore: 0 });
      expect(host.allOf("advance")).toHaveLength(0);
    });
  });

  it("rejects a batch without a batch id without grading any of it", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await join(room, host, "Host");
      await join(room, guest, "Guest");
      await startRace(room, host);

      await room.handleCatchUp(guest, {
        type: "catch-up", raceStartedAt: room.state.raceStartedAt, entries: correctBatch(room, 0, 2),
      });

      expect(room.playerFor(guest)).toMatchObject({ score: 0, attempts: 0 });
      expect(guest.lastOf("catch-up-ack")?.rejected).toBeTruthy();
    });
  });

  it("accepts a batch exactly at the cap", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await join(room, host, "Host");
      await join(room, guest, "Guest");
      await startRace(room, host);
      const cap = CATCHUP_MAX_ENTRIES_PER_PROBLEM * room.state.raceLength;
      const entries = Array.from({ length: cap }, () => ({ index: 0, value: "nope" }));

      await catchUp(room, guest, entries);

      expect(guest.lastOf("catch-up-ack")?.rejected).toBeNull();
      expect(room.playerFor(guest).attempts).toBe(cap);
    });
  });

  it("no-ops a batch from a race that ended while the socket was down", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await join(room, host, "Host");
      await join(room, guest, "Guest");
      await startRace(room, host);
      room.state.raceStartedAt = Date.now() - 30000;
      for (const conn of [host, guest]) {
        for (let i = 0; i < room.state.raceLength; i++) await answerCorrectly(room, conn);
      }
      expect(room.state.state).toBe("finished");
      const attemptsBefore = room.playerFor(guest).attempts;

      await catchUp(room, guest, [{ index: 0, value: "1" }]);

      expect(room.playerFor(guest).attempts).toBe(attemptsBefore);
      expect(guest.lastOf("catch-up-ack")).toMatchObject({ applied: 0, skipped: 1 });
    });
  });

  it("no-ops a batch against a rematch's new race (raceStartedAt epoch check)", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await join(room, host, "Host");
      await join(room, guest, "Guest");
      await startRace(room, host);
      const oldStartedAt = room.state.raceStartedAt;
      room.state.raceStartedAt = Date.now() - 30000;
      for (const conn of [host, guest]) {
        for (let i = 0; i < room.state.raceLength; i++) await answerCorrectly(room, conn);
      }
      await room.handleRematch(host);
      await room.handleStartRace(host);
      await runCountdown(room);
      expect(room.state.state).toBe("racing");

      // The batch from race one must not grade against race two's sequence.
      await room.handleCatchUp(guest, {
        type: "catch-up",
        batchId: 1,
        raceStartedAt: oldStartedAt,
        entries: [{ index: 0, value: String(room.state.problemSequence[0].answer) }],
      });

      expect(room.playerFor(guest).score).toBe(0);
      expect(guest.lastOf("catch-up-ack")).toMatchObject({ applied: 0, skipped: 1, finalScore: 0 });
    });
  });

  it("no-ops a batch for a seat whose reconnect grace expired", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await join(room, host, "Host");
      const guestRacerId = await join(room, guest, "Guest");
      await startRace(room, host);

      // The grace expired mid-outage: the seat is dropped (kept for its DNF
      // row) and its late answers are ignored — same as today's late answers.
      const pid = room.playerFor(guest).id;
      await room.removePlayer(pid);
      expect(room.state.players.find((p) => p.id === pid).dropped).toBe(true);

      const guest2 = makeConn("guest-2");
      await room.handleHello(guest2, { type: "hello", playerId: guestRacerId, handle: "Guest" });
      await catchUp(room, guest2, correctBatch(room, 0, 3));

      const player = room.playerFor(guest2);
      expect(player.dropped).toBe(true);
      expect(player.score).toBe(0);
      expect(guest2.lastOf("catch-up-ack")).toMatchObject({ applied: 0, skipped: 3, finalScore: 0 });
    });
  });
});

describe("catch-up in a Quick Match", () => {
  it("a seat spliced during the outage still gets an ack, so the drain pause lifts", async () => {
    const alice = makeConn("alice");
    const bob = makeConn("bob");
    const conns = [alice, bob];
    const stub = env.PublicRaceRoom.get(env.PublicRaceRoom.idFromName("m-cu-" + crypto.randomUUID()));
    await runInDurableObject(stub, async (room) => {
      if (!room.state) await room.onStart();
      room.getConnections = () => connectionIterator(conns);
      room.broadcast = (s) => { for (const c of conns) c.send(s); };
      room.releaseLobby = async () => {};
      const aliceRacerId = await join(room, alice, "Alice");
      await join(room, bob, "Bob");
      room.state.state = "racing";
      room.state.raceStartedAt = Date.now() - 5000;
      const raceStartedAt = room.state.raceStartedAt;

      // Alice's reconnect grace ran out mid-race with Bob still racing: a
      // public room splices an unfinished seat rather than keeping it dropped.
      await room.removePlayer(room.playerFor(alice).id);
      expect(room.state.state).toBe("racing");

      // Her reconnect is refused a seat, and the batch still follows hello.
      const alice2 = makeConn("alice-2");
      conns.push(alice2);
      await room.handleHello(alice2, { type: "hello", playerId: aliceRacerId, handle: "Alice" });
      expect(alice2.lastOf("error")).toMatchObject({ code: "BAD_STATE" });
      await room.handleCatchUp(alice2, {
        type: "catch-up", batchId: 1, raceStartedAt, entries: [{ index: 0, value: "1" }],
      });

      expect(alice2.lastOf("catch-up-ack")).toMatchObject({
        applied: 0, rejected: "no-seat", finalScore: null, finishMs: null,
      });
      expect(bob.allOf("advance")).toHaveLength(0);
    });
  });
});

describe("catch-up and active verification", () => {
  it("a superhuman-paced catch-up finish still triggers the captcha challenge", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await join(room, host, "Host", "dev-host");
      await join(room, guest, "Guest", "dev-guest");
      await startRace(room, host);
      // ~350 ms/problem: above the 200 ms floor, inside the 500 ms trigger.
      room.state.raceStartedAt = Date.now() - 3500;

      await catchUp(room, guest, correctBatch(room));

      const player = room.playerFor(guest);
      expect(player.finishMs).not.toBeNull();
      expect(player.resultHeld).toBe(true);
      const challenge = room.state.captchaChallenges?.[player.id];
      expect(challenge).toBeTruthy();
      const msg = guest.lastOf("captcha");
      expect(msg).toBeTruthy();
      expect(msg.problems).toHaveLength(challenge.count);
      for (const p of msg.problems) expect(Object.keys(p)).toEqual(["problem"]);

      // The race ends at a human pace for the host; the held row is not
      // written by race end, and passing the challenge records it clean.
      room.state.raceStartedAt = Date.now() - 30000;
      for (let i = 0; i < room.state.raceLength; i++) await answerCorrectly(room, host);
      expect(room.state.state).toBe("finished");
      expect((await rowsForRoom(room)).filter((r) => r.device_id === "dev-guest")).toHaveLength(0);
    });
  });
});

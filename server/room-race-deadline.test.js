// The race deadline: every race ends, whether or not everyone answers.
//
// A race used to end only when isRaceComplete() said so — every non-dropped
// player finished (private) or every human did (quickmatch). A racer who stayed
// connected and simply stopped answering therefore held the race open forever:
// whoever had already crossed the line never received `finish`, their row was
// never written, and the room never emptied into its cleanup path. Quickmatch
// had nothing else to fall back on, since PublicRaceRoom.expiresWhenIdle() is
// false by design.
//
// Two bounds close that, both read through RaceRoom.raceDeadlineAt():
//   - the grace the FIRST finisher opens (raceGraceMs), which is the rule
//     docs/phase-6-private-rooms-plan.md specified;
//   - a ceiling on the race as a whole (RACE_MAX_MS_PER_PROBLEM), for the race
//     where nobody ever finishes and so nothing arms the grace.
//
// Either way finishRace() runs the ordinary ending: unfinished racers are dnf,
// `finish` is broadcast, every row is persisted, cleanup proceeds as usual.

import { describe, it, expect, beforeEach } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";

import {
  RACE_GRACE_MIN_MS,
  RACE_GRACE_MS_PER_PROBLEM,
  RACE_MAX_MS_PER_PROBLEM,
  raceGraceMs,
} from "./room.js";

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
 * Run against a real room DO with the WS plumbing redirected at `conns`.
 * PublicRaceRoom.persistResults is fire-and-forget (finishRace must not suspend
 * on D1), so every call is recorded for the test to await before reading rows.
 */
async function withRoom(binding, name, conns, fn) {
  const stub = binding.get(binding.idFromName(name));
  return runInDurableObject(stub, async (room) => {
    if (!room.state) await room.onStart();
    room.getConnections = () => connectionIterator(conns);
    room.broadcast = (s) => { for (const c of conns) c.send(s); };
    room.releaseLobby = async () => {};

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
  withRoom(env.RaceRoom, "dl-" + crypto.randomUUID(), conns, fn);
const withPublicRoom = (conns, fn) =>
  withRoom(env.PublicRaceRoom, "m-dl-" + crypto.randomUUID(), conns, fn);

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

/** Finish `conns`, at a human pace so no captcha challenge holds their rows. */
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

/** Force the pending race deadline into the past and let the alarm see it. */
async function expireRaceDeadline(room) {
  const deadline = room.raceDeadlineAt();
  expect(deadline).not.toBeNull();
  const slack = deadline - Date.now() + 1;
  room.state.graceDeadline = room.state.graceDeadline != null ? Date.now() - 1 : null;
  if (room.state.graceDeadline == null) room.state.raceStartedAt -= slack;
  await room.onAlarm();
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM race_results");
});

describe("private room — the post-first-finisher grace", () => {
  it("ends the race and dnfs a connected racer who stops answering", async () => {
    const host = makeConn("host");
    const idle = makeConn("idle");
    await withPrivateRoom([host, idle], async (room) => {
      await join(room, host, "Host");
      const idleId = await join(room, idle, "Idle");
      await room.handleStartRace(host);
      await runCountdown(room);

      await raceToFinish(room, [host]);

      // The idle racer has answered nothing, so the old rule would hold here
      // forever. Instead the finish put the race on a clock.
      expect(room.state.state).toBe("racing");
      expect(playerOf(room, idleId).score).toBe(0);
      expect(room.state.graceDeadline).toBeGreaterThan(Date.now());
      expect(room.raceDeadlineAt()).toBe(room.state.graceDeadline);

      // And the alarm is set to enforce it.
      await room.ctx.storage.deleteAlarm();
      await room.scheduleNextAlarm();
      expect(await room.ctx.storage.getAlarm()).toBe(room.state.graceDeadline);

      // Before the deadline, an alarm changes nothing.
      await room.onAlarm();
      expect(room.state.state).toBe("racing");
      expect(playerOf(room, idleId).dnf).toBe(false);

      // Past it, the race ends the ordinary way.
      await expireRaceDeadline(room);
      expect(room.state.state).toBe("finished");

      const idlePlayer = playerOf(room, idleId);
      expect(idlePlayer.dnf).toBe(true);
      expect(idlePlayer.dropped).toBe(false);
      expect(idlePlayer.finishMs).toBeNull();

      // Everyone got the podium, including the racer who finished and waited.
      const finish = host.lastOf("finish");
      expect(finish).toBeTruthy();
      expect(finish.rankings.map((r) => r.handle)).toEqual(["Host", "Idle"]);
      expect(idle.lastOf("finish")).toBeTruthy();

      // And both rows landed: the finisher's is a finish, the idle racer's is not.
      const rows = await rowsForRoom(room);
      expect(rows).toHaveLength(2);
      const byDevice = Object.fromEntries(rows.map((r) => [r.device_id, r]));
      expect(byDevice["dev-Host"].finished).toBe(1);
      expect(byDevice["dev-Host"].finish_time_ms).toBeGreaterThan(0);
      expect(byDevice["dev-Idle"].finished).toBe(0);
      expect(byDevice["dev-Idle"].finish_time_ms).toBeNull();
      expect(byDevice["dev-Idle"].problems_correct).toBe(0);
    });
  });

  it("a racer who finishes inside the grace counts normally", async () => {
    const host = makeConn("host");
    const slow = makeConn("slow");
    await withPrivateRoom([host, slow], async (room) => {
      await join(room, host, "Host");
      const slowId = await join(room, slow, "Slow");
      await room.handleStartRace(host);
      await runCountdown(room);

      await raceToFinish(room, [host]);
      expect(room.state.state).toBe("racing");

      // An alarm while the window is still open must not pre-empt them.
      await room.onAlarm();
      expect(room.state.state).toBe("racing");

      await raceToFinish(room, [slow], 20000);

      expect(room.state.state).toBe("finished");
      const slowPlayer = playerOf(room, slowId);
      expect(slowPlayer.dnf).toBe(false);
      expect(slowPlayer.finishMs).toBeGreaterThan(0);
      expect(slowPlayer.score).toBe(room.state.raceLength);

      const rows = await rowsForRoom(room);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.finished === 1)).toBe(true);
    });
  });

  it("the first finisher owns the window; a later finish does not push it out", async () => {
    const a = makeConn("a");
    const b = makeConn("b");
    const c = makeConn("c");
    await withPrivateRoom([a, b, c], async (room) => {
      await join(room, a, "A");
      await join(room, b, "B");
      const cId = await join(room, c, "C");
      await room.handleStartRace(a);
      await runCountdown(room);

      await raceToFinish(room, [a]);
      const armed = room.state.graceDeadline;
      expect(armed).toBeGreaterThan(Date.now());

      await raceToFinish(room, [b], 9000);
      expect(room.state.graceDeadline).toBe(armed);
      expect(playerOf(room, cId).dnf).toBe(false);

      await expireRaceDeadline(room);
      expect(room.state.state).toBe("finished");
      expect(playerOf(room, cId).dnf).toBe(true);
      expect(await rowsForRoom(room)).toHaveLength(3);
    });
  });

  it("scales the window with the race and floors it for the shortest rooms", () => {
    expect(raceGraceMs(10)).toBe(RACE_GRACE_MS_PER_PROBLEM * 10);
    expect(raceGraceMs(50)).toBe(RACE_GRACE_MS_PER_PROBLEM * 50);
    // 5 problems × 6s is under the floor.
    expect(raceGraceMs(5)).toBe(RACE_GRACE_MIN_MS);
  });
});

describe("private room — the ceiling on a race nobody finishes", () => {
  it("ends a race where every racer is idle from the start", async () => {
    const a = makeConn("a");
    const b = makeConn("b");
    await withPrivateRoom([a, b], async (room) => {
      const aId = await join(room, a, "A");
      const bId = await join(room, b, "B");
      await room.handleStartRace(a);
      await runCountdown(room);

      // Nothing has finished, so nothing armed the grace — the ceiling is the
      // only bound, and it is the one on the alarm.
      expect(room.state.graceDeadline).toBeNull();
      const ceiling = room.state.raceStartedAt + RACE_MAX_MS_PER_PROBLEM * room.state.raceLength;
      expect(room.raceDeadlineAt()).toBe(ceiling);
      await room.ctx.storage.deleteAlarm();
      await room.scheduleNextAlarm();
      expect(await room.ctx.storage.getAlarm()).toBe(ceiling);

      await room.onAlarm();
      expect(room.state.state).toBe("racing");

      await expireRaceDeadline(room);
      expect(room.state.state).toBe("finished");
      expect(playerOf(room, aId).dnf).toBe(true);
      expect(playerOf(room, bId).dnf).toBe(true);

      const rows = await rowsForRoom(room);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.finished === 0)).toBe(true);
    });
  });
});

describe("race deadlines do not outlive their race", () => {
  it("stops driving the alarm once the race is finished, and a rematch clears it", async () => {
    const host = makeConn("host");
    const idle = makeConn("idle");
    await withPrivateRoom([host, idle], async (room) => {
      await join(room, host, "Host");
      await join(room, idle, "Idle");
      await room.handleStartRace(host);
      await runCountdown(room);
      await raceToFinish(room, [host]);
      await expireRaceDeadline(room);
      expect(room.state.state).toBe("finished");

      // No race timer survives the race: only the idle winddown is left to
      // wake this room for.
      expect(room.state.graceDeadline).toBeNull();
      expect(room.raceDeadlineAt()).toBeNull();
      await room.ctx.storage.deleteAlarm();
      await room.scheduleNextAlarm();
      expect(await room.ctx.storage.getAlarm()).toBe(room.idleExpiryAt());

      // A rematch starts the next race with no deadline inherited.
      await room.handleRematch(host);
      expect(room.state.state).toBe("lobby");
      expect(room.state.graceDeadline).toBeNull();
      expect(room.raceDeadlineAt()).toBeNull();
    });
  });

  it("an expired room keeps no alarm at all", async () => {
    const host = makeConn("host");
    const idle = makeConn("idle");
    await withPrivateRoom([host, idle], async (room) => {
      await join(room, host, "Host");
      await join(room, idle, "Idle");
      await room.handleStartRace(host);
      await runCountdown(room);
      await raceToFinish(room, [host]);
      expect(room.raceDeadlineAt()).not.toBeNull();

      await room.expireRoom();
      expect(room.raceDeadlineAt()).toBeNull();
      await room.scheduleNextAlarm();
      expect(await room.ctx.storage.getAlarm()).toBeNull();
    });
  });
});

describe("public quickmatch — the same deadline, bots unaffected", () => {
  it("ends the race, dnfs the idle human, and persists the finisher's row", async () => {
    const a = makeConn("a");
    const b = makeConn("b");
    await withPublicRoom([a, b], async (room, { settled }) => {
      const aId = await join(room, a, "A", { difficulty: "medium" });
      const bId = await join(room, b, "B", { difficulty: "medium" });

      // Force the auto-start, then run the countdown into the race.
      room.state.autoStartDeadline = Date.now() - 1;
      await room.onAlarm();
      await runCountdown(room);
      expect(room.state.botTimelines.length).toBeGreaterThan(0);
      const botCount = room.state.players.filter((p) => p.isBot).length;
      expect(botCount).toBeGreaterThan(0);

      await raceToFinish(room, [a]);

      // Bots never arm or hold the race: the clock came from A's finish, and
      // it is running even though the bots are mid-timeline.
      expect(room.state.state).toBe("racing");
      expect(room.state.graceDeadline).toBeGreaterThan(Date.now());
      expect(room.raceDeadlineAt()).toBe(room.state.graceDeadline);
      await room.ctx.storage.deleteAlarm();
      await room.scheduleNextAlarm();
      expect(await room.ctx.storage.getAlarm()).toBe(room.state.graceDeadline);

      await room.onAlarm();
      expect(room.state.state).toBe("racing");

      await expireRaceDeadline(room);
      expect(room.state.state).toBe("finished");

      expect(playerOf(room, bId).dnf).toBe(true);
      expect(playerOf(room, aId).finishMs).toBeGreaterThan(0);
      // Bots are scored from their timelines and stripped, exactly as on every
      // other finish path.
      expect(room.state.players.some((p) => p.isBot)).toBe(false);

      await settled();
      const rows = await rowsForRoom(room);
      expect(rows).toHaveLength(2);
      const byDevice = Object.fromEntries(rows.map((r) => [r.device_id, r]));
      expect(byDevice["dev-A"].finished).toBe(1);
      expect(byDevice["dev-B"].finished).toBe(0);
    });
  });

  it("ends a quickmatch race nobody finishes, which has no idle winddown to fall back on", async () => {
    const a = makeConn("a");
    const b = makeConn("b");
    await withPublicRoom([a, b], async (room, { settled }) => {
      await join(room, a, "A", { difficulty: "medium" });
      await join(room, b, "B", { difficulty: "medium" });
      room.state.autoStartDeadline = Date.now() - 1;
      await room.onAlarm();
      await runCountdown(room);

      expect(room.expiresWhenIdle()).toBe(false);
      expect(room.idleExpiryAt()).toBeNull();
      expect(room.state.graceDeadline).toBeNull();
      expect(room.raceDeadlineAt()).toBe(
        room.state.raceStartedAt + RACE_MAX_MS_PER_PROBLEM * room.state.raceLength
      );

      await expireRaceDeadline(room);
      expect(room.state.state).toBe("finished");
      await settled();
      const rows = await rowsForRoom(room);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.finished === 0)).toBe(true);
    });
  });
});

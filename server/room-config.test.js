// Regression coverage for: "you can't change the difficulty settings in a
// private room, which forced me to create a new room."
//
// The reproduction is the test. Two players join a private room, race to the
// finish, and then the host changes difficulty — the exact sequence the owner
// hit. Before the fix, `set-config` was rejected with BAD_STATE in every phase
// but 'lobby', so the room's difficulty was effectively frozen after the first
// race and the host's only escape was to abandon the room.

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

/**
 * Fresh RaceRoom DO with WS plumbing wired to a list of fake connections, so
 * assertions can check what each player actually received. `broadcastState`
 * is left as the real implementation — it reads `getConnections()`.
 */
async function withRoom(conns, fn) {
  const stub = env.RaceRoom.get(env.RaceRoom.idFromName("cfg-" + crypto.randomUUID()));
  return runInDurableObject(stub, async (room) => {
    if (!room.state) await room.onStart();
    room.getConnections = () => conns;
    room.broadcast = (s) => { for (const c of conns) c.send(s); };
    return fn(room);
  });
}

async function join(room, conn, handle, deviceId = crypto.randomUUID()) {
  const playerId = crypto.randomUUID();
  await room.handleHello(conn, {
    type: "hello", playerId, handle, deviceId,
  });
  return playerId;
}

/** Drive the real countdown alarms without waiting a real 3 seconds. */
async function runCountdown(room) {
  for (let i = 0; i < 8 && room.state.state === "countdown"; i++) {
    room.state.countdownAt = Date.now() - 1;
    await room.onAlarm();
  }
}

/** One correct answer from `conn`. Returns the handler's pending promise. */
function answerOnce(room, conn) {
  const player = room.playerFor(conn);
  const problem = room.state.problemSequence[player.score];
  return room.handleAnswer(conn, { type: "answer", value: String(problem.answer) });
}

/**
 * Race everyone to the finish except `last`, who is left one answer short —
 * so the race ends exactly when the caller decides to send it.
 */
async function raceToBrink(room, conns, last) {
  const len = room.state.raceLength;
  for (const conn of conns) {
    const target = conn === last ? len - 1 : len;
    while (room.playerFor(conn).score < target) await answerOnce(room, conn);
  }
}

/** Answer every problem correctly for each connection, in lockstep. */
async function raceToFinish(room, conns) {
  const len = room.state.raceLength;
  for (let i = 0; i < len; i++) {
    for (const conn of conns) {
      const player = room.playerFor(conn);
      const problem = room.state.problemSequence[player.score];
      await room.handleAnswer(conn, { type: "answer", value: String(problem.answer) });
    }
  }
}

/** Two players, one full race, room left in 'finished'. */
async function playOneRace(room, host, guest) {
  await join(room, host, "HostGuy");
  await join(room, guest, "FriendBob");
  await room.handleSetConfig(host, { type: "set-config", difficulty: "hard", raceLength: 5 });
  await room.handleStartRace(host);
  await runCountdown(room);
  expect(room.state.state).toBe("racing");
  await raceToFinish(room, [host, guest]);
  expect(room.state.state).toBe("finished");
}

describe("private room — changing difficulty after a race (the reported bug)", () => {
  it("host can change difficulty once the race is finished", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await playOneRace(room, host, guest);
      host.sent.length = 0;
      guest.sent.length = 0;

      await room.handleSetConfig(host, { type: "set-config", difficulty: "easy", raceLength: 5 });

      expect(host.errors()).toEqual([]);
      expect(room.state.difficulty).toBe("easy");
    });
  });

  it("every player in the room sees the change, not just the host", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await playOneRace(room, host, guest);
      host.sent.length = 0;
      guest.sent.length = 0;

      await room.handleSetConfig(host, { type: "set-config", difficulty: "easy", raceLength: 8 });

      for (const conn of [host, guest]) {
        expect(conn.lastOf("config-changed"), conn.label).toMatchObject({
          difficulty: "easy", raceLength: 8,
        });
        expect(conn.lastOf("state").state, conn.label).toMatchObject({
          difficulty: "easy", raceLength: 8,
        });
      }
    });
  });

  it("the next race actually uses the new difficulty", async () => {
    // Rules out "difficulty is captured once and never re-read": easy problems
    // are only + and -, hard problems are only × and ÷.
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await playOneRace(room, host, guest);
      expect(room.state.problemSequence.every((p) => /[×÷]/.test(p.problem))).toBe(true);

      await room.handleSetConfig(host, { type: "set-config", difficulty: "easy", raceLength: 5 });
      await room.handleRematch(host);
      expect(room.state.difficulty).toBe("easy");

      await room.handleStartRace(host);
      await runCountdown(room);

      expect(room.state.problemSequence).toHaveLength(5);
      expect(room.state.problemSequence.every((p) => /^\d+ [+-] \d+$/.test(p.problem))).toBe(true);
    });
  });

  it("a race-length change between races carries into the next race", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await playOneRace(room, host, guest);
      await room.handleSetConfig(host, { type: "set-config", difficulty: "hard", raceLength: 12 });
      await room.handleRematch(host);
      await room.handleStartRace(host);
      await runCountdown(room);
      expect(room.state.problemSequence).toHaveLength(12);
    });
  });

  it("changing race length between races does not rewrite the finished race's scoreboard", async () => {
    // The lobby renders "3/10 — didn't finish" from the room's race length.
    // Once config can change while results are on screen, the finished race
    // needs its own recorded length or the results silently re-scale.
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await playOneRace(room, host, guest); // raceLength 5
      expect(room.state.lastRace).toMatchObject({ difficulty: "hard", raceLength: 5 });

      await room.handleSetConfig(host, { type: "set-config", difficulty: "easy", raceLength: 40 });
      expect(room.state.lastRace).toMatchObject({ difficulty: "hard", raceLength: 5 });
      expect(room.state.raceLength).toBe(40);
    });
  });
});

describe("private room — config permissions are unchanged elsewhere", () => {
  it("still rejects config changes mid-race", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await join(room, host, "HostGuy");
      await join(room, guest, "FriendBob");
      await room.handleStartRace(host);
      await runCountdown(room);
      expect(room.state.state).toBe("racing");

      const before = room.state.difficulty;
      host.sent.length = 0;
      await room.handleSetConfig(host, { type: "set-config", difficulty: "easy", raceLength: 5 });

      expect(host.lastOf("error")).toMatchObject({ code: "BAD_STATE" });
      expect(room.state.difficulty).toBe(before);
    });
  });

  it("still rejects config changes during the countdown", async () => {
    // The problem sequence is already generated by then, so accepting the
    // change would look like it worked and quietly do nothing.
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await join(room, host, "HostGuy");
      await join(room, guest, "FriendBob");
      await room.handleStartRace(host);
      expect(room.state.state).toBe("countdown");

      const before = room.state.difficulty;
      host.sent.length = 0;
      await room.handleSetConfig(host, { type: "set-config", difficulty: "easy", raceLength: 5 });

      expect(host.lastOf("error")).toMatchObject({ code: "BAD_STATE" });
      expect(room.state.difficulty).toBe(before);
    });
  });

  it("still rejects a non-host, including between races", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await playOneRace(room, host, guest);
      guest.sent.length = 0;

      await room.handleSetConfig(guest, { type: "set-config", difficulty: "easy", raceLength: 5 });

      expect(guest.lastOf("error")).toMatchObject({ code: "NOT_CREATOR" });
      expect(room.state.difficulty).toBe("hard");
    });
  });

  it("still validates difficulty and race length between races", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await playOneRace(room, host, guest);

      for (const bad of [
        { difficulty: "impossible", raceLength: 5 },
        { difficulty: "easy", raceLength: 0 },
        { difficulty: "easy", raceLength: 999 },
        { difficulty: "easy", raceLength: 5.5 },
      ]) {
        host.sent.length = 0;
        await room.handleSetConfig(host, { type: "set-config", ...bad });
        expect(host.lastOf("error"), JSON.stringify(bad)).toMatchObject({ code: "INVALID_INPUT" });
      }
      expect(room.state.difficulty).toBe("hard");
      expect(room.state.raceLength).toBe(5);
    });
  });
});

// The race that just ran owns every row written for it. `finished` is a
// configurable state and a D1 insert is a subrequest, not a storage operation,
// so the input gate stays open across the per-player insert loop: whatever the
// host sends the instant they see `finish` lands in the middle of it. The
// public boards filter on `difficulty` and `problems_total`, so a row restamped
// there is a clean, eligible result attributed to a race nobody ran.
describe("private room — results describe the race that ran, not the next one", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM race_results");
  });

  async function rowsByDevice() {
    const { results } = await env.DB
      .prepare("SELECT * FROM race_results WHERE device_id IN ('dev-host', 'dev-guest')")
      .all();
    return Object.fromEntries(results.map((r) => [r.device_id, r]));
  }

  /** Two players one answer away from ending an easy 5-problem race. */
  async function raceToBrink5(room, host, guest) {
    await join(room, host, "HostGuy", "dev-host");
    await join(room, guest, "FriendBob", "dev-guest");
    await room.handleSetConfig(host, { type: "set-config", difficulty: "easy", raceLength: 5 });
    await room.handleStartRace(host);
    await runCountdown(room);
    // Answers below run with no typing delay, which would finish in single-digit
    // milliseconds — fast enough to trip the captcha trigger and hold the rows
    // this suite asserts on. Backdate the clock so the pace is human-plausible
    // (1s/problem; the captcha behavior itself is covered in room-captcha.test.js).
    room.state.raceStartedAt = Date.now() - 5000;
    await raceToBrink(room, [host, guest], guest);
  }

  it("a set-config delivered mid-persist cannot restamp rows with the next race's config", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await raceToBrink5(room, host, guest);

      // The guest's last answer ends the race: finishRace broadcasts `finish`
      // and then writes one row per player. The host's client reacts to that
      // broadcast by dialling in the next race while the loop is still going.
      const persisting = answerOnce(room, guest);
      await room.handleSetConfig(host, { type: "set-config", difficulty: "hard", raceLength: 12 });
      await persisting;

      expect(room.state.difficulty).toBe("hard");
      expect(room.state.raceLength).toBe(12);

      const rows = await rowsByDevice();
      expect(Object.keys(rows).sort()).toEqual(["dev-guest", "dev-host"]);
      for (const [device, row] of Object.entries(rows)) {
        expect(row.difficulty, device).toBe("easy");
        expect(row.problems_total, device).toBe(5);
        expect(row.finished, device).toBe(1);
      }
    });
  });

  it("a rematch delivered mid-persist cannot blank the rows still being written", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await raceToBrink5(room, host, guest);

      // Same window, the other button on the same screen: Race Again resets
      // every player's score and finish time for the next race.
      const persisting = answerOnce(room, guest);
      await room.handleRematch(host);
      await persisting;

      expect(room.state.state).toBe("lobby");
      expect(room.state.players.every((p) => p.score === 0)).toBe(true);

      const rows = await rowsByDevice();
      expect(Object.keys(rows).sort()).toEqual(["dev-guest", "dev-host"]);
      for (const [device, row] of Object.entries(rows)) {
        expect(row.finished, device).toBe(1);
        expect(row.problems_correct, device).toBe(5);
        expect(row.problems_total, device).toBe(5);
        expect(row.finish_time_ms, device).not.toBeNull();
      }
    });
  });
});

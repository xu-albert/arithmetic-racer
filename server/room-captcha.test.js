// Active-verification (captcha) flow, end to end against the real room DO and
// D1: the trigger at race end, held rows, grading, single-use, the timeout
// path, cross-player isolation, wire hygiene, and the quickmatch variant.
//
// Harness mirrors server/room-config.test.js: fake connections, handlers
// called directly, real D1 via cloudflare:test.

import { describe, it, expect, beforeEach } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";

import { captchaProblems } from "./captcha.js";

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
 * What `getConnections()` actually hands back under `hibernate: true`: a plain
 * `[Symbol.iterator]`/`next` object (partyserver's HibernatingConnectionIterator),
 * which — unlike an array or a generator — carries none of Iterator.prototype's
 * helpers. Stubbing an array here is what let array-only code pass in CI and
 * throw in production.
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
  const stub = env.RaceRoom.get(env.RaceRoom.idFromName("cap-" + crypto.randomUUID()));
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

async function answerCorrectly(room, conn) {
  const player = room.playerFor(conn);
  const problem = room.state.problemSequence[player.score];
  await room.handleAnswer(conn, { type: "answer", value: String(problem.answer) });
}

/** Answer every problem correctly for the given connections. */
async function raceToFinish(room, conns) {
  const len = room.state.raceLength;
  for (let i = 0; i < len; i++) {
    for (const conn of conns) await answerCorrectly(room, conn);
  }
}

/**
 * One race where `fast` finishes in the captcha-trigger zone (~350 ms/problem,
 * above the 200 ms impossibly_fast floor) and everyone else finishes at a
 * human pace (~800 ms/problem, no trigger). Leaves the room in 'finished'
 * with a pending challenge for `fast`.
 */
async function raceWithOneTrigger(room, fast, others) {
  await room.handleStartRace(fast.conn);
  await runCountdown(room);
  // Slow players first, against a backdated clock that gives them ~800ms/problem.
  room.state.raceStartedAt = Date.now() - 8000;
  await raceToFinish(room, others);
  // Then the fast player against a fresh backdate: ~350ms/problem.
  room.state.raceStartedAt = Date.now() - 3500;
  await raceToFinish(room, [fast.conn]);
  expect(room.state.state).toBe("finished");
}

function challengeFor(room, conn) {
  const player = room.playerFor(conn);
  if (!player) return null;
  return room.state.captchaChallenges?.[player.id] ?? null;
}

/** The graded problems for a challenge — same derivation the server grades with. */
function problemsOf(room, challenge) {
  return captchaProblems(challenge.seed, room.state.lastRace.difficulty, challenge.count);
}

async function answerCaptcha(room, conn, challenge, count) {
  const problems = problemsOf(room, challenge);
  for (let i = 0; i < count; i++) {
    await room.handleCaptchaAnswer(conn, { type: "captcha-answer", value: String(problems[i].answer) });
  }
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

describe("private room — captcha trigger at race end", () => {
  it("challenges only the superhuman-paced player, sends no answers, holds the row", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await join(room, host, "Host");
      await join(room, guest, "Guest");
      await raceWithOneTrigger(room, { conn: host }, [guest]);

      const hostChallenge = challengeFor(room, host);
      expect(hostChallenge).toBeTruthy();
      expect(challengeFor(room, guest)).toBeNull();

      // The challenged seat got the problems; answers are not on the wire.
      const msg = host.lastOf("captcha");
      expect(msg).toBeTruthy();
      expect(msg.problems).toHaveLength(hostChallenge.count);
      for (const p of msg.problems) {
        expect(Object.keys(p)).toEqual(["problem"]);
      }
      expect(guest.lastOf("captcha")).toBeNull();

      // The clean player's row is already in; the held row is not.
      const rows = await rowsForRoom(room);
      expect(rows).toHaveLength(1);
      expect(rows[0].finished).toBe(1);
      expect(rows[0].suspect).toBe(0);
    });
  });

  it("does not challenge a normal-paced race at all", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await join(room, host, "Host");
      await join(room, guest, "Guest");
      await room.handleStartRace(host);
      await runCountdown(room);
      room.state.raceStartedAt = Date.now() - 8000;
      await raceToFinish(room, [host, guest]);

      expect(room.state.captchaChallenges).toEqual({});
      expect(host.lastOf("captcha")).toBeNull();
      expect(guest.lastOf("captcha")).toBeNull();
      const rows = await rowsForRoom(room);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.suspect === 0)).toBe(true);
    });
  });

  it("never puts the challenge on the broadcast wire", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await join(room, host, "Host");
      await join(room, guest, "Guest");
      await raceWithOneTrigger(room, { conn: host }, [guest]);

      host.sent.length = 0;
      guest.sent.length = 0;
      room.broadcastState();

      for (const conn of [host, guest]) {
        const stateMsg = conn.lastOf("state");
        expect(stateMsg).toBeTruthy();
        expect("captchaChallenges" in stateMsg.state).toBe(false);
        expect(JSON.stringify(stateMsg)).not.toContain("captchaChallenges");
      }
    });
  });
});

describe("private room — grading and consequences", () => {
  it("passing records the held row as clean (single-use afterwards)", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await join(room, host, "Host");
      await join(room, guest, "Guest");
      await raceWithOneTrigger(room, { conn: host }, [guest]);

      const challenge = challengeFor(room, host);
      await answerCaptcha(room, host, challenge, challenge.count);

      const result = host.lastOf("captcha-result");
      expect(result).toEqual({ type: "captcha-result", verified: true });
      expect(challengeFor(room, host)).toBeNull();

      const rows = await rowsForRoom(room);
      expect(rows).toHaveLength(2);
      // Host finished in ~3500ms, guest in ~8000ms — both recorded clean.
      const hostRow = rows.find((r) => r.finish_time_ms < 4000);
      expect(hostRow).toBeTruthy();
      expect(hostRow.finished).toBe(1);
      expect(hostRow.suspect).toBe(0);
      expect(rows.find((r) => r.finish_time_ms >= 4000)?.suspect).toBe(0);

      // Single-use: further captcha-answers are silently ignored, no extra row.
      await room.handleCaptchaAnswer(host, { type: "captcha-answer", value: "0" });
      await room.handleCaptchaAnswer(guest, { type: "captcha-answer", value: "0" });
      expect((await rowsForRoom(room))).toHaveLength(2);
    });
  });

  it("a wrong answer records the race unverified (suspect, captcha_failed)", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await join(room, host, "Host");
      await join(room, guest, "Guest");
      await raceWithOneTrigger(room, { conn: host }, [guest]);

      const challenge = challengeFor(room, host);
      const problems = problemsOf(room, challenge);
      const wrong = problems[0].answer + 1;
      await room.handleCaptchaAnswer(host, { type: "captcha-answer", value: String(wrong) });

      const result = host.lastOf("captcha-result");
      expect(result).toMatchObject({ type: "captcha-result", verified: false, reason: "captcha_failed" });
      expect(challengeFor(room, host)).toBeNull();

      const rows = await rowsForRoom(room);
      expect(rows).toHaveLength(2);
      const held = rows.find((r) => r.suspect === 1);
      expect(held).toBeTruthy();
      expect(held.suspect_reason).toBe("captcha_failed");
      expect(held.finished).toBe(1);
      // The race still happened and is still the player's own history.
      expect(held.finish_time_ms).toBeGreaterThan(0);
    });
  });

  it("letting the deadline pass records captcha_timeout via the alarm", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await join(room, host, "Host");
      await join(room, guest, "Guest");
      await raceWithOneTrigger(room, { conn: host }, [guest]);

      const challenge = challengeFor(room, host);
      challenge.deadline = Date.now() - 1;
      await room.onAlarm();

      const result = host.lastOf("captcha-result");
      expect(result).toMatchObject({ type: "captcha-result", verified: false, reason: "captcha_timeout" });
      expect(challengeFor(room, host)).toBeNull();

      const rows = await rowsForRoom(room);
      const held = rows.find((r) => r.suspect === 1);
      expect(held).toBeTruthy();
      expect(held.suspect_reason).toBe("captcha_timeout");
    });
  });

  it("a mid-challenge disconnect settles as timeout when the seat is removed", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await join(room, host, "Host");
      await join(room, guest, "Guest");
      await raceWithOneTrigger(room, { conn: host }, [guest]);
      expect(challengeFor(room, host)).toBeTruthy();

      await room.removePlayer(room.playerFor(host).id);

      expect(challengeFor(room, host)).toBeNull();
      const rows = await rowsForRoom(room);
      const held = rows.find((r) => r.suspect === 1);
      expect(held).toBeTruthy();
      expect(held.suspect_reason).toBe("captcha_timeout");
    });
  });

  it("removes the departing seat even if the roster shifts during the held insert", async () => {
    const b = makeConn("b");
    const a = makeConn("a");
    const c = makeConn("c");
    await withRoom([b, a, c], async (room) => {
      await join(room, b, "Bee");
      await join(room, a, "Ay");
      await join(room, c, "Cee");
      const [bId, aId, cId] = room.state.players.map((p) => p.id);

      // Settling a challenge awaits a D1 insert. That is a subrequest, so the
      // room keeps taking messages across it — model the interleaving by
      // having another player leave while A's timeout is still in flight.
      const settle = room.resolveCaptchaChallenge.bind(room);
      room.resolveCaptchaChallenge = async (pid, outcome) => {
        await settle(pid, outcome);
        if (pid !== aId) return;
        room.resolveCaptchaChallenge = settle;
        await room.removePlayer(bId);
      };

      await room.removePlayer(aId);

      expect(room.state.players.map((p) => p.id)).toEqual([cId]);
    });
  });

  it("rematch settles pending challenges as timeouts before resetting", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await join(room, host, "Host");
      await join(room, guest, "Guest");
      await raceWithOneTrigger(room, { conn: host }, [guest]);
      expect(challengeFor(room, host)).toBeTruthy();

      await room.handleRematch(host);

      expect(room.state.captchaChallenges).toEqual({});
      expect(room.state.state).toBe("lobby");
      const rows = await rowsForRoom(room);
      expect(rows.some((r) => r.suspect_reason === "captcha_timeout")).toBe(true);
    });
  });
});

describe("private room — isolation", () => {
  it("another player cannot answer, consume, or even probe the challenge", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await join(room, host, "Host");
      await join(room, guest, "Guest");
      await raceWithOneTrigger(room, { conn: host }, [guest]);

      const challenge = challengeFor(room, host);
      const problems = problemsOf(room, challenge);

      // Guest has no challenge; answering must do nothing at all.
      await room.handleCaptchaAnswer(guest, { type: "captcha-answer", value: String(problems[0].answer) });
      expect(challengeFor(room, host)).toBeTruthy();
      expect(guest.lastOf("captcha-result")).toBeNull();
      expect(guest.errors()).toEqual([]);

      // A brand-new arrival cannot probe either.
      const stranger = makeConn("stranger");
      await join(room, stranger, "Zed");
      await room.handleCaptchaAnswer(stranger, { type: "captcha-answer", value: String(problems[0].answer) });
      expect(challengeFor(room, host)).toBeTruthy();
      expect(stranger.lastOf("captcha-result")).toBeNull();
    });
  });

  it("reconnect re-offers the remaining problems on the new socket", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    const conns = [host, guest]; // mutable: the replacement socket joins mid-test
    await withRoom(conns, async (room) => {
      await join(room, host, "Host");
      await join(room, guest, "Guest");
      await raceWithOneTrigger(room, { conn: host }, [guest]);

      const challenge = challengeFor(room, host);
      // Answer one correctly, then "drop" and reconnect on a fresh socket.
      await answerCaptcha(room, host, challenge, 1);
      host.sent.length = 0;
      const host2 = makeConn("host-2");
      conns.push(host2);
      const hostRacerId = room.playerFor(host).racerId;
      // Most of the budget is already spent by the time the socket comes back.
      challenge.deadline = Date.now() + 2000;
      await room.handleHello(host2, { type: "hello", playerId: hostRacerId, handle: "Host" });

      const msg = host2.lastOf("captcha");
      expect(msg).toBeTruthy();
      expect(msg.problems).toHaveLength(challenge.count - 1);
      for (const p of msg.problems) expect(Object.keys(p)).toEqual(["problem"]);
      // The clock the client shows is what is left of the server's deadline —
      // a re-offer must not hand back a full fresh budget.
      expect(msg.remainingMs).toBeGreaterThan(0);
      expect(msg.remainingMs).toBeLessThanOrEqual(2000);
    });
  });
});

describe("public quickmatch room", () => {
  it("challenges a superhuman-paced human and holds the row", async () => {
    const conns = [makeConn("a")];
    const stub = env.PublicRaceRoom.get(env.PublicRaceRoom.idFromName("m-cap-" + crypto.randomUUID()));
    await runInDurableObject(stub, async (room) => {
      if (!room.state) await room.onStart();
      room.getConnections = () => connectionIterator(conns);
      room.broadcast = (s) => { for (const c of conns) c.send(s); };

      await room.handleHello(conns[0], {
        type: "hello", playerId: crypto.randomUUID(), handle: "Solo", difficulty: "medium",
        deviceId: crypto.randomUUID(),
      });
      expect(room.state.players.filter((p) => !p.isBot)).toHaveLength(1);

      // Force the auto-start, run the countdown, then race superhumanly.
      room.state.autoStartDeadline = Date.now() - 1;
      await room.onAlarm();
      for (let i = 0; i < 8 && room.state.state === "countdown"; i++) {
        room.state.countdownAt = Date.now() - 1;
        await room.onAlarm();
      }
      expect(room.state.state).toBe("racing");
      room.state.raceStartedAt = Date.now() - 3500;
      const len = room.state.raceLength;
      for (let i = 0; i < len; i++) {
        const player = room.playerFor(conns[0]);
        await room.handleAnswer(conns[0], { type: "answer", value: String(room.state.problemSequence[player.score].answer) });
      }
      expect(room.state.state).toBe("finished");

      const player = room.playerFor(conns[0]);
      const challenge = room.state.captchaChallenges?.[player.id];
      expect(challenge).toBeTruthy();
      const msg = conns[0].lastOf("captcha");
      expect(msg).toBeTruthy();
      expect(msg.problems).toHaveLength(challenge.count);

      // Bots must not be challenged and the row stays held.
      expect(Object.keys(room.state.captchaChallenges)).toEqual([player.id]);
      expect(await rowsForRoom(room)).toHaveLength(0);

      // Grading works the same way.
      await answerCaptcha(room, conns[0], challenge, challenge.count);
      const rows = await rowsForRoom(room);
      expect(rows).toHaveLength(1);
      expect(rows[0].suspect).toBe(0);
    });
  });
});

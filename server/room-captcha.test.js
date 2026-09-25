// Active-verification (captcha) flow, end to end against the real room DO and
// D1: the trigger at race end, held rows, grading, single-use, the timeout
// path, cross-player isolation, wire hygiene, and the quickmatch variant.
//
// Harness mirrors server/room-config.test.js: fake connections, handlers
// called directly, real D1 via cloudflare:test.

import { describe, it, expect, beforeEach } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";

import { captchaProblems } from "./captcha.js";
import { CAPTCHA_PROBLEM_COUNT, CAPTCHA_MS_PER_PROBLEM } from "../worker/plausibility.js";

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
async function raceWithOneTrigger(room, fast, others, starter = fast.conn) {
  await room.handleStartRace(starter);
  await runCountdown(room);
  // Slow players first, against a backdated clock that gives them ~800ms/problem.
  room.state.raceStartedAt = Date.now() - 8000;
  await raceToFinish(room, others);
  // Then the fast player against a fresh backdate: ~350ms/problem.
  room.state.raceStartedAt = Date.now() - 3500;
  await raceToFinish(room, [fast.conn]);
  expect(room.state.state).toBe("finished");
}

/**
 * The ordering the per-racer re-anchor made normal: the fast racer finishes
 * first and is challenged while a straggler is still going, so the challenge
 * settles *before* the race ends and finishRace() runs afterwards. Returns a
 * function that finishes the straggler at a human pace.
 */
async function raceFastFirst(room, fast, slow, starter) {
  await room.handleStartRace(starter);
  await runCountdown(room);
  room.state.raceStartedAt = Date.now() - 3500;
  await raceToFinish(room, [fast]);
  expect(room.state.state).toBe("racing");
  return async () => {
    room.state.raceStartedAt = Date.now() - 30000;
    await raceToFinish(room, [slow]);
    expect(room.state.state).toBe("finished");
  };
}

function challengeFor(room, conn) {
  const player = room.playerFor(conn);
  if (!player) return null;
  return room.state.captchaChallenges?.[player.id] ?? null;
}

/** The graded problems for a challenge — same derivation the server grades with. */
function problemsOf(room, challenge) {
  return captchaProblems(challenge.seed, challenge.difficulty, challenge.count);
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

describe("private room — the captcha trigger", () => {
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

describe("private room — the challenge belongs to the racer, not the race", () => {
  it("challenges a fast racer at their own finish, while the race is still running", async () => {
    const fast = makeConn("fast");
    const slow = makeConn("slow");
    await withRoom([fast, slow], async (room) => {
      await join(room, fast, "Fast");
      await join(room, slow, "Slow");
      await room.handleStartRace(fast);
      await runCountdown(room);

      room.state.raceStartedAt = Date.now() - 3500;
      await raceToFinish(room, [fast]);

      // The straggler has not finished, so the race has not ended — and the
      // challenge is already on its way to the racer who earned it.
      expect(room.state.state).toBe("racing");
      const challenge = challengeFor(room, fast);
      expect(challenge).toBeTruthy();
      expect(fast.lastOf("captcha")).toBeTruthy();
      expect(slow.lastOf("captcha")).toBeNull();

      // The budget is anchored to that finish: waiting on a straggler for
      // another 40 seconds does not spend any of it.
      const deadline = challenge.deadline;
      room.state.raceStartedAt = Date.now() - 40000;
      await raceToFinish(room, [slow]);

      expect(room.state.state).toBe("finished");
      expect(challengeFor(room, fast).deadline).toBe(deadline);
      expect(challengeFor(room, slow)).toBeNull();
    });
  });

  it("a host rematch does not settle another racer's verification", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await join(room, host, "Host", "dev-host");
      await join(room, guest, "Guest", "dev-guest");
      await raceWithOneTrigger(room, { conn: guest }, [host], host);

      const challenge = challengeFor(room, guest);
      expect(challenge).toBeTruthy();
      guest.sent.length = 0;

      // Two clicks from the host — Play Again, then Race Again — land well
      // inside the guest's response window.
      await room.handleRematch(host);

      expect(room.state.state).toBe("lobby");
      expect(challengeFor(room, guest)).toBeTruthy();
      expect(guest.lastOf("captcha-result")).toBeNull();
      const afterRematch = await rowsForRoom(room);
      expect(afterRematch.map((r) => r.device_id)).toEqual(["dev-host"]);

      // The guest finishes verifying on their own time and the row counts.
      await answerCaptcha(room, guest, challenge, challenge.count);

      expect(guest.lastOf("captcha-result")).toMatchObject({ verified: true });
      const rows = await rowsForRoom(room);
      const guestRow = rows.find((r) => r.device_id === "dev-guest");
      expect(guestRow.suspect).toBe(0);
      expect(guestRow.finished).toBe(1);
    });
  });

  it("re-offers a pending challenge to a reloaded tab after the room has reset", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    const conns = [host, guest];
    await withRoom(conns, async (room) => {
      await join(room, host, "Host", "dev-host");
      await join(room, guest, "Guest", "dev-guest");
      await raceWithOneTrigger(room, { conn: guest }, [host], host);

      const challenge = challengeFor(room, guest);
      await answerCaptcha(room, guest, challenge, 1);
      const guestRacerId = room.playerFor(guest).racerId;
      await room.handleRematch(host);
      expect(room.state.state).toBe("lobby");

      // A reload, not a socket blip: a brand new connection presenting the
      // stored racerId, with no race in progress to hand the message to.
      const guest2 = makeConn("guest-2");
      conns.push(guest2);
      await room.handleHello(guest2, { type: "hello", playerId: guestRacerId, handle: "Guest" });

      const msg = guest2.lastOf("captcha");
      expect(msg).toBeTruthy();
      expect(msg.problems).toHaveLength(challenge.count - 1);
      for (const p of msg.problems) expect(Object.keys(p)).toEqual(["problem"]);
      expect(msg.remainingMs).toBeGreaterThan(0);
    });
  });
});

describe("private room — one row per racer per race, whenever the challenge settles", () => {
  it("passing while a straggler is still racing does not write a second row", async () => {
    const fast = makeConn("fast");
    const slow = makeConn("slow");
    await withRoom([fast, slow], async (room) => {
      await join(room, fast, "Fast", "dev-fast");
      await join(room, slow, "Slow", "dev-slow");
      const finishStraggler = await raceFastFirst(room, fast, slow, fast);

      const challenge = challengeFor(room, fast);
      await answerCaptcha(room, fast, challenge, challenge.count);
      expect(await rowsForRoom(room)).toHaveLength(1);

      // The race ends much later. The verified row is already written.
      await finishStraggler();

      const rows = await rowsForRoom(room);
      expect(rows.filter((r) => r.device_id === "dev-fast")).toHaveLength(1);
      expect(rows.filter((r) => r.device_id === "dev-slow")).toHaveLength(1);
      expect(rows.find((r) => r.device_id === "dev-fast").suspect).toBe(0);
    });
  });

  it("ignoring the challenge cannot be undone by the race ending later", async () => {
    const fast = makeConn("fast");
    const slow = makeConn("slow");
    await withRoom([fast, slow], async (room) => {
      await join(room, fast, "Fast", "dev-fast");
      await join(room, slow, "Slow", "dev-slow");
      const finishStraggler = await raceFastFirst(room, fast, slow, fast);

      // Answer nothing; the deadline settles it while the race is still on.
      challengeFor(room, fast).deadline = Date.now() - 1;
      await room.onAlarm();
      expect(room.state.state).toBe("racing");

      await finishStraggler();

      // Exactly one row, and it is the unverified one. A second, clean row
      // here would satisfy every leaderboard predicate and make ignoring the
      // captcha free for anyone who finishes before their opponent.
      const mine = (await rowsForRoom(room)).filter((r) => r.device_id === "dev-fast");
      expect(mine).toHaveLength(1);
      expect(mine[0].suspect).toBe(1);
      expect(mine[0].suspect_reason).toBe("captcha_timeout");
    });
  });

  it("a wrong answer mid-race is not overwritten by a clean row at race end", async () => {
    const fast = makeConn("fast");
    const slow = makeConn("slow");
    await withRoom([fast, slow], async (room) => {
      await join(room, fast, "Fast", "dev-fast");
      await join(room, slow, "Slow", "dev-slow");
      const finishStraggler = await raceFastFirst(room, fast, slow, fast);

      const challenge = challengeFor(room, fast);
      const wrong = problemsOf(room, challenge)[0].answer + 1;
      await room.handleCaptchaAnswer(fast, { type: "captcha-answer", value: String(wrong) });

      await finishStraggler();

      const mine = (await rowsForRoom(room)).filter((r) => r.device_id === "dev-fast");
      expect(mine).toHaveLength(1);
      expect(mine[0].suspect).toBe(1);
      expect(mine[0].suspect_reason).toBe("captcha_failed");
    });
  });

  it("a later race persists normally once the held row is behind it", async () => {
    const fast = makeConn("fast");
    const slow = makeConn("slow");
    await withRoom([fast, slow], async (room) => {
      await join(room, fast, "Fast", "dev-fast");
      await join(room, slow, "Slow", "dev-slow");
      const finishStraggler = await raceFastFirst(room, fast, slow, fast);
      const challenge = challengeFor(room, fast);
      await answerCaptcha(room, fast, challenge, challenge.count);
      await finishStraggler();

      // Second race, both at a human pace: nothing is held, so both rows write.
      await room.handleRematch(fast);
      await room.handleStartRace(fast);
      await runCountdown(room);
      room.state.raceStartedAt = Date.now() - 30000;
      await raceToFinish(room, [fast, slow]);

      const rows = await rowsForRoom(room);
      expect(rows.filter((r) => r.device_id === "dev-fast")).toHaveLength(2);
      expect(rows.filter((r) => r.device_id === "dev-slow")).toHaveLength(2);
    });
  });
});

describe("private room — a superseded challenge", () => {
  it("records captcha_superseded (not captcha_timeout) and reissues three fresh problems on a full budget", async () => {
    const fast = makeConn("fast");
    const slow = makeConn("slow");
    await withRoom([fast, slow], async (room) => {
      await join(room, fast, "Fast", "dev-fast");
      await join(room, slow, "Slow", "dev-slow");
      const finishStraggler = await raceFastFirst(room, fast, slow, fast);

      // The supersede settles fire-and-forget (the finish path must not
      // suspend on a database write); capture the promise so the row it
      // writes is awaitable.
      const settles = [];
      const origResolve = room.resolveCaptchaChallenge.bind(room);
      room.resolveCaptchaChallenge = (...args) => {
        const p = origResolve(...args);
        settles.push(p);
        return p;
      };

      // One of three answered before the host rematches into the window.
      const first = challengeFor(room, fast);
      expect(first).toBeTruthy();
      await answerCaptcha(room, fast, first, 1);
      await finishStraggler();

      // Second race, fast again: the pending challenge is superseded.
      await room.handleRematch(fast);
      await room.handleStartRace(fast);
      await runCountdown(room);
      room.state.raceStartedAt = Date.now() - 3500;
      await raceToFinish(room, [fast]);
      await Promise.allSettled(settles);

      // The abandoned challenge's row says what actually happened: the budget
      // was still live and the racer was mid-answer when the reissue landed.
      const firstRaceRows = (await rowsForRoom(room)).filter((r) => r.device_id === "dev-fast");
      expect(firstRaceRows).toHaveLength(1);
      expect(firstRaceRows[0].suspect).toBe(1);
      expect(firstRaceRows[0].suspect_reason).toBe("captcha_superseded");
      expect(fast.sent.filter((m) => m.type === "captcha-result"))
        .toContainEqual({ type: "captcha-result", verified: false, reason: "captcha_superseded" });

      // Progress on the superseded challenge does not carry: the reissue is
      // three fresh problems with the full budget, like any other challenge.
      const second = challengeFor(room, fast);
      expect(second).toBeTruthy();
      expect(second.index).toBe(0);
      expect(second.count).toBe(CAPTCHA_PROBLEM_COUNT);
      const budgetLeft = second.deadline - Date.now();
      expect(budgetLeft).toBeGreaterThan((CAPTCHA_PROBLEM_COUNT - 1) * CAPTCHA_MS_PER_PROBLEM);
      expect(budgetLeft).toBeLessThanOrEqual(CAPTCHA_PROBLEM_COUNT * CAPTCHA_MS_PER_PROBLEM);
      expect(fast.lastOf("captcha").problems).toHaveLength(CAPTCHA_PROBLEM_COUNT);

      // All three must be answered to pass, and the second race's row then
      // records clean.
      const problems = problemsOf(room, second);
      await answerCaptcha(room, fast, second, CAPTCHA_PROBLEM_COUNT - 1);
      expect(challengeFor(room, fast)).toBeTruthy();
      await room.handleCaptchaAnswer(fast, {
        type: "captcha-answer", value: String(problems[CAPTCHA_PROBLEM_COUNT - 1].answer),
      });
      expect(fast.lastOf("captcha-result")).toMatchObject({ verified: true });
      expect(challengeFor(room, fast)).toBeNull();

      const mine = (await rowsForRoom(room)).filter((r) => r.device_id === "dev-fast");
      expect(mine).toHaveLength(2);
      expect(mine.filter((r) => r.suspect === 0)).toHaveLength(1);
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

  it("a mid-challenge disconnect leaves the verdict to the challenge's own deadline", async () => {
    const host = makeConn("host");
    const guest = makeConn("guest");
    await withRoom([host, guest], async (room) => {
      await join(room, host, "Host");
      await join(room, guest, "Guest");
      await raceWithOneTrigger(room, { conn: host }, [guest]);
      const pid = room.playerFor(host).id;
      expect(room.state.captchaChallenges[pid]).toBeTruthy();

      // Losing the seat is not a verdict — the racer may still be answering on
      // a socket that is on its way back.
      await room.removePlayer(pid);
      expect(room.state.captchaChallenges[pid]).toBeTruthy();
      expect(await rowsForRoom(room)).toHaveLength(1);

      // Their own deadline still settles it, seat or no seat.
      room.state.captchaChallenges[pid].deadline = Date.now() - 1;
      await room.onAlarm();

      expect(room.state.captchaChallenges[pid]).toBeUndefined();
      const held = (await rowsForRoom(room)).find((r) => r.suspect === 1);
      expect(held.suspect_reason).toBe("captcha_timeout");
    });
  });

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

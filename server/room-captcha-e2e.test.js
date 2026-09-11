// End-to-end active verification over a real WebSocket.
//
// Every other captcha suite calls the room's handlers directly. This one drives
// the product path a browser drives: POST /api/rooms, a websocket upgrade
// through the Worker's partyserver route, the same JSON wire messages
// public/src/room-client.js sends, then the public read surface
// (GET /api/recent-finishes) and the persisted race_results rows.
//
// It therefore covers the seams the direct-handler suites stub out — partyserver
// routing, the real `getConnections()` iterator behind `sendToSeat`, and the
// JSON shapes that actually cross the wire — and it answers the captcha the way
// a human does: by reading the problem strings and doing the arithmetic, since
// the answers never leave the Durable Object.
//
// The run prints a readable transcript of the whole exchange at the end, so a
// CI log carries the same evidence a reviewer would otherwise have to collect
// by hand from a probe client.

import { describe, it, expect, beforeEach } from "vitest";
import { env, SELF, runInDurableObject } from "cloudflare:test";
import { handleRecentFinishes } from "../worker/routes/recent-finishes.js";

const TRANSCRIPT = [];
const log = (line = "") => TRANSCRIPT.push(line);

function tick(ms = 5) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A browser-equivalent client: real socket, real JSON wire messages. */
async function connect(roomId, label) {
  const res = await SELF.fetch(`https://e2e.test/parties/race-room/${roomId}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  const inbox = [];
  ws.addEventListener("message", (e) => inbox.push(JSON.parse(e.data)));
  ws.accept();

  // Messages are consumed in arrival order, so `wait` never misses one that
  // landed while the test was awaiting something else.
  let cursor = 0;

  return {
    label,
    inbox,
    playerId: null,
    send(msg) { ws.send(JSON.stringify(msg)); },
    /** Say hello and remember the broadcast id the room hands back. */
    async hello(racerId, handle, deviceId) {
      this.send({ type: "hello", playerId: racerId, handle, deviceId });
      this.playerId = (await this.wait("hello-ack")).playerId;
      return this.playerId;
    },
    close() { try { ws.close(); } catch { /* already gone */ } },
    /** Wait for the next unconsumed message of `type`. */
    async wait(type, timeoutMs = 4000) {
      const hit = await this.until((m) => m.type === type, timeoutMs, `'${type}'`);
      return hit;
    },
    /** Wait for the next unconsumed message matching `pred`. */
    async until(pred, timeoutMs = 4000, what = "match") {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        for (let i = cursor; i < inbox.length; i++) {
          if (!pred(inbox[i])) continue;
          cursor = i + 1;
          return inbox[i];
        }
        await tick();
      }
      throw new Error(`${label}: no ${what} within ${timeoutMs}ms; saw ` +
        JSON.stringify(inbox.map((m) => m.type)));
    },
    /** Assert nothing of `type` has arrived (used for "was never challenged"). */
    none(type) { return inbox.filter((m) => m.type === type).length === 0; },
  };
}

const roomStub = (roomId) => env.RaceRoom.get(env.RaceRoom.idFromName(roomId));

/** Reach into the live DO the way only a test can: to move its clock. */
const inRoom = (roomId, fn) => runInDurableObject(roomStub(roomId), fn);

async function createRoom() {
  const res = await SELF.fetch("https://e2e.test/api/rooms", { method: "POST" });
  const { roomId } = await res.json();
  return roomId;
}

/** Burn the 3s countdown by moving the DO's own deadline into the past. */
async function fastForwardCountdown(roomId) {
  for (let i = 0; i < 8; i++) {
    const done = await inRoom(roomId, async (room) => {
      if (room.state.state !== "countdown") return true;
      room.state.countdownAt = Date.now() - 1;
      await room.onAlarm();
      return room.state.state !== "countdown";
    });
    if (done) break;
  }
}

/**
 * Backdate the race clock so the server stamps a finish at `msPerProblem`.
 * Test answers arrive in microseconds; without this every finish would be
 * below the 200ms/problem passive floor rather than in the captcha band.
 */
const setPace = (roomId, msPerProblem, len = 10) =>
  inRoom(roomId, (room) => { room.state.raceStartedAt = Date.now() - msPerProblem * len; });

/**
 * Answer the whole race from the sequence `race-start` shipped to this client,
 * waiting for each server `advance` before sending the next answer — the room
 * scores strictly in order, so an un-acked answer would race the next one.
 */
async function race(client, sequence) {
  for (let i = 0; i < sequence.length; i++) {
    client.send({ type: "answer", value: String(sequence[i].answer) });
    await client.until(
      (m) => m.type === "advance" && m.playerId === client.playerId && m.score === i + 1,
      4000, `advance to ${i + 1}`,
    );
  }
}

/** Do the arithmetic ourselves — the captcha wire message carries no answers. */
function solve(problem) {
  const [a, op, b] = problem.split(" ");
  const [x, y] = [Number(a), Number(b)];
  if (op === "+") return x + y;
  if (op === "-") return x - y;
  if (op === "×") return x * y;
  if (op === "÷") return x / y;
  throw new Error(`unparsed problem: ${problem}`);
}

async function rowsFor(roomId) {
  const { results } = await env.DB.prepare(
    "SELECT device_id, finish_time_ms, problems_total, finished, suspect, suspect_reason" +
    "  FROM race_results WHERE room_id = ? ORDER BY finish_time_ms"
  ).bind(roomId).all();
  return results;
}

async function publicFeed() {
  const res = await handleRecentFinishes(new Request("https://e2e.test/api/recent-finishes"), env);
  expect(res.status).toBe(200);
  return (await res.json()).finishes;
}

/** One race where `fast` is in the captcha band and `slow` is human-paced. */
async function raceWithFastFinisher(roomId, fast, slow) {
  fast.send({ type: "start-race" });
  await fast.wait("countdown").catch(() => {});
  await fastForwardCountdown(roomId);
  const { sequence } = await fast.wait("race-start");
  await setPace(roomId, 350);          // 3.5s / 10 problems — under the 500ms trigger
  await race(fast, sequence);
  return async () => {                  // finish the straggler later
    await setPace(roomId, 3000);
    await race(slow, sequence);
    await slow.wait("finish");   // every racer home; the room persists the race
  };
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM race_results");
});

describe("active verification, end to end over a real socket", () => {
  it("challenges a superhuman finish, and a solved challenge counts normally", async () => {
    const roomId = await createRoom();
    log(`\n=== SCENARIO 1 — superhuman pace, challenge solved ===`);
    log(`POST /api/rooms -> ${roomId}`);

    const fast = await connect(roomId, "fast");
    const slow = await connect(roomId, "slow");
    await fast.hello(crypto.randomUUID(), "Speedy", "dev-fast-1");
    await slow.hello(crypto.randomUUID(), "Steady", "dev-slow-1");

    const finishStraggler = await raceWithFastFinisher(roomId, fast, slow);

    const advance = [...fast.inbox].reverse().find((m) => m.type === "advance" && m.finishMs != null);
    log(`\nfast racer finished: ${advance.finishMs}ms for 10 problems ` +
        `(${Math.round(advance.finishMs / 10)} ms/problem, trigger is <500)`);

    const offer = await fast.wait("captcha");
    log(`\n<- captcha  ${JSON.stringify(offer)}`);
    log(`   (problem strings only: no 'answer' field anywhere on the wire)`);
    expect(JSON.stringify(offer)).not.toContain("answer");
    expect(offer.problems).toHaveLength(3);
    expect(offer.remainingMs).toBeGreaterThan(11000);
    expect(offer.remainingMs).toBeLessThanOrEqual(12000);
    expect(slow.none("captcha")).toBe(true);
    log(`   human-paced racer got no challenge: ${slow.none("captcha")}`);

    for (const p of offer.problems) {
      const answer = solve(p.problem);
      log(`-> captcha-answer  ${p.problem} = ${answer}`);
      fast.send({ type: "captcha-answer", value: String(answer) });
      await tick(15);
    }
    const verdict = await fast.wait("captcha-result");
    log(`<- captcha-result  ${JSON.stringify(verdict)}`);
    expect(verdict).toEqual({ type: "captcha-result", verified: true });

    await finishStraggler();
    await tick(30);

    const rows = await rowsFor(roomId);
    log(`\nrace_results rows for this room:`);
    for (const r of rows) log(`   ${JSON.stringify(r)}`);
    expect(rows).toHaveLength(2);
    const verified = rows.find((r) => r.device_id === "dev-fast-1");
    expect(verified.suspect).toBe(0);
    expect(verified.suspect_reason).toBe(null);

    const feed = await publicFeed();
    log(`\nGET /api/recent-finishes -> ${JSON.stringify(feed, null, 2)}`);
    expect(feed).toHaveLength(2);
    // The headline rate is this race's own row, not a wall-clock constant: the
    // finish the server stamped is the backdated 3.5s plus whatever the ten
    // socket round trips above actually cost, which moves with machine load.
    // So assert the feed agrees with the row it was derived from, and that the
    // verified racer — not the straggler — is still the one on top.
    const headline = Math.max(...feed.map((f) => f.ppm));
    const row = await env.DB.prepare(
      "SELECT problems_correct, finish_time_ms FROM race_results WHERE room_id = ? AND device_id = 'dev-fast-1'"
    ).bind(roomId).first();
    expect(headline).toBeCloseTo(row.problems_correct * 60000 / row.finish_time_ms, 6);
    expect(headline).toBeGreaterThan(Math.min(...feed.map((f) => f.ppm)));

    fast.close(); slow.close();
  });

  it("a wrong answer keeps the row out of the public feed", async () => {
    const roomId = await createRoom();
    log(`\n=== SCENARIO 2 — superhuman pace, wrong captcha answer ===`);
    log(`POST /api/rooms -> ${roomId}`);

    const fast = await connect(roomId, "fast");
    const slow = await connect(roomId, "slow");
    await fast.hello(crypto.randomUUID(), "Bot", "dev-fast-2");
    await slow.hello(crypto.randomUUID(), "Steady", "dev-slow-2");

    const finishStraggler = await raceWithFastFinisher(roomId, fast, slow);
    const offer = await fast.wait("captcha");
    log(`\n<- captcha  ${JSON.stringify(offer.problems)}`);

    const wrong = solve(offer.problems[0].problem) + 1;
    log(`-> captcha-answer  ${offer.problems[0].problem} = ${wrong}   (wrong)`);
    fast.send({ type: "captcha-answer", value: String(wrong) });
    const verdict = await fast.wait("captcha-result");
    log(`<- captcha-result  ${JSON.stringify(verdict)}`);
    expect(verdict).toEqual({ type: "captcha-result", verified: false, reason: "captcha_failed" });

    await finishStraggler();
    await tick(30);

    const rows = await rowsFor(roomId);
    log(`\nrace_results rows for this room:`);
    for (const r of rows) log(`   ${JSON.stringify(r)}`);
    expect(rows).toHaveLength(2);
    const flagged = rows.find((r) => r.device_id === "dev-fast-2");
    expect(flagged.suspect).toBe(1);
    expect(flagged.suspect_reason).toBe("captcha_failed");

    const feed = await publicFeed();
    log(`\nGET /api/recent-finishes -> ${JSON.stringify(feed, null, 2)}`);
    log(`   (only the human-paced finish is listed; the unverified one is filtered out)`);
    expect(feed).toHaveLength(1);
    expect(feed[0].ppm).toBeLessThan(25);   // the human-paced 30s finish, not the 3.5s one

    fast.close(); slow.close();
  });

  it("ignoring the challenge times out, and the race end cannot launder it clean", async () => {
    const roomId = await createRoom();
    log(`\n=== SCENARIO 3 — superhuman pace, challenge ignored ===`);
    log(`POST /api/rooms -> ${roomId}`);

    const fast = await connect(roomId, "fast");
    const slow = await connect(roomId, "slow");
    await fast.hello(crypto.randomUUID(), "Ghost", "dev-fast-3");
    await slow.hello(crypto.randomUUID(), "Steady", "dev-slow-3");

    const finishStraggler = await raceWithFastFinisher(roomId, fast, slow);
    const offer = await fast.wait("captcha");
    log(`\n<- captcha  ${JSON.stringify(offer.problems)}   (${offer.remainingMs}ms budget, never answered)`);

    // Let the 12s budget expire while the other racer is still going.
    await inRoom(roomId, async (room) => {
      for (const ch of Object.values(room.state.captchaChallenges)) ch.deadline = Date.now() - 1;
      await room.onAlarm();
    });
    const verdict = await fast.wait("captcha-result");
    log(`<- captcha-result  ${JSON.stringify(verdict)}`);
    expect(verdict).toEqual({ type: "captcha-result", verified: false, reason: "captcha_timeout" });

    await finishStraggler();
    await tick(30);

    const rows = await rowsFor(roomId);
    log(`\nrace_results rows for this room (race ended AFTER the timeout):`);
    for (const r of rows) log(`   ${JSON.stringify(r)}`);
    expect(rows).toHaveLength(2);
    const flagged = rows.filter((r) => r.device_id === "dev-fast-3");
    log(`   rows for the unverified racer: ${flagged.length} (a second, clean row would reach the board)`);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].suspect).toBe(1);
    expect(flagged[0].suspect_reason).toBe("captcha_timeout");

    const feed = await publicFeed();
    log(`\nGET /api/recent-finishes -> ${JSON.stringify(feed, null, 2)}`);
    expect(feed).toHaveLength(1);

    fast.close(); slow.close();
  });

  it("re-offers a pending challenge to a reloaded tab", async () => {
    const roomId = await createRoom();
    log(`\n=== SCENARIO 4 — the tab is reloaded mid-challenge ===`);
    log(`POST /api/rooms -> ${roomId}`);

    const racerId = crypto.randomUUID();
    const fast = await connect(roomId, "fast");
    const slow = await connect(roomId, "slow");
    await fast.hello(racerId, "Reloader", "dev-fast-4");
    await slow.hello(crypto.randomUUID(), "Steady", "dev-slow-4");

    await raceWithFastFinisher(roomId, fast, slow);
    const offer = await fast.wait("captcha");
    log(`\n<- captcha  ${JSON.stringify(offer.problems)}   ${offer.remainingMs}ms left`);

    const first = solve(offer.problems[0].problem);
    log(`-> captcha-answer  ${offer.problems[0].problem} = ${first}`);
    fast.send({ type: "captcha-answer", value: String(first) });
    await tick(20);

    log(`\n--- tab reloaded: socket closed, fresh socket, same localStorage racerId ---`);
    fast.close();
    await tick(30);
    const reloaded = await connect(roomId, "reloaded");
    await reloaded.hello(racerId, "Reloader", "dev-fast-4");

    const reoffer = await reloaded.wait("captcha");
    log(`<- captcha  ${JSON.stringify(reoffer)}`);
    log(`   ${reoffer.problems.length} problems left (not ${offer.problems.length}), ` +
        `${reoffer.remainingMs}ms of the ORIGINAL ${offer.remainingMs}ms budget — not a fresh clock`);
    expect(reoffer.problems).toHaveLength(2);
    expect(reoffer.problems.map((p) => p.problem)).toEqual(offer.problems.slice(1).map((p) => p.problem));
    expect(reoffer.remainingMs).toBeLessThan(offer.remainingMs);

    for (const p of reoffer.problems) {
      const answer = solve(p.problem);
      log(`-> captcha-answer  ${p.problem} = ${answer}`);
      reloaded.send({ type: "captcha-answer", value: String(answer) });
      await tick(15);
    }
    const verdict = await reloaded.wait("captcha-result");
    log(`<- captcha-result  ${JSON.stringify(verdict)}   (the reload did not cost the racer their race)`);
    expect(verdict.verified).toBe(true);

    const rows = await rowsFor(roomId);
    log(`\nrace_results rows for this room:`);
    for (const r of rows) log(`   ${JSON.stringify(r)}`);
    expect(rows.find((r) => r.device_id === "dev-fast-4").suspect).toBe(0);

    reloaded.close(); slow.close();
  });

  it("a human-paced race is never interrupted", async () => {
    const roomId = await createRoom();
    log(`\n=== SCENARIO 5 — ordinary race, nobody is challenged ===`);
    log(`POST /api/rooms -> ${roomId}`);

    const a = await connect(roomId, "a");
    const b = await connect(roomId, "b");
    await a.hello(crypto.randomUUID(), "Human", "dev-human-a");
    await b.hello(crypto.randomUUID(), "Alsohuman", "dev-human-b");

    a.send({ type: "start-race" });
    await fastForwardCountdown(roomId);
    const { sequence } = await a.wait("race-start");
    await setPace(roomId, 2400);   // 24s for 10 problems
    await race(a, sequence);
    await race(b, sequence);
    await a.wait("finish");
    await tick(30);

    log(`\nboth finished at 2400 ms/problem — no captcha message on either wire: ` +
        `${a.none("captcha") && b.none("captcha")}`);
    expect(a.none("captcha")).toBe(true);
    expect(b.none("captcha")).toBe(true);

    const rows = await rowsFor(roomId);
    log(`race_results rows: ${JSON.stringify(rows)}`);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.suspect === 0)).toBe(true);

    const feed = await publicFeed();
    log(`GET /api/recent-finishes -> ${JSON.stringify(feed)}`);
    expect(feed).toHaveLength(2);

    a.close(); b.close();
    log("");
    console.log(TRANSCRIPT.join("\n"));
  });
});

// Guests keep full access to play — the core product promise.
//
// Anonymous quick-play is v1's whole game and signing in is an optional
// upgrade, never a requirement: these tests prove every mode works with no
// session cookie at all. They drive the real Worker entry (SELF.fetch) and
// real WebSockets, the way a browser without an account would:
//
//   - solo:       POST /api/race-result stores a finished guest race
//   - Quick Match: POST /api/matchmake/join hands a guest a room, and the
//                 public room seats them as a guest
//   - private:    POST /api/rooms mints a room, two guests race in it
//
// Signed-in variants of these paths are covered incidentally by
// worker/routes/me.test.js, server/server.test.js (identity stamping), and
// the room suites; this file exists so the *unsigned* path can never
// quietly grow an auth gate.

import { describe, it, expect, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";

function tick(ms = 5) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A browser-equivalent guest client: real socket, no cookies. */
async function connect(party, roomId, label) {
  const res = await SELF.fetch(`https://guest.test/parties/${party}/${roomId}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  const inbox = [];
  ws.addEventListener("message", (e) => inbox.push(JSON.parse(e.data)));
  ws.accept();

  // Messages are consumed in arrival order, so `until` never misses one that
  // landed while the test was awaiting something else.
  let cursor = 0;

  return {
    label,
    playerId: null,
    send(msg) { ws.send(JSON.stringify(msg)); },
    async hello(racerId, handle, deviceId, extra = {}) {
      this.send({ type: "hello", playerId: racerId, handle, deviceId, ...extra });
      const ack = await this.until((m) => m.type === "hello-ack", 4000, "'hello-ack'");
      this.playerId = ack.playerId;
      return ack;
    },
    close() { try { ws.close(); } catch { /* already gone */ } },
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
  };
}

const VALID_RACE = {
  difficulty: "easy",
  finished: true,
  finish_time_ms: 60000,
  problems_total: 10,
  problems_correct: 10,
  problems_attempted: 10,
  avg_time_per_problem_ms: 6000,
  accuracy_pct: 100,
  longest_streak: 10,
};

describe("guest access — every mode plays without an account", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM race_results");
  });

  it("solo: a finished race is stored with no session", async () => {
    const res = await SELF.fetch("https://guest.test/api/race-result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...VALID_RACE, device_id: "guest-solo-device" }),
    });
    expect(res.status).toBe(200);
    const { id } = await res.json();
    expect(typeof id).toBe("string");

    const row = await env.DB
      .prepare("SELECT user_id, room_id FROM race_results WHERE id = ?")
      .bind(id)
      .first();
    expect(row.user_id).toBeNull();
    expect(row.room_id).toBeNull();
  });

  it("quick match: matchmaking seats a guest in a public room", async () => {
    const res = await SELF.fetch("https://guest.test/api/matchmake/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ difficulty: "medium", device_id: "guest-qm-device" }),
    });
    expect(res.status).toBe(200);
    const { roomId, mode } = await res.json();
    expect(mode).toBe("public");

    const guest = await connect("public-race-room", roomId, "qm-guest");
    await guest.hello(crypto.randomUUID(), null, "guest-qm-device", { difficulty: "medium" });

    // The room's own roster says who it seated: a human guest, not an error.
    // (onConnect pushes a state snapshot before hello, so match the first
    // state that actually contains this seat.)
    const state = await guest.until(
      (m) => m.type === "state" && m.state.players.some((p) => p.id === guest.playerId),
      4000,
      "'state' containing the seat",
    );
    const seat = state.state.players.find((p) => p.id === guest.playerId);
    expect(seat).toBeTruthy();
    expect(seat.isGuest).toBe(true);
    guest.close();
  });

  it("private room: a guest creates one and two guests race in it", async () => {
    const res = await SELF.fetch("https://guest.test/api/rooms", { method: "POST" });
    expect(res.status).toBe(200);
    const { roomId } = await res.json();

    const host = await connect("race-room", roomId, "host");
    await host.hello(crypto.randomUUID(), null, "guest-host-device");
    const guest = await connect("race-room", roomId, "guest");
    await guest.hello(crypto.randomUUID(), null, "guest-join-device");

    host.send({ type: "start-race" });
    // 3-2-1-GO ticks on one-second alarms before racing starts.
    const start = await guest.until((m) => m.type === "race-start", 15000, "'race-start'");
    expect(start.sequence.length).toBeGreaterThan(0);

    // A correct answer advances the guest's car — the race itself works.
    guest.send({ type: "answer", value: start.sequence[0].answer });
    const advance = await guest.until(
      (m) => m.type === "advance" && m.playerId === guest.playerId,
      4000,
      "'advance'",
    );
    expect(advance.score).toBe(1);

    host.close();
    guest.close();
  });
});

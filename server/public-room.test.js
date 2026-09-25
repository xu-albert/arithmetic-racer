import { describe, it, expect, beforeEach, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";

describe("PublicRaceRoom — scaffold", () => {
  it("class is exported and binding resolves", () => {
    expect(env.PublicRaceRoom).toBeDefined();
    const id = env.PublicRaceRoom.idFromName("test-scaffold-" + crypto.randomUUID());
    const stub = env.PublicRaceRoom.get(id);
    expect(stub).toBeDefined();
  });
});

import { computeAutoStartDeadline, MAX_PLAYERS, LONE_TIMEOUT_MS, GATHER_WINDOW_MS } from "../public/src/auto-start.js";

// Distinct per socket, like the real Connection.id: the seat records which
// socket owns it, and onClose only graces its owner.
function makeConn() {
  return {
    id: "sock-" + crypto.randomUUID(),
    sent: [],
    state: undefined,
    send(s) { this.sent.push(JSON.parse(s)); },
    setState(s) { this.state = s; },
  };
}

/**
 * Create a fresh PublicRaceRoom DO stub, run a callback inside its context
 * (so we can access and mutate the real instance), and stub out the WS
 * broadcast machinery so unit tests never need real WebSockets.
 *
 * The callback receives `(instance)` with:
 *   - `instance.releaseCalls` — array of roomIds passed to releaseLobby
 *   - instance.broadcast / broadcastState / getConnections already stubbed
 */
// Test rooms must carry the same e-/m-/h- prefix that production LobbyRouter
// emits, since PublicRaceRoom now derives its difficulty from `this.name`.
// Tests that need a non-medium difficulty pass it as the third arg.
async function withRoom(name, fnOrDifficulty, maybeFn) {
  const difficulty = typeof fnOrDifficulty === "string" ? fnOrDifficulty : "medium";
  const fn = typeof fnOrDifficulty === "function" ? fnOrDifficulty : maybeFn;
  const prefix = { easy: "e", medium: "m", hard: "h" }[difficulty];
  const prefixed = name.startsWith(`${prefix}-`) ? name : `${prefix}-${name}`;
  const stub = env.PublicRaceRoom.get(env.PublicRaceRoom.idFromName(prefixed));
  return runInDurableObject(stub, async (instance) => {
    // Ensure onStart has run (idempotent — sets state if not yet set).
    if (!instance.state) await instance.onStart();

    // Stub WS plumbing — unit tests verify state/messages directly.
    instance.broadcast = () => {};
    instance.broadcastState = () => {};
    instance.getConnections = () => [];

    // Intercept releaseLobby to capture calls.
    const releaseCalls = [];
    instance.releaseLobby = async () => { releaseCalls.push(instance.name); };
    instance.releaseCalls = releaseCalls;

    return fn(instance);
  });
}

describe("PublicRaceRoom.handleHello — difficulty lock + auto-start", () => {
  it("first hello locks difficulty in state", async () => {
    await withRoom("test-lock-" + crypto.randomUUID(), async (room) => {
      const conn = makeConn();
      await room.handleHello(conn, {
        type: "hello",
        playerId: crypto.randomUUID(),
        handle: "Alice",
        difficulty: "medium",
      });
      expect(room.state.difficulty).toBe("medium");
    });
  });

  it("second hello with different difficulty is rejected", async () => {
    await withRoom("test-reject-" + crypto.randomUUID(), async (room) => {
      await room.handleHello(makeConn(), {
        type: "hello",
        playerId: crypto.randomUUID(),
        handle: "A",
        difficulty: "medium",
      });
      const conn2 = makeConn();
      const p2 = crypto.randomUUID();
      await room.handleHello(conn2, {
        type: "hello",
        playerId: p2,
        handle: "B",
        difficulty: "hard",
      });
      const err = conn2.sent.find((m) => m.type === "error");
      expect(err).toBeTruthy();
      expect(err.code).toBe("BAD_DIFFICULTY");
      expect(room.state.players.find((p) => p.racerId === p2)).toBeUndefined();
    });
  });

  it("first arrival sets lone-timer deadline", async () => {
    await withRoom("test-lone-" + crypto.randomUUID(), async (room) => {
      const before = Date.now();
      const conn = makeConn();
      await room.handleHello(conn, {
        type: "hello",
        playerId: crypto.randomUUID(),
        handle: "A",
        difficulty: "medium",
      });
      expect(room.state.autoStartDeadline).toBeGreaterThanOrEqual(before + LONE_TIMEOUT_MS);
      expect(room.state.autoStartDeadline).toBeLessThanOrEqual(Date.now() + LONE_TIMEOUT_MS + 100);
      expect(room.state.gatherTriggered).toBe(false);
    });
  });

  it("second arrival triggers gather countdown", async () => {
    await withRoom("test-gather-" + crypto.randomUUID(), async (room) => {
      await room.handleHello(makeConn(), {
        type: "hello",
        playerId: crypto.randomUUID(),
        handle: "A",
        difficulty: "medium",
      });
      const before = Date.now();
      await room.handleHello(makeConn(), {
        type: "hello",
        playerId: crypto.randomUUID(),
        handle: "B",
        difficulty: "medium",
      });
      expect(room.state.gatherTriggered).toBe(true);
      expect(room.state.autoStartDeadline).toBeGreaterThanOrEqual(before + GATHER_WINDOW_MS);
    });
  });

  it("third arrival does NOT reset deadline", async () => {
    await withRoom("test-nodeadline-" + crypto.randomUUID(), async (room) => {
      await room.handleHello(makeConn(), {
        type: "hello",
        playerId: crypto.randomUUID(),
        handle: "A",
        difficulty: "medium",
      });
      await room.handleHello(makeConn(), {
        type: "hello",
        playerId: crypto.randomUUID(),
        handle: "B",
        difficulty: "medium",
      });
      const deadlineAfter2 = room.state.autoStartDeadline;
      await new Promise((r) => setTimeout(r, 5)); // ensure Date.now() advances
      await room.handleHello(makeConn(), {
        type: "hello",
        playerId: crypto.randomUUID(),
        handle: "C",
        difficulty: "medium",
      });
      expect(room.state.autoStartDeadline).toBe(deadlineAfter2);
    });
  });

  it("reconnect hello does NOT reset the lone-timer deadline", async () => {
    await withRoom("test-reconnect-" + crypto.randomUUID(), async (room) => {
      const playerId = crypto.randomUUID();
      await room.handleHello(makeConn(), {
        type: "hello",
        playerId,
        handle: "A",
        difficulty: "medium",
      });
      const firstDeadline = room.state.autoStartDeadline;
      expect(firstDeadline).toBeGreaterThan(0);
      // Simulate a brief network blip — player reconnects with the same id.
      await new Promise((r) => setTimeout(r, 10));
      await room.handleHello(makeConn(), {
        type: "hello",
        playerId,
        handle: "A",
        difficulty: "medium",
      });
      expect(room.state.autoStartDeadline).toBe(firstDeadline);
    });
  });

  it("seventh hello is rejected with ROOM_FULL", async () => {
    await withRoom("test-seventh-" + crypto.randomUUID(), async (room) => {
      for (let i = 1; i <= 6; i++) {
        await room.handleHello(makeConn(), {
          type: "hello",
          playerId: crypto.randomUUID(),
          handle: `H${i}`,
          difficulty: "medium",
        });
      }
      expect(room.state.players.length).toBe(6);
      const conn7 = makeConn();
      await room.handleHello(conn7, {
        type: "hello",
        playerId: crypto.randomUUID(),
        handle: "H7",
        difficulty: "medium",
      });
      const err = conn7.sent.find((m) => m.type === "error");
      expect(err).toBeTruthy();
      expect(err.code).toBe("ROOM_FULL");
      expect(room.state.players.length).toBe(6);
    });
  });

  it("sixth arrival sets deadline to now (immediate fire) and releases router", async () => {
    await withRoom("test-sixth-" + crypto.randomUUID(), async (room) => {
      // Lock difficulty up front so all hellos are consistent.
      room.state.difficulty = "medium";
      for (let i = 1; i <= 5; i++) {
        await room.handleHello(makeConn(), {
          type: "hello",
          playerId: crypto.randomUUID(),
          handle: `H${i}`,
          difficulty: "medium",
        });
      }
      const before = Date.now();
      await room.handleHello(makeConn(), {
        type: "hello",
        playerId: crypto.randomUUID(),
        handle: "H6",
        difficulty: "medium",
      });
      expect(room.state.autoStartDeadline).toBeLessThanOrEqual(Date.now());
      expect(room.state.autoStartDeadline).toBeGreaterThanOrEqual(before);
      expect(room.releaseCalls.length).toBeGreaterThan(0);
    });
  });
});

describe("PublicRaceRoom.removePlayer", () => {
  async function withRoomNPlayers(name, n, fn) {
    return withRoom(name, async (room) => {
      room.state.difficulty = "easy";
      const playerIds = [];
      for (let i = 0; i < n; i++) {
        await room.handleHello(makeConn(), {
          type: "hello",
          playerId: crypto.randomUUID(),
          handle: `Player${i + 1}`,
          difficulty: "medium",
        });
        // The room mints its own ephemeral broadcast id; that — not the racerId
        // the client sent — is what removePlayer and the wire messages key on.
        playerIds.push(room.state.players.at(-1).id);
      }
      return fn(room, playerIds);
    });
  }

  it("last player leaving lobby releases LobbyRouter", async () => {
    await withRoomNPlayers("test-release-" + crypto.randomUUID(), 1, async (room, [pid]) => {
      await room.removePlayer(pid);
      expect(room.releaseCalls.length).toBeGreaterThan(0);
    });
  });

  it("last player leaving clears autoStartDeadline and resets gatherTriggered", async () => {
    await withRoomNPlayers("test-clear-deadline-" + crypto.randomUUID(), 1, async (room, [pid]) => {
      // Ensure deadline and gatherTriggered are set before removal.
      room.state.autoStartDeadline = Date.now() + 10000;
      room.state.gatherTriggered = true;
      await room.removePlayer(pid);
      expect(room.state.autoStartDeadline).toBeNull();
      expect(room.state.gatherTriggered).toBe(false);
    });
  });

  it("non-last player leaving does not give isCreator to remaining player", async () => {
    await withRoomNPlayers("test-no-promote-" + crypto.randomUUID(), 2, async (room, [pid1, pid2]) => {
      await room.removePlayer(pid1);
      // pid2 should still be in the room but must NOT have isCreator set.
      const remaining = room.state.players.find((p) => p.id === pid2);
      expect(remaining).toBeDefined();
      expect(remaining.isCreator).toBeFalsy();
    });
  });

  it("last player leaving does not release router when difficulty is null", async () => {
    await withRoom("test-no-difficulty-" + crypto.randomUUID(), async (room) => {
      // Simulate a misrouted connection that landed on a room whose name has
      // no valid difficulty prefix: difficulty stays null. removePlayer must
      // not try to call into a LobbyRouter for a non-existent difficulty.
      room.state.difficulty = null;
      const pid = crypto.randomUUID();
      room.state.players.push({
        id: pid, handle: "Solo", isCreator: false, joinedAt: Date.now(),
        score: 0, finishMs: null, dropped: false, dnf: false,
      });
      await room.removePlayer(pid);
      expect(room.releaseCalls.length).toBe(0);
    });
  });
});

describe("PublicRaceRoom.isRaceComplete", () => {
  it("returns true when all humans done, ignoring mid-race bots", async () => {
    await withRoom("test-ircomplete-bots-" + crypto.randomUUID(), async (room) => {
      room.state.raceLength = 10;
      room.state.state = "racing";
      room.state.players = [
        { id: "h-1", isBot: false, score: 10, dropped: false, finishMs: 1234 },
        { id: "b-1", isBot: true, score: 3, dropped: false, finishMs: null },
        { id: "b-2", isBot: true, score: 0, dropped: false, finishMs: null },
      ];
      expect(room.isRaceComplete()).toBe(true);
    });
  });

  it("returns false when at least one human is mid-race", async () => {
    await withRoom("test-ircomplete-human-" + crypto.randomUUID(), async (room) => {
      room.state.raceLength = 10;
      room.state.state = "racing";
      room.state.players = [
        { id: "h-1", isBot: false, score: 7, dropped: false, finishMs: null },
        { id: "h-2", isBot: false, score: 10, dropped: false, finishMs: 999 },
        { id: "b-1", isBot: true, score: 10, dropped: false, finishMs: 500 },
      ];
      expect(room.isRaceComplete()).toBe(false);
    });
  });

  it("treats dropped humans as done", async () => {
    await withRoom("test-ircomplete-dropped-" + crypto.randomUUID(), async (room) => {
      room.state.raceLength = 10;
      room.state.state = "racing";
      room.state.players = [
        { id: "h-1", isBot: false, score: 4, dropped: true, finishMs: null },
        { id: "h-2", isBot: false, score: 10, dropped: false, finishMs: 999 },
      ];
      expect(room.isRaceComplete()).toBe(true);
    });
  });
});

import { computeBotTimelines } from "../public/src/bot-timeline.js";
import { RACE_MAX_MS_PER_PROBLEM } from "./room.js";

describe("PublicRaceRoom auto-start sequence", () => {
  it("fires auto-start when autoStartDeadline elapses: bots added, router released, state→countdown", async () => {
    await withRoom("test-autostart-" + crypto.randomUUID(), async (room) => {
      const playerId = crypto.randomUUID();
      const conn = makeConn();
      await room.handleHello(conn, { type: "hello", playerId, handle: "A", difficulty: "medium" });
      // Force the deadline into the past.
      room.state.autoStartDeadline = Date.now() - 10;
      await room.onAlarm();
      expect(room.state.state).toBe("countdown");
      expect(room.state.players.length).toBe(6); // 1 human + 5 bots
      const bots = room.state.players.filter((p) => p.isBot);
      expect(bots.length).toBe(5);
      expect(typeof room.state.botSeed).toBe("number");
      expect(room.state.botTiers.length).toBe(5);
      expect(room.state.autoStartDeadline).toBeNull();
      expect(room.releaseCalls.length).toBeGreaterThan(0);
    });
  });

  it("gives bots human-style handles that blend in (no Bot- prefix, unique, no clash with humans)", async () => {
    await withRoom("test-bothandles-" + crypto.randomUUID(), async (room) => {
      const playerId = crypto.randomUUID();
      await room.handleHello(makeConn(), { type: "hello", playerId, handle: "BraveOtter", difficulty: "medium" });
      room.state.autoStartDeadline = Date.now() - 10;
      await room.onAlarm();
      const bots = room.state.players.filter((p) => p.isBot);
      expect(bots.length).toBe(5);
      const handles = bots.map((b) => b.handle);
      for (const h of handles) {
        expect(h).not.toMatch(/bot/i);
        expect(h).not.toMatch(/easy|medium|hard/i);
        // Adjective+Animal shape, optional numeric fallback suffix.
        expect(h).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+\d*$/);
      }
      // Unique among bots and distinct from the human's handle.
      expect(new Set(handles).size).toBe(handles.length);
      expect(handles).not.toContain("BraveOtter");
    });
  });

  it("computes botTimelines when countdown→racing transition fires", async () => {
    await withRoom("test-timeline-" + crypto.randomUUID(), async (room) => {
      const playerId = crypto.randomUUID();
      await room.handleHello(makeConn(), { type: "hello", playerId, handle: "A", difficulty: "medium" });
      room.state.autoStartDeadline = Date.now() - 10;
      await room.onAlarm();
      // Drive countdown ticks to completion by advancing the alarm.
      while (room.state.state === "countdown") {
        room.state.countdownAt = Date.now() - 10;
        await room.onAlarm();
      }
      expect(room.state.state).toBe("racing");
      expect(room.state.botTimelines.length).toBe(5);
      for (const tl of room.state.botTimelines) expect(tl.length).toBe(room.state.raceLength);
    });
  });

  it("computed botTimelines match the pure helper", async () => {
    await withRoom("test-match-" + crypto.randomUUID(), async (room) => {
      const playerId = crypto.randomUUID();
      await room.handleHello(makeConn(), { type: "hello", playerId, handle: "A", difficulty: "medium" });
      room.state.autoStartDeadline = Date.now() - 10;
      await room.onAlarm();
      while (room.state.state === "countdown") {
        room.state.countdownAt = Date.now() - 10;
        await room.onAlarm();
      }
      const expected = computeBotTimelines({
        botSeed: room.state.botSeed,
        botTiers: room.state.botTiers,
        difficulty: room.state.difficulty,
        raceLength: room.state.raceLength,
      });
      expect(room.state.botTimelines).toEqual(expected);
    });
  });
});

describe("PublicRaceRoom bot timelines — one write, self-healing", () => {
  it("lands the timelines in the same storage write as the racing snapshot", async () => {
    const stub = env.PublicRaceRoom.get(env.PublicRaceRoom.idFromName("m-onewrite-" + crypto.randomUUID()));
    await runInDurableObject(stub, async (room, ctx) => {
      if (!room.state) await room.onStart();
      room.broadcast = () => {};
      room.broadcastState = () => {};
      room.getConnections = () => [];
      room.releaseLobby = async () => {};
      await room.handleHello(makeConn(), {
        type: "hello", playerId: crypto.randomUUID(), handle: "A", difficulty: "medium",
      });
      room.state.autoStartDeadline = Date.now() - 10;
      await room.onAlarm();
      // Drive to the last countdown tick, then watch the transition wake.
      while (room.state.state === "countdown" && room.state.countdownN > 0) {
        room.state.countdownAt = Date.now() - 10;
        await room.onAlarm();
      }
      const put = vi.spyOn(ctx.storage, "put");
      try {
        room.state.countdownAt = Date.now() - 10;
        await room.onAlarm();
        expect(room.state.state).toBe("racing");
        // One write, and it already holds the timelines: there is no
        // racing-with-empty-timelines snapshot for a restart to strand on.
        expect(put).toHaveBeenCalledTimes(1);
        const stored = await ctx.storage.get("state");
        expect(stored.state).toBe("racing");
        expect(stored.botTimelines.length).toBe(5);
      } finally {
        put.mockRestore();
        await ctx.storage.deleteAlarm();
      }
    });
  });

  it("re-derives timelines a lost write dropped, before finishRace reads them", async () => {
    await withRoom("test-timeline-heal-" + crypto.randomUUID(), async (room) => {
      const broadcasts = [];
      room.broadcast = (s) => broadcasts.push(JSON.parse(s));
      await room.handleHello(makeConn(), {
        type: "hello", playerId: crypto.randomUUID(), handle: "A", difficulty: "medium",
      });
      room.state.autoStartDeadline = Date.now() - 10;
      await room.onAlarm();
      while (room.state.state === "countdown") {
        room.state.countdownAt = Date.now() - 10;
        await room.onAlarm();
      }
      expect(room.state.state).toBe("racing");

      // What an older build could leave behind: a racing snapshot whose
      // timelines never landed (the second write died with the DO).
      room.state.botTimelines = [];
      await room.persist();
      broadcasts.length = 0;

      // The next wake — here the race ceiling — must heal the timelines before
      // finishRace reads them, or every bot of the match records score 0.
      room.state.raceStartedAt = Date.now() - (RACE_MAX_MS_PER_PROBLEM * room.state.raceLength + 1000);
      await room.onAlarm();

      expect(room.state.state).toBe("finished");
      expect(broadcasts.some((m) => m.type === "bot-timelines")).toBe(true);
      const finish = broadcasts.find((m) => m.type === "finish");
      expect(finish).toBeTruthy();
      const bots = finish.rankings.filter((p) => p.isBot);
      expect(bots.length).toBe(5);
      for (const b of bots) {
        expect(b.score).toBe(room.state.raceLength);
        expect(b.finishMs).toBeGreaterThan(0);
      }
    });
  });
});

describe("PublicRaceRoom.finishRace — bot finalization", () => {
  it("finalizes bot scores from botTimelines at race end (captured in broadcast)", async () => {
    await withRoom("test-finish-room-" + crypto.randomUUID(), async (room) => {
      // Capture the 'finish' broadcast so we can inspect bot rankings.
      const broadcasts = [];
      room.broadcast = (s) => broadcasts.push(JSON.parse(s));
      room.state.raceLength = 10;
      room.state.raceStartedAt = 1000;
      room.state.state = "racing";
      room.state.botTimelines = [
        [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000],
        [200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000],
      ];
      room.state.players = [
        { id: "h-1", isBot: false, score: 10, dropped: false, finishMs: 1100, dnf: false },
        { id: "b-1", isBot: true, score: 0, dropped: false, finishMs: null, dnf: false },
        { id: "b-2", isBot: true, score: 0, dropped: false, finishMs: null, dnf: false },
      ];
      room.finishRace(1100);

      const finish = broadcasts.find((m) => m.type === "finish");
      expect(finish).toBeTruthy();
      const b1 = finish.rankings.find((p) => p.id === "b-1");
      const b2 = finish.rankings.find((p) => p.id === "b-2");
      expect(b1.score).toBe(10);
      expect(b1.finishMs).toBe(1000);
      expect(b1.dnf).toBe(false);
      expect(b2.score).toBe(5);
      expect(b2.finishMs).toBeNull();
      expect(b2.dnf).toBe(true);
      expect(room.state.state).toBe("finished");
    });
  });

  it("strips bots from state.players after finish so cleanup can fire", async () => {
    await withRoom("test-finish-strip-" + crypto.randomUUID(), async (room) => {
      room.state.raceLength = 10;
      room.state.raceStartedAt = 1000;
      room.state.state = "racing";
      room.state.botTimelines = [[100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]];
      room.state.players = [
        { id: "h-1", isBot: false, score: 10, dropped: false, finishMs: 1100, dnf: false },
        { id: "b-1", isBot: true, score: 0, dropped: false, finishMs: null, dnf: false },
      ];
      room.finishRace(1100);
      expect(room.state.players.length).toBe(1);
      expect(room.state.players[0].isBot).toBeFalsy();
    });
  });

  it("removing the last human in a finished room schedules idle cleanup", async () => {
    await withRoom("test-finish-cleanup-" + crypto.randomUUID(), async (room) => {
      room.state.raceLength = 10;
      room.state.raceStartedAt = 1000;
      room.state.state = "racing";
      room.state.botTimelines = [];
      const pid = crypto.randomUUID();
      room.state.players = [
        { id: pid, isBot: false, score: 10, dropped: false, finishMs: 1100, dnf: false },
      ];
      room.finishRace(1100);
      expect(room.state.state).toBe("finished");
      // Human leaves after the race.
      await room.removePlayer(pid);
      expect(room.state.players.length).toBe(0);
      expect(room.state.idleCleanupAt).toBeGreaterThan(Date.now());
    });
  });
});

describe("PublicRaceRoom — race_results persistence", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM race_results");
  });

  it("inserts one row per non-bot finisher with room_id set", async () => {
    const roomName = "test-results-" + crypto.randomUUID();
    await withRoom(roomName, async (room) => {
      // Set up state: 1 finished human + 1 dropped human + 1 bot.
      room.state.raceLength = 10;
      room.state.raceStartedAt = Date.now() - 10000;
      room.state.state = 'racing';
      room.state.botTimelines = [[100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]];
      room.state.players = [
        { id: 'h-1', handle: 'Alice', deviceId: 'dev-1', userId: null, isBot: false, score: 10, finishMs: 5000, dropped: false, dnf: false },
        { id: 'h-2', handle: 'Bob', deviceId: 'dev-2', userId: null, isBot: false, score: 4, finishMs: null, dropped: true, dnf: false },
        { id: 'b-1', isBot: true, tier: 'medium', score: 0, finishMs: null, dropped: false, dnf: false },
      ];

      await room.persistResults();

      // The prefix-stamped name is the actual room_id in race_results.
      const actualRoomId = room.name;
      const rows = await env.DB.prepare("SELECT * FROM race_results WHERE room_id = ?").bind(actualRoomId).all();
      expect(rows.results.length).toBe(2); // 1 finished + 1 dropped human; bot excluded
      const finished = rows.results.find((r) => r.device_id === 'dev-1');
      const dropped = rows.results.find((r) => r.device_id === 'dev-2');
      expect(finished.finished).toBe(1);
      expect(finished.finish_time_ms).toBe(5000);
      expect(finished.room_id).toBe(actualRoomId);
      expect(dropped.finished).toBe(0);
      expect(dropped.finish_time_ms).toBeNull();
      // A multiplayer race scores exactly like a solo one — same writer, same
      // formula. 10 correct in 5s = 120 ppm -> 10 x 120/60 = 20 points.
      expect(finished.points).toBeCloseTo(20, 6);
      // The player who dropped out did not finish, so there is nothing to score.
      expect(dropped.points).toBeNull();
    });
  });
});

describe("PublicRaceRoom.handleHello — identity stamping", () => {
  it("takes deviceId from the message but userId ONLY from connection state", async () => {
    await withRoom("test-stamp-room-" + crypto.randomUUID(), async (room) => {
      const playerId = crypto.randomUUID();
      const conn = makeConn();
      // connection.state.userId is set server-side from the cookie-derived
      // x-arithmetic-user-id header in onConnect — the trusted source.
      conn.state = { userId: "user-from-cookie" };
      await room.handleHello(conn, {
        type: "hello", playerId, handle: "A", difficulty: "medium",
        deviceId: "dev-stamp", userId: "user-spoofed",
      });
      const p = room.state.players.find((p) => p.racerId === playerId);
      expect(p.deviceId).toBe("dev-stamp");
      expect(p.userId).toBe("user-from-cookie");
    });
  });

  it("ignores a spoofed msg.userId for anonymous connections", async () => {
    await withRoom("test-spoof-room-" + crypto.randomUUID(), async (room) => {
      const playerId = crypto.randomUUID();
      await room.handleHello(makeConn(), {
        type: "hello", playerId, handle: "A", difficulty: "medium",
        deviceId: "dev-anon", userId: "victim-user-id",
      });
      const p = room.state.players.find((p) => p.racerId === playerId);
      expect(p.userId).toBeNull();
    });
  });
});

describe("PublicRaceRoom — disabled operations return BAD_STATE", () => {
  async function roomWithOnePlayer(name) {
    // Returns { room, conn } inside a withRoom callback — caller must be inside withRoom.
    // We return a factory so each test drives withRoom itself.
    throw new Error("use withRoomAndPlayer directly");
  }

  async function withRoomAndPlayer(name, fn) {
    return withRoom(name, async (room) => {
      const playerId = "p-" + crypto.randomUUID();
      const conn1 = makeConn();
      await room.handleHello(conn1, {
        type: "hello",
        playerId,
        handle: "Alice",
        difficulty: "medium",
      });
      // Build a conn whose state resolves to the player we just added.
      const conn = makeConn();
      conn.state = { playerId };
      return fn(room, conn);
    });
  }

  it("handleStartRace sends BAD_STATE", async () => {
    await withRoomAndPlayer("test-start-" + crypto.randomUUID(), async (room, conn) => {
      await room.handleStartRace(conn);
      const err = conn.sent.find((m) => m.type === "error");
      expect(err?.code).toBe("BAD_STATE");
    });
  });

  it("handleSetConfig sends BAD_STATE", async () => {
    await withRoomAndPlayer("test-config-" + crypto.randomUUID(), async (room, conn) => {
      await room.handleSetConfig(conn, { type: "set_config", difficulty: "hard" });
      const err = conn.sent.find((m) => m.type === "error");
      expect(err?.code).toBe("BAD_STATE");
    });
  });

  it("handleRematch sends BAD_STATE", async () => {
    await withRoomAndPlayer("test-rematch-" + crypto.randomUUID(), async (room, conn) => {
      await room.handleRematch(conn);
      const err = conn.sent.find((m) => m.type === "error");
      expect(err?.code).toBe("BAD_STATE");
    });
  });
});

import { publicPlayer } from "./room.js";

describe("publicPlayer — broadcast shape", () => {
  it("exposes isGuest instead of identity; bots read as guests", () => {
    const signedIn = publicPlayer({ id: "a", handle: "X", userId: "u1", deviceId: "d1", attempts: 3, currentStreak: 1, longestStreak: 2 });
    expect(signedIn.isGuest).toBe(false);
    expect(signedIn.userId).toBeUndefined();
    expect(signedIn.deviceId).toBeUndefined();
    expect(signedIn.attempts).toBeUndefined();

    const guest = publicPlayer({ id: "b", handle: "Y", userId: null, deviceId: "d2" });
    expect(guest.isGuest).toBe(true);

    const bot = publicPlayer({ id: "bot-1", handle: "Z", isBot: true });
    expect(bot.isGuest).toBe(true);
    expect(bot.isBot).toBe(true);
  });

  it("strips the racerId reconnect secret", () => {
    const secret = crypto.randomUUID();
    const p = publicPlayer({ id: "p-1", racerId: secret, handle: "X", userId: null });
    expect(p.racerId).toBeUndefined();
    expect(p.id).toBe("p-1");
    expect(JSON.stringify(p)).not.toContain(secret);
  });
});

// Quick Match seats up to 5 strangers together, so anything this room puts on
// the wire reaches all of them — including a socket that has not said hello.
// Two things must never ride along: deviceId (the anon-identity join key used
// by claim-on-signup) and racerId (the secret that reclaims a seat).
describe("PublicRaceRoom — broadcast identity hygiene", () => {
  it("never puts racerId/deviceId/userId on the wire, and keeps bot markers", async () => {
    await withRoom("test-privacy-" + crypto.randomUUID(), async (room) => {
      const wire = [];
      room.broadcast = (s) => wire.push(s);
      // Restore the real broadcastState (withRoom stubs it out) so `state`
      // pushes are checked by the same assertion as `finish`.
      delete room.broadcastState;
      const conns = [makeConn(), makeConn()];
      room.getConnections = () => conns;
      room.persistResults = async () => {};

      const aliceSecret = crypto.randomUUID();
      room.state.raceLength = 10;
      room.state.raceStartedAt = 1000;
      room.state.state = "racing";
      room.state.botTimelines = [[100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]];
      const aliceConnId = "sock-" + crypto.randomUUID();
      room.state.players = [
        { id: "p-1", racerId: aliceSecret, connId: aliceConnId, handle: "Alice", isBot: false, deviceId: "dev-alice", userId: "user-alice", score: 10, dropped: false, finishMs: 1100, dnf: false, attempts: 12, currentStreak: 3, longestStreak: 5 },
        { id: "p-2", racerId: crypto.randomUUID(), connId: "sock-" + crypto.randomUUID(), handle: "Bob", isBot: false, deviceId: "dev-bob", userId: null, score: 4, dropped: false, finishMs: null, dnf: false, attempts: 6, currentStreak: 0, longestStreak: 1 },
        { id: "bot-1", handle: "Zed", isBot: true, tier: "strong", score: 0, dropped: false, finishMs: null, dnf: false },
      ];

      room.broadcastState();
      room.finishRace(1100);

      const payloads = [...wire, ...conns.flatMap((c) => c.sent.map((m) => JSON.stringify(m)))];
      const messages = payloads.map((p) => JSON.parse(p));
      expect(messages.some((m) => m.type === "state")).toBe(true);
      expect(messages.some((m) => m.type === "finish")).toBe(true);

      for (const raw of payloads) {
        expect(raw).not.toMatch(/"racerId"/);
        expect(raw).not.toMatch(/"deviceId"/);
        expect(raw).not.toMatch(/"userId"/);
        // Server-only seat bookkeeping: publicPlayer must strip it, or it
        // rides ...rest to all five strangers in the match.
        expect(raw).not.toMatch(/"connId"/);
        expect(raw).not.toContain(aliceSecret);
        expect(raw).not.toContain(aliceConnId);
        expect(raw).not.toMatch(/dev-alice|dev-bob|user-alice/);
      }

      // Bot markers are deliberately public — disclosure over concealment.
      const finish = messages.find((m) => m.type === "finish");
      const bot = finish.rankings.find((p) => p.id === "bot-1");
      expect(bot.isBot).toBe(true);
      expect(bot.tier).toBe("strong");
      // …and the rankings are still usable for the scoreboard.
      expect(finish.rankings.map((p) => p.handle).sort()).toEqual(["Alice", "Bob", "Zed"]);
      expect(finish.rankings.find((p) => p.id === "p-1").isGuest).toBe(false);
      expect(finish.rankings.find((p) => p.id === "p-2").isGuest).toBe(true);
    });
  });
});

describe("PublicRaceRoom.handleHello — seat ownership", () => {
  it("a stranger replaying a broadcast id cannot take over the seat", async () => {
    await withRoom("test-hijack-" + crypto.randomUUID(), async (room) => {
      const victimConn = makeConn();
      victimConn.state = { userId: "victim-user" };
      await room.handleHello(victimConn, {
        type: "hello", playerId: crypto.randomUUID(), handle: "Victim",
        deviceId: "victim-device", difficulty: "medium",
      });
      const victim = room.state.players[0];

      const attacker = makeConn();
      attacker.state = { userId: "attacker-user" };
      await room.handleHello(attacker, {
        type: "hello", playerId: victim.id, handle: "Attacker",
        deviceId: "attacker-device", difficulty: "medium",
      });

      expect(attacker.sent.find((m) => m.type === "error")?.code).toBe("INVALID_INPUT");
      expect(room.state.players.length).toBe(1);
      expect(victim.deviceId).toBe("victim-device");
      expect(victim.userId).toBe("victim-user");
    });
  });

  it("a hello with an unknown secret is a new joiner, so the ROOM_FULL gate applies", async () => {
    // The old lookup let any hello quoting a seated player's id skip this gate
    // entirely by landing on the reconnect branch.
    await withRoom("test-hijack-full-" + crypto.randomUUID(), async (room) => {
      for (let i = 1; i <= MAX_PLAYERS; i++) {
        await room.handleHello(makeConn(), {
          type: "hello", playerId: crypto.randomUUID(), handle: `H${i}`,
          deviceId: `dev-${i}`, difficulty: "medium",
        });
      }
      const seated = room.state.players.map((p) => p.id);
      const attacker = makeConn();
      await room.handleHello(attacker, {
        type: "hello", playerId: crypto.randomUUID(), handle: "Attacker",
        deviceId: "attacker-device", difficulty: "medium",
      });
      expect(attacker.sent.find((m) => m.type === "error")?.code).toBe("ROOM_FULL");
      expect(room.state.players.map((p) => p.id)).toEqual(seated);
    });
  });

  it("a reconnect with the right secret still skips the auto-start reset and the full gate", async () => {
    await withRoom("test-reconnect-full-" + crypto.randomUUID(), async (room) => {
      const secrets = [];
      for (let i = 1; i <= MAX_PLAYERS; i++) {
        const secret = crypto.randomUUID();
        secrets.push(secret);
        await room.handleHello(makeConn(), {
          type: "hello", playerId: secret, handle: `H${i}`,
          deviceId: `dev-${i}`, difficulty: "medium",
        });
      }
      const seatId = room.state.players[0].id;
      const deadline = room.state.autoStartDeadline;

      const back = makeConn();
      await room.handleHello(back, {
        type: "hello", playerId: secrets[0], handle: "H1",
        deviceId: "dev-1-new", difficulty: "medium",
      });

      expect(back.sent.some((m) => m.type === "error")).toBe(false);
      expect(back.sent.find((m) => m.type === "hello-ack").playerId).toBe(seatId);
      expect(room.state.players.length).toBe(MAX_PLAYERS);
      expect(room.state.players[0].id).toBe(seatId);
      expect(room.state.players[0].deviceId).toBe("dev-1-new");
      expect(room.state.autoStartDeadline).toBe(deadline);
    });
  });

  it("a rejected hello does not push out the lone player's auto-start deadline", async () => {
    // A hello the base handler refuses seats nobody, so the bookkeeping after
    // it must not run. Otherwise anyone can hold a lone player in the lobby
    // indefinitely by re-sending a rejected hello every few seconds (bug_002).
    await withRoom("test-rejected-hello-" + crypto.randomUUID(), async (room) => {
      await room.handleHello(makeConn(), {
        type: "hello", playerId: crypto.randomUUID(), handle: "Alone",
        deviceId: "dev-1", difficulty: "medium",
      });
      const deadline = room.state.autoStartDeadline;
      expect(deadline).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 5)); // ensure Date.now() advances

      // A broadcast id is not a UUID, so this is rejected outright.
      const attacker = makeConn();
      await room.handleHello(attacker, {
        type: "hello", playerId: room.state.players[0].id, handle: "Nudge",
        deviceId: "attacker-device", difficulty: "medium",
      });

      expect(attacker.sent.find((m) => m.type === "error")?.code).toBe("INVALID_INPUT");
      expect(room.state.players.length).toBe(1);
      expect(room.state.autoStartDeadline).toBe(deadline);
    });
  });
});

import { BOT_TIER_NAMES } from "../public/src/bot.js";

describe("Quick Match state broadcast — bot markers stay on the wire", () => {
  // Bot backfill is disclosed in the UI copy, not hidden from the client, so
  // the real `state` message a Quick Match player receives must still carry
  // isBot/tier for every backfilled lane (while identity stays stripped).
  it("sends isBot/tier for backfilled bots and no identity fields", async () => {
    const stub = env.PublicRaceRoom.get(env.PublicRaceRoom.idFromName("m-test-wire-" + crypto.randomUUID()));
    const players = await runInDurableObject(stub, async (room) => {
      if (!room.state) await room.onStart();
      room.releaseLobby = async () => {};

      // Real broadcastState/publicState run here — only the socket is faked.
      const conn = makeConn();
      room.getConnections = () => [conn];

      const playerId = crypto.randomUUID();
      await room.handleHello(conn, {
        type: "hello",
        playerId,
        handle: "Alice",
        difficulty: "medium",
        deviceId: "dev-alice",
      });

      room.state.autoStartDeadline = Date.now() - 10;
      await room.onAlarm();

      const state = conn.sent.filter((m) => m.type === "state").at(-1);
      const bots = state.state.players.filter((p) => p.isBot);
      const humans = state.state.players.filter((p) => !p.isBot);
      expect(humans.map((p) => p.handle)).toEqual(["Alice"]);
      expect(bots.length).toBe(5);
      for (const b of bots) {
        expect(b.isBot).toBe(true);
        expect(BOT_TIER_NAMES).toContain(b.tier);
        expect(b.deviceId).toBeUndefined();
        expect(b.userId).toBeUndefined();
      }
      return state.state.players;
    });

    // Printed so the wire payload itself is reviewable evidence.
    console.log("[wire] state.players =", JSON.stringify(players, null, 2));
  });
});

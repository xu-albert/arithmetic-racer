import { describe, it, expect, beforeEach } from "vitest";
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

function makeConn() {
  return {
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
      expect(room.state.players.find((p) => p.id === p2)).toBeUndefined();
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
        const pid = crypto.randomUUID();
        playerIds.push(pid);
        await room.handleHello(makeConn(), {
          type: "hello",
          playerId: pid,
          handle: `Player${i + 1}`,
          difficulty: "medium",
        });
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
    // Mirror migration so the test D1 has the room_id column.
    await env.DB.exec(
      "CREATE TABLE IF NOT EXISTS race_results (" +
        "id TEXT PRIMARY KEY, user_id TEXT, device_id TEXT NOT NULL, " +
        "difficulty TEXT NOT NULL CHECK (difficulty IN ('easy','medium','hard')), " +
        "finished INTEGER NOT NULL CHECK (finished IN (0,1)), finish_time_ms INTEGER, " +
        "problems_total INTEGER NOT NULL DEFAULT 20, problems_correct INTEGER NOT NULL, " +
        "problems_attempted INTEGER NOT NULL, avg_time_per_problem_ms INTEGER NOT NULL, " +
        "accuracy_pct REAL NOT NULL, longest_streak INTEGER NOT NULL, played_at INTEGER NOT NULL, " +
        "room_id TEXT)"
    );
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
      const p = room.state.players.find((p) => p.id === playerId);
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
      const p = room.state.players.find((p) => p.id === playerId);
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
});

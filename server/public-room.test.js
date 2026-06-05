import { describe, it, expect } from "vitest";
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
async function withRoom(name, fn) {
  const stub = env.PublicRaceRoom.get(env.PublicRaceRoom.idFromName(name));
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
        difficulty: "easy",
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
        difficulty: "easy",
      });
      const before = Date.now();
      await room.handleHello(makeConn(), {
        type: "hello",
        playerId: crypto.randomUUID(),
        handle: "B",
        difficulty: "easy",
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
        difficulty: "easy",
      });
      await room.handleHello(makeConn(), {
        type: "hello",
        playerId: crypto.randomUUID(),
        handle: "B",
        difficulty: "easy",
      });
      const deadlineAfter2 = room.state.autoStartDeadline;
      await new Promise((r) => setTimeout(r, 5)); // ensure Date.now() advances
      await room.handleHello(makeConn(), {
        type: "hello",
        playerId: crypto.randomUUID(),
        handle: "C",
        difficulty: "easy",
      });
      expect(room.state.autoStartDeadline).toBe(deadlineAfter2);
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
        difficulty: "easy",
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

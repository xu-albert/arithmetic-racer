import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { isValidHandle, MAX_HANDLE_LEN } from "./room.js";
import { generateRoomId } from "./room-id.js";
import { ADJECTIVES, ANIMALS } from "../public/src/handles.js";
import { containsProfanity } from "../worker/username-validator.js";

describe("isValidHandle — profanity screening", () => {
  it("rejects a profane handle", () => {
    expect(isValidHandle("shit")).toBe(false);
  });

  it("rejects profanity embedded in a longer handle", () => {
    expect(isValidHandle("SuperShitLord")).toBe(false);
  });

  it("rejects obfuscated profanity", () => {
    // obscenity's recommended transformers fold leetspeak/spacing tricks.
    expect(isValidHandle("sh1t")).toBe(false);
  });

  it("still accepts an ordinary handle", () => {
    expect(isValidHandle("BraveOtter")).toBe(true);
  });

  it("still accepts handles with punctuation and emoji", () => {
    // Pre-existing behavior: punctuation/emoji are deliberately allowed.
    expect(isValidHandle("Otter_99!")).toBe(true);
    expect(isValidHandle("🦦 Otter")).toBe(true);
  });

  it("still enforces the pre-existing length and control-char rules", () => {
    expect(isValidHandle("")).toBe(false);
    expect(isValidHandle("a".repeat(MAX_HANDLE_LEN + 1))).toBe(false);
    expect(isValidHandle("bad\nhandle")).toBe(false);
  });
});

describe("containsProfanity", () => {
  it("flags profanity", () => {
    expect(containsProfanity("shit")).toBe(true);
  });

  it("passes clean text", () => {
    expect(containsProfanity("BraveOtter")).toBe(false);
  });

  it("does not trip on innocent words containing profane substrings", () => {
    // The Scunthorpe problem. These must stay valid handles.
    for (const clean of ["assassin", "Scunthorpe", "classic", "Cassidy", "grass", "analysis", "Bassett"]) {
      expect(containsProfanity(clean), clean).toBe(false);
    }
  });

  it("does not trip on the double-i mushroom spelling", () => {
    // The library whitelists "shitake" (single i) but its blacklist
    // collapse-transforms make "shiitake" match a banned term anyway; the
    // matcher adds the double-i spelling to the whitelist. Regression test
    // for the flagship review finding on the username gate — the same
    // shared matcher screens room handles here.
    for (const clean of ["shiitake", "MyShiitake", "MushroomShiitake"]) {
      expect(containsProfanity(clean), clean).toBe(false);
    }
    // Surgical: profanity next to the whitelisted word is still caught.
    expect(containsProfanity("ShiitakeShit")).toBe(true);
  });

  it("documents the accepted gap: all-lowercase run-on words are not caught", () => {
    // No boundary exists to split on, and substring matching would reject the
    // innocent words above. Deliberate trade-off — see splitWordBoundaries.
    expect(containsProfanity("supershitlord")).toBe(false);
  });

  it("treats non-strings as clean rather than throwing", () => {
    expect(containsProfanity(null)).toBe(false);
    expect(containsProfanity(undefined)).toBe(false);
    expect(containsProfanity(42)).toBe(false);
  });
});

// Regression guard, not a red-green test: today zero of the generated
// combinations are profane, so this passes on the current word lists. Its
// job is to fail loudly if someone later adds a word to ADJECTIVES/ANIMALS
// that combines into something profane — which is cheaper and more complete
// than filtering at generation time, since it proves the property for every
// possible output rather than the handful a runtime check would ever see.
describe("generated identifiers are profanity-free by construction", () => {
  it("no adjective/animal/animal room slug is profane", () => {
    const offenders = [];
    for (const adj of ADJECTIVES) {
      for (const a1 of ANIMALS) {
        for (const a2 of ANIMALS) {
          if (a1 === a2) continue;
          const slug = `${adj}-${a1}-${a2}`.toLowerCase();
          if (containsProfanity(slug)) offenders.push(slug);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no adjective/animal guest handle is profane", () => {
    const offenders = [];
    for (const adj of ADJECTIVES) {
      for (const ani of ANIMALS) {
        if (containsProfanity(`${adj}${ani}`)) offenders.push(`${adj}${ani}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every generated room slug passes the handle validator", () => {
    let rngState = 0;
    const rng = () => ((rngState = (rngState * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 200; i++) {
      expect(containsProfanity(generateRoomId(rng))).toBe(false);
    }
  });
});

function makeConn() {
  return {
    id: "sock-" + crypto.randomUUID(),
    sent: [],
    state: undefined,
    send(s) { this.sent.push(JSON.parse(s)); },
    setState(s) { this.state = s; },
  };
}

async function withRoom(name, fn) {
  const stub = env.RaceRoom.get(env.RaceRoom.idFromName(name));
  return runInDurableObject(stub, async (instance) => {
    if (!instance.state) await instance.onStart();
    instance.broadcast = () => {};
    instance.broadcastState = () => {};
    instance.getConnections = () => [];
    return fn(instance);
  });
}

describe("handleSetHandle — profanity", () => {
  it("rejects a profane handle and leaves the existing one intact", async () => {
    await withRoom("profanity-set-" + crypto.randomUUID(), async (room) => {
      const conn = makeConn();
      const playerId = crypto.randomUUID();
      room.state.players.push({
        id: playerId, handle: "BraveOtter", score: 0, attempts: 0,
        currentStreak: 0, longestStreak: 0, deviceId: null, userId: null,
      });
      conn.state = { playerId };
      room.playerFor = () => room.state.players.find((p) => p.id === playerId);

      await room.handleSetHandle(conn, { type: "set-handle", handle: "shit" });

      const player = room.state.players.find((p) => p.id === playerId);
      expect(player.handle).toBe("BraveOtter");
      const errors = conn.sent.filter((m) => m.type === "error");
      expect(errors.length).toBe(1);
      expect(errors[0].code).toBe("INVALID_INPUT");
    });
  });

  it("explains WHY a profane handle was rejected", async () => {
    // Folding the screen into isValidHandle means the generic shape message
    // would otherwise claim the handle was the wrong length.
    await withRoom("profanity-msg-" + crypto.randomUUID(), async (room) => {
      const conn = makeConn();
      const playerId = crypto.randomUUID();
      room.state.players.push({
        id: playerId, handle: "BraveOtter", score: 0, attempts: 0,
        currentStreak: 0, longestStreak: 0, deviceId: null, userId: null,
      });
      conn.state = { playerId };
      room.playerFor = () => room.state.players.find((p) => p.id === playerId);

      await room.handleSetHandle(conn, { type: "set-handle", handle: "shit" });

      const [error] = conn.sent.filter((m) => m.type === "error");
      expect(error.message).not.toMatch(/24 chars|control chars/);
      expect(error.message).toMatch(/different handle/i);
    });
  });

  it("still reports a shape problem as a shape problem", async () => {
    await withRoom("shape-msg-" + crypto.randomUUID(), async (room) => {
      const conn = makeConn();
      const playerId = crypto.randomUUID();
      room.state.players.push({
        id: playerId, handle: "BraveOtter", score: 0, attempts: 0,
        currentStreak: 0, longestStreak: 0, deviceId: null, userId: null,
      });
      conn.state = { playerId };
      room.playerFor = () => room.state.players.find((p) => p.id === playerId);

      await room.handleSetHandle(conn, { type: "set-handle", handle: "x".repeat(99) });

      const [error] = conn.sent.filter((m) => m.type === "error");
      expect(error.message).toMatch(/24 chars/);
    });
  });

  it("still accepts a clean handle change", async () => {
    await withRoom("profanity-ok-" + crypto.randomUUID(), async (room) => {
      const conn = makeConn();
      const playerId = crypto.randomUUID();
      room.state.players.push({
        id: playerId, handle: "BraveOtter", score: 0, attempts: 0,
        currentStreak: 0, longestStreak: 0, deviceId: null, userId: null,
      });
      conn.state = { playerId };
      room.playerFor = () => room.state.players.find((p) => p.id === playerId);

      await room.handleSetHandle(conn, { type: "set-handle", handle: "SilentBadger" });

      expect(room.state.players.find((p) => p.id === playerId).handle).toBe("SilentBadger");
      expect(conn.sent.filter((m) => m.type === "error")).toEqual([]);
    });
  });
});

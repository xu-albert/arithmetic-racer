import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { handleMatchmakeJoin } from "./matchmake.js";

describe("matchmaking e2e — POST → router → PublicRaceRoom", () => {
  beforeEach(async () => {
    const list = await env.MATCHMAKING_LIMITS.list();
    for (const k of list.keys) await env.MATCHMAKING_LIMITS.delete(k.name);
    // Ensure race_results table exists with room_id column (for any DB checks).
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

  it("two POSTs with same difficulty return the same roomId", async () => {
    const r1 = await handleMatchmakeJoin(
      new Request("http://test/", {
        method: "POST",
        body: JSON.stringify({ difficulty: "medium", device_id: "dev-X" }),
        headers: { "content-type": "application/json" },
      }),
      env,
    );
    const r2 = await handleMatchmakeJoin(
      new Request("http://test/", {
        method: "POST",
        body: JSON.stringify({ difficulty: "medium", device_id: "dev-Y" }),
        headers: { "content-type": "application/json" },
      }),
      env,
    );
    const b1 = await r1.json();
    const b2 = await r2.json();
    expect(b1.roomId).toBe(b2.roomId);
  });

  it("different difficulties return different roomIds", async () => {
    const r1 = await handleMatchmakeJoin(
      new Request("http://test/", {
        method: "POST",
        body: JSON.stringify({ difficulty: "easy", device_id: "dev-X" }),
        headers: { "content-type": "application/json" },
      }),
      env,
    );
    const r2 = await handleMatchmakeJoin(
      new Request("http://test/", {
        method: "POST",
        body: JSON.stringify({ difficulty: "hard", device_id: "dev-Y" }),
        headers: { "content-type": "application/json" },
      }),
      env,
    );
    const b1 = await r1.json();
    const b2 = await r2.json();
    expect(b1.roomId).not.toBe(b2.roomId);
  });

  it("released router mints a new roomId on next pick", async () => {
    const stub = env.LobbyRouter.get(env.LobbyRouter.idFromName("medium"));
    const { roomId: first } = await stub.pick();
    await stub.release(first);
    const { roomId: second } = await stub.pick();
    expect(second).not.toBe(first);
  });
});

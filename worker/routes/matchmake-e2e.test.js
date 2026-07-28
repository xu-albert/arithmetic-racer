import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { handleMatchmakeJoin } from "./matchmake.js";

describe("matchmaking e2e — POST → router → PublicRaceRoom", () => {
  beforeEach(async () => {
    const list = await env.MATCHMAKING_LIMITS.list();
    for (const k of list.keys) await env.MATCHMAKING_LIMITS.delete(k.name);
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
    const { roomId: first } = await stub.pick("medium");
    await stub.release(first);
    const { roomId: second } = await stub.pick("medium");
    expect(second).not.toBe(first);
  });
});

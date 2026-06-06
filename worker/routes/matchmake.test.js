import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { handleMatchmakeJoin } from "./matchmake.js";

function makeReq(body) {
  return new Request("http://test.local/api/matchmake/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/matchmake/join", () => {
  beforeEach(async () => {
    const list = await env.MATCHMAKING_LIMITS.list();
    for (const k of list.keys) await env.MATCHMAKING_LIMITS.delete(k.name);
  });

  it("returns 200 with roomId for a valid request", async () => {
    const res = await handleMatchmakeJoin(makeReq({ difficulty: "medium", device_id: "dev-a" }), env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.roomId).toBeTruthy();
    expect(body.difficulty).toBe("medium");
    expect(body.mode).toBe("public");
  });

  it("rejects invalid difficulty with 400", async () => {
    const res = await handleMatchmakeJoin(makeReq({ difficulty: "extreme", device_id: "dev-a" }), env);
    expect(res.status).toBe(400);
  });

  it("rejects missing device_id with 400", async () => {
    const res = await handleMatchmakeJoin(makeReq({ difficulty: "medium" }), env);
    expect(res.status).toBe(400);
  });

  it("returns cached roomId when queue-lock is set", async () => {
    const res1 = await handleMatchmakeJoin(makeReq({ difficulty: "medium", device_id: "dev-b" }), env);
    const body1 = await res1.json();
    const res2 = await handleMatchmakeJoin(makeReq({ difficulty: "medium", device_id: "dev-b" }), env);
    const body2 = await res2.json();
    expect(body2.roomId).toBe(body1.roomId);
  });
});

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

  it("switching difficulty between calls returns a fresh prefixed roomId, not the cached one", async () => {
    const res1 = await handleMatchmakeJoin(makeReq({ difficulty: "easy", device_id: "dev-c" }), env);
    const body1 = await res1.json();
    expect(body1.roomId).toMatch(/^e-/);
    const res2 = await handleMatchmakeJoin(makeReq({ difficulty: "medium", device_id: "dev-c" }), env);
    const body2 = await res2.json();
    expect(body2.roomId).toMatch(/^m-/);
    expect(body2.roomId).not.toBe(body1.roomId);
  });

  it("returns 429 with Retry-After when rate limit exceeded", async () => {
    const dev = "dev-rl-exceed";
    // Seed the rate-limit counter at the cap so the next call trips the limit.
    await env.MATCHMAKING_LIMITS.put(`rl:${dev}`, "3", { expirationTtl: 60 });
    const res = await handleMatchmakeJoin(makeReq({ difficulty: "easy", device_id: dev }), env);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    const body = await res.json();
    expect(body.error).toBe("rate_limited");
  });
});

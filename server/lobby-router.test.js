import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";

function stub(name) {
  return env.LobbyRouter.get(env.LobbyRouter.idFromName(name));
}

describe("LobbyRouter", () => {
  let routerName;
  beforeEach(() => {
    routerName = "test-" + crypto.randomUUID();
  });

  it("pick() mints a new roomId when empty", async () => {
    const r = stub(routerName);
    const { roomId } = await r.pick();
    expect(typeof roomId).toBe("string");
    expect(roomId.length).toBeGreaterThan(0);
  });

  it("pick() returns the same roomId on subsequent calls", async () => {
    const r = stub(routerName);
    const { roomId: a } = await r.pick();
    const { roomId: b } = await r.pick();
    expect(a).toBe(b);
  });

  it("release(roomId) clears the current room; next pick mints a new one", async () => {
    const r = stub(routerName);
    const { roomId: a } = await r.pick();
    await r.release(a);
    const { roomId: b } = await r.pick();
    expect(b).not.toBe(a);
  });

  it("release(wrongId) is a no-op", async () => {
    const r = stub(routerName);
    const { roomId: a } = await r.pick();
    await r.release("not-the-current-room");
    const { roomId: b } = await r.pick();
    expect(b).toBe(a);
  });

  it("two routers with different names are independent", async () => {
    const r1 = stub("test-rt-" + crypto.randomUUID());
    const r2 = stub("test-rt-" + crypto.randomUUID());
    const { roomId: id1 } = await r1.pick();
    const { roomId: id2 } = await r2.pick();
    expect(id1).not.toBe(id2);
  });
});

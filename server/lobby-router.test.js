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

  it("pick(difficulty) mints a new roomId when empty", async () => {
    const r = stub(routerName);
    const { roomId } = await r.pick("medium");
    expect(typeof roomId).toBe("string");
    expect(roomId.length).toBeGreaterThan(0);
  });

  it("pick() prefixes the roomId with the difficulty letter", async () => {
    const e = stub("test-e-" + crypto.randomUUID());
    const m = stub("test-m-" + crypto.randomUUID());
    const h = stub("test-h-" + crypto.randomUUID());
    expect((await e.pick("easy")).roomId).toMatch(/^e-/);
    expect((await m.pick("medium")).roomId).toMatch(/^m-/);
    expect((await h.pick("hard")).roomId).toMatch(/^h-/);
  });

  // Note: LobbyRouter.pick throws on unknown difficulty as defense-in-depth.
  // The real validation guard lives at the route handler (matchmake.test.js
  // verifies '400 invalid_difficulty'). Asserting the DO throw here in
  // vitest-pool-workers produces a noisy unhandled-rejection log even when
  // the test passes, so the case is intentionally not covered here.

  it("pick() returns the same roomId on subsequent calls", async () => {
    const r = stub(routerName);
    const { roomId: a } = await r.pick("easy");
    const { roomId: b } = await r.pick("easy");
    expect(a).toBe(b);
  });

  it("release(roomId) clears the current room; next pick mints a new one", async () => {
    const r = stub(routerName);
    const { roomId: a } = await r.pick("easy");
    await r.release(a);
    const { roomId: b } = await r.pick("easy");
    expect(b).not.toBe(a);
  });

  it("release(wrongId) is a no-op", async () => {
    const r = stub(routerName);
    const { roomId: a } = await r.pick("easy");
    await r.release("not-the-current-room");
    const { roomId: b } = await r.pick("easy");
    expect(b).toBe(a);
  });

  it("two routers with different names are independent", async () => {
    const r1 = stub("test-rt-" + crypto.randomUUID());
    const r2 = stub("test-rt-" + crypto.randomUUID());
    const { roomId: id1 } = await r1.pick("easy");
    const { roomId: id2 } = await r2.pick("easy");
    expect(id1).not.toBe(id2);
  });
});

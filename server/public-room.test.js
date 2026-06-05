import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";

describe("PublicRaceRoom — scaffold", () => {
  it("class is exported and binding resolves", () => {
    expect(env.PublicRaceRoom).toBeDefined();
    const id = env.PublicRaceRoom.idFromName("test-scaffold-" + crypto.randomUUID());
    const stub = env.PublicRaceRoom.get(id);
    expect(stub).toBeDefined();
  });
});

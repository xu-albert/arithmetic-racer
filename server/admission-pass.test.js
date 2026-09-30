import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { ADMISSION_PASS_TTL_MS, issueAdmissionPass, verifyAdmissionPass } from "./admission-pass.js";

describe("admission passes", () => {
  it("binds a pass to room and mode and expires it", async () => {
    const now = 1_700_000_000_000;
    const pass = await issueAdmissionPass(env, "room-a", "private", now);
    expect(await verifyAdmissionPass(env, pass, { roomId: "room-a", mode: "private", now })).toBe(true);
    expect(await verifyAdmissionPass(env, pass, { roomId: "room-b", mode: "private", now })).toBe(false);
    expect(await verifyAdmissionPass(env, pass, { roomId: "room-a", mode: "public", now })).toBe(false);
    expect(await verifyAdmissionPass(env, pass, {
      roomId: "room-a", mode: "private", now: now + ADMISSION_PASS_TTL_MS,
    })).toBe(false);
  });

  it("rejects tampering", async () => {
    const pass = await issueAdmissionPass(env, "room-a", "public");
    const [version, payload, signature] = pass.split(".");
    const tampered = `${version}.${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}.${signature}`;
    expect(await verifyAdmissionPass(env, tampered, { roomId: "room-a", mode: "public" })).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { ADMISSION_PASS_TTL_MS, issueAdmissionPass, verifyAdmissionPass } from "./admission-pass.js";

const base64Url = (bytes) => btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

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

  it("signs with the deployed BETTER_AUTH_SECRET and nothing else", async () => {
    const prod = { BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET };
    const pass = await issueAdmissionPass(prod, "room-a", "private");
    expect(await verifyAdmissionPass(prod, pass, { roomId: "room-a", mode: "private" })).toBe(true);

    // A different auth secret is a different key.
    const rotated = { BETTER_AUTH_SECRET: `${env.BETTER_AUTH_SECRET}-rotated` };
    expect(await verifyAdmissionPass(rotated, pass, { roomId: "room-a", mode: "private" })).toBe(false);

    // The retired dedicated secret is not a source any more: without the auth
    // secret there is no key, so nothing is issued and nothing verifies.
    const dedicatedOnly = { ADMISSION_PASS_SECRET: "a-dedicated-admission-secret-0123456789" };
    await expect(issueAdmissionPass(dedicatedOnly, "room-a", "private")).rejects.toThrow();
    expect(await verifyAdmissionPass(dedicatedOnly, pass, { roomId: "room-a", mode: "private" })).toBe(false);
  });

  it("does not accept a pass signed with the auth secret itself", async () => {
    // Domain separation: an HMAC keyed directly by BETTER_AUTH_SECRET — the
    // key better-auth signs with — must not be a valid admission pass.
    const payload = base64Url(new TextEncoder().encode(JSON.stringify({
      roomId: "room-a", mode: "private", exp: Date.now() + ADMISSION_PASS_TTL_MS,
    })));
    const rawKey = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(env.BETTER_AUTH_SECRET),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", rawKey, new TextEncoder().encode(payload));
    const forged = `v1.${payload}.${base64Url(new Uint8Array(signature))}`;
    expect(await verifyAdmissionPass(env, forged, { roomId: "room-a", mode: "private" })).toBe(false);
  });
});

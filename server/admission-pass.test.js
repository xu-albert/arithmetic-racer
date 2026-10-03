import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { ADMISSION_PASS_TTL_MS, issueAdmissionPass, checkAdmissionPass } from "./admission-pass.js";

const base64Url = (bytes) => btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("admission passes", () => {
  it("binds a pass to room and mode, and tells fresh from stale", async () => {
    const now = 1_700_000_000_000;
    const pass = await issueAdmissionPass(env, "room-a", "private", now);
    expect(await checkAdmissionPass(env, pass, { roomId: "room-a", mode: "private", now })).toBe("fresh");
    expect(await checkAdmissionPass(env, pass, { roomId: "room-b", mode: "private", now })).toBeNull();
    expect(await checkAdmissionPass(env, pass, { roomId: "room-a", mode: "public", now })).toBeNull();
    // Expiry does not make a pass another room's or a forgery: it is still
    // this room's pass, only no longer one that may create the room.
    expect(await checkAdmissionPass(env, pass, {
      roomId: "room-a", mode: "private", now: now + ADMISSION_PASS_TTL_MS,
    })).toBe("stale");
  });

  it("rejects tampering and anything that is not a pass", async () => {
    const pass = await issueAdmissionPass(env, "room-a", "public");
    const [version, payload, signature] = pass.split(".");
    const tampered = `${version}.${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}.${signature}`;
    expect(await checkAdmissionPass(env, tampered, { roomId: "room-a", mode: "public" })).toBeNull();
    for (const junk of [null, undefined, "", "v1.x.y", "not-a-pass"]) {
      expect(await checkAdmissionPass(env, junk, { roomId: "room-a", mode: "public" })).toBeNull();
    }
  });

  it("signs with the deployed BETTER_AUTH_SECRET and nothing else", async () => {
    const prod = { BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET };
    const pass = await issueAdmissionPass(prod, "room-a", "private");
    expect(await checkAdmissionPass(prod, pass, { roomId: "room-a", mode: "private" })).toBe("fresh");

    // A different auth secret is a different key.
    const rotated = { BETTER_AUTH_SECRET: `${env.BETTER_AUTH_SECRET}-rotated` };
    expect(await checkAdmissionPass(rotated, pass, { roomId: "room-a", mode: "private" })).toBeNull();

    // The retired dedicated secret is not a source any more: without the auth
    // secret there is no key, so nothing is issued and nothing is admitted.
    const dedicatedOnly = { ADMISSION_PASS_SECRET: "a-dedicated-admission-secret-0123456789" };
    await expect(issueAdmissionPass(dedicatedOnly, "room-a", "private")).rejects.toThrow();
    expect(await checkAdmissionPass(dedicatedOnly, pass, { roomId: "room-a", mode: "private" })).toBeNull();
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
    expect(await checkAdmissionPass(env, forged, { roomId: "room-a", mode: "private" })).toBeNull();
  });
});

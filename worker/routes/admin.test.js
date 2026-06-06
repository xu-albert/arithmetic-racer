// Tests for the admin dashboard route. Runs under @cloudflare/vitest-pool-workers.
// Each test file gets its own ephemeral D1; we apply the user + race_results DDL
// inline in beforeAll (same pattern as me.test.js).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { timingSafeEqualStrings } from "./admin.js";

beforeAll(async () => {
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS "user" (` +
      `"id" text not null primary key, ` +
      `"name" text not null, ` +
      `"email" text not null unique, ` +
      `"emailVerified" integer not null, ` +
      `"image" text, ` +
      `"createdAt" date not null, ` +
      `"updatedAt" date not null, ` +
      `"username" text unique` +
      `)`
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS race_results (" +
      "id TEXT PRIMARY KEY, " +
      `user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL, ` +
      "device_id TEXT NOT NULL, " +
      "difficulty TEXT NOT NULL CHECK (difficulty IN ('easy','medium','hard')), " +
      "finished INTEGER NOT NULL CHECK (finished IN (0,1)), " +
      "finish_time_ms INTEGER, " +
      "problems_total INTEGER NOT NULL DEFAULT 20, " +
      "problems_correct INTEGER NOT NULL, " +
      "problems_attempted INTEGER NOT NULL, " +
      "avg_time_per_problem_ms INTEGER NOT NULL, " +
      "accuracy_pct REAL NOT NULL, " +
      "longest_streak INTEGER NOT NULL, " +
      "played_at INTEGER NOT NULL" +
      ")"
  );
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM race_results");
  await env.DB.exec(`DELETE FROM "user"`);
});

describe("timingSafeEqualStrings", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqualStrings("abc123", "abc123")).toBe(true);
  });
  it("returns false for different equal-length strings", () => {
    expect(timingSafeEqualStrings("abc123", "abc124")).toBe(false);
  });
  it("returns false for different-length strings", () => {
    expect(timingSafeEqualStrings("abc", "abc123")).toBe(false);
  });
  it("returns false when either side is empty", () => {
    expect(timingSafeEqualStrings("", "abc")).toBe(false);
    expect(timingSafeEqualStrings("abc", "")).toBe(false);
  });
  it("returns false when both sides are empty (no valid empty token)", () => {
    expect(timingSafeEqualStrings("", "")).toBe(false);
  });
});

describe("GET /admin/ token gate", () => {
  it("returns 404 when no token is provided", async () => {
    const { handleAdminIndex } = await import("./admin.js");
    const req = new Request("http://x/admin/");
    const res = await handleAdminIndex(req, { ...env, ADMIN_TOKEN: "expected-secret" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when token is wrong", async () => {
    const { handleAdminIndex } = await import("./admin.js");
    const req = new Request("http://x/admin/?token=wrong");
    const res = await handleAdminIndex(req, { ...env, ADMIN_TOKEN: "expected-secret" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when ADMIN_TOKEN is unset (no admin URL works)", async () => {
    const { handleAdminIndex } = await import("./admin.js");
    const req = new Request("http://x/admin/?token=anything");
    const res = await handleAdminIndex(req, { ...env, ADMIN_TOKEN: undefined });
    expect(res.status).toBe(404);
  });
});

describe("GET /admin/ happy path", () => {
  it("returns 200 HTML when token matches and DB is empty", async () => {
    const { handleAdminIndex } = await import("./admin.js");
    const req = new Request("http://x/admin/?token=expected-secret");
    const res = await handleAdminIndex(req, { ...env, ADMIN_TOKEN: "expected-secret" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("Arithmetic Racer");
    expect(body).toContain("admin");
  });
});

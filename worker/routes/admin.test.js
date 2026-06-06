// Tests for the admin dashboard route. Runs under @cloudflare/vitest-pool-workers.
// Each test file gets its own ephemeral D1; we apply the user + race_results DDL
// inline in beforeAll (same pattern as me.test.js).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { timingSafeEqualStrings } from "./admin.js";

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

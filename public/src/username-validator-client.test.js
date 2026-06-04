// Client username-validator tests. Runs under `node --test`.
// The client validator covers format + reserved only; banned-word checking
// is server-only (the browser cannot resolve the bare `obscenity` specifier
// without a bundler, and the server is authoritative anyway). The full set
// of cases — including banned-word checks — runs in the worker mirror at
// worker/username-validator.test.js.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { validateUsernameSync } from "./username-validator-client.js";

describe("validateUsernameSync — valid", () => {
  for (const name of ["BraveOtter", "xu_27", "albert", "User_123"]) {
    test(`accepts ${name}`, () => {
      assert.deepEqual(validateUsernameSync(name), { valid: true });
    });
  }
});

describe("validateUsernameSync — invalid_format", () => {
  const cases = [
    ["empty string", ""],
    ["too short (2 chars)", "ab"],
    ["too long (21 chars)", "a".repeat(21)],
    ["starts with digit", "1abc"],
    ["contains space", "has space"],
    ["contains dash", "has-dash"],
    ["non-ASCII letter", "é"],
    ["non-ASCII letter inside", "Bravé"],
    ["leading underscore", "_abc"],
    ["only digits", "123456"],
  ];
  for (const [label, value] of cases) {
    test(`rejects ${label}`, () => {
      assert.deepEqual(validateUsernameSync(value), {
        valid: false,
        reason: "invalid_format",
      });
    });
  }

  test("rejects non-string input", () => {
    assert.deepEqual(validateUsernameSync(undefined), {
      valid: false,
      reason: "invalid_format",
    });
    assert.deepEqual(validateUsernameSync(null), {
      valid: false,
      reason: "invalid_format",
    });
    assert.deepEqual(validateUsernameSync(42), {
      valid: false,
      reason: "invalid_format",
    });
  });

  test("accepts exact lower bound (3 chars)", () => {
    assert.deepEqual(validateUsernameSync("abc"), { valid: true });
  });

  test("accepts exact upper bound (20 chars)", () => {
    assert.deepEqual(validateUsernameSync("a" + "b".repeat(19)), {
      valid: true,
    });
  });
});

describe("validateUsernameSync — reserved", () => {
  for (const name of ["admin", "ADMIN", "Admin", "moderator", "bot", "Root", "SYSTEM"]) {
    test(`rejects reserved name ${name}`, () => {
      assert.deepEqual(validateUsernameSync(name), {
        valid: false,
        reason: "reserved",
      });
    });
  }
});

// Banned-word coverage lives in worker/username-validator.test.js. The
// server runs obscenity at submit time and returns { error: "banned" } to
// the auth modal, which surfaces it as an inline error.

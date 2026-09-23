// Client username-validator tests. Runs under `node --test`.
// The client validator covers format + reserved exactly and banned words
// against a compact curated list (worker/username-validator.js carries the
// full obscenity dataset and stays authoritative on submit). The full set of
// cases runs in the worker mirror at worker/username-validator.test.js.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { validateUsernameSync } from "./username-validator-client.js";

describe("validateUsernameSync — valid", () => {
  for (const name of [
    "BraveOtter",
    "xu_27",
    "albert",
    "User_123",
    // camelCase names that must NOT trip the boundary-split check
    "ClassicAnna",
    "Assassin",
    "Scunthorpe",
    "GrassHopper",
    // shiitake-themed names (the server once falsely banned these; the
    // client list never contained the mushroom false positive)
    "MyShiitake",
    "MushroomShiitake",
  ]) {
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

describe("validateUsernameSync — banned (curated list)", () => {
  for (const name of [
    "shit",
    "bitch",
    "BoobMaster",
    // camelCase run-together names: whole-word matching on the raw string
    // misses these; the boundary-split form catches them. Finding WRK-02.
    "SuperShitLord",
    "BigTits99",
  ]) {
    test(`rejects ${name}`, () => {
      assert.deepEqual(validateUsernameSync(name), {
        valid: false,
        reason: "banned",
      });
    });
  }

  // The client list is a subset of the server's obscenity dataset, so the
  // preview can green-light a name the server rejects — leetspeak like this
  // passes here and is caught only at submit time. Locks the guarantee the
  // file header states (never rejects a name the server would accept) and
  // its documented converse gap.
  test("accepts leetspeak the server rejects at submit (subset gap)", () => {
    assert.deepEqual(validateUsernameSync("sh1t"), { valid: true });
  });
});


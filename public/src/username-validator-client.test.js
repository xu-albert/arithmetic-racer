// Client username-validator tests. Runs under `node --test`.
// Mirror tests live in worker/username-validator.test.js — both files cover
// the same cases, since the client and server validators must agree on
// every input.

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

describe("validateUsernameSync — banned (obscenity)", () => {
  // These words are in obscenity 0.4.6's englishDataset. Pinned exact version
  // means the dataset is stable; if the library ever changes its dataset,
  // this test may need updating.
  test("rejects an obvious profanity from the english dataset", () => {
    assert.deepEqual(validateUsernameSync("bitch"), {
      valid: false,
      reason: "banned",
    });
  });

  test("rejects an obfuscated (leetspeak) form", () => {
    // englishRecommendedTransformers includes resolveLeetSpeakTransformer,
    // which folds digits like 1 -> i so 'b1tch' resolves to 'bitch'.
    assert.deepEqual(validateUsernameSync("b1tch"), {
      valid: false,
      reason: "banned",
    });
  });

  test("rejects when profanity is embedded in a longer name", () => {
    // Format-valid (letters only, starts with a letter, length OK) but
    // contains a banned substring.
    assert.deepEqual(validateUsernameSync("BoobMaster"), {
      valid: false,
      reason: "banned",
    });
  });
});

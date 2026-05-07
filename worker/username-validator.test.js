// Server username-validator tests. Runs under vitest-pool-workers.
// Mirror tests live in public/src/username-validator-client.test.js.

import { describe, expect, test } from "vitest";
import { validateUsernameSync } from "./username-validator.js";

describe("validateUsernameSync — valid", () => {
  test.each([
    ["BraveOtter"],
    ["xu_27"],
    ["albert"],
    ["User_123"],
  ])("accepts %s", (name) => {
    expect(validateUsernameSync(name)).toEqual({ valid: true });
  });
});

describe("validateUsernameSync — invalid_format", () => {
  test.each([
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
  ])("rejects %s", (_label, value) => {
    expect(validateUsernameSync(value)).toEqual({
      valid: false,
      reason: "invalid_format",
    });
  });

  test("rejects non-string input", () => {
    // @ts-expect-error testing runtime guard
    expect(validateUsernameSync(undefined)).toEqual({
      valid: false,
      reason: "invalid_format",
    });
    // @ts-expect-error testing runtime guard
    expect(validateUsernameSync(null)).toEqual({
      valid: false,
      reason: "invalid_format",
    });
    // @ts-expect-error testing runtime guard
    expect(validateUsernameSync(42)).toEqual({
      valid: false,
      reason: "invalid_format",
    });
  });

  test("accepts exact lower bound (3 chars)", () => {
    expect(validateUsernameSync("abc")).toEqual({ valid: true });
  });

  test("accepts exact upper bound (20 chars)", () => {
    expect(validateUsernameSync("a" + "b".repeat(19))).toEqual({ valid: true });
  });
});

describe("validateUsernameSync — reserved", () => {
  test.each([
    ["admin"],
    ["ADMIN"],
    ["Admin"],
    ["moderator"],
    ["bot"],
    ["Root"],
    ["SYSTEM"],
  ])("rejects reserved name %s", (name) => {
    expect(validateUsernameSync(name)).toEqual({
      valid: false,
      reason: "reserved",
    });
  });
});

describe("validateUsernameSync — banned (obscenity)", () => {
  // These words are in obscenity 0.4.6's englishDataset. Pinned exact version
  // means the dataset is stable; if the library ever changes its dataset,
  // this test may need updating.
  test("rejects an obvious profanity from the english dataset", () => {
    // 'bitch' is documented as a stable entry; matched as a plain pattern.
    expect(validateUsernameSync("bitch")).toEqual({
      valid: false,
      reason: "banned",
    });
  });

  test("rejects an obfuscated (leetspeak) form", () => {
    // englishRecommendedTransformers includes resolveLeetSpeakTransformer,
    // which folds digits like 1 -> i so 'b1tch' resolves to 'bitch'.
    expect(validateUsernameSync("b1tch")).toEqual({
      valid: false,
      reason: "banned",
    });
  });

  test("rejects when profanity is embedded in a longer name", () => {
    // Format-valid (letters only, starts with a letter, length OK) but
    // contains a banned substring.
    expect(validateUsernameSync("BoobMaster")).toEqual({
      valid: false,
      reason: "banned",
    });
  });
});

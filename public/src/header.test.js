import { test } from "node:test";
import assert from "node:assert/strict";
import { _internals } from "./header.js";

const { pickBest, fmtTime, difficultyLetter } = _internals;

// ---------- pickBest ----------

test("pickBest returns null when aggregates is empty", () => {
  assert.equal(pickBest([]), null);
});

test("pickBest returns null when given a non-array", () => {
  assert.equal(pickBest(null), null);
  assert.equal(pickBest(undefined), null);
});

test("pickBest returns null when no aggregate has a best time", () => {
  const aggs = [
    { difficulty: "easy", best_time_ms: null },
    { difficulty: "medium", best_time_ms: null },
    { difficulty: "hard", best_time_ms: null },
  ];
  assert.equal(pickBest(aggs), null);
});

test("pickBest returns the only best when one is set", () => {
  const aggs = [
    { difficulty: "easy", best_time_ms: null },
    { difficulty: "medium", best_time_ms: 42000 },
    { difficulty: "hard", best_time_ms: null },
  ];
  assert.deepEqual(pickBest(aggs), {
    best_time_ms: 42000,
    best_difficulty: "medium",
  });
});

test("pickBest picks the shortest time across multiple bests", () => {
  const aggs = [
    { difficulty: "easy", best_time_ms: 30000 },
    { difficulty: "medium", best_time_ms: 25000 },
    { difficulty: "hard", best_time_ms: 27000 },
  ];
  assert.deepEqual(pickBest(aggs), {
    best_time_ms: 25000,
    best_difficulty: "medium",
  });
});

test("pickBest tolerates malformed entries", () => {
  const aggs = [
    null,
    undefined,
    { difficulty: "easy", best_time_ms: 33000 },
    { difficulty: "hard" }, // missing best_time_ms
  ];
  assert.deepEqual(pickBest(aggs), {
    best_time_ms: 33000,
    best_difficulty: "easy",
  });
});

// ---------- fmtTime ----------

test("fmtTime returns the em-dash placeholder for null", () => {
  assert.equal(fmtTime(null), "—");
});

test("fmtTime returns the em-dash placeholder for undefined", () => {
  assert.equal(fmtTime(undefined), "—");
});

test("fmtTime formats zero as 0:00.0", () => {
  assert.equal(fmtTime(0), "0:00.0");
});

test("fmtTime formats sub-second values with leading zero seconds", () => {
  assert.equal(fmtTime(999), "0:01.0");
});

test("fmtTime formats the brief's canonical example 48100 ms", () => {
  assert.equal(fmtTime(48100), "0:48.1");
});

test("fmtTime formats exactly one minute as 1:00.0", () => {
  assert.equal(fmtTime(60000), "1:00.0");
});

test("fmtTime formats minutes-and-seconds", () => {
  assert.equal(fmtTime(65432), "1:05.4");
});

// ---------- difficultyLetter ----------

test("difficultyLetter maps known difficulties to single letters", () => {
  assert.equal(difficultyLetter("easy"), "E");
  assert.equal(difficultyLetter("medium"), "M");
  assert.equal(difficultyLetter("hard"), "H");
});

test("difficultyLetter returns empty string for unknown values", () => {
  assert.equal(difficultyLetter(null), "");
  assert.equal(difficultyLetter("nightmare"), "");
});

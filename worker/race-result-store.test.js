// Tests for the shared race-result insert helper, used by both the
// POST /api/race-result route handler and the RaceRoom Durable Object.
// Runs under @cloudflare/vitest-pool-workers with a real D1 binding.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { insertRaceResult } from "./race-result-store.js";

beforeAll(async () => {
  // Mirror of migrations/0002 + 0003. Keep in sync with the migrations dir.
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS race_results (" +
      "id TEXT PRIMARY KEY, " +
      "user_id TEXT, " +
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
      "played_at INTEGER NOT NULL, " +
      "room_id TEXT" +
      ")"
  );
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM race_results");
});

function basePayload(overrides = {}) {
  return {
    user_id: null,
    device_id: "device-xyz",
    difficulty: "medium",
    finished: true,
    finish_time_ms: 30000,
    problems_total: 10,
    problems_correct: 10,
    problems_attempted: 11,
    avg_time_per_problem_ms: 3000,
    accuracy_pct: 90.9090909,
    longest_streak: 5,
    room_id: null,
    ...overrides,
  };
}

describe("insertRaceResult", () => {
  it("inserts a solo-anon row (user_id and room_id NULL)", async () => {
    const { id, played_at } = await insertRaceResult(env, basePayload());
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof played_at).toBe("number");
    expect(played_at).toBeGreaterThan(0);

    const { results } = await env.DB.prepare(
      "SELECT * FROM race_results WHERE id = ?"
    ).bind(id).all();
    expect(results).toHaveLength(1);
    expect(results[0].user_id).toBeNull();
    expect(results[0].room_id).toBeNull();
    expect(results[0].device_id).toBe("device-xyz");
    expect(results[0].finished).toBe(1);
  });

  it("inserts a room+logged-in row with both user_id and room_id set", async () => {
    const { id } = await insertRaceResult(env, basePayload({
      user_id: "user-abc",
      room_id: "brave-otter-eel",
    }));

    const { results } = await env.DB.prepare(
      "SELECT user_id, room_id FROM race_results WHERE id = ?"
    ).bind(id).all();
    expect(results[0].user_id).toBe("user-abc");
    expect(results[0].room_id).toBe("brave-otter-eel");
  });

  it("inserts a DNF row (finished=false, finish_time_ms NULL)", async () => {
    const { id } = await insertRaceResult(env, basePayload({
      finished: false,
      finish_time_ms: null,
      problems_correct: 4,
      problems_attempted: 5,
      avg_time_per_problem_ms: 0,
      accuracy_pct: 80,
      longest_streak: 3,
      room_id: "brave-otter-eel",
    }));

    const { results } = await env.DB.prepare(
      "SELECT finished, finish_time_ms, problems_correct, room_id FROM race_results WHERE id = ?"
    ).bind(id).all();
    expect(results[0].finished).toBe(0);
    expect(results[0].finish_time_ms).toBeNull();
    expect(results[0].problems_correct).toBe(4);
    expect(results[0].room_id).toBe("brave-otter-eel");
  });

  it("returns a unique id per call", async () => {
    const a = await insertRaceResult(env, basePayload());
    const b = await insertRaceResult(env, basePayload());
    expect(a.id).not.toBe(b.id);
  });
});

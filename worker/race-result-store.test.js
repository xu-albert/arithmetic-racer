// Tests for the shared race-result insert helper, used by both the
// POST /api/race-result route handler and the RaceRoom Durable Object.
// Runs under @cloudflare/vitest-pool-workers with a real D1 binding.

import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { insertRaceResult } from "./race-result-store.js";

// Schema comes from migrations/ via worker/test-setup.js.

beforeEach(async () => {
  await env.DB.exec("DELETE FROM race_results");
  await env.DB.exec(`DELETE FROM "user"`);
});

// race_results.user_id carries an ON DELETE SET NULL foreign key to "user",
// which D1 enforces. A test that sets user_id therefore has to have a real user
// row to point at. The inline schema this file used to declare dropped the
// constraint entirely, so it never noticed.
async function seedUser(id) {
  await env.DB.prepare(
    `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
     VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))`
  )
    .bind(id, `name-${id}`, `${id}@example.test`)
    .run();
}

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
    await seedUser("user-abc");
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

  it("scores the race on insert — one writer, so solo and room races both get points", async () => {
    // 10 correct in 30s = 20 ppm -> 10 x 20/60 = 3.333 points.
    const { id, points } = await insertRaceResult(env, basePayload());
    expect(points).toBeCloseTo(3.3333, 4);

    const row = await env.DB.prepare("SELECT points FROM race_results WHERE id = ?")
      .bind(id)
      .first();
    expect(row.points).toBeCloseTo(3.3333, 4);
  });

  it("stores the same points for the same race regardless of difficulty", async () => {
    // Difficulty is a separate pool, not a weight on a shared scale.
    const scores = [];
    for (const difficulty of ["easy", "medium", "hard"]) {
      const { points } = await insertRaceResult(env, basePayload({ difficulty }));
      scores.push(points);
    }
    expect(scores[0]).toBe(scores[1]);
    expect(scores[1]).toBe(scores[2]);
  });

  it("stores NULL points for a DNF row, and 0 for a finished race with nothing correct", async () => {
    const dnf = await insertRaceResult(env, basePayload({
      finished: false,
      finish_time_ms: null,
      problems_correct: 4,
    }));
    expect(dnf.points).toBeNull();

    const blank = await insertRaceResult(env, basePayload({ problems_correct: 0 }));
    expect(blank.points).toBe(0);

    const rows = await env.DB.prepare(
      "SELECT id, points FROM race_results WHERE id IN (?,?)"
    ).bind(dnf.id, blank.id).all();
    const byId = new Map(rows.results.map((r) => [r.id, r.points]));
    expect(byId.get(dnf.id)).toBeNull();
    expect(byId.get(blank.id)).toBe(0);
  });

  it("scores a suspect race — the flag is a read-time filter, not a veto", async () => {
    const { id, suspect, points } = await insertRaceResult(env, basePayload({
      finish_time_ms: 500, // under 10 problems x 200ms
    }));
    expect(suspect).toBe(1);
    expect(points).toBeGreaterThan(0);

    const row = await env.DB.prepare("SELECT points FROM race_results WHERE id = ?")
      .bind(id)
      .first();
    expect(row.points).toBeGreaterThan(0);
  });

  it("returns a unique id per call", async () => {
    const a = await insertRaceResult(env, basePayload());
    const b = await insertRaceResult(env, basePayload());
    expect(a.id).not.toBe(b.id);
  });

  // Room-counted rows are written from the room's durable outbox, which
  // retries — and a retry can follow a write that secretly succeeded. A room
  // row carries its race's own time, and the (room, device, race time,
  // result) fingerprint makes the retry stand down. Solo rows carry no race
  // time: they are one-shot POSTs and are never deduped (see above).
  describe("room rows", () => {
    const RACE_AT = Date.UTC(2026, 8, 24, 23, 59, 30);
    const roomPayload = (overrides = {}) =>
      basePayload({ room_id: "room-dedupe-test", ...overrides });
    const dnfPayload = () => roomPayload({
      finished: false, finish_time_ms: null, problems_correct: 3,
      problems_attempted: 5, avg_time_per_problem_ms: 0,
    });
    const roomRows = async (roomId = "room-dedupe-test") => {
      const { results } = await env.DB.prepare(
        "SELECT id, played_at FROM race_results WHERE room_id = ?"
      ).bind(roomId).all();
      return results;
    };

    it("dates the row to the race, not to the write", async () => {
      const { played_at } = await insertRaceResult(env, roomPayload(), undefined, RACE_AT);
      expect(played_at).toBe(RACE_AT);
      const [row] = await roomRows();
      expect(row.played_at).toBe(RACE_AT);
    });

    it("skips a replayed insert of the same room row", async () => {
      const a = await insertRaceResult(env, roomPayload(), undefined, RACE_AT);
      const b = await insertRaceResult(env, roomPayload(), undefined, RACE_AT);
      expect(b.duplicate).toBe(true);
      expect(b.id).toBeNull();
      const rows = await roomRows();
      expect(rows.map((r) => r.id)).toEqual([a.id]);
    });

    it("does not merge two different results from the same race", async () => {
      await insertRaceResult(env, roomPayload({ finish_time_ms: 30000 }), undefined, RACE_AT);
      await insertRaceResult(env, roomPayload({ finish_time_ms: 41234 }), undefined, RACE_AT);
      expect(await roomRows()).toHaveLength(2);
    });

    it("fingerprints unfinished rows too (finish_time_ms NULL)", async () => {
      await insertRaceResult(env, dnfPayload(), undefined, RACE_AT);
      const b = await insertRaceResult(env, dnfPayload(), undefined, RACE_AT);
      expect(b.duplicate).toBe(true);
      expect(await roomRows()).toHaveLength(1);
    });

    it("stores identical-count DNFs from two different races", async () => {
      // A racer who idles through a rematch posts the same counts twice; only
      // the race time tells the two races apart.
      await insertRaceResult(env, dnfPayload(), undefined, RACE_AT);
      const b = await insertRaceResult(env, dnfPayload(), undefined, RACE_AT + 90_000);
      expect(b.duplicate).toBeUndefined();
      expect(await roomRows()).toHaveLength(2);
    });

    it("does not merge the same result raced under two different rooms", async () => {
      await insertRaceResult(env, roomPayload(), undefined, RACE_AT);
      await insertRaceResult(env, roomPayload({ room_id: "room-dedupe-other" }), undefined, RACE_AT);
      const { results } = await env.DB.prepare(
        "SELECT id FROM race_results WHERE device_id = ?"
      ).bind("device-xyz").all();
      expect(results).toHaveLength(2);
    });
  });
});

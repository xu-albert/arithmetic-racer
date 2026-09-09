// A race that fails (or times out of) server-side captcha verification is
// recorded with suspect=1 and a captcha_* reason via the store's plausibility
// override argument. These tests pin the consequence from the brief:
// that row must not appear on leaderboards or in the recent-finishes feed,
// while a verified (passed) row from the same room does.

import { describe, it, expect, beforeEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";

import { insertRaceResult } from "../race-result-store.js";
import { handleLeaderboard, _resetRateLimitLog } from "./leaderboard.js";
import { handleRecentFinishes } from "./recent-finishes.js";

async function seedUser({ id, username }) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", username)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(id, username ?? id, `${id}@example.test`, 0, now, now, username ?? null).run();
}

function basePayload(overrides = {}) {
  return {
    user_id: null,
    device_id: crypto.randomUUID(),
    difficulty: "medium",
    finished: true,
    finish_time_ms: 3500, // 350 ms/problem — inside the captcha-trigger zone
    problems_total: 10,
    problems_correct: 10,
    problems_attempted: 10,
    avg_time_per_problem_ms: 350,
    accuracy_pct: 100,
    longest_streak: 10,
    room_id: "room-cap-" + crypto.randomUUID(),
    ...overrides,
  };
}

let originSeq = 0;

async function boardRows() {
  const ctx = createExecutionContext();
  // caches.default is not rolled back between tests and the board is cached by
  // origin — each call needs its own, like worker/routes/leaderboard.test.js.
  const origin = `https://cap-${++originSeq}.test`;
  const res = await handleLeaderboard(
    new Request(`${origin}/api/leaderboard?difficulty=medium&period=all`, {
      headers: { "cf-connecting-ip": "203.0.113.7" },
    }),
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  return (await res.json()).entries ?? [];
}

async function feedRows() {
  const res = await handleRecentFinishes(
    new Request("https://t.test/api/recent-finishes"),
    env
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.finishes ?? [];
}

beforeEach(async () => {
  _resetRateLimitLog();
  await env.DB.exec("DELETE FROM race_results");
  await env.DB.exec(`DELETE FROM "user"`);
});

describe("captcha-unverified rows vs public surfaces", () => {
  it("a captcha_failed row is stored suspect and excluded from both surfaces", async () => {
    await seedUser({ id: "u-fail", username: "cheater" });
    const stored = await insertRaceResult(
      env,
      basePayload({ user_id: "u-fail" }),
      { suspect: 1, reason: "captcha_failed" },
    );
    expect(stored.suspect).toBe(1);
    expect(stored.suspect_reason).toBe("captcha_failed");

    const row = await env.DB.prepare("SELECT suspect_reason FROM race_results").first();
    expect(row.suspect_reason).toBe("captcha_failed");

    expect(await boardRows()).toHaveLength(0);
    expect(await feedRows()).toHaveLength(0);
  });

  it("a captcha_timeout row is excluded from both surfaces too", async () => {
    await seedUser({ id: "u-slow", username: "idler" });
    await insertRaceResult(
      env,
      basePayload({ user_id: "u-slow" }),
      { suspect: 1, reason: "captcha_timeout" },
    );

    expect(await boardRows()).toHaveLength(0);
    expect(await feedRows()).toHaveLength(0);
  });

  it("a passed (verified) row from the same trigger zone counts normally", async () => {
    await seedUser({ id: "u-pass", username: "legit" });
    const stored = await insertRaceResult(env, basePayload({ user_id: "u-pass" }));
    expect(stored.suspect).toBe(0);

    const board = await boardRows();
    expect(board).toHaveLength(1);
    expect(board[0].username).toBe("legit");

    expect(await feedRows()).toHaveLength(1);
  });
});

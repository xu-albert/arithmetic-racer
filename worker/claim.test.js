// Tests for the anonymous-history claim (runClaim in worker/auth.js): it only
// reaches back CLAIM_WINDOW_MS, and every claim leaves a history_claims row.
//
// Runs under @cloudflare/vitest-pool-workers against a real D1 binding; the
// schema is applied from migrations/ by worker/test-setup.js.

import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { getAuth, runClaim, CLAIM_WINDOW_MS } from "./auth.js";
import { handlePostUsername } from "./routes/me.js";
import { _setTestUserId } from "./session.js";

const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);

beforeEach(async () => {
  await env.DB.exec("DELETE FROM history_claims");
  await env.DB.exec("DELETE FROM race_results");
  await env.DB.exec(`DELETE FROM "user"`);
  _setTestUserId(null);
});

async function seedUser(id, username = null) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", username)
     VALUES (?,?,?,?,?,?,?)`
  )
    .bind(id, username ?? id, `${id}@example.com`, 0, now, now, username)
    .run();
}

async function seedRace({ device_id = "dev-1", user_id = null, played_at }) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO race_results (
       id, user_id, device_id, difficulty, finished, finish_time_ms,
       problems_total, problems_correct, problems_attempted,
       avg_time_per_problem_ms, accuracy_pct, longest_streak, played_at
     ) VALUES (?,?,?,'easy',1,30000,10,10,10,3000,100,10,?)`
  )
    .bind(id, user_id, device_id, played_at)
    .run();
  return id;
}

async function ownerOf(raceId) {
  return env.DB.prepare("SELECT user_id FROM race_results WHERE id = ?").bind(raceId).first("user_id");
}

async function claimRows() {
  const { results } = await env.DB
    .prepare("SELECT * FROM history_claims ORDER BY created_at, id")
    .all();
  return results;
}

describe("runClaim window", () => {
  it("claims anonymous races played inside the window", async () => {
    await seedUser("u1");
    const recent = await seedRace({ played_at: NOW - 60_000 });
    const edge = await seedRace({ played_at: NOW - CLAIM_WINDOW_MS });

    const result = await runClaim(env, "u1", "dev-1", { source: "signup", now: NOW });

    expect(result).toEqual({ claimed: 2 });
    expect(await ownerOf(recent)).toBe("u1");
    expect(await ownerOf(edge)).toBe("u1");
  });

  it("leaves races older than the window anonymous", async () => {
    await seedUser("u1");
    const recent = await seedRace({ played_at: NOW - 60_000 });
    const stale = await seedRace({ played_at: NOW - CLAIM_WINDOW_MS - 1 });
    const ancient = await seedRace({ played_at: NOW - 90 * 24 * 60 * 60 * 1000 });

    const result = await runClaim(env, "u1", "dev-1", { source: "signup", now: NOW });

    expect(result).toEqual({ claimed: 1 });
    expect(await ownerOf(recent)).toBe("u1");
    expect(await ownerOf(stale)).toBeNull();
    expect(await ownerOf(ancient)).toBeNull();
  });

  it("never touches another device's races or rows that already have an owner", async () => {
    await seedUser("u1");
    await seedUser("u2");
    const otherDevice = await seedRace({ device_id: "dev-2", played_at: NOW - 60_000 });
    const owned = await seedRace({ user_id: "u2", played_at: NOW - 60_000 });

    const result = await runClaim(env, "u1", "dev-1", { source: "signup", now: NOW });

    expect(result).toEqual({ claimed: 0 });
    expect(await ownerOf(otherDevice)).toBeNull();
    expect(await ownerOf(owned)).toBe("u2");
  });

  it("is a no-op, and logs nothing, without a usable device id", async () => {
    await seedUser("u1");
    for (const deviceId of [undefined, "", 42, { id: "dev-1" }]) {
      expect(await runClaim(env, "u1", deviceId, { source: "signup", now: NOW })).toEqual({ claimed: 0 });
    }
    expect(await claimRows()).toEqual([]);
  });
});

describe("runClaim log", () => {
  it("records who claimed, which device, how many, how many were too old, and when", async () => {
    await seedUser("u1");
    await seedRace({ played_at: NOW - 60_000 });
    await seedRace({ played_at: NOW - 120_000 });
    await seedRace({ played_at: NOW - CLAIM_WINDOW_MS - 1 });
    // Another device's old race must not count as this device's leftovers.
    await seedRace({ device_id: "dev-2", played_at: NOW - CLAIM_WINDOW_MS - 1 });

    await runClaim(env, "u1", "dev-1", { source: "signup", now: NOW });

    const rows = await claimRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: "u1",
      device_id: "dev-1",
      source: "signup",
      claimed: 2,
      left_unclaimed: 1,
      created_at: NOW,
    });
    expect(typeof rows[0].id).toBe("string");
  });

  it("logs a claim that matched nothing", async () => {
    await seedUser("u1");

    await runClaim(env, "u1", "never-raced", { source: "signup", now: NOW });

    const rows = await claimRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: "u1", device_id: "never-raced", claimed: 0, left_unclaimed: 0 });
  });

  it("logs every call, so a device presented by two accounts shows up twice", async () => {
    await seedUser("u1");
    await seedUser("u2");
    await seedRace({ played_at: NOW - 60_000 });

    await runClaim(env, "u1", "dev-1", { source: "signup", now: NOW });
    await runClaim(env, "u2", "dev-1", { source: "first_username_set", now: NOW + 1 });

    const rows = await claimRows();
    expect(rows.map((r) => [r.user_id, r.source, r.claimed])).toEqual([
      ["u1", "signup", 1],
      ["u2", "first_username_set", 0],
    ]);
  });

  it("does not claim when the log cannot be written", async () => {
    await seedUser("u1");
    const recent = await seedRace({ played_at: NOW - 60_000 });

    // An unknown source violates the log's CHECK constraint, failing the
    // INSERT; the batch must take the UPDATE down with it.
    await expect(
      runClaim(env, "u1", "dev-1", { source: "bogus", now: NOW }),
    ).rejects.toThrow();

    expect(await ownerOf(recent)).toBeNull();
    expect(await claimRows()).toEqual([]);
  });
});

describe("POST /api/me/username claim", () => {
  function post(body) {
    return handlePostUsername(
      new Request("http://x/api/me/username", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );
  }

  it("claims recent races on first-username-set and logs it as that source", async () => {
    await seedUser("u1");
    _setTestUserId("u1");
    const recent = await seedRace({ played_at: Date.now() - 60_000 });
    const stale = await seedRace({ played_at: Date.now() - CLAIM_WINDOW_MS - 60_000 });

    const res = await post({ username: "Alice", deviceId: "dev-1" });

    expect(res.status).toBe(200);
    expect(await ownerOf(recent)).toBe("u1");
    expect(await ownerOf(stale)).toBeNull();
    const rows = await claimRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: "u1",
      device_id: "dev-1",
      source: "first_username_set",
      claimed: 1,
      left_unclaimed: 1,
    });
  });

  it("runs no claim, and logs none, on a later rename", async () => {
    await seedUser("u1", "Alice");
    _setTestUserId("u1");
    await seedRace({ played_at: Date.now() - 60_000 });

    const res = await post({ username: "Bobby", deviceId: "dev-1" });

    expect(res.status).toBe(200);
    expect(await claimRows()).toEqual([]);
  });
});

describe("email/password signup claim", () => {
  it("claims recent races from the signup body's deviceId and logs it as a signup", async () => {
    const recent = await seedRace({ played_at: Date.now() - 60_000 });
    const stale = await seedRace({ played_at: Date.now() - CLAIM_WINDOW_MS - 60_000 });

    const res = await getAuth(env).handler(
      new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({
          email: "carol@example.com",
          password: "correct-horse-battery",
          name: "Carol",
          username: "Carol",
          deviceId: "dev-1",
        }),
      }),
    );

    expect(res.status).toBe(200);
    const user = await env.DB.prepare(`SELECT id FROM "user" WHERE email = ?`)
      .bind("carol@example.com")
      .first();
    expect(await ownerOf(recent)).toBe(user.id);
    expect(await ownerOf(stale)).toBeNull();
    const rows = await claimRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: user.id,
      device_id: "dev-1",
      source: "signup",
      claimed: 1,
      left_unclaimed: 1,
    });
  });
});

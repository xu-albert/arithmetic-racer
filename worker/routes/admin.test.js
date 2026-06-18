// Tests for the admin dashboard route. Runs under @cloudflare/vitest-pool-workers.
// Each test file gets its own ephemeral D1; we apply the user + race_results DDL
// inline in beforeAll (same pattern as me.test.js).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { timingSafeEqualStrings } from "./admin.js";

beforeAll(async () => {
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS "user" (` +
      `"id" text not null primary key, ` +
      `"name" text not null, ` +
      `"email" text not null unique, ` +
      `"emailVerified" integer not null, ` +
      `"image" text, ` +
      `"createdAt" date not null, ` +
      `"updatedAt" date not null, ` +
      `"username" text unique` +
      `)`
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS race_results (" +
      "id TEXT PRIMARY KEY, " +
      `user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL, ` +
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
      "played_at INTEGER NOT NULL" +
      ")"
  );
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM race_results");
  await env.DB.exec(`DELETE FROM "user"`);
});

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

describe("GET /admin/ token gate", () => {
  it("returns 404 when no token is provided", async () => {
    const { handleAdminIndex } = await import("./admin.js");
    const req = new Request("http://x/admin/");
    const res = await handleAdminIndex(req, { ...env, ADMIN_TOKEN: "expected-secret" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when token is wrong", async () => {
    const { handleAdminIndex } = await import("./admin.js");
    const req = new Request("http://x/admin/?token=wrong");
    const res = await handleAdminIndex(req, { ...env, ADMIN_TOKEN: "expected-secret" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when ADMIN_TOKEN is unset (no admin URL works)", async () => {
    const { handleAdminIndex } = await import("./admin.js");
    const req = new Request("http://x/admin/?token=anything");
    const res = await handleAdminIndex(req, { ...env, ADMIN_TOKEN: undefined });
    expect(res.status).toBe(404);
  });
});

describe("GET /admin/ happy path", () => {
  it("returns 200 HTML when token matches and DB is empty", async () => {
    const { handleAdminIndex } = await import("./admin.js");
    const req = new Request("http://x/admin/?token=expected-secret");
    const res = await handleAdminIndex(req, { ...env, ADMIN_TOKEN: "expected-secret" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("Arithmetic Racer");
    expect(body).toContain("admin");
  });
});

async function seedUser(id, username, createdAtMs) {
  await env.DB.prepare(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", username)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(id, username, `${username}@example.com`, 0, createdAtMs, createdAtMs, username).run();
}

async function seedRace(overrides = {}) {
  const r = {
    id: crypto.randomUUID(),
    user_id: null,
    device_id: "dev-1",
    difficulty: "medium",
    finished: 1,
    finish_time_ms: 48000,
    problems_total: 20,
    problems_correct: 18,
    problems_attempted: 20,
    avg_time_per_problem_ms: 2400,
    accuracy_pct: 90,
    longest_streak: 7,
    played_at: Date.now(),
    ...overrides,
  };
  await env.DB.prepare(
    `INSERT INTO race_results (id, user_id, device_id, difficulty, finished, finish_time_ms,
       problems_total, problems_correct, problems_attempted, avg_time_per_problem_ms,
       accuracy_pct, longest_streak, played_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(r.id, r.user_id, r.device_id, r.difficulty, r.finished, r.finish_time_ms,
          r.problems_total, r.problems_correct, r.problems_attempted, r.avg_time_per_problem_ms,
          r.accuracy_pct, r.longest_streak, r.played_at)
    .run();
  return r;
}

describe("recent races table", () => {
  it("renders rows newest-first with username when user_id set", async () => {
    const now = Date.now();
    await seedUser("u-alice", "alice", now);
    await seedRace({ user_id: "u-alice", played_at: now - 1000, finish_time_ms: 48200, accuracy_pct: 96 });
    await seedRace({ user_id: null, device_id: "dev-xyz1234567", played_at: now - 2000 });

    const { handleAdminIndex } = await import("./admin.js");
    const req = new Request("http://x/admin/?token=expected-secret");
    const res = await handleAdminIndex(req, { ...env, ADMIN_TOKEN: "expected-secret" });
    const body = await res.text();

    expect(body).toContain("alice");
    expect(body).toContain("dev:dev-xy");
    expect(body.indexOf("alice")).toBeLessThan(body.indexOf("dev-xy"));
  });

  it("marks DNF rows with a 'dnf' class", async () => {
    await seedRace({ finished: 0, finish_time_ms: null });
    const { handleAdminIndex } = await import("./admin.js");
    const res = await handleAdminIndex(
      new Request("http://x/admin/?token=expected-secret"),
      { ...env, ADMIN_TOKEN: "expected-secret" }
    );
    const body = await res.text();
    expect(body).toMatch(/class="[^"]*dnf[^"]*"/);
  });

  it("respects ?before=<played_at> cursor", async () => {
    const now = Date.now();
    await seedRace({ device_id: "dev-newer", played_at: now - 1000 });
    await seedRace({ device_id: "dev-older", played_at: now - 9000 });
    const { handleAdminIndex } = await import("./admin.js");
    const cursor = now - 5000;
    const res = await handleAdminIndex(
      new Request(`http://x/admin/?token=expected-secret&before=${cursor}`),
      { ...env, ADMIN_TOKEN: "expected-secret" }
    );
    const body = await res.text();
    expect(body).toContain("dev-older");
    expect(body).not.toContain("dev-newer");
  });

  it("renders 'Older' link only when result count hits LIMIT", async () => {
    await seedRace();
    const { handleAdminIndex } = await import("./admin.js");
    const res = await handleAdminIndex(
      new Request("http://x/admin/?token=expected-secret"),
      { ...env, ADMIN_TOKEN: "expected-secret" }
    );
    const body = await res.text();
    expect(body).not.toMatch(/Older →/);
  });
});

describe("summary tiles", () => {
  it("shows zeros on empty DB", async () => {
    const { handleAdminIndex } = await import("./admin.js");
    const req = new Request("http://x/admin/?token=expected-secret");
    const res = await handleAdminIndex(req, { ...env, ADMIN_TOKEN: "expected-secret" });
    const body = await res.text();
    expect(body).toContain("races finished");
    expect(body).toContain("unique players");
    expect(body).toContain("signups");
  });

  it("counts finished races in today/7d/all-time windows", async () => {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000;
    const twentyDaysAgo = now - 20 * 24 * 60 * 60 * 1000;

    await seedRace({ played_at: oneHourAgo,    finished: 1 });
    await seedRace({ played_at: threeDaysAgo,  finished: 1 });
    await seedRace({ played_at: twentyDaysAgo, finished: 1 });
    await seedRace({ played_at: oneHourAgo,    finished: 0 });

    const { handleAdminIndex } = await import("./admin.js");
    const req = new Request("http://x/admin/?token=expected-secret");
    const res = await handleAdminIndex(req, { ...env, ADMIN_TOKEN: "expected-secret" });
    const body = await res.text();

    expect(body).toMatch(/data-window="today"[^>]*>\s*<[^>]*>1</);
    expect(body).toMatch(/data-window="7d"[^>]*>\s*<[^>]*>2</);
    expect(body).toMatch(/data-window="all"[^>]*>\s*<[^>]*>3</);
  });

  it("counts unique players by user_id or device_id", async () => {
    await seedUser("user-a", "alice", Date.now());
    await seedRace({ user_id: "user-a", device_id: "dev-1" });
    await seedRace({ user_id: "user-a", device_id: "dev-9" });
    await seedRace({ user_id: null,     device_id: "dev-2" });
    await seedRace({ user_id: null,     device_id: "dev-2" });

    const { handleAdminIndex } = await import("./admin.js");
    const req = new Request("http://x/admin/?token=expected-secret");
    const res = await handleAdminIndex(req, { ...env, ADMIN_TOKEN: "expected-secret" });
    const body = await res.text();
    expect(body).toMatch(/unique-players[^>]*data-window="all"[^>]*>\s*<[^>]*>2</);
  });

  it("counts signups in time windows", async () => {
    const now = Date.now();
    await seedUser("u1", "alice", now - 60 * 60 * 1000);
    await seedUser("u2", "bob",   now - 3 * 24 * 60 * 60 * 1000);
    await seedUser("u3", "carol", now - 20 * 24 * 60 * 60 * 1000);

    const { handleAdminIndex } = await import("./admin.js");
    const req = new Request("http://x/admin/?token=expected-secret");
    const res = await handleAdminIndex(req, { ...env, ADMIN_TOKEN: "expected-secret" });
    const body = await res.text();
    expect(body).toMatch(/signups[^>]*data-window="today"[^>]*>\s*<[^>]*>1</);
    expect(body).toMatch(/signups[^>]*data-window="7d"[^>]*>\s*<[^>]*>2</);
    expect(body).toMatch(/signups[^>]*data-window="all"[^>]*>\s*<[^>]*>3</);
  });
});

describe("30-day sparkline", () => {
  it("renders a polyline element even with empty data", async () => {
    const { handleAdminIndex } = await import("./admin.js");
    const res = await handleAdminIndex(
      new Request("http://x/admin/?token=expected-secret"),
      { ...env, ADMIN_TOKEN: "expected-secret" }
    );
    const body = await res.text();
    expect(body).toMatch(/<svg[^>]*class="sparkline"/);
    expect(body).toMatch(/<polyline/);
  });

  it("includes a non-zero point when a recent race exists", async () => {
    await seedRace({ played_at: Date.now() - 60 * 1000 });
    const { handleAdminIndex } = await import("./admin.js");
    const res = await handleAdminIndex(
      new Request("http://x/admin/?token=expected-secret"),
      { ...env, ADMIN_TOKEN: "expected-secret" }
    );
    const body = await res.text();
    const match = body.match(/<polyline[^>]*points="([^"]+)"/);
    expect(match).not.toBeNull();
    const points = match[1].split(/\s+/).filter(Boolean);
    expect(points.length).toBe(30);
  });
});

describe("per-user drill-down", () => {
  it("404s with no token", async () => {
    const { handleAdminUser } = await import("./admin.js");
    const res = await handleAdminUser(
      new Request("http://x/admin/users/u-alice"),
      { ...env, ADMIN_TOKEN: "expected-secret" }
    );
    expect(res.status).toBe(404);
  });

  it("404s when user does not exist (token valid)", async () => {
    const { handleAdminUser } = await import("./admin.js");
    const res = await handleAdminUser(
      new Request("http://x/admin/users/missing?token=expected-secret"),
      { ...env, ADMIN_TOKEN: "expected-secret" }
    );
    expect(res.status).toBe(404);
  });

  it("returns user header + only that user's races", async () => {
    const now = Date.now();
    await seedUser("u-alice", "alice", now - 86400000);
    await seedUser("u-bob",   "bob",   now);
    await seedRace({ user_id: "u-alice", played_at: now - 500 });
    await seedRace({ user_id: "u-bob",   played_at: now - 100 });

    const { handleAdminUser } = await import("./admin.js");
    const res = await handleAdminUser(
      new Request("http://x/admin/users/u-alice?token=expected-secret"),
      { ...env, ADMIN_TOKEN: "expected-secret" }
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("alice");
    expect(body).not.toContain("bob");
  });
});

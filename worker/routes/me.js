// Profile API handlers.
//
// Contracts: see worker/api-contracts.js (frozen).
//
// Auth: handlers that need a user_id read it via the readUserId() stub
// below. The stub returns null in this phase so the route can be merged
// before Agent D's auth.js exists. A test-only override (_setTestUserId)
// lets vitest inject a user_id without a real session. The integrator
// (Phase 3) replaces both with a call to better-auth and removes the
// override + its export — see INTEGRATION NOTE markers.

import { db } from "../db.js";
import { validateUsernameSync } from "../username-validator.js";
import { readUserId } from "../session.js";
import { runClaim } from "../auth.js";

const DIFFICULTIES = ["easy", "medium", "hard"];

/**
 * Coerce a value that may be a number (epoch ms) or an ISO/SQL date string
 * into an ISO 8601 string. better-auth stores timestamps as integers in
 * SQLite via the D1 driver; race_results.played_at is also stored as an
 * INTEGER (epoch ms). Either way, new Date(...).toISOString() works.
 */
function toIso(value) {
  if (value == null) return null;
  return new Date(value).toISOString();
}

export async function handleGetMe(request, env) {
  const userId = await readUserId(request, env);
  if (!userId) return new Response("unauthorized", { status: 401 });

  // Schema note: the `user` table is owned by better-auth and uses camelCase
  // column names (createdAt, etc.). See migrations/0001_better_auth.sql.
  const userRow = await db(env)
    .prepare(`SELECT username, email, "createdAt" AS createdAt FROM "user" WHERE id = ?`)
    .bind(userId)
    .first();
  if (!userRow) return new Response("not found", { status: 404 });

  const { results: aggRows } = await db(env)
    .prepare(
      `SELECT difficulty,
              COUNT(*) AS races_played,
              SUM(CASE WHEN finished = 1 THEN 1 ELSE 0 END) AS races_finished,
              MIN(CASE WHEN finished = 1 THEN finish_time_ms END) AS best_time_ms,
              AVG(accuracy_pct) AS avg_accuracy,
              AVG(avg_time_per_problem_ms) AS avg_problem_time_ms
         FROM race_results
        WHERE user_id = ?
        GROUP BY difficulty`
    )
    .bind(userId)
    .all();

  const byDifficulty = new Map((aggRows ?? []).map((r) => [r.difficulty, r]));
  const aggregates = DIFFICULTIES.map((d) => {
    const r = byDifficulty.get(d);
    if (!r) {
      return {
        difficulty: d,
        races_played: 0,
        races_finished: 0,
        best_time_ms: null,
        avg_accuracy: 0,
        avg_problem_time_ms: 0,
      };
    }
    return {
      difficulty: d,
      races_played: Number(r.races_played) || 0,
      races_finished: Number(r.races_finished) || 0,
      best_time_ms: r.best_time_ms == null ? null : Number(r.best_time_ms),
      avg_accuracy: r.avg_accuracy == null ? 0 : Number(r.avg_accuracy),
      avg_problem_time_ms: Math.round(Number(r.avg_problem_time_ms) || 0),
    };
  });

  // race_seq is a 1-based per-user counter that mirrors the chronological
  // order in which the user played each race. We compute it via a window
  // function over ALL of the user's races, then take the most recent 10.
  const { results: recentRows } = await db(env)
    .prepare(
      `WITH ordered AS (
         SELECT difficulty, finish_time_ms, accuracy_pct,
                avg_time_per_problem_ms, played_at,
                ROW_NUMBER() OVER (ORDER BY played_at ASC) AS race_seq
           FROM race_results
          WHERE user_id = ?
       )
       SELECT * FROM ordered
        ORDER BY played_at DESC
        LIMIT 10`
    )
    .bind(userId)
    .all();

  const recent = (recentRows ?? []).map((r) => ({
    race_seq: Number(r.race_seq),
    difficulty: r.difficulty,
    finish_time_ms: r.finish_time_ms == null ? null : Number(r.finish_time_ms),
    accuracy_pct: Number(r.accuracy_pct),
    avg_time_per_problem_ms: Number(r.avg_time_per_problem_ms),
    played_at: toIso(r.played_at),
  }));

  return Response.json({
    username: userRow.username ?? "",
    email: userRow.email,
    created_at: toIso(userRow.createdAt),
    aggregates,
    recent,
  });
}

export async function handlePostUsername(request, env) {
  const userId = await readUserId(request, env);
  if (!userId) return new Response("unauthorized", { status: 401 });

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_format" }, { status: 400 });
  }
  const username = body && typeof body === "object" ? body.username : undefined;
  // deviceId is optional; only sent on first-username-set after Google OAuth
  // signup. Used to attribute prior anon races to this user (the email/password
  // signup path runs the claim from auth.js's databaseHooks instead).
  const deviceId = body && typeof body === "object" ? body.deviceId : undefined;

  const result = validateUsernameSync(username);
  if (!result.valid) {
    return Response.json({ error: result.reason }, { status: 400 });
  }

  // Uniqueness check (case-insensitive). LOWER() is fine for ASCII; the
  // FORMAT_RE in the validator already restricts usernames to ASCII so we
  // don't need locale-aware folding here.
  const collision = await db(env)
    .prepare(`SELECT id FROM "user" WHERE LOWER(username) = LOWER(?) AND id != ?`)
    .bind(username, userId)
    .first();
  if (collision) return Response.json({ error: "taken" }, { status: 400 });

  // Detect first-username-set so we can run the OAuth claim. We check the
  // current row before updating; if username was NULL/empty, this is the
  // OAuth signup's username modal completing.
  const before = await db(env)
    .prepare(`SELECT username FROM "user" WHERE id = ?`)
    .bind(userId)
    .first();
  const wasUnset = !before?.username;

  await db(env)
    .prepare(`UPDATE "user" SET username = ? WHERE id = ?`)
    .bind(username, userId)
    .run();

  if (wasUnset && deviceId) {
    try {
      await runClaim(env, userId, deviceId);
    } catch (err) {
      // Don't fail the rename on a claim hiccup; the user has their name set.
      console.error("[me] claim on first-username-set failed", err);
    }
  }

  return Response.json({ username });
}

export async function handleByDevice(request, env) {
  const url = new URL(request.url);
  const deviceId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  if (!deviceId) {
    return Response.json({ total_races: 0, best_time_ms: null, best_difficulty: null });
  }

  // Only count anon rows (user_id IS NULL). After a claim, the same
  // device's old rows have user_id set, and the header pills should reflect
  // only what the *current anonymous* session has accumulated since.
  const row = await db(env)
    .prepare(
      `SELECT COUNT(*) AS total_races,
              MIN(CASE WHEN finished = 1 THEN finish_time_ms END) AS best_time_ms,
              (SELECT difficulty
                 FROM race_results
                WHERE user_id IS NULL AND device_id = ? AND finished = 1
                ORDER BY finish_time_ms ASC
                LIMIT 1) AS best_difficulty
         FROM race_results
        WHERE user_id IS NULL AND device_id = ?`
    )
    .bind(deviceId, deviceId)
    .first();

  return Response.json({
    total_races: Number(row?.total_races ?? 0),
    best_time_ms: row?.best_time_ms == null ? null : Number(row.best_time_ms),
    best_difficulty: row?.best_difficulty ?? null,
  });
}

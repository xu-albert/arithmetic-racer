// Profile API handlers.
//
// Contracts: see worker/api-contracts.js (frozen).
//
// Auth: handlers that need a user_id read it via readUserId() in
// worker/session.js, which resolves the better-auth session cookie. Tests
// inject a user id through that module's _setTestUserId override instead of
// signing in for real.

import { db, withColumnFallback } from "../db.js";
import { validateUsernameSync } from "../username-validator.js";
import { readUserId } from "../session.js";
import { runClaim } from "../auth.js";
import { logError, KINDS } from "../logger.js";

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

/**
 * The per-difficulty aggregate query for handleGetMe. `pointsExpr` is "points"
 * on a database at migration 0009 or later, "NULL" on one still behind — see
 * withColumnFallback in ../db.js. AVG(CASE WHEN finished = 1 ...) for the
 * problem-time average is deliberate: a quit race's avg_time_per_problem_ms
 * is a mandated 0, and counting it would dilute the pace of finished races.
 */
const AGGREGATES_SQL = (pointsExpr) => `SELECT difficulty,
        COUNT(*) AS races_played,
        SUM(CASE WHEN finished = 1 THEN 1 ELSE 0 END) AS races_finished,
        MIN(CASE WHEN finished = 1 THEN finish_time_ms END) AS best_time_ms,
        AVG(accuracy_pct) AS avg_accuracy,
        AVG(CASE WHEN finished = 1 THEN avg_time_per_problem_ms END) AS avg_problem_time_ms,
        SUM(${pointsExpr}) AS total_points,
        AVG(CASE WHEN finished = 1 AND finish_time_ms > 0
                 THEN problems_correct * 60000.0 / finish_time_ms END) AS avg_ppm,
        MAX(CASE WHEN finished = 1 AND finish_time_ms > 0
                 THEN problems_correct * 60000.0 / finish_time_ms END) AS best_ppm
   FROM race_results
  WHERE user_id = ?
  GROUP BY difficulty`;

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

  // Every score aggregate is GROUP BY difficulty and nothing collapses the
  // three tiers together: easy/medium/hard are separate point pools, and a
  // cross-difficulty total or ranking is not a thing this API produces.
  //
  // PPM is derived here rather than stored — it is problems_correct over
  // minutes, both of which are already columns. `points` is stored (see
  // migrations/0009_race_results_points.sql) because it accumulates and must
  // not be retroactively rewritten by a formula change.
  //
  // Every rate aggregate skips unfinished races: a quit race has no rate. Its
  // avg_time_per_problem_ms is a mandated 0 (worker/routes/race-result.js,
  // server/room-stats.js), so including it would report a pace 2-3x faster
  // than anything the racer ever ran; its PPM is NULL either way. That makes
  // the averages ones over races_finished, not races_played.
  //
  // `points` may not exist while the database is a migration behind
  // (migrations/README.md), so the aggregate compiles in two forms and reads
  // NULL for the column in the fallback — which total_points already reports
  // as 0.
  const aggRows = await withColumnFallback(
    env,
    AGGREGATES_SQL("points"),
    AGGREGATES_SQL("NULL"),
    [userId]
  );

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
        total_points: 0,
        avg_ppm: null,
        best_ppm: null,
      };
    }
    return {
      difficulty: d,
      races_played: Number(r.races_played) || 0,
      races_finished: Number(r.races_finished) || 0,
      best_time_ms: r.best_time_ms == null ? null : Number(r.best_time_ms),
      avg_accuracy: r.avg_accuracy == null ? 0 : Number(r.avg_accuracy),
      avg_problem_time_ms: Math.round(Number(r.avg_problem_time_ms) || 0),
      // 0 points is a real standing (raced, earned nothing), so it is not
      // null-able. A missing PPM is different: with no finished race there is
      // no speed to report, and 0 would read as "very slow".
      total_points: r.total_points == null ? 0 : Number(r.total_points),
      avg_ppm: r.avg_ppm == null ? null : Number(r.avg_ppm),
      best_ppm: r.best_ppm == null ? null : Number(r.best_ppm),
    };
  });

  // `recent` is the first page of the race history, unchanged since the
  // contract froze: the newest ten across every difficulty. A client that
  // wants more pages, or one tier, walks GET /api/me/races (handleGetMyRaces).
  const { races: recent } = await fetchRaceHistory(env, userId, { limit: RECENT_LIMIT });

  return Response.json({
    username: userRow.username ?? "",
    email: userRow.email,
    created_at: toIso(userRow.createdAt),
    aggregates,
    recent,
  });
}

// ── Race history ────────────────────────────────────────────────────────────
//
// GET /api/me/races is the account's full race history, paged newest-first,
// optionally narrowed to one difficulty. It is a sibling of /api/me rather
// than a query string on it because /api/me's shape is frozen (see
// worker/api-contracts.js) and because the profile fetches the two at
// different times: aggregates once on open, history again on every filter
// change or "load older" click. Re-running the aggregate GROUP BY to page a
// table would be paying for numbers the screen already has.
//
// The cursor is a race_seq. race_seq is a 1-based per-user counter that
// mirrors the chronological order in which the user played each race — the
// same ROW_NUMBER() window /api/me has always used for `recent`. It is
// computed over ALL of the user's races before any filter applies, so race #5
// is still race #5 when only medium races are listed, and `before=N` means
// "races older than the one numbered N" regardless of filter. The counter is
// dense, so the client also knows a page whose oldest row is #1 has nothing
// older — the server still says so explicitly in `next_cursor`.
//
// ORDER BY inside the window carries an `id` tiebreak. One multiplayer race
// persists every player in the same tick, and a solo result can land on the
// same millisecond; without the tiebreak ROW_NUMBER() may number two such rows
// differently on two queries, and a keyset cursor over a number that moves
// skips or repeats a row. The client's "Load older" is exactly that cursor.
//
// The cost model is the one the old `recent` query already had: the window
// function reads every row the user owns via idx_race_results_user_played
// (a few thousand at the very most), then the filter and LIMIT apply. `limit`
// therefore bounds the response, not the read, and its ceiling is a UI
// sanity bound rather than a D1 billing one.

/** Rows per page when the caller does not ask for a size. */
const HISTORY_DEFAULT_LIMIT = 20;
/** Hard ceiling on rows per page. */
const HISTORY_MAX_LIMIT = 100;
/** /api/me's `recent`: the newest ten, as the frozen contract says. */
const RECENT_LIMIT = 10;

/** A race_results row from the `ordered` CTE, in RaceListItem shape. */
function raceListItem(r) {
  return {
    race_seq: Number(r.race_seq),
    difficulty: r.difficulty,
    finish_time_ms: r.finish_time_ms == null ? null : Number(r.finish_time_ms),
    accuracy_pct: Number(r.accuracy_pct),
    avg_time_per_problem_ms: Number(r.avg_time_per_problem_ms),
    // NULL on both for a DNF: that race earned nothing and set no pace.
    points: r.points == null ? null : Number(r.points),
    ppm: r.ppm == null ? null : Number(r.ppm),
    played_at: toIso(r.played_at),
  };
}

/**
 * The race-history page query for fetchRaceHistory. `pointsExpr` is "points"
 * on a database at migration 0009 or later, "NULL" on one still behind — see
 * withColumnFallback in ../db.js; raceListItem already reads a NULL points as
 * "not scored". PPM is derived from columns that predate 0009, so it always
 * lands.
 */
const HISTORY_SQL = (pointsExpr, whereClause) => `WITH ordered AS (
   SELECT difficulty, finish_time_ms, accuracy_pct,
          avg_time_per_problem_ms, played_at, ${pointsExpr} AS points,
          CASE WHEN finished = 1 AND finish_time_ms > 0
               THEN problems_correct * 60000.0 / finish_time_ms END AS ppm,
          ROW_NUMBER() OVER (ORDER BY played_at ASC, id ASC) AS race_seq
     FROM race_results
    WHERE user_id = ?
 )
 SELECT * FROM ordered
  ${whereClause}
  ORDER BY race_seq DESC
  LIMIT ?`;

/**
 * One page of a user's races, newest first.
 *
 * Reads `limit + 1` rows so `next_cursor` can say whether an older page exists
 * without a second COUNT query; the probe row is never returned.
 *
 * @param {object} env
 * @param {string} userId
 * @param {{difficulty?: string|null, before?: number|null, limit: number}} page
 *   `difficulty` narrows to one tier (null = every tier); `before` is a
 *   race_seq and only races numbered strictly below it are returned.
 * @returns {Promise<{races: object[], next_cursor: number|null}>}
 */
async function fetchRaceHistory(env, userId, { difficulty = null, before = null, limit }) {
  const where = [];
  const binds = [userId];
  if (difficulty != null) {
    where.push("difficulty = ?");
    binds.push(difficulty);
  }
  if (before != null) {
    where.push("race_seq < ?");
    binds.push(before);
  }
  binds.push(limit + 1);

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await withColumnFallback(
    env,
    HISTORY_SQL("points", whereClause),
    HISTORY_SQL("NULL", whereClause),
    binds
  );
  const races = rows.slice(0, limit).map(raceListItem);
  const hasOlder = rows.length > limit;
  return {
    races,
    next_cursor: hasOlder ? races[races.length - 1].race_seq : null,
  };
}

/**
 * Parse `?before=`. Absent means "from the newest race". Anything else must
 * be a positive integer written plainly — a cursor is something the client
 * copied from `next_cursor`, so a value that does not look like one is a bug
 * on the caller's side and gets a 400, unlike the forgiving `?limit=`.
 *
 * @returns {number|null|undefined} null when absent, undefined when invalid.
 */
function parseBefore(raw) {
  if (raw == null) return null;
  if (!/^[1-9]\d*$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * Parse `?limit=`. Anything unreadable falls back to the default rather than
 * 400-ing — the same posture as /api/leaderboard: a page size is a view
 * preference, not a claim about which rows exist.
 */
function parseHistoryLimit(raw) {
  if (raw == null || raw === "") return HISTORY_DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return HISTORY_DEFAULT_LIMIT;
  return Math.min(n, HISTORY_MAX_LIMIT);
}

export async function handleGetMyRaces(request, env) {
  const userId = await readUserId(request, env);
  if (!userId) return new Response("unauthorized", { status: 401 });

  const url = new URL(request.url);
  // `?difficulty=` (present but empty) reads as "no filter", so a client can
  // bind the parameter unconditionally to an "All" control.
  const difficulty = url.searchParams.get("difficulty") || null;
  if (difficulty != null && !DIFFICULTIES.includes(difficulty)) {
    return Response.json({ error: "invalid_difficulty" }, { status: 400 });
  }
  const before = parseBefore(url.searchParams.get("before"));
  if (before === undefined) {
    return Response.json({ error: "invalid_cursor" }, { status: 400 });
  }
  const limit = parseHistoryLimit(url.searchParams.get("limit"));

  const page = await fetchRaceHistory(env, userId, { difficulty, before, limit });
  return Response.json({ difficulty, limit, ...page });
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
  // signup. Used to attribute recent anon races to this user (the email/password
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
      await runClaim(env, userId, deviceId, { source: "first_username_set" });
    } catch (err) {
      // Don't fail the rename on a claim hiccup; the user has their name set.
      logError(KINDS.CLAIM_FAILED, err, { trigger: "first_username_set", userId });
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

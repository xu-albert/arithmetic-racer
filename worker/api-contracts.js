// API contracts for the arithmetic-racer Worker.
// FROZEN: a shape already described here does not change after Foundation.
// Backend route handlers and frontend code both depend on these shapes, so
// altering one requires coordinating with all consumers. Appending the
// typedefs for a newly added endpoint is not such a change — that is how a new
// route gets documented, and leaves every existing shape untouched.
//
// All endpoints are mounted under the same origin as the static assets.

/**
 * @typedef {'easy'|'medium'|'hard'} Difficulty
 */

/**
 * POST /api/race-result
 * Body: RaceResultInput
 * Response: { id: string, claimed: boolean }
 *
 * @typedef {Object} RaceResultInput
 * @property {string} device_id           UUID v4 from localStorage
 * @property {Difficulty} difficulty
 * @property {boolean} finished
 * @property {number|null} finish_time_ms NULL if user quit
 * @property {number} problems_total      default 20
 * @property {number} problems_correct
 * @property {number} problems_attempted
 * @property {number} avg_time_per_problem_ms
 * @property {number} accuracy_pct        0..100
 * @property {number} longest_streak
 */

/**
 * GET /api/me  (requires session cookie)
 * Response: MeResponse  |  401 if no session
 *
 * @typedef {Object} MeResponse
 * @property {string} username
 * @property {string} email
 * @property {string} created_at          ISO 8601
 * @property {DifficultyAggregates[]} aggregates  always 3 entries (one per difficulty)
 * @property {RaceListItem[]} recent
 *
 * Scoring note: `points` and `ppm` are per-difficulty by construction. The
 * three difficulties are separate point pools — this API never returns a
 * cross-difficulty total, ranking, or weighted score, and consumers must not
 * build one. Formula: worker/race-score.js.
 *
 * @typedef {Object} DifficultyAggregates
 * @property {Difficulty} difficulty
 * @property {number} races_played
 * @property {number} races_finished
 * @property {number|null} best_time_ms
 * @property {number} avg_accuracy        0..100
 * @property {number} avg_problem_time_ms
 * @property {number} total_points        sum over this difficulty only; 0 if none scored
 * @property {number|null} avg_ppm        mean problems/minute over *finished* races; null if none
 * @property {number|null} best_ppm       best problems/minute; null if no finished race
 *
 * @typedef {Object} RaceListItem
 * @property {number} race_seq            1-based per-user counter
 * @property {Difficulty} difficulty
 * @property {number|null} finish_time_ms
 * @property {number} accuracy_pct
 * @property {number} avg_time_per_problem_ms
 * @property {number|null} points         null for a DNF (0 is an earnable score)
 * @property {number|null} ppm            problems/minute; null for a DNF
 * @property {string} played_at           ISO 8601
 */

/**
 * POST /api/me/username  (requires session cookie)
 * Body: { username: string, deviceId?: string }
 *   The optional deviceId is used by the OAuth signup flow to claim anon
 *   races on first-username-set; ignored on subsequent renames.
 * Response (200): { username: string }
 * Response (400): { error: 'taken' | 'banned' | 'reserved' | 'invalid_format' }
 * Response (401): if no session.
 */

/**
 * GET /api/leaderboard?difficulty=…&period=…&limit=…   (no auth)
 *
 * ADDITIVE: a new endpoint, added after the freeze. Nothing above it changed —
 * the freeze protects the shapes existing consumers already read, and this
 * introduces no new consumer for any of them.
 *
 * One board = one (difficulty, period) pair. `difficulty` is required and the
 * three tiers are never combined: there is no all-difficulty board, and a
 * consumer must not build one by merging responses. `period` defaults to
 * 'all'; every bounded period runs from a **UTC** calendar boundary to now
 * (weeks start Monday) — see worker/leaderboard-period.js.
 *
 * Only server-observed races are listed: room races (room_id IS NOT NULL) by
 * a signed-in racer, with suspect = 0. Solo/Quickplay results are client-
 * reported and never appear. Rationale: worker/routes/leaderboard.js.
 *
 * Response (200): LeaderboardResponse
 * Response (400): { error: 'invalid_difficulty' | 'invalid_period' }
 *
 * @typedef {Object} LeaderboardResponse
 * @property {Difficulty} difficulty
 * @property {'all'|'day'|'week'|'month'|'year'} period
 * @property {string|null} period_start   ISO 8601 UTC; null on the all-time board
 * @property {string} generated_at        ISO 8601
 * @property {LeaderboardEntry[]} entries ranked best-first; at most `limit` (default 10, max 50)
 *
 * @typedef {Object} LeaderboardEntry
 * @property {number} rank                1-based, dense within the response
 * @property {string} username
 * @property {number} ppm                 best problems/minute in the window
 * @property {number|null} points         points from *that* race; null only if unscored
 * @property {string} played_at           ISO 8601 — when the ranked race happened
 */

/**
 * GET /api/stats/by-device/:device_id   (no auth)
 * Counts only rows with user_id IS NULL — i.e., still-anonymous races.
 * After a claim, those rows have user_id set and stop counting here.
 *
 * @typedef {Object} ByDeviceStats
 * @property {number} total_races
 * @property {number|null} best_time_ms
 * @property {Difficulty|null} best_difficulty
 */

/**
 * GET /api/recent-finishes?limit=N   (no auth)
 *
 * The lobby's "who's racing" strip: newest eligible room finishes, ordered by
 * recency and never by speed. `limit` defaults to 8 and is capped at 25; an
 * unreadable value falls back to the default rather than 400-ing.
 *
 * Eligibility (room races only, plausible, finished) and why anonymous racers
 * ARE listed here even though leaderboards exclude them:
 * worker/routes/recent-finishes.js. Neither `room_id` nor `device_id` is ever
 * returned.
 *
 * @typedef {Object} RecentFinishesResponse
 * @property {string} generated_at        ISO 8601; the clock relative times are computed against
 * @property {number} limit               the limit actually applied
 * @property {RecentFinish[]} finishes    newest first
 *
 * @typedef {Object} RecentFinish
 * @property {string|null} username       null for an anonymous racer — render as "Guest"
 * @property {Difficulty} difficulty
 * @property {number} problems_correct
 * @property {number} ppm                 problems/minute for this race
 * @property {number|null} points         null when unscored (0 is an earnable score)
 * @property {string} played_at           ISO 8601
 */

export {};

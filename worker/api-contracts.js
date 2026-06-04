// API contracts for the arithmetic-racer Worker.
// FROZEN: do not modify after Foundation. Backend route handlers and
// frontend code both depend on these shapes. Any change here requires
// coordinating with all consumers.
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
 * @typedef {Object} DifficultyAggregates
 * @property {Difficulty} difficulty
 * @property {number} races_played
 * @property {number} races_finished
 * @property {number|null} best_time_ms
 * @property {number} avg_accuracy        0..100
 * @property {number} avg_problem_time_ms
 *
 * @typedef {Object} RaceListItem
 * @property {number} race_seq            1-based per-user counter
 * @property {Difficulty} difficulty
 * @property {number|null} finish_time_ms
 * @property {number} accuracy_pct
 * @property {number} avg_time_per_problem_ms
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
 * GET /api/stats/by-device/:device_id   (no auth)
 * Counts only rows with user_id IS NULL — i.e., still-anonymous races.
 * After a claim, those rows have user_id set and stop counting here.
 *
 * @typedef {Object} ByDeviceStats
 * @property {number} total_races
 * @property {number|null} best_time_ms
 * @property {Difficulty|null} best_difficulty
 */

export {};

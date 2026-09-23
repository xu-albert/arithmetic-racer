// Client-side username validator (browser).
//
// MIRROR of worker/username-validator.js — covers format + reserved exactly,
// and banned words against a compact curated list. The browser cannot resolve
// the bare `obscenity` specifier without a bundler (we serve vanilla ES
// modules), and vendoring obscenity's full dataset for instant inline checks
// isn't worth the bytes, so the client checks only the most common banned
// words with the same raw + word-boundary-split matching the server uses.
//
// Every word on BANNED_WORDS below also exists in the server's obscenity
// dataset (verified against the pinned obscenity version), so the preview
// never rejects a name the server would accept. The converse does NOT hold:
// the client list is a subset of the server's dataset, so the preview can
// green-light a name the server rejects — leetspeak like "sh1t" and rarer
// terms pass here and are caught only at submit time, where the server
// returns { error: "banned" } and the auth modal surfaces it as an inline
// error.
//
// Coverage:
//   format    : checked here (instant feedback as the user types)
//   reserved  : checked here (instant feedback)
//   banned    : checked here (common words, instant feedback) + server-only
//               remainder at submit
//   uniqueness: server-only.

/**
 * @typedef {{ valid: true } | { valid: false, reason: 'banned'|'reserved'|'invalid_format' }} ValidationResult
 */

const RESERVED = new Set([
  "admin",
  "administrator",
  "moderator",
  "mod",
  "system",
  "root",
  "support",
  "help",
  "api",
  "www",
  "null",
  "undefined",
  "anonymous",
  "guest",
  "bot",
]);

const FORMAT_RE = /^[A-Za-z][A-Za-z0-9_]{2,19}$/;

// Compact subset of the server's obscenity dataset: the common words worth
// instant feedback. Kept whole-word-only so legitimate names that merely
// contain a banned syllable ("ClassicAnna", "Assassin", "Scunthorpe") stay
// valid. Every entry here must also match worker/username-validator.js's
// matcher — if the server-side dataset or library is ever changed, re-verify
// the overlap (worker/username-validator.test.js asserts the bypass cases).
const BANNED_WORDS = [
  "bitch",
  "boob",
  "boobs",
  "cock",
  "cunt",
  "dick",
  "fuck",
  "nigga",
  "nigger",
  "porn",
  "pussy",
  "shit",
  "slut",
  "tits",
  "whore",
];

const BANNED_RES = BANNED_WORDS.map((w) => new RegExp(`\\b${w}\\b`, "i"));

/**
 * Insert spaces at camelCase and letter/digit transitions so run-together
 * names expose their word boundaries, mirroring splitWordBoundaries in
 * worker/username-validator.js.
 */
function splitWordBoundaries(s) {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Za-z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ");
}

/**
 * Whole-word match against the raw name and its boundary-split form — the
 * same dual check the server's containsProfanity runs. Raw catches plain
 * forms ("shit"), split catches run-together forms ("SuperShitLord" ->
 * "super shit lord"). Neither form is sufficient alone.
 */
function hasBannedWord(username) {
  const split = splitWordBoundaries(username);
  return BANNED_RES.some((re) => re.test(username) || re.test(split));
}

/**
 * Format + reserved + common-banned-word check. Does NOT check uniqueness,
 * and its banned list is a subset of the server's — the server remains the
 * authority on submit.
 * @param {string} username
 * @returns {ValidationResult}
 */
export function validateUsernameSync(username) {
  if (typeof username !== "string" || !FORMAT_RE.test(username)) {
    return { valid: false, reason: "invalid_format" };
  }
  if (RESERVED.has(username.toLowerCase())) {
    return { valid: false, reason: "reserved" };
  }
  if (hasBannedWord(username)) {
    return { valid: false, reason: "banned" };
  }
  return { valid: true };
}

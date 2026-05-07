// Client-side username validator (browser).
//
// PARTIAL MIRROR of worker/username-validator.js — covers format + reserved
// only. The browser cannot resolve the bare `obscenity` specifier without
// a bundler (we serve vanilla ES modules), and vendoring obscenity's full
// dataset for instant inline checks isn't worth the bytes. The Worker is
// authoritative on profanity: when a user types a banned name, the server
// returns { error: "banned" } at submit time and the auth modal surfaces
// it as an inline error.
//
// Coverage:
//   format    : checked here (instant feedback as the user types)
//   reserved  : checked here (instant feedback)
//   banned    : NOT checked here. Surfaced only on submit by the server.
//   uniqueness: server-only.

/**
 * @typedef {{ valid: true } | { valid: false, reason: 'reserved'|'invalid_format' }} ValidationResult
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

/**
 * Format + reserved-name check. Does NOT check banned words or uniqueness.
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
  return { valid: true };
}

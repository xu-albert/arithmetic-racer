// MIRROR OF worker/username-validator.js — keep in sync.
//
// Pure-function username validator. Used in the browser by the auth modal
// to give inline feedback without a server round trip. The server is
// authoritative; this file must produce identical results for identical
// input so the inline preview matches what the server will say on submit.
//
// The browser bundler will pull obscenity from node_modules; in Node.js
// (where the test runner lives), the standard ESM wrapper at
// `obscenity/dist/index.mjs` resolves correctly. Only the Workers runtime
// has a quirk that requires the `createRequire` workaround in the server
// mirror.

import {
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
} from "obscenity";

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

const matcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

/**
 * Run all pure-function checks. Does NOT check DB uniqueness.
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
  if (matcher.hasMatch(username)) {
    return { valid: false, reason: "banned" };
  }
  return { valid: true };
}

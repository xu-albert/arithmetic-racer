// MIRROR OF public/src/username-validator-client.js — keep in sync.
//
// Pure-function username validator. Used by the Worker to validate usernames
// before any DB write. Does NOT check uniqueness — callers must run a separate
// DB query for that. The client mirror at public/src/username-validator-client.js
// must produce identical results for identical input so the inline preview in
// the auth modal matches what the server will say on submit.
//
// NOTE on the import: obscenity ships an ESM wrapper (`dist/index.mjs`) that
// does `import mod from './index.js'` and then re-exports `mod.X` for each
// named export. In the Cloudflare Workers runtime this `mod` resolves to
// `undefined`, so the named imports throw. Loading via `createRequire`
// pulls the CJS file directly (`module.exports`) and works correctly under
// `nodejs_compat`. Node's ESM loader handles the wrapper fine, so the
// client mirror uses a normal `import`.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
} = require("obscenity");

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

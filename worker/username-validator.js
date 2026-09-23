// MIRROR OF public/src/username-validator-client.js — keep in sync.
//
// Pure-function username validator. Used by the Worker to validate usernames
// before any DB write. Does NOT check uniqueness — callers must run a separate
// DB query for that. The client mirror at public/src/username-validator-client.js
// runs the same format + reserved checks so the inline preview in the auth
// modal matches the server; its banned-word check uses a compact curated list
// (every word on it also exists in this file's obscenity dataset, so a name the
// client rejects the server rejects too), while the full dataset here remains
// the authority on submit.
//
// NOTE on the import: obscenity ships a broken ESM wrapper at `dist/index.mjs`
// that does `import mod from "./index.js"` and re-exports `mod.X` for each
// named symbol. In the workerd runtime, `mod` resolves to `undefined` and the
// wrapper itself fails to evaluate (TypeError at the `export const DataSet =
// mod.DataSet` line).
//
// `wrangler.jsonc` aliases `obscenity` -> `./node_modules/obscenity/dist/index.js`
// (the CJS file) for the bundled Worker, so this regular import resolves to
// the working module. vitest-pool-workers also picks up the same wrangler
// config, so tests get the same alias.
//
// Agent A's original workaround (`createRequire(import.meta.url)`) worked in
// the test environment but broke under `wrangler dev` because esbuild's
// bundled entry has `import.meta.url` undefined. The alias is cleaner than
// per-file workarounds.
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
 * Profanity check with no format opinion, for callers that allow shapes
 * `validateUsernameSync` would reject anyway — room handles permit
 * punctuation, emoji, and 1-24 chars. Shares the matcher above so there's a
 * single source of profanity truth and only one dataset build per isolate.
 *
 * Non-strings are treated as clean; shape validation belongs to the caller.
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function containsProfanity(text) {
  if (typeof text !== "string") return false;
  // Checked in both forms deliberately. obscenity only matches terms starting
  // at a word boundary (that's what keeps "assassin", "classic", "Scunthorpe"
  // and "grass" from tripping it), so "SuperShitLord" slips through raw but is
  // caught once camel case is split into words. The reverse is also true —
  // leetspeak like "sh1t" matches raw but not after splitting — so neither
  // form alone is sufficient.
  return matcher.hasMatch(text) || matcher.hasMatch(splitWordBoundaries(text));
}

/**
 * Insert spaces at camelCase and letter/digit transitions so run-together
 * handles expose their word boundaries to the matcher.
 *
 * Known limitation: an all-lowercase run-on like "supershitlord" has no
 * boundary to find and stays undetected. Catching it would mean substring
 * matching, which reintroduces the Scunthorpe problem and would reject
 * legitimate handles. Deliberate trade-off in favor of not blocking real names.
 */
function splitWordBoundaries(s) {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Za-z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ");
}

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
  if (containsProfanity(username)) {
    return { valid: false, reason: "banned" };
  }
  return { valid: true };
}

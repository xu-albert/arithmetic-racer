// MIRROR OF public/src/username-validator-client.js — keep in sync.
//
// Pure-function username validator. Used by the Worker to validate usernames
// before any DB write. Does NOT check uniqueness — callers must run a separate
// DB query for that. The client mirror at public/src/username-validator-client.js
// must produce identical results for identical input so the inline preview in
// the auth modal matches what the server will say on submit.
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

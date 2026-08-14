// The running app version, for bug reports.
//
// Two values, because they answer different questions:
//
//   APP_VERSION — package.json's version. Coarse and human-readable, but it is
//     bumped by hand and has never been bumped, so on its own it cannot say
//     *which* deploy a reporter was on.
//   deployId(env) — the Cloudflare Worker Version id, read from the
//     `version_metadata` binding. Cloudflare mints a new one on every deploy
//     with no human diligence required, which is what makes a bug report
//     attributable to a build.
//
// There is no build step for `public/` — wrangler's ASSETS binding serves those
// files byte-for-byte — so there is no existing place where a build-time value
// gets substituted into client code, and nothing to hook into. The Worker, by
// contrast, *is* bundled (esbuild, via wrangler), so importing package.json
// here collapses to a string literal in the output with no new tooling; the
// same import resolves under vitest, which is why it can be asserted on.
//
// Reading both server-side also means a bug report cannot claim a version it
// isn't running. Assets and Worker ship in a single deploy, so this is the
// version of the page the reporter had open, not just of the API.
import pkg from "../package.json";

export const APP_VERSION = pkg.version;

/**
 * The Worker Version id of the running deploy, or null when it is unknowable.
 *
 * Null is a real case rather than a defect: the binding is absent on any build
 * deployed before it was added to wrangler.jsonc, and the value it carries
 * under `wrangler dev` / miniflare is whatever the local runtime makes up. A
 * stored null reads as "this build could not say", which is honest, so the
 * field is omitted entirely rather than filled with a stand-in.
 *
 * @param {object} [env] Worker env; `CF_VERSION_METADATA` is the binding.
 * @returns {string|null}
 */
export function deployId(env) {
  const id = env?.CF_VERSION_METADATA?.id;
  return typeof id === "string" && id ? id : null;
}

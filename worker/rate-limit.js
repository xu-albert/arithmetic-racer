// Seam over the native Workers rate-limit binding.
//
// Why a seam at all: the binding is not constructible in a test — it arrives on
// `env` and has no local implementation — so calling it directly from a route
// would make that route's policy untestable and would hard-fail anywhere
// `ratelimits` is not configured (local dev, a stripped preview).
//
// This is **cost control, not integrity**. Its job is to stop a script
// hammering D1, not to decide whether a score is real; that is
// worker/plausibility.js. Keeping the two apart is what makes each number
// obvious — conflating them is how the original spec ended up with a cap set
// below what a real player produces.
//
// Two properties of the binding shape the callers:
//   - `period` must be exactly 10 or 60 seconds. Hourly windows are not
//     expressible, so any "N per hour" rule has to be restated per minute.
//   - Counters are per Cloudflare location, not global. A distributed client
//     gets one budget per colo it reaches, so treat every limit as a floor on
//     what an attacker can send, not a ceiling.

import { logWarn, KINDS } from "./logger.js";

/**
 * Fail-open warnings, latched once per condition per isolate.
 *
 * What the warn reports is a property of the deployment or of an ongoing
 * incident — "this limiter is unavailable" is true of every request or of
 * none — so one line carries the whole signal and a line per request carries
 * nothing more. This only became material when the leaderboard put this helper
 * on the lobby's first screen: the previous caller was a POST that happens once
 * per race, where per-call was per-race. `observability.head_sampling_rate` is
 * 1, so nothing downstream thins it either.
 *
 * The two conditions latch independently because an operator wants to tell
 * them apart: an absent binding is a configuration mistake that will not
 * resolve itself (AGENTS.md: `wrangler.jsonc` bindings are not inherited by
 * `env.preview`, so a one-place edit produces exactly this there), while a
 * throwing binding is usually a transient service failure. Seeing the second
 * appear while the first stays quiet is the difference between "we shipped it
 * wrong" and "Cloudflare is having a moment".
 *
 * Volume only. Every caller still gets the same answer on every path.
 */
let warnedNoBinding = false;
let warnedLimiterThrew = false;

/** Test seam: the latches outlive a call, so a suite must be able to clear them. */
export function _resetFailOpenWarnings() {
  warnedNoBinding = false;
  warnedLimiterThrew = false;
}

/**
 * @param {{limit: (arg: {key: string}) => Promise<{success: boolean}>}|undefined} limiter
 *   A rate-limit binding from `env`, or undefined where none is configured.
 * @param {string} key The bucket to count against — a device id or client IP.
 * @returns {Promise<boolean>} true if the request may proceed.
 */
export async function allowRequest(limiter, key) {
  // Fail open on a missing binding. This endpoint's job is recording races;
  // refusing every write because a limiter was not configured trades a
  // hypothetical abuse problem for a certain outage. Same call the contact
  // form already makes when KV is unavailable.
  if (!limiter || typeof limiter.limit !== "function") {
    if (!warnedNoBinding) {
      warnedNoBinding = true;
      logWarn(KINDS.RATE_LIMIT_UNAVAILABLE, "no rate limit binding configured", {
        outcome: "failed_open",
        cause: "no_binding",
      });
    }
    return true;
  }

  let result;
  try {
    result = await limiter.limit({ key });
  } catch (err) {
    if (!warnedLimiterThrew) {
      warnedLimiterThrew = true;
      logWarn(KINDS.RATE_LIMIT_UNAVAILABLE, err, {
        outcome: "failed_open",
        cause: "limiter_threw",
      });
    }
    return true;
  }

  // Deliberately not `!== false`: a binding returning a shape we do not
  // recognise must not be read as permission, or one bad response silently
  // disables the limit. Unlike the throw path above, this is a live binding
  // giving a live answer — we just cannot parse it.
  return result?.success === true;
}

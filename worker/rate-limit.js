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
    logWarn(KINDS.RATE_LIMIT_UNAVAILABLE, "no rate limit binding configured", {
      outcome: "failed_open",
    });
    return true;
  }

  let result;
  try {
    result = await limiter.limit({ key });
  } catch (err) {
    logWarn(KINDS.RATE_LIMIT_UNAVAILABLE, err, { outcome: "failed_open" });
    return true;
  }

  // Deliberately not `!== false`: a binding returning a shape we do not
  // recognise must not be read as permission, or one bad response silently
  // disables the limit. Unlike the throw path above, this is a live binding
  // giving a live answer — we just cannot parse it.
  return result?.success === true;
}

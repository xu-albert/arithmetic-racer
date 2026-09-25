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
import { logThrottleDecision, FRESH_THROTTLE } from "./log-throttle.js";

/**
 * How long one `limiter_threw` line speaks for. Not the limiter's own period —
 * this is a claim about log volume, not about rate policy, and tying it to the
 * binding's window would couple two unrelated numbers.
 */
const THREW_LOG_WINDOW_MS = 60_000;

/**
 * Bounded fail-open warnings, per condition and per limiter.
 *
 * What the warn reports is a property of the deployment or of an ongoing
 * incident — "this limiter is unavailable" — so a line per request would scale
 * with exactly the traffic it is about and add nothing. This only became
 * material when the leaderboard put this helper on the lobby's first screen:
 * the previous caller was a POST that happens once per race, where per-call was
 * per-race. `observability.head_sampling_rate` is 1, so nothing downstream
 * thins it either.
 *
 * Keyed by limiter, because three of them share this seam
 * (LEADERBOARD_IP_LIMIT, RACE_RESULT_IP_LIMIT, RACE_RESULT_LIMIT). A single
 * bound across all three would let the first one to fail silence the other two,
 * and the surviving line does not say which fired — strictly worse to debug
 * than the unbounded version it replaced.
 *
 * The two causes are bounded differently because they behave differently:
 *
 *   no_binding    — a configuration mistake that will not resolve itself
 *                   (AGENTS.md: `wrangler.jsonc` bindings are not inherited by
 *                   `env.preview`, so a one-place edit produces exactly this
 *                   there). One line per deployment is the whole signal, so a
 *                   plain latch fits.
 *   limiter_threw — usually a transient service failure, and one that can
 *                   recur. A permanent latch would let a blip at 10:00 hide a
 *                   real outage at 14:00 in the same warm isolate, and would
 *                   make a one-request hiccup indistinguishable from a
 *                   two-hour incident. Windowed instead, so recurrence stays
 *                   visible while volume stays bounded.
 *
 * Volume and content only. Every caller still gets the same answer on every
 * path, and the label is optional so an unlabelled call still works.
 */
const warnedNoBinding = new Set();
const threwThrottles = new Map();

/** Test seam: this state outlives a call, so a suite must be able to clear it. */
export function _resetFailOpenWarnings() {
  warnedNoBinding.clear();
  threwThrottles.clear();
}

/**
 * @param {{limit: (arg: {key: string}) => Promise<{success: boolean}>}|undefined} limiter
 *   A rate-limit binding from `env`, or undefined where none is configured.
 * @param {string} key The bucket to count against — a device id or client IP.
 * @param {string} [label] Binding name, so a fail-open line says which limiter
 *   it is about. Omitting it still works; the line just cannot name one.
 * @returns {Promise<boolean>} true if the request may proceed.
 */
export async function allowRequest(limiter, key, label = "unnamed") {
  // Fail open on a missing binding. The callers here record races and serve
  // the public boards; refusing all of that because a limiter was not
  // configured trades a hypothetical abuse problem for a certain outage. Same
  // call the contact form already makes when its limiter is unavailable.
  if (!limiter || typeof limiter.limit !== "function") {
    if (!warnedNoBinding.has(label)) {
      warnedNoBinding.add(label);
      logWarn(KINDS.RATE_LIMIT_UNAVAILABLE, "no rate limit binding configured", {
        outcome: "failed_open",
        cause: "no_binding",
        limiter: label,
      });
    }
    return true;
  }

  let result;
  try {
    result = await limiter.limit({ key });
  } catch (err) {
    const decision = logThrottleDecision(
      threwThrottles.get(label) ?? FRESH_THROTTLE,
      Date.now(),
      THREW_LOG_WINDOW_MS
    );
    threwThrottles.set(label, decision.state);
    if (decision.emit) {
      logWarn(KINDS.RATE_LIMIT_UNAVAILABLE, err, {
        outcome: "failed_open",
        cause: "limiter_threw",
        limiter: label,
        // Failures, not denied requests: this path never denied anything.
        failures: decision.count,
        since_ms: decision.sinceMs,
        window_s: THREW_LOG_WINDOW_MS / 1000,
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

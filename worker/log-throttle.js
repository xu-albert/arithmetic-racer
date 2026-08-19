// Bounded logging for conditions that repeat per request.
//
// Several diagnostics on the hot path report a *condition* rather than an
// event: "this limiter is unavailable", "the limit is being hit". A line per
// request would scale with exactly the traffic the condition is about, and
// `observability.head_sampling_rate` is 1 in wrangler.jsonc, so nothing
// downstream thins it. One line per window carries the same signal.
//
// Pure so the bound is testable without leaning on wall-clock timing or on
// whichever caller logged first: state in, decision out. The caller owns the
// state and the window, because "how often is too often" is a property of the
// thing being reported, not of this helper.

/** Starting state. Never mutated — every decision returns a fresh object. */
export const FRESH_THROTTLE = Object.freeze({ count: 0, lastLogMs: null });

/**
 * READ THE PAYLOAD CAREFULLY. This emits on the *leading* edge, so the first
 * line of a burst is a first-occurrence notice, not a census: `count: 1` with
 * `sinceMs: null` means "this just started happening", not "it happened once".
 * A Worker has no timer and no trailing flush, so occurrences that accumulate
 * after that line only surface when a later one crosses the window — which
 * means `count` is a real total only on a line whose `sinceMs` is at least one
 * window. `sinceMs` is carried precisely so the two cannot be confused: a big
 * `count` over a `sinceMs` barely past the window is a flood, and a burst that
 * dies inside one window leaves its tail uncounted rather than misreported.
 *
 * `count` is deliberately neutral — a caller names it for what it counted.
 *
 * @param {{count: number, lastLogMs: number|null}} state
 * @param {number} now
 * @param {number} windowMs
 */
export function logThrottleDecision(state, now, windowMs) {
  const count = state.count + 1;
  const sinceMs = state.lastLogMs == null ? null : now - state.lastLogMs;
  if (sinceMs !== null && sinceMs < windowMs) {
    return { emit: false, state: { count, lastLogMs: state.lastLogMs } };
  }
  // The emitting occurrence counts itself, so this is the suppressed tail plus one.
  return { emit: true, count, sinceMs, state: { count: 0, lastLogMs: now } };
}

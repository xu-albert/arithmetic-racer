// Per-connection WebSocket message limiter.
//
// Deliberately not the native rate-limit binding. A RaceRoom is a single
// Durable Object instance that already holds per-connection state in memory and
// processes messages one at a time, so a plain Map is both more accurate than
// an external limiter (which counts per-colo) and free — no binding, no
// network hop on the hot path of every answer.
//
// Counters live only in memory. Hibernation drops them, which resets a
// connection's budget; that is the correct trade here, since the thing being
// prevented is a sustained flood and a hibernating room is by definition idle.

/**
 * A race is 10 problems over ~30s, so a real player sends well under one
 * message per second. 20/s is far above any human interaction rate while still
 * stopping a socket from spinning messages as fast as it can write them.
 */
export const MAX_MESSAGES_PER_WINDOW = 20;

/** Fixed window. Short enough that a blocked client recovers almost at once. */
export const WINDOW_MS = 1000;

/**
 * @param {{max?: number, windowMs?: number, now?: () => number}} [options]
 *   `now` is injectable so window expiry can be tested without sleeping.
 */
export function createSocketLimiter({
  max = MAX_MESSAGES_PER_WINDOW,
  windowMs = WINDOW_MS,
  now = Date.now,
} = {}) {
  /** @type {Map<string, {windowStart: number, count: number}>} */
  const buckets = new Map();

  return {
    /**
     * Record a message from `id` and report whether it may be handled.
     * @param {string} id A connection id.
     * @returns {boolean}
     */
    allow(id) {
      const t = now();
      const bucket = buckets.get(id);

      if (!bucket || t - bucket.windowStart >= windowMs) {
        buckets.set(id, { windowStart: t, count: 1 });
        return true;
      }

      bucket.count += 1;
      return bucket.count <= max;
    },

    /**
     * Drop a connection's bucket. Called on close so a long-lived room does
     * not retain an entry per socket it has ever seen.
     * @param {string} id
     */
    forget(id) {
      buckets.delete(id);
    },

    /** Number of tracked connections. Exposed for tests and diagnostics. */
    size() {
      return buckets.size;
    },
  };
}

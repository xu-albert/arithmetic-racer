// Leaderboard period windows.
//
// A board is either all-time or "period to date": every window starts at a
// calendar boundary and runs to now. That is what makes a daily board reset —
// a rolling "last 24 hours" never resets, so nobody ever gets to be today's
// fastest.
//
// **Every boundary is UTC.** `race_results.played_at` is epoch milliseconds,
// the Worker has no user timezone to consult, and a board whose day rolls over
// at the *server's* local midnight would move if the runtime's TZ ever changed.
// UTC makes the boundary a property of the data rather than of where the code
// runs, and it is the same convention the admin dashboard already uses
// (`utcMidnightMs` in worker/routes/admin.js).
//
// Weeks start Monday (ISO 8601), so the week board resets when the work week
// does rather than mid-weekend.

/** Board windows, in the order the UI shows them. `all` has no lower bound. */
export const PERIODS = ["all", "day", "week", "month", "year"];

const PERIOD_SET = new Set(PERIODS);

/** True for a value that names one of the board windows. */
export function isPeriod(value) {
  return typeof value === "string" && PERIOD_SET.has(value);
}

/**
 * Inclusive lower bound (epoch ms) of a board window containing `nowMs`.
 *
 * Returns 0 for `all` rather than null so callers can bind it into the same
 * `played_at >= ?` parameter for every window — one query shape, no branch.
 * (0 is 1970; no race predates it, and `played_at` is NOT NULL.)
 *
 * @param {string} period one of PERIODS
 * @param {number} nowMs epoch milliseconds
 * @returns {number} epoch milliseconds
 */
export function periodStartMs(period, nowMs) {
  if (!isPeriod(period)) throw new TypeError(`unknown period: ${period}`);
  if (period === "all") return 0;
  if (!Number.isFinite(nowMs)) throw new TypeError(`nowMs must be finite: ${nowMs}`);

  const d = new Date(nowMs);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const date = d.getUTCDate();

  switch (period) {
    case "day":
      return Date.UTC(year, month, date);
    case "week": {
      // getUTCDay() is 0=Sunday..6=Saturday; shift so Monday is 0. Date.UTC
      // normalizes a day-of-month that goes below 1, so subtracting rolls back
      // into the previous month (and year) without any special-casing.
      const daysSinceMonday = (d.getUTCDay() + 6) % 7;
      return Date.UTC(year, month, date - daysSinceMonday);
    }
    case "month":
      return Date.UTC(year, month, 1);
    case "year":
      return Date.UTC(year, 0, 1);
    default:
      // Unreachable: isPeriod() already gated the value.
      throw new TypeError(`unknown period: ${period}`);
  }
}

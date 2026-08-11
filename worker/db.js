// Tiny D1 helper. Centralizes the binding lookup so route handlers don't
// reach into env directly. Add query helpers here later if patterns repeat.
export function db(env) {
  return env.DB;
}

// SQLite words a missing column two ways depending on the statement: a SELECT
// that names one fails with "no such column: x", an INSERT with "table t has
// no column named x". D1 wraps both, prefixed and sometimes nested under
// `cause`, so match on the phrasing and walk the chain.
const MISSING_COLUMN_RE = /no such column|has no column named/i;

/**
 * True when a statement failed *only* because a column it names does not exist.
 *
 * Migrations here are applied by hand while the Worker deploys from a push, so
 * a build can briefly run against a database one migration behind — see
 * migrations/README.md. Code that reads a newly added column uses this to fall
 * back to the older shape for exactly that window. Every other failure is left
 * to propagate, so a real database error still surfaces as one.
 */
export function isMissingColumnError(err) {
  let e = err;
  for (let depth = 0; e != null && depth < 4; depth++) {
    const message = typeof e === "string" ? e : e.message;
    if (typeof message === "string" && MISSING_COLUMN_RE.test(message)) return true;
    e = e.cause;
  }
  return false;
}

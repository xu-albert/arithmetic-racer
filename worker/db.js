// Tiny D1 helpers. Centralizes the binding lookup so route handlers don't
// reach into env directly, plus the shared missing-column fallback for reads
// of recently migrated columns (withColumnFallback below).
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

/**
 * Run a `.all()` query that names a column a recent migration added, retrying
 * with a column-free statement when the database is still a migration behind.
 *
 * Migrations here are applied by hand while the Worker deploys from a push, so
 * a build can briefly run against a database one migration behind — see
 * migrations/README.md. Callers that read a newly added column pass both
 * statement forms and the fallback becomes the default instead of a discipline
 * each route has to remember. Only a genuinely missing column takes the
 * fallback; every other failure propagates, so a real database error still
 * surfaces as one.
 *
 * @param {object} env
 * @param {string} withSql Statement naming the new column.
 * @param {string} withoutSql The same statement with that column's read
 *   replaced by a literal (usually NULL) so it compiles without the column.
 * @param {unknown[]} [binds] Bound parameters, identical for both forms.
 * @returns {Promise<object[]>} The statement's `results` rows, or [] when none.
 */
export async function withColumnFallback(env, withSql, withoutSql, binds = []) {
  try {
    const { results } = await db(env).prepare(withSql).bind(...binds).all();
    return results ?? [];
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    const { results } = await db(env).prepare(withoutSql).bind(...binds).all();
    return results ?? [];
  }
}

// CHECK-constraint extraction for scripts/check-schema-drift.mjs. Kept apart
// from that script because this half is pure string work with no sqlite3 or D1
// dependency at all, and is covered on its own by scripts/sql-constraints.test.mjs.

/**
 * Blank out line comments and block comments, leaving a space in their place so
 * neighbouring tokens do not glue together. Quoted spans are copied through
 * untouched, so a literal like `'%--%'` is not mistaken for a comment opener.
 */
function stripSqlComments(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] !== ch) {
          j++;
        } else if (sql[j + 1] === ch) {
          j += 2; // doubled quote is an escaped quote, not the end
        } else {
          j++;
          break;
        }
      }
      out += sql.slice(i, j);
      i = j;
    } else if (ch === "-" && sql[i + 1] === "-") {
      const newline = sql.indexOf("\n", i);
      i = newline === -1 ? sql.length : newline;
      out += " ";
    } else if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/**
 * Pull the CHECK constraints out of a stored CREATE TABLE, whitespace-normalized
 * so formatting differences are not drift. Neither `PRAGMA table_info` nor any
 * other pragma exposes them, and they are load-bearing: `difficulty`, `finished`,
 * `kind` and `handled` are all constrained this way.
 *
 * SQLite stores the CREATE TABLE text verbatim, comments included — 0006 keeps
 * two inside the `contact_messages` body — so comments are stripped first and a
 * commented-out CHECK never becomes a constraint.
 */
export function checkConstraints(tableSql) {
  if (!tableSql) return [];
  const sql = stripSqlComments(tableSql);
  const found = [];
  const opener = /\bCHECK\s*\(/gi;
  while (opener.exec(sql) !== null) {
    let depth = 1;
    let quote = null;
    let i = opener.lastIndex;
    while (i < sql.length && depth > 0) {
      const ch = sql[i];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === "'" || ch === '"') {
        quote = ch;
      } else if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth--;
      }
      i++;
    }
    found.push(`CHECK (${sql.slice(opener.lastIndex, i - 1).replace(/\s+/g, " ").trim()})`);
    opener.lastIndex = i;
  }
  return found;
}

// Exercises the drift-detection logic against scratch SQLite files built here
// in the test. Nothing in this file contacts a live D1 database; the only
// dependency is the `sqlite3` CLI the checker already requires.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compare, diff, readSchema } from "./check-schema-drift.mjs";

// `user` and `race_results` both carry constraint indexes; `contact_messages`
// carries none (INTEGER PRIMARY KEY is the rowid, not an index); `d1_migrations`
// is bookkeeping the checker must skip. The mix is deliberate: the per-index
// PRAGMA results are sliced out of one flat batch by position, so tables and
// indexes that do not line up one-to-one are what catches an offset error.
const USER_TABLE = `CREATE TABLE "user" (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE
);`;

const CONTACT_TABLE = `CREATE TABLE contact_messages (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'general' CHECK (kind IN ('general', 'deletion'))
);`;

const RACE_TABLE = `CREATE TABLE race_results (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  room_id TEXT,
  score INTEGER NOT NULL DEFAULT 0,
  finished INTEGER NOT NULL DEFAULT 0 CHECK (finished IN (0, 1)),
  UNIQUE (room_id, user_id)
);`;

const ROOM_INDEX = `CREATE INDEX race_results_room_idx
  ON race_results(room_id)
  WHERE room_id IS NOT NULL;`;

const LEDGER_TABLE = `CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE);`;

const BASE_DDL = [USER_TABLE, CONTACT_TABLE, RACE_TABLE, ROOM_INDEX, LEDGER_TABLE].join("\n");

function schemaOf(ddl) {
  const dir = mkdtempSync(join(tmpdir(), "drift-test-"));
  const dbPath = join(dir, "scratch.db");
  try {
    execFileSync("sqlite3", [dbPath, ddl], { encoding: "utf8" });
    return readSchema((statements) =>
      statements.map((sql) => {
        const out = execFileSync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8" }).trim();
        return out ? JSON.parse(out) : [];
      })
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("describes every column of every table", () => {
  const schema = schemaOf(BASE_DDL);

  assert.deepEqual(schema.columns.user, [
    "email TEXT notnull=1 default=- pk=0",
    "id TEXT notnull=0 default=- pk=1",
  ]);
  assert.deepEqual(schema.columns.race_results, [
    "finished INTEGER notnull=1 default=0 pk=0",
    "id TEXT notnull=0 default=- pk=1",
    "room_id TEXT notnull=0 default=- pk=0",
    "score INTEGER notnull=1 default=0 pk=0",
    "user_id TEXT notnull=0 default=- pk=0",
  ]);
});

test("describes foreign keys, which PRAGMA table_info cannot see", () => {
  const schema = schemaOf(BASE_DDL);

  assert.deepEqual(schema.foreignKeys.race_results, [
    "user_id -> user(id) on_update=NO ACTION on_delete=SET NULL match=NONE",
  ]);
  assert.deepEqual(schema.foreignKeys.user, []);
});

test("describes CHECK constraints per table", () => {
  const schema = schemaOf(BASE_DDL);

  assert.deepEqual(schema.checks.race_results, ["CHECK (finished IN (0, 1))"]);
  assert.deepEqual(schema.checks.contact_messages, ["CHECK (kind IN ('general', 'deletion'))"]);
  assert.deepEqual(schema.checks.user, []);
});

test("attributes each constraint index to its own table and columns", () => {
  const schema = schemaOf(BASE_DDL);

  // The autoindex names (`sqlite_autoindex_race_results_1`) are numbered by
  // declaration order and deliberately not compared; the covered columns are.
  assert.deepEqual(schema.uniques.race_results, [
    "pk unique=1 partial=0 (id)",
    "u unique=1 partial=0 (room_id, user_id)",
  ]);
  assert.deepEqual(schema.uniques.user, [
    "pk unique=1 partial=0 (id)",
    "u unique=1 partial=0 (email)",
  ]);
  assert.deepEqual(schema.uniques.contact_messages, []);
});

test("keeps explicit CREATE INDEX DDL, whitespace-normalized", () => {
  const schema = schemaOf(BASE_DDL);

  assert.deepEqual(schema.indexes, {
    race_results_room_idx:
      "CREATE INDEX race_results_room_idx ON race_results(room_id) WHERE room_id IS NOT NULL",
  });
});

test("skips D1 bookkeeping tables and the indexes behind them", () => {
  const schema = schemaOf(BASE_DDL);

  assert.deepEqual(Object.keys(schema.columns).sort(), ["contact_messages", "race_results", "user"]);
  assert.equal("d1_migrations" in schema.uniques, false);
  assert.equal(
    Object.keys(schema.indexes).some((name) => name.includes("d1_migrations")),
    false
  );
});

test("describes an empty database as an empty schema", () => {
  const schema = schemaOf("PRAGMA user_version = 0");

  assert.deepEqual(schema, { columns: {}, foreignKeys: {}, checks: {}, uniques: {}, indexes: {} });
});

test("reports no problems when the database matches the migrations", () => {
  assert.deepEqual(compare(schemaOf(BASE_DDL), schemaOf(BASE_DDL)), []);
});

test("reports a foreign key the database dropped", () => {
  // The 2026-07-28 drift in miniature: `user_id TEXT` that quietly lost its
  // `REFERENCES "user"(id)`, invisible to a column-only comparison.
  const actual = schemaOf(BASE_DDL.replace(`user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL`, "user_id TEXT"));

  assert.deepEqual(compare(schemaOf(BASE_DDL), actual), [
    "race_results: missing or altered foreign key -> " +
      "user_id -> user(id) on_update=NO ACTION on_delete=SET NULL match=NONE",
  ]);
});

test("reports a table the database never got", () => {
  const actual = schemaOf([USER_TABLE, RACE_TABLE, ROOM_INDEX, LEDGER_TABLE].join("\n"));

  assert.deepEqual(compare(schemaOf(BASE_DDL), actual), ["missing table: contact_messages"]);
});

test("reports a table the migrations do not describe", () => {
  const expected = schemaOf([USER_TABLE, RACE_TABLE, ROOM_INDEX, LEDGER_TABLE].join("\n"));

  assert.deepEqual(compare(expected, schemaOf(BASE_DDL)), ["unexpected table: contact_messages"]);
});

test("reports a column the database is missing", () => {
  const actual = schemaOf(BASE_DDL.replace("  room_id TEXT,\n", "").replace("UNIQUE (room_id, user_id)", "UNIQUE (user_id)").replace("ON race_results(room_id)", "ON race_results(user_id)").replace("WHERE room_id IS NOT NULL", "WHERE user_id IS NOT NULL"));
  const problems = compare(schemaOf(BASE_DDL), actual);

  assert.ok(
    problems.includes("race_results: missing or altered column -> room_id TEXT notnull=0 default=- pk=0"),
    `expected a missing-column problem, got: ${JSON.stringify(problems)}`
  );
});

test("reports a column the migrations do not describe", () => {
  const actual = schemaOf(BASE_DDL.replace("  room_id TEXT,", "  room_id TEXT,\n  bonus INTEGER,"));

  assert.deepEqual(compare(schemaOf(BASE_DDL), actual), [
    "race_results: unexpected column -> bonus INTEGER notnull=0 default=- pk=0",
  ]);
});

test("reports a CHECK constraint the database dropped", () => {
  const actual = schemaOf(BASE_DDL.replace(" CHECK (finished IN (0, 1))", ""));

  assert.deepEqual(compare(schemaOf(BASE_DDL), actual), [
    "race_results: missing or altered CHECK constraint -> CHECK (finished IN (0, 1))",
  ]);
});

test("reports a UNIQUE constraint the database dropped", () => {
  const actual = schemaOf(BASE_DDL.replace("  email TEXT NOT NULL UNIQUE", "  email TEXT NOT NULL"));

  assert.deepEqual(compare(schemaOf(BASE_DDL), actual), [
    "user: missing or altered PRIMARY KEY / UNIQUE index -> u unique=1 partial=0 (email)",
  ]);
});

test("reports an explicit index the database never got", () => {
  const actual = schemaOf([USER_TABLE, CONTACT_TABLE, RACE_TABLE, LEDGER_TABLE].join("\n"));

  assert.deepEqual(compare(schemaOf(BASE_DDL), actual), ["missing index: race_results_room_idx"]);
});

test("reports an explicit index the migrations do not describe", () => {
  const expected = schemaOf([USER_TABLE, CONTACT_TABLE, RACE_TABLE, LEDGER_TABLE].join("\n"));

  assert.deepEqual(compare(expected, schemaOf(BASE_DDL)), ["unexpected index: race_results_room_idx"]);
});

test("reports an explicit index whose covered columns changed", () => {
  const actual = schemaOf(BASE_DDL.replace("ON race_results(room_id)", "ON race_results(user_id)"));
  const problems = compare(schemaOf(BASE_DDL), actual);

  assert.equal(problems.length, 1);
  assert.match(problems[0], /^index differs: race_results_room_idx\n/);
  assert.match(problems[0], /migrations: CREATE INDEX race_results_room_idx ON race_results\(room_id\)/);
  assert.match(problems[0], /database: {3}CREATE INDEX race_results_room_idx ON race_results\(user_id\)/);
});

test("reports a partial index that lost its WHERE clause", () => {
  const actual = schemaOf(BASE_DDL.replace("\n  WHERE room_id IS NOT NULL", ""));
  const problems = compare(schemaOf(BASE_DDL), actual);

  assert.equal(problems.length, 1);
  assert.match(problems[0], /^index differs: race_results_room_idx\n/);
});

test("compares each group as a set, not by declaration order", () => {
  const reordered = schemaOf(
    BASE_DDL.replace(
      "  score INTEGER NOT NULL DEFAULT 0,\n  finished INTEGER NOT NULL DEFAULT 0",
      "  finished INTEGER NOT NULL DEFAULT 0"
    ).replace(
      "CHECK (finished IN (0, 1)),\n  UNIQUE (room_id, user_id)",
      "CHECK (finished IN (0, 1)),\n  score INTEGER NOT NULL DEFAULT 0,\n  UNIQUE (room_id, user_id)"
    )
  );

  assert.deepEqual(compare(schemaOf(BASE_DDL), reordered), []);
});

test("diff records what each side is missing", () => {
  const problems = [];
  diff(problems, "race_results", "column", ["a", "b"], ["b", "c"]);

  assert.deepEqual(problems, [
    "race_results: missing or altered column -> a",
    "race_results: unexpected column -> c",
  ]);
});

test("diff records nothing when both sides hold the same set", () => {
  const problems = [];
  diff(problems, "race_results", "column", ["a", "b"], ["b", "a"]);

  assert.deepEqual(problems, []);
});

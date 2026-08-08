#!/usr/bin/env node
// Compares the schema that `migrations/` produces against what the live D1
// databases actually contain.
//
// This exists because on 2026-07-28 three migrations turned out to have never
// been applied to either database: race_results was missing `room_id`, so every
// race insert had been failing since 2026-06-06, and `contact_messages` did not
// exist at all, so the contact form 500'd. Neither showed up in tests, because
// each test file hand-built its own schema — they were exercising a shape prod
// did not have. Nothing compared the migrations directory to reality.
//
// What is compared, per table: columns, foreign keys, CHECK constraints, and
// the indexes SQLite builds behind PRIMARY KEY / UNIQUE. Constraints matter as
// much as columns here: part of the drift that started all this was a
// `user_id TEXT` that had quietly lost its `REFERENCES "user"(id)`, and a
// foreign key is invisible to `PRAGMA table_info`.
//
// Those four are compared as *sets*, never as raw `sqlite_master` SQL text. A
// column added by ALTER TABLE lands at the end of the table definition, so a
// database that applied 0003 and 0007 in a different order than a fresh replay
// produces byte-different DDL for an identical schema. Declaration order is not
// meaningful here — every INSERT in the codebase names its columns explicitly.
//
// Explicit CREATE INDEX statements are the exception. They are keyed by index
// name and compared by their whitespace-normalized DDL text, which is stricter
// than a set comparison and deliberately so: it covers the indexed columns,
// their sort order and any WHERE clause, none of which a name-only comparison
// would notice. The cost is that editing an already-applied migration's
// CREATE INDEX — reformatting it, or adding an inline comment — reports
// `index differs` for a schema that is semantically identical.
//
// Usage:
//   node scripts/check-schema-drift.mjs                 # prod + preview
//   node scripts/check-schema-drift.mjs --db prod       # one database
//
// Exits non-zero if any database differs from the migrations.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkConstraints } from "./sql-constraints.mjs";

const DATABASES = { prod: "arithmetic-racer", preview: "arithmetic-racer-preview" };

// Bookkeeping tables D1/miniflare create on their own. `d1_migrations` is
// wrangler's tracker and is stale here by design: this project applies
// migrations by hand with `--file=`, which never writes to it.
const IGNORED_TABLES = new Set(["_cf_KV", "_cf_ALARM", "d1_migrations"]);

// Per-table comparison groups, as `[key on the schema object, noun for errors]`.
const PER_TABLE = [
  ["columns", "column"],
  ["foreignKeys", "foreign key"],
  ["checks", "CHECK constraint"],
  ["uniques", "PRIMARY KEY / UNIQUE index"],
];

function sqlite(dbPath, sql) {
  return execFileSync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8" }).trim();
}

function parse(out) {
  return out ? JSON.parse(out) : [];
}

/** Replay every migration in filename order into a throwaway SQLite file. */
function expectedSchema() {
  const dir = mkdtempSync(join(tmpdir(), "arith-schema-"));
  const dbPath = join(dir, "expected.db");
  try {
    const files = readdirSync("migrations")
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      execFileSync("sqlite3", [dbPath, `.read migrations/${f}`], { encoding: "utf8" });
    }
    return readSchema((statements) => statements.map((sql) => parse(sqlite(dbPath, sql))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * wrangler prefixes the JSON payload with a banner on some versions, and those
 * banners carry brackets of their own (`▲ [WARNING] …`). Anchor on a line
 * boundary so a banner can never be mistaken for the start of the payload.
 */
function jsonPayload(out) {
  const lines = out.split("\n");
  const start = lines.findIndex((line) => line.trim().startsWith("["));
  if (start === -1) throw new Error(`wrangler printed no JSON payload:\n${out}`);
  return lines.slice(start).join("\n");
}

/** Read the live schema out of a D1 database over the wrangler CLI. */
function actualSchema(binding) {
  return readSchema((statements) => {
    if (statements.length === 0) return [];
    // One `--command` carries the whole batch; D1 answers with one result
    // object per statement, in order.
    const out = execFileSync(
      "npx",
      [
        "wrangler",
        "d1",
        "execute",
        binding,
        "--remote",
        "--json",
        "--command",
        statements.map((sql) => `${sql};`).join("\n"),
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
    );
    const payload = JSON.parse(jsonPayload(out));
    if (payload.length !== statements.length) {
      throw new Error(
        `wrangler returned ${payload.length} result(s) for ${statements.length} statement(s); ` +
          `the batch cannot be matched up positionally.`
      );
    }
    return payload.map((r) => r.results ?? []);
  });
}

/**
 * Collect the full schema description using a caller-supplied batch query — it
 * takes an array of statements and returns an array of row arrays, one per
 * statement — so the local scratch file and the remote D1 are read through
 * exactly the same logic. Two round trips: one to learn the names, one to
 * describe everything they name.
 */
function readSchema(query) {
  const [tableRows, indexRows] = query([
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    "SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' ORDER BY name",
  ]);

  const tableList = tableRows.filter((t) => !IGNORED_TABLES.has(t.name));
  const indexList = indexRows.filter((i) => !IGNORED_TABLES.has(i.tbl_name));

  const described = query([
    ...tableList.flatMap((t) => [
      `PRAGMA table_info("${t.name}")`,
      `PRAGMA foreign_key_list("${t.name}")`,
      `PRAGMA index_list("${t.name}")`,
    ]),
    ...indexList.map((i) => `PRAGMA index_info("${i.name}")`),
  ]);

  // Index columns first: the per-table constraint indexes are described by the
  // columns they cover, not by their `sqlite_autoindex_<table>_<n>` name, whose
  // number depends on the order the constraints were declared in.
  const indexColumns = {};
  indexList.forEach((index, i) => {
    indexColumns[index.name] = described[tableList.length * 3 + i]
      .slice()
      .sort((a, b) => a.seqno - b.seqno)
      .map((c) => c.name ?? "<expr>")
      .join(", ");
  });

  const columns = {};
  const foreignKeys = {};
  const checks = {};
  const uniques = {};

  tableList.forEach((table, i) => {
    const [tableInfo, fkList, idxList] = described.slice(i * 3, i * 3 + 3);
    columns[table.name] = tableInfo
      .map((c) => `${c.name} ${c.type} notnull=${c.notnull} default=${c.dflt_value ?? "-"} pk=${c.pk}`)
      .sort();
    foreignKeys[table.name] = fkList
      .map(
        (f) =>
          `${f.from} -> ${f.table}(${f.to ?? "primary key"}) ` +
          `on_update=${f.on_update} on_delete=${f.on_delete} match=${f.match}`
      )
      .sort();
    checks[table.name] = checkConstraints(table.sql).sort();
    // `origin: "c"` indexes come from CREATE INDEX and are compared below by
    // their DDL; these are the ones SQLite builds for PRIMARY KEY and UNIQUE,
    // which have no DDL of their own and were previously invisible.
    uniques[table.name] = idxList
      .filter((idx) => idx.origin !== "c")
      .map((idx) => `${idx.origin} unique=${idx.unique} partial=${idx.partial} (${indexColumns[idx.name]})`)
      .sort();
  });

  const indexes = {};
  for (const index of indexList) {
    if (index.sql) indexes[index.name] = index.sql.replace(/\s+/g, " ").trim();
  }

  return { columns, foreignKeys, checks, uniques, indexes };
}

function diff(problems, table, kind, want, have) {
  const present = new Set(have);
  for (const item of want) if (!present.has(item)) problems.push(`${table}: missing or altered ${kind} -> ${item}`);
  const wanted = new Set(want);
  for (const item of have) if (!wanted.has(item)) problems.push(`${table}: unexpected ${kind} -> ${item}`);
}

function compare(label, expected, actual) {
  const problems = [];

  for (const table of Object.keys(expected.columns)) {
    if (!(table in actual.columns)) {
      problems.push(`missing table: ${table}`);
      continue;
    }
    for (const [group, kind] of PER_TABLE) {
      diff(problems, table, kind, expected[group][table], actual[group][table]);
    }
  }
  for (const table of Object.keys(actual.columns)) {
    if (!(table in expected.columns)) problems.push(`unexpected table: ${table}`);
  }

  for (const [name, sql] of Object.entries(expected.indexes)) {
    if (!(name in actual.indexes)) problems.push(`missing index: ${name}`);
    else if (actual.indexes[name] !== sql) problems.push(`index differs: ${name}\n    migrations: ${sql}\n    database:   ${actual.indexes[name]}`);
  }
  for (const name of Object.keys(actual.indexes)) {
    if (!(name in expected.indexes)) problems.push(`unexpected index: ${name}`);
  }

  if (problems.length === 0) {
    console.log(`✅ ${label}: matches migrations/`);
    return true;
  }
  console.log(`❌ ${label}: ${problems.length} difference(s)`);
  for (const p of problems) console.log(`   - ${p}`);
  console.log(
    `   Fix by applying the missing migration(s) with:\n` +
      `     npm run migrate:${label} -- --file=migrations/<file>.sql`
  );
  return false;
}

const only = process.argv.includes("--db") ? process.argv[process.argv.indexOf("--db") + 1] : null;
const targets = only ? { [only]: DATABASES[only] } : DATABASES;
if (only && !DATABASES[only]) {
  console.error(`Unknown database "${only}". Expected one of: ${Object.keys(DATABASES).join(", ")}`);
  process.exit(2);
}

const expected = expectedSchema();
let ok = true;
for (const [label, binding] of Object.entries(targets)) {
  ok = compare(label, expected, actualSchema(binding)) && ok;
}
process.exit(ok ? 0 : 1);

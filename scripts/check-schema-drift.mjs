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
// Compares column *sets*, not the raw `sqlite_master` SQL text. A column added
// by ALTER TABLE lands at the end of the table definition, so a database that
// applied 0003 and 0007 in a different order than a fresh replay produces
// byte-different DDL for an identical schema. Column order is not meaningful
// here — every INSERT in the codebase names its columns explicitly.
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

const DATABASES = { prod: "arithmetic-racer", preview: "arithmetic-racer-preview" };

// Bookkeeping tables D1/miniflare create on their own. `d1_migrations` is
// wrangler's tracker and is stale here by design: this project applies
// migrations by hand with `--file=`, which never writes to it.
const IGNORED_TABLES = new Set(["_cf_KV", "_cf_ALARM", "d1_migrations"]);

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
    return readSchema((sql) => parse(sqlite(dbPath, sql)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Read the live schema out of a D1 database over the wrangler CLI. */
function actualSchema(binding) {
  return readSchema((sql) => {
    const out = execFileSync(
      "npx",
      ["wrangler", "d1", "execute", binding, "--remote", "--json", "--command", sql],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
    );
    // wrangler prefixes the JSON payload with a banner on some versions.
    const start = out.indexOf("[");
    return JSON.parse(out.slice(start))[0].results;
  });
}

/**
 * Collect {tables: {name -> [column, ...]}, indexes: {name -> sql}} using a
 * caller-supplied query function, so the local file and the remote D1 are read
 * through exactly the same logic.
 */
function readSchema(query) {
  const tables = {};
  const names = query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).map((r) => r.name);

  for (const name of names) {
    if (IGNORED_TABLES.has(name)) continue;
    tables[name] = query(`PRAGMA table_info("${name}")`)
      .map((c) => `${c.name} ${c.type} notnull=${c.notnull} default=${c.dflt_value ?? "-"} pk=${c.pk}`)
      .sort();
  }

  const indexes = {};
  for (const row of query(
    "SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name"
  )) {
    indexes[row.name] = row.sql.replace(/\s+/g, " ").trim();
  }
  return { tables, indexes };
}

function compare(label, expected, actual) {
  const problems = [];

  for (const [table, cols] of Object.entries(expected.tables)) {
    if (!(table in actual.tables)) {
      problems.push(`missing table: ${table}`);
      continue;
    }
    const have = new Set(actual.tables[table]);
    for (const col of cols) if (!have.has(col)) problems.push(`${table}: missing or altered column -> ${col}`);
    const want = new Set(cols);
    for (const col of actual.tables[table]) if (!want.has(col)) problems.push(`${table}: unexpected column -> ${col}`);
  }
  for (const table of Object.keys(actual.tables)) {
    if (!(table in expected.tables)) problems.push(`unexpected table: ${table}`);
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

// Migration tests. Applies the real .sql files, in filename order, to an
// in-memory SQLite database (better-sqlite3, already a devDependency for the
// better-auth config stub) and asserts on the schema that results.
//
// These run under `node --test`, not vitest-pool-workers, for one reason:
// D1's `exec()` splits its input on newlines and runs each line as a
// statement, so it cannot execute a multi-line `CREATE TABLE` — which is what
// every migration file here is. better-sqlite3's `exec()` parses real
// multi-statement SQL, so the *actual file* can be tested instead of a
// hand-maintained single-line paraphrase of it. D1 is SQLite, so the schema
// semantics under test (CHECK constraints, index survival, foreign keys) are
// the same engine's.
//
// The point is the 0008 rebuild: SQLite cannot widen a CHECK constraint in
// place, and the create/copy/drop/rename dance silently drops indexes and
// foreign keys if you let it.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const MIGRATIONS_DIR = dirname(fileURLToPath(import.meta.url));

function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // filename order is the apply order — see migrations/README.md
}

/**
 * Fresh database with every migration applied, optionally pausing after a
 * named file so a test can seed rows that the later migrations must carry.
 *
 * @param {(db: Database, applied: string) => void} [afterEach]
 */
function migrate(afterEach) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const file of migrationFiles()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    afterEach?.(db, file);
  }
  return db;
}

function indexNames(db, table) {
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`)
    .all(table)
    .map((r) => r.name)
    .filter((n) => !n.startsWith("sqlite_autoindex_"))
    .sort();
}

function columnNames(db, table) {
  return db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map((r) => r.name);
}

function insertMessage(db, overrides = {}) {
  const row = {
    id: `m-${Math.random().toString(36).slice(2)}`,
    email: null,
    message: "hello",
    kind: "general",
    user_id: null,
    device_id: null,
    handled: 0,
    created_at: 1700000000000,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO contact_messages (id, email, message, kind, user_id, device_id, handled, created_at)
     VALUES (@id, @email, @message, @kind, @user_id, @device_id, @handled, @created_at)`
  ).run(row);
  return row;
}

describe("migrations apply", () => {
  test("every migration file applies cleanly in filename order", () => {
    assert.doesNotThrow(() => migrate().close());
  });

  test("0008 applies after the file that creates the table it rebuilds", () => {
    // Filename order is the apply order, and 0008 rebuilds the table 0006
    // creates, so all this needs to pin is that it still lands after it — and
    // after 0007, the highest number it was renumbered past. This file was
    // `0007_contact_bug_reports.sql` until the gapless renumber (see
    // README.md); any future renumber that drags it above its prerequisite
    // fails here. It deliberately says nothing about which file is *last*, so
    // the next unrelated migration does not break the suite.
    //
    // The missing-file case is asserted explicitly: indexOf returns -1 for a
    // name that no longer exists, which would satisfy every `<` below and turn
    // this test vacuously green after a rename.
    const files = migrationFiles();
    const at = (name) => {
      const i = files.indexOf(name);
      assert.notEqual(i, -1, `${name} is missing — was it renumbered?`);
      return i;
    };
    assert.ok(at("0006_contact_messages.sql") < at("0008_contact_bug_reports.sql"));
    assert.ok(at("0007_race_results_suspect.sql") < at("0008_contact_bug_reports.sql"));
  });
});

describe("0008 — kind constraint", () => {
  let db;
  before(() => { db = migrate(); });

  test("accepts the bug kind", () => {
    assert.doesNotThrow(() => insertMessage(db, { kind: "bug" }));
    const row = db.prepare(`SELECT kind FROM contact_messages WHERE kind = 'bug'`).get();
    assert.equal(row.kind, "bug");
  });

  test("still accepts the kinds from 0006", () => {
    assert.doesNotThrow(() => insertMessage(db, { kind: "general" }));
    assert.doesNotThrow(() => insertMessage(db, { kind: "deletion" }));
  });

  test("still rejects an unknown kind", () => {
    // The CHECK is the schema-level backstop behind the route's allowlist. If
    // the rebuild had dropped it, an unknown kind would land silently.
    assert.throws(
      () => insertMessage(db, { kind: "urgent" }),
      /CHECK constraint failed/
    );
  });

  test("still defaults kind to general", () => {
    db.prepare(
      `INSERT INTO contact_messages (id, message, created_at) VALUES ('d1', 'no kind given', 1)`
    ).run();
    assert.equal(
      db.prepare(`SELECT kind FROM contact_messages WHERE id = 'd1'`).get().kind,
      "general"
    );
  });

  test("still rejects a handled value outside 0/1", () => {
    assert.throws(() => insertMessage(db, { handled: 2 }), /CHECK constraint failed/);
  });
});

describe("0008 — context column", () => {
  let db;
  before(() => { db = migrate(); });

  test("adds a nullable context column", () => {
    assert.ok(columnNames(db, "contact_messages").includes("context"));
    assert.doesNotThrow(() => insertMessage(db, { kind: "general" }));
    assert.equal(
      db.prepare(`SELECT context FROM contact_messages LIMIT 1`).get().context,
      null
    );
  });

  test("stores JSON that json_extract can read back", () => {
    // The justification for TEXT-over-anything-else: SQLite has no JSON type,
    // and the json_*() functions operate on TEXT. This is what "a JSON column"
    // means here, and it has to actually be queryable to be worth the choice.
    const context = JSON.stringify({ browser: "Chrome 141", os: "macOS", app_version: "0.1.0" });
    db.prepare(
      `INSERT INTO contact_messages (id, message, kind, created_at, context)
       VALUES ('c1', 'boom', 'bug', 1, ?)`
    ).run(context);
    const row = db
      .prepare(`SELECT json_extract(context, '$.os') AS os FROM contact_messages WHERE id = 'c1'`)
      .get();
    assert.equal(row.os, "macOS");
  });
});

describe("0008 — the rebuild preserves what 0006 created", () => {
  test("carries existing rows across unchanged", () => {
    // Seeded after 0006/0007 but before 0008, so the rows go through the
    // create/copy/drop/rename for real rather than being written afterwards.
    let seeded;
    const db = migrate((d, file) => {
      if (file !== "0007_race_results_suspect.sql") return;
      d.prepare(
        `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", username)
         VALUES ('u-1', 'Ada', 'ada@example.test', 0, '2026-01-01', '2026-01-01', 'ada')`
      ).run();
      seeded = insertMessage(d, {
        id: "old-1",
        email: "ada@example.test",
        message: "please delete my data",
        kind: "deletion",
        user_id: "u-1",
        device_id: "dev-abc",
        handled: 1,
        created_at: 1699999999999,
      });
    });

    const row = db.prepare(`SELECT * FROM contact_messages WHERE id = 'old-1'`).get();
    assert.deepEqual(
      { ...row, context: undefined },
      { ...seeded, context: undefined },
      "every column value must survive the table rebuild"
    );
    assert.equal(row.context, null, "pre-existing rows have no captured context");
    db.close();
  });

  test("keeps both indexes, including the partial unhandled one", () => {
    const db = migrate();
    assert.deepEqual(indexNames(db, "contact_messages"), [
      "idx_contact_messages_created",
      "idx_contact_messages_unhandled",
    ]);
    // The partial predicate is the part a careless rebuild loses quietly.
    const sql = db
      .prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_contact_messages_unhandled'`)
      .get().sql;
    assert.match(sql, /WHERE handled = 0/);
    db.close();
  });

  test("keeps the foreign key to \"user\", still ON DELETE SET NULL", () => {
    const db = migrate();
    const fks = db.prepare(`SELECT * FROM pragma_foreign_key_list('contact_messages')`).all();
    assert.equal(fks.length, 1);
    assert.equal(fks[0].table, "user");
    assert.equal(fks[0].from, "user_id");
    assert.equal(fks[0].to, "id");
    assert.equal(fks[0].on_delete, "SET NULL");
    db.close();
  });

  test("the foreign key is enforced, not merely declared", () => {
    const db = migrate();
    assert.throws(
      () => insertMessage(db, { user_id: "nobody" }),
      /FOREIGN KEY constraint failed/
    );
    db.close();
  });

  test("deleting a user nulls the message's user_id instead of deleting it", () => {
    // The whole reason for ON DELETE SET NULL: a deletion request must outlive
    // the account it was about, or the record of why the account went away is
    // destroyed along with it.
    const db = migrate();
    db.prepare(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", username)
       VALUES ('u-2', 'Bo', 'bo@example.test', 0, '2026-01-01', '2026-01-01', 'bo')`
    ).run();
    insertMessage(db, { id: "keep-1", user_id: "u-2", kind: "bug" });
    db.prepare(`DELETE FROM "user" WHERE id = 'u-2'`).run();

    const row = db.prepare(`SELECT * FROM contact_messages WHERE id = 'keep-1'`).get();
    assert.ok(row, "the message must survive its author's deletion");
    assert.equal(row.user_id, null);
    db.close();
  });

  test("leaves no rebuild scaffolding behind", () => {
    const db = migrate();
    const leftovers = db
      .prepare(`SELECT name FROM sqlite_master WHERE name LIKE '%contact_messages_new%'`)
      .all();
    assert.deepEqual(leftovers, []);
    db.close();
  });

  test("the schema passes SQLite's own integrity checks", () => {
    const db = migrate();
    assert.deepEqual(db.prepare(`PRAGMA foreign_key_check`).all(), []);
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
    db.close();
  });
});

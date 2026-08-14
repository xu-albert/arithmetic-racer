import { test } from "node:test";
import assert from "node:assert/strict";
import { checkConstraints } from "./sql-constraints.mjs";

test("returns nothing for a table with no CHECK", () => {
  assert.deepEqual(checkConstraints('CREATE TABLE t ("id" TEXT PRIMARY KEY)'), []);
});

test("returns nothing when the table has no stored DDL", () => {
  assert.deepEqual(checkConstraints(null), []);
  assert.deepEqual(checkConstraints(""), []);
});

test("extracts each CHECK, whitespace-normalized", () => {
  assert.deepEqual(
    checkConstraints(
      "CREATE TABLE race_results (\n" +
        "  difficulty TEXT NOT NULL CHECK (difficulty IN ('easy','medium','hard')),\n" +
        "  finished INTEGER NOT NULL CHECK (finished\n     IN (0,1))\n" +
        ")"
    ),
    ["CHECK (difficulty IN ('easy','medium','hard'))", "CHECK (finished IN (0,1))"]
  );
});

test("ignores a CHECK that is inside a line comment", () => {
  assert.deepEqual(
    checkConstraints(
      "CREATE TABLE t (\n" +
        "  a TEXT, -- CHECK (a IN ('x'))\n" +
        "  b INTEGER CHECK (b > 0)\n" +
        ")"
    ),
    ["CHECK (b > 0)"]
  );
});

test("ignores a CHECK that is inside a block comment", () => {
  assert.deepEqual(
    checkConstraints("CREATE TABLE t (a TEXT /* CHECK (a <> '') */, b INTEGER CHECK (b > 0))"),
    ["CHECK (b > 0)"]
  );
});

test("ignores a CHECK in a trailing comment with no newline after it", () => {
  assert.deepEqual(checkConstraints("CREATE TABLE t (a TEXT) -- CHECK (a IN ('x'))"), []);
});

test("keeps a comment that only sits next to a real CHECK", () => {
  // The shape 0006_contact_messages.sql actually stores: an inline comment on
  // the line above the constraint it documents.
  assert.deepEqual(
    checkConstraints(
      "CREATE TABLE contact_messages (\n" +
        "  email TEXT,                          -- optional; submitter may stay anonymous\n" +
        "  kind TEXT NOT NULL DEFAULT 'general' -- 'general' | 'deletion'\n" +
        "    CHECK (kind IN ('general', 'deletion')),\n" +
        "  handled INTEGER NOT NULL DEFAULT 0 CHECK (handled IN (0, 1))\n" +
        ")"
    ),
    ["CHECK (kind IN ('general', 'deletion'))", "CHECK (handled IN (0, 1))"]
  );
});

test("does not treat a comment opener inside a string literal as a comment", () => {
  assert.deepEqual(checkConstraints("CREATE TABLE t (a TEXT CHECK (a NOT LIKE '%--%'))"), [
    "CHECK (a NOT LIKE '%--%')",
  ]);
  assert.deepEqual(checkConstraints("CREATE TABLE t (a TEXT CHECK (a <> '/*'))"), [
    "CHECK (a <> '/*')",
  ]);
});

test("balances parentheses that appear inside string literals", () => {
  assert.deepEqual(checkConstraints("CREATE TABLE t (a TEXT CHECK (a IN ('a)b', 'c')))"), [
    "CHECK (a IN ('a)b', 'c'))",
  ]);
});

test("handles a doubled quote inside a literal", () => {
  assert.deepEqual(checkConstraints("CREATE TABLE t (a TEXT CHECK (a <> 'it''s'))"), [
    "CHECK (a <> 'it''s')",
  ]);
});

test("does not match CHECK as part of a longer identifier", () => {
  assert.deepEqual(checkConstraints("CREATE TABLE t (recheck INTEGER, xcheck (1))"), []);
});

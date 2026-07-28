-- Bug reports: a third contact kind, plus the context captured alongside one.
--
-- Two changes in one file, because the first forces a table rebuild and the
-- second may as well ride along in the same rewrite:
--
--   1. `kind` gains 'bug'. SQLite cannot ALTER a CHECK constraint in place, so
--      widening it means the rebuild dance below: create the new shape, copy,
--      drop, rename, recreate indexes. Both indexes and the foreign key to
--      "user" are reproduced verbatim from 0005 — DROP TABLE takes a table's
--      indexes with it, so a rebuild that forgot them would silently leave the
--      admin dashboard doing full scans.
--
--   2. `context` holds the browser/OS/screen/route/version snapshot taken when
--      a bug report is submitted, as a JSON object serialized to TEXT. TEXT
--      because SQLite — and therefore D1 — has no JSON column type at all; the
--      json_*() functions read and write TEXT, so `json_extract(context, ...)`
--      works on this exactly as it would on anything called a JSON column.
--      One blob rather than a column per field because the captured set is
--      expected to change with the app, and a column per field means a table
--      rebuild per field on a database that cannot cheaply drop columns.
--      NULL for the kinds that capture nothing ('general', 'deletion').
--
-- 0005's property is preserved: the row is the durable record and email is
-- only best-effort notification. Nothing here makes storing depend on sending.
--
-- No other table has a foreign key *to* contact_messages, so the DROP/RENAME
-- below cannot rewrite a reference elsewhere in the schema. defer_foreign_keys
-- is set regardless so the copy's own references to "user" are checked once at
-- the end of the enclosing transaction rather than row by row.

PRAGMA defer_foreign_keys = on;

CREATE TABLE contact_messages_new (
  id TEXT PRIMARY KEY,
  email TEXT,                          -- optional; submitter may stay anonymous
  message TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'general' -- 'general' | 'deletion' | 'bug'
    CHECK (kind IN ('general', 'deletion', 'bug')),
  user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL, -- set when signed in
  device_id TEXT,
  handled INTEGER NOT NULL DEFAULT 0 CHECK (handled IN (0, 1)),
  created_at INTEGER NOT NULL,
  context TEXT                         -- JSON object; NULL except on bug reports
);

INSERT INTO contact_messages_new
  (id, email, message, kind, user_id, device_id, handled, created_at, context)
SELECT id, email, message, kind, user_id, device_id, handled, created_at, NULL
  FROM contact_messages;

DROP TABLE contact_messages;

ALTER TABLE contact_messages_new RENAME TO contact_messages;

-- Verbatim from 0005: the dashboard lists newest-first and filters to
-- unhandled, and both indexes died with the old table above.
CREATE INDEX idx_contact_messages_created ON contact_messages (created_at DESC, id DESC);
CREATE INDEX idx_contact_messages_unhandled ON contact_messages (created_at DESC) WHERE handled = 0;

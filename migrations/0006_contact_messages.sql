-- Contact form submissions (POST /api/contact).
--
-- Stored as well as emailed: email delivery is best-effort and must never
-- fail the user's request, so the row is the durable record and the mail is
-- only a notification. If Loops is down or misconfigured, nothing is lost.
--
-- `email` is what the submitter typed, not an authenticated identity. A form
-- post proves nothing about who sent it, so a deletion request arriving here
-- must be verified out-of-band before anything is deleted. `handled` exists so
-- that triage state survives; it is not a claim that the sender is who they say.
CREATE TABLE contact_messages (
  id TEXT PRIMARY KEY,
  email TEXT,                          -- optional; submitter may stay anonymous
  message TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'general' -- 'general' | 'deletion'
    CHECK (kind IN ('general', 'deletion')),
  user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL, -- set when signed in
  device_id TEXT,
  handled INTEGER NOT NULL DEFAULT 0 CHECK (handled IN (0, 1)),
  created_at INTEGER NOT NULL
);

-- The admin dashboard lists newest-first and filters to unhandled; this covers
-- both without a table scan.
CREATE INDEX idx_contact_messages_created ON contact_messages (created_at DESC, id DESC);
CREATE INDEX idx_contact_messages_unhandled ON contact_messages (created_at DESC) WHERE handled = 0;

-- Audit log for the anonymous-history claim (runClaim in worker/auth.js).
--
-- Signing up attributes a browser's anonymous races to the new account, and
-- the only proof offered is the browser's deviceId. That id is not a secret
-- anyone can protect — whoever gets hold of it can claim the races behind it —
-- so the claim is narrowed to recent races and every claim leaves a row here
-- for the admin dashboard. A row is written for every claim that runs, even
-- one that found nothing: an account presenting a device that other accounts
-- have also presented is the pattern worth reviewing, whatever it matched.
--
-- The row is written in the same D1 batch as the claim's UPDATE, so there is
-- no claim without its record: if this table is missing, the claim fails too.
CREATE TABLE history_claims (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL, -- the claiming account
  device_id TEXT NOT NULL,                               -- the device it presented
  source TEXT NOT NULL                                   -- which flow ran the claim
    CHECK (source IN ('signup', 'first_username_set')),
  claimed INTEGER NOT NULL,        -- anonymous races attributed to the account
  left_unclaimed INTEGER NOT NULL, -- anonymous races on the device still unowned (older than the window)
  created_at INTEGER NOT NULL
);

-- The dashboard lists newest-first; the device index answers "who else has
-- claimed this device", which the dashboard shows beside each row.
CREATE INDEX idx_history_claims_created ON history_claims (created_at DESC, id DESC);
CREATE INDEX idx_history_claims_device ON history_claims (device_id);

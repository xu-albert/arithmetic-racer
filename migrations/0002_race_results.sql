-- Race results table. Holds one row per race, both anonymous (user_id NULL)
-- and registered (user_id set). device_id is recorded for both so the
-- claim-on-signup flow can attribute prior anon races to a fresh account.

CREATE TABLE race_results (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  device_id TEXT NOT NULL,
  difficulty TEXT NOT NULL CHECK (difficulty IN ('easy','medium','hard')),
  finished INTEGER NOT NULL CHECK (finished IN (0,1)),
  finish_time_ms INTEGER,
  problems_total INTEGER NOT NULL DEFAULT 20,
  problems_correct INTEGER NOT NULL,
  problems_attempted INTEGER NOT NULL,
  avg_time_per_problem_ms INTEGER NOT NULL,
  accuracy_pct REAL NOT NULL,
  longest_streak INTEGER NOT NULL,
  played_at INTEGER NOT NULL
);

CREATE INDEX idx_race_results_user_played ON race_results (user_id, played_at DESC);
CREATE INDEX idx_race_results_anon_device ON race_results (device_id) WHERE user_id IS NULL;

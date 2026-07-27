-- Race integrity: mark implausible results instead of refusing them.
--
-- The alternative was rejecting an out-of-bounds race at the API boundary, but
-- that destroys the exact row worth examining and tells the sender where the
-- threshold sits. Storing the verdict keeps the evidence and lets the policy
-- change later without having lost the data — a bound that turns out to be too
-- tight can be recomputed over history, whereas a rejected race is simply gone.
--
-- Leaderboards (Batch 2) must filter `suspect = 0`. Nothing else should.
-- Existing rows default to 0: they predate the bounds and were written when the
-- only writer was the game itself.
ALTER TABLE race_results ADD COLUMN suspect INTEGER NOT NULL DEFAULT 0;

-- Which bound was crossed ('impossibly_fast' | 'implausibly_slow'), NULL when
-- clean. Free text rather than a CHECK constraint so adding a new reason does
-- not require rewriting the table on SQLite.
ALTER TABLE race_results ADD COLUMN suspect_reason TEXT;

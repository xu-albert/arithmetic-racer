-- Per-race score.
--
--   points = problems_correct × (problems_correct / minutes) / 60
--
-- i.e. problems solved × problems-per-second: the structural analogue of
-- TypeRacer's words × words-per-second. Volume × rate, so a long race at a
-- moderate pace can out-earn a short one at a blistering pace. The formula
-- lives in worker/race-score.js; this file must agree with it.
--
-- Difficulty does not enter the number. easy/medium/hard are three separate
-- point pools that are never compared, weighted, or summed together — the
-- silo is what makes the score unfakeable, because README.md flags the
-- difficulty calibration as provisional and a weight would make that
-- provisional number decide who wins. Every aggregate over this column must
-- GROUP BY difficulty.
--
-- REAL, not INTEGER: rounding is a display concern, and storing rounded points
-- would make sums over a season drift. NULL rather than 0 for a race that was
-- not finished — 0 is a score a racer can genuinely earn (finished, nothing
-- correct), so conflating the two would corrupt every average built on this.
ALTER TABLE race_results ADD COLUMN points REAL;

-- Backfill: every past race already carries the two inputs, so history can be
-- scored retroactively and nothing has to be treated as pre-scoring. The WHERE
-- clause is the same scorability test as worker/race-score.js — finished, with
-- a positive finish time — leaving unfinished and untimed rows NULL.
--
-- PPM is deliberately NOT stored: it is problems_correct / minutes, derivable
-- from columns that are already here, and a stored copy is one more thing that
-- can disagree with them.
UPDATE race_results
   SET points = (problems_correct * (problems_correct * 60000.0 / finish_time_ms)) / 60.0
 WHERE finished = 1
   AND finish_time_ms IS NOT NULL
   AND finish_time_ms > 0;

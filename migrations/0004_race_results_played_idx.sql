-- Admin dashboard read paths order/scan by played_at: recent-races pagination
-- (ORDER BY played_at DESC, id DESC) and the summary/sparkline range queries
-- (WHERE played_at >= ?). The existing indexes both lead with user_id, so those
-- queries fall back to full table scans. This played_at-leading index turns the
-- pagination query into an indexed seek and bounds the summary scans.
CREATE INDEX IF NOT EXISTS idx_race_results_played_at
  ON race_results (played_at DESC, id DESC);

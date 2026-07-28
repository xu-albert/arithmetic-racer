-- room_id was added to race_results by 0003_race_results_room_id.sql.
-- Quickmatch and future per-room analytics filter by room_id, so add a
-- partial index that skips the (large) solo population where room_id is NULL.
CREATE INDEX idx_race_results_room ON race_results (room_id) WHERE room_id IS NOT NULL;

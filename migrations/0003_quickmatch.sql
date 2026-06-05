-- Add room_id to race_results so private + public room races can be filtered
-- and analyzed. NULL means a solo (non-room) race.
ALTER TABLE race_results ADD COLUMN room_id TEXT;
CREATE INDEX idx_race_results_room ON race_results (room_id) WHERE room_id IS NOT NULL;

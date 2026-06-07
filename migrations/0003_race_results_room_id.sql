-- Adds room_id (nullable) to race_results. Solo races leave it NULL; room
-- races store the room slug (e.g., "brave-otter-eel"). No FK — rooms are
-- ephemeral DO state, not table rows. No index — add one when a query needs it.

ALTER TABLE race_results ADD COLUMN room_id TEXT;

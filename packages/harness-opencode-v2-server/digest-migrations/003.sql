CREATE TABLE opcv2_pending_turn (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  PRIMARY KEY(session_id,turn_id)
);
ALTER TABLE opcv2_transcript_scan ADD COLUMN targeted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE opcv2_transcript_scan ADD COLUMN target_offset INTEGER NOT NULL DEFAULT 0;

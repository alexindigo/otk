ALTER TABLE opcv1_messages ADD COLUMN terminal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE opcv1_scan ADD COLUMN committed INTEGER NOT NULL DEFAULT 0;
UPDATE opcv1_scan SET committed=1 WHERE complete_revision IS NOT NULL;
-- The terminal projection is new; retain values while demand rebuilds its proof.
UPDATE opcv1_scan SET dirty=1,complete_revision=NULL,after_message=NULL,after_created=NULL,api_cursor=NULL,covered_created=NULL,covered_message=NULL;
CREATE TABLE opcv1_pending_turn (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  PRIMARY KEY(session_id,turn_id)
);

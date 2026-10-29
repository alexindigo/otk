ALTER TABLE opcv1_messages ADD COLUMN variant TEXT;
CREATE TABLE opcv1_helper_tools (
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  part_id TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL,
  time_start INTEGER,
  message_created INTEGER NOT NULL,
  scan_generation INTEGER NOT NULL,
  PRIMARY KEY(session_id,part_id)
);
CREATE INDEX opcv1_helper_tools_order
  ON opcv1_helper_tools(session_id,time_start,message_created,message_id,part_id);
CREATE TABLE opcv1_helper_scan (
  session_id TEXT PRIMARY KEY,
  after_part TEXT,
  scan_generation INTEGER NOT NULL,
  dirty INTEGER NOT NULL CHECK(dirty IN (0,1))
);

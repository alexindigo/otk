CREATE TABLE opcv2_transcript_header (
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  turn_id TEXT,
  scalar TEXT NOT NULL,
  generation INTEGER NOT NULL,
  PRIMARY KEY(session_id,message_id)
);
CREATE INDEX opcv2_transcript_header_order ON opcv2_transcript_header(session_id,seq);
CREATE INDEX opcv2_transcript_header_turn ON opcv2_transcript_header(session_id,turn_id,seq);
CREATE TABLE opcv2_transcript_scan (
  session_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0,
  exhausted INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  after_seq INTEGER,
  api_cursor TEXT
);
CREATE TABLE opcv2_transcript_helper (
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  part_id TEXT NOT NULL,
  scalar TEXT NOT NULL,
  generation INTEGER NOT NULL,
  PRIMARY KEY(session_id,message_id,part_id)
);

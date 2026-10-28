CREATE TABLE opcv1_scan (
  session_id TEXT PRIMARY KEY,
  native_id TEXT NOT NULL UNIQUE,
  after_message TEXT,
  scan_generation INTEGER NOT NULL,
  observed_revision INTEGER NOT NULL,
  complete_revision INTEGER,
  dirty INTEGER NOT NULL CHECK(dirty IN (0,1))
);
CREATE TABLE opcv1_messages (
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  turn_id TEXT,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  hash TEXT NOT NULL,
  scan_generation INTEGER NOT NULL,
  time_created INTEGER NOT NULL,
  time_completed INTEGER,
  agent TEXT, provider_id TEXT, model_id TEXT,
  cost REAL,
  input INTEGER, output INTEGER, reasoning INTEGER,
  cache_read INTEGER, cache_write INTEGER,
  PRIMARY KEY(session_id,message_id)
);
CREATE INDEX opcv1_messages_turn ON opcv1_messages(session_id,turn_id,message_id);
CREATE INDEX opcv1_messages_recent ON opcv1_messages(session_id,time_created,message_id);
CREATE TABLE opcv1_aggregates (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  call_count INTEGER NOT NULL,
  cost_sum REAL NOT NULL,
  input_sum INTEGER NOT NULL, output_sum INTEGER NOT NULL,
  reasoning_sum INTEGER NOT NULL,
  cache_read_sum INTEGER NOT NULL, cache_write_sum INTEGER NOT NULL,
  cost_unknown INTEGER NOT NULL,
  input_unknown INTEGER NOT NULL, output_unknown INTEGER NOT NULL,
  reasoning_unknown INTEGER NOT NULL,
  cache_read_unknown INTEGER NOT NULL, cache_write_unknown INTEGER NOT NULL,
  PRIMARY KEY(session_id,turn_id)
);
CREATE TABLE opcv1_inventory (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  generation INTEGER NOT NULL,
  completed_at INTEGER,
  database_identity TEXT
);
CREATE TABLE opcv1_presence (
  session_id TEXT PRIMARY KEY,
  inventory_generation INTEGER NOT NULL
);
CREATE TABLE opcv1_delete_intents (
  session_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  connection_generation INTEGER NOT NULL,
  time INTEGER NOT NULL,
  confirmed INTEGER NOT NULL CHECK(confirmed IN (0,1))
);

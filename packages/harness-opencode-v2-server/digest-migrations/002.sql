CREATE TABLE opcv2_delete_intents (
  session_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  connection_generation INTEGER NOT NULL,
  time INTEGER NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0
);

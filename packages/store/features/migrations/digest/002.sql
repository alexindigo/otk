CREATE TABLE digest_helpers (
  session_id TEXT PRIMARY KEY REFERENCES digest_sessions(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('digesting','ready','unavailable')),
  revision INTEGER NOT NULL,
  tool_count INTEGER CHECK(tool_count >= 0),
  current_name TEXT,
  current_title TEXT,
  current_start INTEGER,
  time_start INTEGER,
  time_end INTEGER
);

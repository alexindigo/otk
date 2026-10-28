CREATE TABLE digest_sessions (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  parent_id TEXT,
  directory TEXT NOT NULL,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  archived INTEGER NOT NULL CHECK(archived IN (0,1)),
  message_count INTEGER,
  call_count INTEGER,
  cost REAL,
  input INTEGER, output INTEGER, reasoning INTEGER,
  cache_read INTEGER, cache_write INTEGER,
  time_start INTEGER, time_end INTEGER, context_peak INTEGER,
  last_agent TEXT, last_provider TEXT, last_model TEXT,
  context_input INTEGER, context_output INTEGER, context_reasoning INTEGER,
  context_cache_read INTEGER, context_cache_write INTEGER,
  state TEXT NOT NULL CHECK(state IN ('digesting','ready','unavailable')),
  revision INTEGER NOT NULL DEFAULT 0,
  digested_at INTEGER,
  native_updated_at INTEGER,
  deleted_at INTEGER,
  deleted_how TEXT CHECK(deleted_how IN ('otk','provider')),
  CHECK((deleted_at IS NULL) = (deleted_how IS NULL))
);
CREATE INDEX digest_sessions_directory ON digest_sessions(directory,time_updated DESC,id);
CREATE INDEX digest_sessions_provider ON digest_sessions(provider,id);
CREATE TABLE digest_turns (
  session_id TEXT NOT NULL REFERENCES digest_sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  call_count INTEGER NOT NULL,
  cost REAL,
  input INTEGER, output INTEGER, reasoning INTEGER,
  cache_read INTEGER, cache_write INTEGER,
  time_start INTEGER, time_end INTEGER,
  context_peak INTEGER,
  revision INTEGER NOT NULL,
  PRIMARY KEY(session_id,turn_id)
);
CREATE TABLE digest_bookkeeping (
  session_id TEXT PRIMARY KEY REFERENCES digest_sessions(id) ON DELETE CASCADE,
  last_message_id TEXT,
  last_message_hash TEXT,
  digested_at INTEGER,
  native_updated_at INTEGER,
  generation INTEGER NOT NULL,
  dirty INTEGER NOT NULL CHECK(dirty IN (0,1))
);

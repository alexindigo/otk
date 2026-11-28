CREATE TABLE checkout_remotes (
  repository TEXT PRIMARY KEY,
  remote TEXT,
  owner TEXT,
  first_seen INTEGER NOT NULL,
  read_at INTEGER NOT NULL
);
CREATE TABLE checkout_remote_anchors (
  remote TEXT PRIMARY KEY,
  repository TEXT NOT NULL
);

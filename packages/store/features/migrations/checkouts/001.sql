CREATE TABLE checkout_history (
  source TEXT NOT NULL,
  repo TEXT NOT NULL,
  scope TEXT NOT NULL,
  canonical TEXT NOT NULL,
  checkout TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('checkout','worktree','unknown')),
  availability TEXT NOT NULL CHECK(availability IN ('present','removed','unknown')),
  proven INTEGER NOT NULL,
  PRIMARY KEY(source,repo,scope)
);

CREATE TABLE checkout_authority (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  sources TEXT NOT NULL
);
CREATE TABLE checkout_scope_owners (
  source TEXT NOT NULL,
  scope TEXT NOT NULL,
  repo TEXT NOT NULL,
  PRIMARY KEY(source, scope, repo)
);

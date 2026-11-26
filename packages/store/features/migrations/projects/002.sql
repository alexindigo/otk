CREATE TABLE project_order (
  user TEXT NOT NULL,
  id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  repo TEXT,
  root TEXT NOT NULL,
  PRIMARY KEY(user, id)
);
CREATE TABLE project_order_aliases (
  user TEXT NOT NULL,
  directory TEXT NOT NULL,
  id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(user, directory)
);
CREATE INDEX project_order_aliases_by_id ON project_order_aliases(user, id, ordinal, directory);
CREATE TABLE project_order_legacy (
  user TEXT NOT NULL,
  directory TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY(user, directory)
);
INSERT INTO project_order_legacy SELECT user, directory, position FROM projects;

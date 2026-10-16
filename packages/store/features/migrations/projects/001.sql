CREATE TABLE project_directories (directory TEXT PRIMARY KEY, position INTEGER NOT NULL, discovered INTEGER NOT NULL);
CREATE TABLE projects (
  user TEXT NOT NULL,
  directory TEXT NOT NULL,
  position INTEGER NOT NULL,
  added INTEGER NOT NULL DEFAULT 0,
  inactive INTEGER NOT NULL DEFAULT 0,
  last_visit INTEGER NOT NULL,
  inactive_at INTEGER,
  PRIMARY KEY(user, directory)
);

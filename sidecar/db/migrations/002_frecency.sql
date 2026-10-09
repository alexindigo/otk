CREATE TABLE frecency (
  directory TEXT NOT NULL,
  path TEXT NOT NULL,
  score REAL NOT NULL,
  last INTEGER NOT NULL,
  PRIMARY KEY(directory, path)
);

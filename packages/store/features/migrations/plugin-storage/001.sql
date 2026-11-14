CREATE TABLE plugin_storage (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (namespace, key)
) WITHOUT ROWID;

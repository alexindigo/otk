CREATE TABLE opcv1_delivery_scan (
  parent_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  revision INTEGER NOT NULL,
  cursor TEXT NOT NULL,
  complete INTEGER NOT NULL
) STRICT;
CREATE TABLE opcv1_delivery (
  parent_id TEXT NOT NULL,
  receipt TEXT NOT NULL,
  child_id TEXT NOT NULL,
  terminal INTEGER NOT NULL,
  PRIMARY KEY(parent_id,receipt)
) STRICT;
CREATE INDEX opcv1_delivery_child ON opcv1_delivery(parent_id,child_id,terminal);
CREATE INDEX opcv1_delivery_retire ON opcv1_delivery(child_id);

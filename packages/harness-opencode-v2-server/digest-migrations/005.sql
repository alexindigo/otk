CREATE TABLE opcv2_delivery_scan (
  parent_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  revision INTEGER NOT NULL,
  cursor TEXT NOT NULL,
  complete INTEGER NOT NULL
) STRICT;
CREATE TABLE opcv2_delivery (
  parent_id TEXT NOT NULL,
  receipt TEXT NOT NULL,
  child_id TEXT NOT NULL,
  terminal INTEGER NOT NULL,
  PRIMARY KEY(parent_id,receipt)
) STRICT;
CREATE INDEX opcv2_delivery_child ON opcv2_delivery(parent_id,child_id,terminal);
CREATE INDEX opcv2_delivery_retire ON opcv2_delivery(child_id);

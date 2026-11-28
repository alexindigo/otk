ALTER TABLE opcv2_delivery ADD COLUMN run_id TEXT;
CREATE INDEX opcv2_delivery_run ON opcv2_delivery(child_id,run_id,parent_id);
-- A pre-upgrade timestamp cannot identify a run. Rebuild from native receipts.
UPDATE opcv2_delivery_scan SET cursor='',complete=0;

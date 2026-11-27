ALTER TABLE opcv1_delivery ADD COLUMN run_id TEXT;
CREATE INDEX opcv1_delivery_run ON opcv1_delivery(child_id,run_id,parent_id);
-- A pre-upgrade timestamp cannot identify a run. Rebuild from native receipts.
UPDATE opcv1_delivery_scan SET cursor='',complete=0;

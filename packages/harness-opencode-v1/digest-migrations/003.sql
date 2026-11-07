ALTER TABLE opcv1_scan ADD COLUMN cursor_version INTEGER NOT NULL DEFAULT 2;
ALTER TABLE opcv1_scan ADD COLUMN source_mode TEXT;
ALTER TABLE opcv1_scan ADD COLUMN source_generation TEXT;
ALTER TABLE opcv1_scan ADD COLUMN after_created INTEGER;
ALTER TABLE opcv1_scan ADD COLUMN api_cursor TEXT;
ALTER TABLE opcv1_scan ADD COLUMN covered_created INTEGER;
ALTER TABLE opcv1_scan ADD COLUMN covered_message TEXT;
ALTER TABLE opcv1_scan ADD COLUMN requested_created INTEGER;
ALTER TABLE opcv1_scan ADD COLUMN requested_message TEXT;
UPDATE opcv1_scan SET after_message=NULL,scan_generation=scan_generation+1,
  complete_revision=NULL,dirty=1;
ALTER TABLE opcv1_helper_scan ADD COLUMN time_start INTEGER;
ALTER TABLE opcv1_helper_scan ADD COLUMN time_end INTEGER;
ALTER TABLE opcv1_helper_scan ADD COLUMN unfinished INTEGER NOT NULL DEFAULT 0;
ALTER TABLE opcv1_helper_scan ADD COLUMN source_mode TEXT;
ALTER TABLE opcv1_helper_scan ADD COLUMN source_generation TEXT;
ALTER TABLE opcv1_helper_scan ADD COLUMN api_cursor TEXT;
UPDATE opcv1_helper_scan SET after_part=NULL,scan_generation=scan_generation+1,dirty=1;

ALTER TABLE opcv1_messages ADD COLUMN timing_json TEXT;
UPDATE opcv1_scan SET committed=CASE WHEN complete_revision IS NOT NULL THEN 1 ELSE committed END,dirty=1,complete_revision=NULL,after_message=NULL,after_created=NULL,api_cursor=NULL,covered_created=NULL,covered_message=NULL;

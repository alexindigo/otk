-- Revalidate joins that predate recognition of versioned native enqueue events.
-- Keep receipt records; only source-proven native evidence can replace a join.
UPDATE opcv2_delivery_scan SET cursor='',complete=0;

-- Knowledge metadata is independent of refresh state and transport revisions.
ALTER TABLE digest_sessions ADD COLUMN result_meta TEXT;
ALTER TABLE digest_sessions ADD COLUMN last_result_meta TEXT;
ALTER TABLE digest_sessions ADD COLUMN last_call_id TEXT;
ALTER TABLE digest_turns ADD COLUMN result_meta TEXT;
ALTER TABLE digest_helpers ADD COLUMN result_meta TEXT;

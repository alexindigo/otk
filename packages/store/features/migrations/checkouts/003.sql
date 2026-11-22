-- Durable repository root of a checkout, recorded when it is discovered.
ALTER TABLE checkout_history ADD COLUMN repository TEXT;

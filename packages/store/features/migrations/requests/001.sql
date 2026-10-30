-- SPDX-License-Identifier: LGPL-3.0-only
CREATE TABLE request_windows (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at > created_at)
);
CREATE TABLE request_receipts (
  principal TEXT NOT NULL,
  client_id TEXT NOT NULL,
  intent_key TEXT NOT NULL,
  window_id TEXT NOT NULL,
  method TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  execution TEXT NOT NULL CHECK(execution IN ('read','local','native','lease')),
  state TEXT NOT NULL CHECK(state IN ('queued','running','waiting','reconciling','succeeded','failed','released')),
  seq INTEGER NOT NULL CHECK(seq > 0),
  accepted_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  retention_until INTEGER NOT NULL,
  dispatched_at INTEGER,
  owner_run TEXT,
  scope_session TEXT,
  scope_directory TEXT,
  scope_resource TEXT,
  progress_code TEXT,
  progress_completed INTEGER,
  progress_total INTEGER,
  receipt_kind TEXT,
  receipt_json TEXT,
  error_code TEXT,
  error_retry TEXT CHECK(error_retry IN ('same-intent','new-intent','none')),
  error_field TEXT,
  diagnostic_id TEXT,
  PRIMARY KEY(principal,client_id,intent_key)
);
CREATE INDEX request_receipts_retention ON request_receipts(state,retention_until);
CREATE INDEX request_receipts_running ON request_receipts(owner_run,state);

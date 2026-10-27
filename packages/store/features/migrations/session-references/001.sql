-- SPDX-License-Identifier: LGPL-3.0-only
CREATE TABLE session_reference_upgrades (
  name TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK(version > 0),
  completed_at INTEGER NOT NULL
);

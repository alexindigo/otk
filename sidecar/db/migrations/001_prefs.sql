-- SPDX-License-Identifier: LGPL-3.0-only
CREATE TABLE prefs (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated INTEGER NOT NULL
);

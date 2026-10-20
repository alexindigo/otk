-- SPDX-License-Identifier: LGPL-3.0-only
CREATE TABLE permission_auto (
  session TEXT PRIMARY KEY
);
CREATE TABLE permission_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request TEXT NOT NULL,
  reply TEXT NOT NULL CHECK(reply IN ('once','always','reject')),
  source TEXT NOT NULL CHECK(source IN ('manual','auto')),
  owner TEXT,
  message TEXT,
  time INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('started','confirmed','failed')),
  error TEXT
);
CREATE INDEX permission_activity_session ON permission_activity(session,id DESC);
CREATE INDEX permission_activity_request ON permission_activity(session,request_id,outcome);
CREATE TABLE permission_activity_family (
  session TEXT NOT NULL,
  activity INTEGER NOT NULL,
  PRIMARY KEY(session,activity)
);

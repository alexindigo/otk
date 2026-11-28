CREATE TABLE programs (
  user TEXT NOT NULL,
  id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  name TEXT,
  owner TEXT,
  dismissed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user, id)
);
CREATE UNIQUE INDEX programs_owner ON programs(user, owner) WHERE owner IS NOT NULL;
CREATE TABLE program_members (
  user TEXT NOT NULL,
  project TEXT NOT NULL,
  program TEXT,
  PRIMARY KEY(user, project)
);
CREATE INDEX program_members_program ON program_members(user, program);
CREATE TABLE program_settings (user TEXT PRIMARY KEY, auto INTEGER NOT NULL DEFAULT 0);

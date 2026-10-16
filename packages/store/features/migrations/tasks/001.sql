CREATE TABLE tasks (id TEXT PRIMARY KEY, directory TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL);
CREATE TABLE task_sessions (task TEXT NOT NULL, session TEXT NOT NULL UNIQUE, position INTEGER NOT NULL, PRIMARY KEY(task, session));

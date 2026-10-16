# @otk/store

Disk-backed SQLite storage for preferences, canonical frecency paths and inbox
metadata. Uses `node:sqlite` and `@std/path`; depends on no other OTK package.
Import only the public `@otk/store` entry. Applications supply their preference
schema, defaults, validator and error construction.

```ts
import {
  Frecency,
  frecencyMigrations,
  OtkDb,
  Prefs,
  prefsMigrations,
} from "@otk/store";

const defaults = { compact: false };
const db = new OtkDb("./state", [prefsMigrations, frecencyMigrations]);
try {
  const prefs = new Prefs(db, {
    defaults,
    validate: (key, value): key is "compact" =>
      key === "compact" && typeof value === "boolean",
    invalid: () => new Error("Invalid preference"),
  });
  const stop = prefs.listen((value) => console.log(value));
  prefs.set("compact", true);
  console.log(prefs.get());
  stop();
  const files = new Frecency(db, { invalid: () => new Error("Invalid path") });
  files.bump("/project", "README.md");
  console.log(files.list("/project"));
} finally {
  db.close();
}
```

`OtkDb(statePath, migrations)` creates a private state directory and opens
`otk.db` with WAL and a 5000 ms busy timeout. The caller composes feature
contributions as `FeatureMigrations` objects: a stable `feature` name plus its
own `migrations` list of `{ version, sql }`. Names are 1–120 ASCII identifier
characters (letters, digits, underscore, dot, colon, hyphen), starting with a
letter or digit. Versions are contiguous within each feature, starting at 1;
feature order is unrestricted. The runner never imports features. A
frecency-only consumer supplies `[frecencyMigrations]`, without prefs.

The `otk_migrations` table records each applied `(feature, version)`. Each
feature's pending upgrades and their records commit together in an immediate
transaction; SQL failure rolls back that feature and closes the connection.
Earlier committed features remain applied for retry. Already-applied SQL (text
or a packaged file URL) is not read or replayed. Invalid contribution lists and
unknown/noncontiguous applied versions of selected features are rejected before
any pending SQL. Unselected features and their records remain untouched, so a
smaller composition can reopen the database safely.

On first open without the tracking table, a frozen compatibility bridge maps
legacy `PRAGMA user_version` 1 to prefs v1, or 2 to prefs v1 + frecency v1,
without reading or replaying that SQL. Version 0 is a fresh database; all other
legacy versions fail clearly. The mapping and tracking-table creation commit
atomically, including records for legacy features not selected by this caller.
Afterward `user_version` is ignored and never advanced. The bridge is historical
compatibility, not a list to extend for new features: each new feature owns its
upgrades, selected only by application composition. Prefs and frecency both
start at v1, with SQL files in their own feature-named directories.

`Prefs<P>` merges validated persisted JSON into a fresh copy of supplied
defaults. It rejects invalid writes before persistence or notification, then
notifies listeners synchronously with the validated full snapshot. Stored
unknown/invalid values are ignored on reads; malformed JSON retains the original
parse-error behavior. `listen` returns an unsubscribe callback.

`Frecency` resolves project/path keys exactly as the app did, rejects empty,
NUL-containing or over-4096-character keys before writing, increments scores,
and retains at most 1000 entries globally. Lists are project-scoped and ordered
by last use. Decay/ranking are consumer concerns.

Inbox features independently export `Projects` / `projectsMigrations`, `Tasks` /
`tasksMigrations`, `Seen` / `seenMigrations`, `Finishes` / `finishesMigrations`
and `ProjectTemplates` / `projectTemplatesMigrations`. Each owns its schema
starting at version 1. They store metadata only, never transcripts. Projects and
seen marks take a user key; tasks, finishes and path templates are
server-scoped. Project discovery preserves first-appearance order, including
directories not explicitly added. Inactive marks freeze visit clocks; clearing a
mark excludes the paused interval. Task membership is ordered and exclusive per
session; replacement and creation with initial sessions are atomic. Closing a
task deletes only its grouping. Clocks can be injected for deterministic
consumers. Feature listeners run after committed writes. Composite preference
defaults are detached on every read.

Use Deno read/write permissions for the state directory and packaged SQL.
License: LGPL-3.0-only. Validate with `deno task test:unit` and
`deno task test:arch` from the workspace, or `deno task test` in this package.

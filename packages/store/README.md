# @otk/store

Disk-backed SQLite storage for preferences and canonical frecency paths. Uses
`node:sqlite` and `@std/path`; depends on no other OTK package. Import only the
public `@otk/store` entry. Applications supply their preference schema,
defaults, validator and error construction.

```ts
import {
  Frecency,
  frecencyMigrations,
  OtkDb,
  Prefs,
  prefsMigrations,
} from "@otk/store";

const defaults = { compact: false };
const db = new OtkDb("./state", [...prefsMigrations, ...frecencyMigrations]);
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
contributions in ascending contiguous `Migration.id` order, starting at 1. The
runner never imports features. Each pending migration (`sql` text or a file URL)
is applied in its own immediate transaction with its `PRAGMA user_version`
advance. Invalid composition and newer unsupported schemas are rejected; failed
SQL rolls back and the connection is closed. Already-applied SQL is not read or
replayed. Keep IDs stable: prefs is 1 (`001_prefs.sql`), frecency is 2
(`002_frecency.sql`). Databases from the original app open without a schema or
data rewrite. A frecency-only consumer still includes the preceding prefs
migration; IDs are database-global, not renumbered per feature.

`Prefs<P>` merges validated persisted JSON into a fresh copy of supplied
defaults. It rejects invalid writes before persistence or notification, then
notifies listeners synchronously with the validated full snapshot. Stored
unknown/invalid values are ignored on reads; malformed JSON retains the original
parse-error behavior. `listen` returns an unsubscribe callback.

`Frecency` resolves project/path keys exactly as the app did, rejects empty,
NUL-containing or over-4096-character keys before writing, increments scores,
and retains at most 1000 entries globally. Lists are project-scoped and ordered
by last use. Decay/ranking are consumer concerns. There is no output-times
persistence or any schema beyond prefs/frecency in this package.

Use Deno read/write permissions for the state directory and packaged SQL.
License: LGPL-3.0-only. Validate with `deno task test:unit` and
`deno task test:arch` from the workspace, or `deno task test` in this package.

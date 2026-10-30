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
`otk.db` with WAL and a 5000 ms busy timeout. An empty state path is rejected
before filesystem access; configuration must resolve its default sentinel before
constructing storage. Explicit relative directories remain supported. The caller
composes feature contributions as `FeatureMigrations` objects: a stable
`feature` name plus its own `migrations` list of `{ version, sql }`. Names are
1–120 ASCII identifier characters (letters, digits, underscore, dot, colon,
hyphen), starting with a letter or digit. Versions are contiguous within each
feature, starting at 1; feature order is unrestricted. The runner never imports
features. A frecency-only consumer supplies `[frecencyMigrations]`, without
prefs.

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
notifies listeners synchronously with a detached validated full snapshot for
each listener. Stored unknown/invalid values are ignored on reads; malformed
JSON retains the original parse-error behavior. `listen` returns an unsubscribe
callback.

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
task deletes only its grouping. `Tasks.addSession` appends only a missing member
and `Tasks.removeSession` deletes only that task/member pair, each in an
immediate transaction against current membership. Repeats preserve ordering;
another task's exclusive membership is never stolen or removed. `Tasks.sessions`
remains an intentional complete replacement, not an add/remove helper. Clocks
can be injected for deterministic consumers. Feature listeners run after
committed writes. All store features share one post-commit dispatcher: an
observer failure is reported without rejecting the committed mutation or
skipping other listeners. `OtkDb` accepts an optional third
`{ observerError(error) }` argument for injected diagnostics; the default logs
the original failure. If the reporter itself throws, a fallback diagnostic
retains both failures. Payloads are detached for each observer and from the
mutation's returned value. Composite preference defaults are detached on every
read.

`OtkDb.transaction(run)` returns a synchronous callback's result after commit or
rolls back and rethrows its failure. If rollback also fails, an AggregateError
retains the original as its cause and first error. Nested transactions reject at
BEGIN without retiring the caller's transaction. Migrations and metadata
features share this connection primitive; feature notifications run only after
commit.

### Composable writes and request receipts

`OtkDb.write(tx => result)` opens one synchronous immediate transaction. An
opaque `StoreWrite` is valid only for that callback and connection. Pass it as
the final argument to task, project, preference, seen, frecency, template and
permission mutations to join the transaction. `db.write(run, tx)` explicitly
joins a scope; omitting it starts a new transaction, so accidental nesting still
rejects. Foreign, fabricated and expired scopes reject. Promise-returning write
callbacks roll back. Finish asynchronous validation before entering a write
scope.

`db.afterCommit(tx, publish)` queues post-commit delivery. Feature notifications
capture detached payloads at the mutation boundary, remain invisible until the
outer commit, and disappear on rollback. Observer failures do not turn a
committed write into a failure. Standalone feature writes retain
immediate-after-commit notifications.

Compose `requestsMigrations` to add the independent `requests` feature to
`otk.db`, and construct `new Requests(db)`. `window(now, durationMs)` issues a
server-owned admission window. `admit(record, tx?)` returns the existing receipt
or inserts one queued receipt under `(principal, client_id, intent_key)`,
comparing window, method, execution and fingerprint on duplicates. The
fingerprint is a caller-supplied SHA-256 equality check, not request content.
Admission and `transition(key, expectedSeq, patch, tx?)` serialize through
SQLite; transitions increment the sequence by one using compare-and-swap and
preserve admission facts, terminal outcomes and committed dispatch fences.

Inside one `write`, apply the feature effect and transition its receipt to
success with the original result's explicit metadata encoding. A crash before
commit retains neither; a crash after commit retains both. Rehydrate that
original receipt on retry instead of applying the mutation again. A newer edit
or deletion does not change the retained original result or authorize recreating
its resource.

`inFlight(afterKey, limit)` keyset-pages active receipts. `sweep(now, limit)`
deletes at most `limit` expired terminal/released receipts and at most `limit`
expired unreferenced windows; its return value counts deleted receipts. Pending
and reconciling work never expires. Known receipts remain attachable after
window expiry, but an unknown/pruned intent requires a live issued window. The
caller sets retention to at least the window expiry plus its configured
retention period.

Receipts accept only the declared scalar columns. They contain no input/body,
credentials, messages, attachments or raw exceptions. `receipt_kind` plus
`receipt_json` are **feature-encoded metadata**, never a generic RPC-result
cache; storage validates scalar/JSON structure and the application owns the
allowlisted shape. Read/body results remain volatile. Storage imports no
protocol, core or provider implementation.

`Projects.policies()` and `Seen.all()` supply batched metadata projections.
Project listeners carry `{user, upsert, remove}` and task listeners carry
`{upsert, remove}`, containing detached committed records. Template listeners
carry `{templates}`. Multiple writes in one `StoreWrite` coalesce each key to
its final value before a single publication; rollback emits nothing and
unchanged member/order/template/policy edits emit no delta. Seen/finish
listeners carry the committed identity and clock, allowing observers to update
those projections without reading a baseline per session. `Finishes.record`
returns its `UPSERT ... RETURNING` clock. `Projects.reactivate` applies activity
reactivation without a preliminary SELECT while retaining post-commit
notification.

Task feature v2 adds `(directory,position,id)` indexing.
`Tasks.list(directory?)`, `get(id)` and `getMany(ids)` use two set queries,
including ordered memberships and empty tasks; an empty batch executes no SQL.
`owner`/`owners` are narrow membership reads. `removeSessions(ids, tx?)` removes
intentional grouping only, returning affected tasks in one batch; provider
deletion never uses it. `Projects.materialize(user, tx?)` creates discovered
user rows in one ordered statement at identity/discovery boundaries. Call it
when selecting a new user; `list`, `get` and `find` are now read-only.
`Seen.mark` and `Finishes.record` return their persisted monotone clock without
a follow-up SELECT and both join explicit write scopes.

`sessionReferenceMigrations` contributes only the neutral
`session_reference_upgrades` marker schema. Applications own any data
transformation through an injected codec and `OtkDb.transaction`; the store and
its SQL migration runner have no native identity knowledge.

Use Deno read/write permissions for the state directory and packaged SQL.

## Derived digest storage

`DigestDb(path, contributions, { busyms })` opens the independent private
`digest.db` file. Compose `digestMigrations` and any provider's structural
migration contribution explicitly. The same connection/migration/transaction
mechanics serve both files; the user-data `OtkDb` constructor remains
compatible. The timeout is installed before WAL selection. Derived connections
enable foreign keys and use feature-local migration versions, never a new legacy
`user_version` mapping.

`DigestStore` exposes scalar `catalog`, `summary`, `turn`, `turns`, `commit`,
`markDeleted`, `resurrect` and `transaction` operations. `DigestCommit`
atomically writes session/turn summaries and bookkeeping; a caller's outer
transaction may also cover provider-private baselines. Fields mirror the SQL
columns, with `null` for unreported values. Invalid negative/non-finite/unsafe
counters reject before commit. The API writes only its fixed column allowlists.
It has no protocol/native dependency and stores no transcript, part JSON or tool
payload. Applications adapt scalar records to their protocol at composition.
Start a turn scan with an empty cursor; pass `digestTurnCursor(lastRow)` for the
next page. The cursor includes both turn and session identity, so equal native
turn IDs across sessions/providers cannot be skipped or repeated.

Digest feature v2 adds `digest_helpers`. `helpers(ids)` returns allowlisted
scalar readiness, revision, count, label and clocks; optional
`DigestCommit.helpers` upsert/removal joins the same transaction as session,
turn and provider-private changes. Fresh installs and v1 upgrades use the same
feature runner. Migration or write failure rolls back instead of deleting either
database. No message bodies, tool arguments or output are stored.

`PermissionStore` / `permissionMigrations` independently contribute explicit
session enablement and the permission reply journal. The application supplies
request JSON; storage imports no protocol. Intents commit before remote I/O, and
later outcome updates distinguish confirmation, failure and an interrupted
unconfirmed attempt. Family queries accept session IDs and return at most101
rows, allowing the application to expose100-row cursor pages. Journal intents
and their indexed family membership commit together, so old helper activity
remains visible after its live index entry expires. Confirmed request identity
is indexed for duplicate-send suppression; no transcript is stored. Listeners
distinguish actual policy changes from journal changes. Journal notifications
carry their persisted family IDs, including for outcome updates; unrelated
families need no refresh. Repeating an unchanged policy emits nothing.

License: LGPL-3.0-only. Validate with `deno task test:unit` and
`deno task test:arch` from the workspace, or `deno task test` in this package.

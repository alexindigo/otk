# Prepared native fixtures and independent consumers

Run preparation in the assigned OTK guest, with a disk-backed workspace
`TMPDIR`:

```sh
deno task test:prepare --version 1.18.34 --scale
deno task test tests/integration/scale/snapshot-fixtures_test.ts
```

Ordinary preparation builds the shipped application and all nine existing Vite
consumer compositions. Tests use `consumerAssets(name)` to validate and serve
prepared assets; they do not install or build inside a case. Consumer caches
hash their public-entry sources, configuration, content and lockfile, and
exact-tree build directories refer to those immutable assets. A missing or
changed asset fails with the preparation command.

`--scale` additionally calls the single `SessionScale` generator for `sessions`,
`messages`, `messages-payload` and `remaining-files`. Keys contain the exact
native version, executable SHA256, contributing fixture/dependency/recipe SHA256
and variant. A product UI edit changes the application build identity without
changing the native fixture revision. Preparation writes `snapshots.json` beside
the exact-tree build receipt, including each snapshot manifest hash.

Snapshots live in `.test-state/snapshots/<key>/`, outside per-test cleanup
roots. An inode-stable sibling lock joins concurrent preparers. Generation takes
the stock schema, seeds transactionally, checks native HTTP compatibility, stops
and joins the native process, checkpoints every SQLite file with
`wal_checkpoint(TRUNCATE)`, closes its handles and checks integrity. The stopped
database uses DELETE journaling so read-only validation cannot create WAL/SHM
beside a published template. A validated staging sibling is atomically renamed
into place. Invalid existing keys and failed staging evidence are preserved;
preparation never evicts them or regenerates through a failed validation.

The manifest records native/schema/migration identities, fixture options, all
filesystem/Git/config file hashes, qualified provider dependency hashes, exact
population and per-session/per-turn expectations (including unknown and zero),
original root and relocation revision. Templates contain native state only: they
never contain OTK's derived digest or warm user state.

`SessionScale.restore` creates a stopped private writable copy; `materialize`
additionally starts native and checks its catalog/newest page. `create` retains
existing fixture callers' API and joins generation once before materialization.
Relocation transactionally maps only characterized project, session, assistant
and edit-tool path fields. Generated relative patch headers and nonpath source
remain unchanged. Unknown schema, JSON or path shapes refuse the copy. The
destination must be new and inside the supplied owned disk-backed fixture root.
Provider configuration is regenerated for the copy's actual local provider URL.
Every copy independently checks SQL populations, usage totals and generated
part/file source before native admission.

The controller's `materializeSnapshot` command requires an unused isolated lease
and a checked key. It explicitly closes the previous stack, admits the private
snapshot through the existing native/provider/sidecar owners, and returns the
replacement stack information and lease. Its populated isolated lease is
disposed rather than reset for another test.

The explicit scale acceptance covers committed WAL sentinels, rejection of
main-file-only copies, concurrent relocated/mutated clones, unchanged source
hashes, invalid-key preservation, lock identity, regenerated provider config,
real native pages and fresh OTK wire totals. No live-database backup API is
provided: stop/join writers before checkpointing or copying. Generation,
validation and copy durations are observations, never numerical pass gates.

# Packaging OTK

Every install channel ships the compiled `otk` executable and
[`systemd/otk.service`](./systemd/otk.service). Deno is a build dependency, not
a runtime dependency. Opencode is a separately running backend.

## Storage availability and supervision

Run durable installations under the shipped `otk.service`, which includes
`Restart=on-failure`. Equivalent supervisors must restart after fatal signals as
well as nonzero exits. A thread worker is not process isolation: a native SQLite
WAL shared-memory fault can terminate OTK, including during cleanup. Setting
database-page `mmap_size=0` does not disable the WAL-index mapping. Do not
remove the restart policy or change the native database's journal mode as a
workaround.

Catchable full-disk and I/O failures keep HTTP and reloadable reads available.
OTK reports one storage failure without a database write and never reports an
uncommitted mutation as successful. Free space or restore disk access; a bounded
committed probe establishes recovery, then derived state is refreshed. The
recovery notice explicitly identifies interrupted observation rather than
claiming complete coverage. Startup logs record SQLite version and effective
database-page mmap size. A supervisor restart alone does not prove storage has
recovered; inspect the storage notice and service journal.

Development qualification runs inside virtual machine
`arch-niri-otk-devbase-otk-m5a` on `ark.home`, profile `otk-m5a`, as `tester` in
a frozen source below `/home/tester/otk`, with `TMPDIR=/home/tester/otk/tmp`.
Use the strict `otk-vm` access route; if the guest is unavailable, stop rather
than run on either physical host.

From the guest source root, with Deno 2.9.6, Bash and GNU coreutils installed:

```sh
deno task compile x86_64-unknown-linux-gnu /absolute/output/otk
```

The output's parent must exist. Use `aarch64-unknown-linux-gnu` for Linux ARM64.
The task installs frozen dependencies, builds the browser app and compiles all
runtime assets, including reflective routes and SQL migrations. Its inclusion
list lives only in `scripts/compile.sh`; AUR source packages invoke this task
and install its output as `/usr/bin/otk`, with the tracked service at
`/usr/lib/systemd/user/otk.service`. No launcher or runtime cache is needed.

To build both release archives, also install GNU tar and zstd, then run:

```sh
bash scripts/release.sh 0.1.0-beta.2 /absolute/output/release
```

This is the same script used by `.github/workflows/release.yml`. It emits
`otk-<version>-<arch>-linux.tar.zst` for x86_64 and aarch64, plus a `SHA256SUMS`
for the archives. Each archive contains the executable, service, license,
README, `THIRD-PARTY-NOTICES.md`, example operator config and a payload
`SHA256SUMS`. Build staging directories are retained beside the archives for
inspection.

Packages, including the separate `otk`, `otk-bin` and `otk-git` AUR recipes,
must install `THIRD-PARTY-NOTICES.md` beside `LICENSE`, for example under
`/usr/share/licenses/otk/`. Those recipe repositories are updated separately at
release time.

Release automation checks out the published tag and uploads both archives and
the archive checksums. Its manual dispatch accepts an existing release tag for a
rebuild; uploads replace assets of the same name. The workflow does not create
tags or releases.

The application release constant is `0.1.0-beta.2`; reusable library package
versions remain independent. Release preparation creates only a signed local
commit and a qualified executable. Publishing the tag, GitHub assets or AUR
updates is a separate, explicitly authorized step.

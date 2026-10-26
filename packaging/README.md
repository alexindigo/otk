# Packaging OTK

Every install channel ships the compiled `otk` executable and
[`systemd/otk.service`](./systemd/otk.service). Deno is a build dependency, not
a runtime dependency. Opencode is a separately running backend.

From the repository root, with Deno 2.9.6, Bash and GNU coreutils installed:

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
bash scripts/release.sh 0.1.0-beta.1 /absolute/output/release
```

This is the same script used by `.github/workflows/release.yml`. It emits
`otk-<version>-<arch>-linux.tar.zst` for x86_64 and aarch64, plus a `SHA256SUMS`
for the archives. Each archive contains the executable, service, license,
README, example operator config and a payload `SHA256SUMS`. Build staging
directories are retained beside the archives for inspection.

Release automation checks out the published tag and uploads both archives and
the archive checksums. Its manual dispatch accepts an existing release tag for a
rebuild; uploads replace assets of the same name. The workflow does not create
tags or releases.

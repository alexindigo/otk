#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-3.0-only
set -euo pipefail

if [[ $# != 2 || ! $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$ ]]; then
  printf 'Usage: bash scripts/release.sh <version-without-v> <output-directory>\n' >&2
  exit 2
fi
version=$1
output=$(realpath -m -- "$2")
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
mkdir -p -- "$output"

for arch in x86_64 aarch64; do
  stage=$(mktemp -d "$output/.otk-$arch.XXXXXXXX")
  deno task compile "$arch-unknown-linux-gnu" "$stage/otk"
  install -m644 packaging/systemd/otk.service LICENSE README.md "$stage/"
  install -m644 defaults/otk.toml "$stage/otk.toml.example"
  (
    cd -- "$stage"
    sha256sum otk otk.service LICENSE README.md otk.toml.example > SHA256SUMS
    ZSTD_CLEVEL=19 ZSTD_NBTHREADS=2 tar --zstd -cf \
      "$output/otk-$version-$arch-linux.tar.zst" \
      otk otk.service LICENSE README.md otk.toml.example SHA256SUMS
  )
done
(
  cd -- "$output"
  sha256sum "otk-$version-x86_64-linux.tar.zst" \
    "otk-$version-aarch64-linux.tar.zst" > SHA256SUMS
)

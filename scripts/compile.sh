#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-3.0-only
set -euo pipefail

if [[ $# != 2 ]]; then
  printf 'Usage: deno task compile <target> <output>\n' >&2
  exit 2
fi
target=$1
output=$(realpath -m -- "$2")
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

deno install --frozen
deno task build:web
# Reflective routes and file-backed assets must be embedded as whole trees.
# Keep this list here: source packages and release assets use this same recipe.
deno compile --frozen --node-modules-dir=none --exclude-unused-npm \
  --allow-net --allow-read --allow-write --allow-env \
  --include core/http/routes \
  --include web/dist \
  --include defaults/otk.toml \
  --include packages/store/features/migrations \
  --include core/static \
  --target "$target" --output "$output" main.ts

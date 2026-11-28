#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-3.0-only
set -euo pipefail
export PATH="$PATH:/usr/sbin"
# Run only inside the assigned disposable Linux test guest, from the source root.
root="$PWD/.test-state/storage-full-$(date +%s)-$$"
mkdir -p "$root/mount"
disk="$root/disposable.ext4"
cleanup() {
  if mountpoint -q "$root/mount"; then sudo -n umount "$root/mount"; fi
  rm -f "$disk"
  rmdir "$root/mount" "$root"
}
trap cleanup EXIT
truncate -s 64M "$disk"
mkfs.ext4 -q -m 0 "$disk"
sudo -n mount -o loop,nosuid,nodev,noexec "$disk" "$root/mount"
sudo -n chown "$(id -u):$(id -g)" "$root/mount"
OTK_STORAGE_TEST_ROOT="$root/mount" deno test -A tests/integration/storage-full_test.ts

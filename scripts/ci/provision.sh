#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-3.0-only
# Shared by hosted runners and the stock-Ubuntu rehearsal. No credentials.
set -euo pipefail
umask 022
version=${1:?usage: provision.sh 1.19.3|2.2.6}
case "$version" in
  1.19.3) native_sha=179ca421d61eefeadfa0c50e084a6e79c1623734732f0f4593f81ccfd3ab7ee9 ;;
  2.2.6) native_sha=50503d24577fa4117a7c95ee85b2cd679606a87eacf20ca54ed5db5c9e1cf895 ;;
  *) echo "Unsupported opencode version: $version" >&2; exit 1 ;;
esac
export TMPDIR=${TMPDIR:-$PWD/.test-state/tmp}
export PLAYWRIGHT_BROWSERS_PATH=/opt/otk-test/ms-playwright
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
export PATH=/opt/otk-test/node/bin:$HOME/.deno/bin:$PATH
export OTK_TEST_VERSION=$version
export OTK_TEST_OPENCODE=/opt/otk-test/opencode/$version/opencode
export OTK_TEST_PROVIDER_CACHE=/opt/otk-test/provider-cache/opencode-$version
p=$PWD/.test-state/provisioning
mkdir -p "$TMPDIR" "$p/downloads/$version" "$HOME/.deno/bin"
sudo -n env TMPDIR="$TMPDIR" DEBIAN_FRONTEND=noninteractive apt-get update
sudo -n env TMPDIR="$TMPDIR" DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates curl unzip xz-utils git rsync python3 ripgrep build-essential \
  dbus-user-session fonts-liberation fonts-noto-color-emoji ffmpeg time btop
sudo -n loginctl enable-linger "$(id -un)"
sudo -n systemctl start "user@$(id -u).service"
for ((i=0; i<60; i++)); do
  [[ -d "$XDG_RUNTIME_DIR" ]] && break
  sleep 1
done
env -u DBUS_SESSION_BUS_ADDRESS systemctl --user daemon-reload
env -u DBUS_SESSION_BUS_ADDRESS systemctl --user start dbus.socket
test -S "$XDG_RUNTIME_DIR/bus"
systemctl --user is-active dbus.socket
sudo -n install -d -m 755 /opt/otk-test/{node,provider-cache,ms-playwright} "/opt/otk-test/opencode/$version"
sudo -n chown "$(id -un):$(id -gn)" /opt/otk-test/{node,provider-cache,ms-playwright} "/opt/otk-test/opencode/$version"
verify() { echo "$2  $1" | sha256sum --check --status; }
download() { curl -fL --retry 2 --max-time 300 -o "$1" "$2"; }
if [[ ! -x /opt/otk-test/node/bin/node ]] || [[ $(/opt/otk-test/node/bin/node --version) != v24.22.2 ]]; then
  download "$p/downloads/node.tar.xz" https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.xz
  verify "$p/downloads/node.tar.xz" 48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75
  tar -xJf "$p/downloads/node.tar.xz" -C /opt/otk-test/node --strip-components=1
fi
if ! command -v deno >/dev/null || ! verify "$(command -v deno)" bceb5b6a6239b0b010418406d8c77a508f67cf4337d94288f1c19fe71304aab0; then
  download "$p/downloads/deno.zip" https://github.com/denoland/deno/releases/download/v2.9.6/deno-x86_64-unknown-linux-gnu.zip
  unzip -o "$p/downloads/deno.zip" -d "$HOME/.deno/bin"
  verify "$HOME/.deno/bin/deno" bceb5b6a6239b0b010418406d8c77a508f67cf4337d94288f1c19fe71304aab0
fi
if ! [[ -x "$OTK_TEST_OPENCODE" ]] || ! verify "$OTK_TEST_OPENCODE" "$native_sha"; then
  download "$p/downloads/$version/native.tar.gz" "https://github.com/anomalyco/opencode/releases/download/v$version/opencode-linux-x64.tar.gz"
  if [[ $version == 2.2.6 ]]; then
    verify "$p/downloads/$version/native.tar.gz" 08bb21d6326ce740d91cce7ebe88a6536933f6e1e30353b91a06b01f25da306c
  fi
  tar -xzf "$p/downloads/$version/native.tar.gz" -C "$p/downloads/$version"
  verify "$p/downloads/$version/opencode" "$native_sha"
  install -m 755 "$p/downloads/$version/opencode" "$OTK_TEST_OPENCODE"
fi
verify "$OTK_TEST_OPENCODE" "$native_sha"
npm --prefix tests/browser ci
sudo -n env PATH="$PATH" TMPDIR="$TMPDIR" PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" \
  node tests/browser/node_modules/playwright/cli.js install-deps chromium
node tests/browser/node_modules/playwright/cli.js install chromium
deno task prepare:test
# Trees that embed the pinned PTY asset need it before unit tests.
if [[ -f scripts/fetch-opencode-pty.ts ]]; then
  deno task pty:fetch x86_64-unknown-linux-gnu
fi
python3 - <<'PY'
import hashlib, json, os, pathlib, shutil, subprocess, urllib.request, zipfile
def digest(p): return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def out(*a): return subprocess.check_output(a, text=True).strip()
version = os.environ['OTK_TEST_VERSION']
sha = 'f5d889b7792cf9ad0993496e2ee5322516e7e1deba36c1a5a79a002bf00759bb'
name = 'denort-x86_64-unknown-linux-gnu.zip'
url = 'https://github.com/denoland/deno/releases/download/v2.9.6/' + name
cache = pathlib.Path(json.loads(out('deno', 'info', '--json'))['denoDir']) / 'dl/release/v2.9.6' / name
cache.parent.mkdir(parents=True, exist_ok=True)
if not cache.exists() or digest(cache) != sha:
    with urllib.request.urlopen(url, timeout=180) as response: data = response.read()
    assert hashlib.sha256(data).hexdigest() == sha
    pending = cache.with_name(cache.name + '.pending')
    pending.write_bytes(data)
    with zipfile.ZipFile(pending) as archive: assert archive.testzip() is None and archive.namelist() == ['denort']
    pending.replace(cache)
with zipfile.ZipFile(cache) as archive: assert archive.testzip() is None and archive.namelist() == ['denort']
receipt = {'node': out('node', '--version'), 'npm': out('npm', '--version'),
           'deno': out('deno', '--version'), 'playwright': out('node', 'tests/browser/node_modules/playwright/cli.js', '--version'),
           'native': {version: {'sha256': digest(os.environ['OTK_TEST_OPENCODE']), 'version': out(os.environ['OTK_TEST_OPENCODE'], '--version')}},
           'denort': {'url': url, 'sha256': sha}, 'tmpdir': os.environ['TMPDIR'],
           'node_archive_sha256': '48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75',
           'node_binary_sha256': digest(shutil.which('node')), 'deno_binary_sha256': digest(shutil.which('deno'))}
assert receipt['node'] == 'v24.22.2' and receipt['npm'] == '11.19.1'
assert receipt['deno'].startswith('deno 2.9.6 ') and receipt['playwright'] == 'Version 1.64.1'
pathlib.Path('.test-state/provisioning/toolchain.json').write_text(json.dumps(receipt, indent=2))
pathlib.Path('.test-state/provisioning/toolchain-' + version + '.json').write_text(json.dumps(receipt, indent=2))
print(json.dumps(receipt))
PY
if [[ -n ${GITHUB_ENV:-} ]]; then
  for key in XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS PLAYWRIGHT_BROWSERS_PATH OTK_TEST_VERSION OTK_TEST_OPENCODE OTK_TEST_PROVIDER_CACHE; do
    echo "$key=${!key}" >> "$GITHUB_ENV"
  done
fi
if [[ -n ${GITHUB_PATH:-} ]]; then
  printf '%s\n' /opt/otk-test/node/bin "$HOME/.deno/bin" >> "$GITHUB_PATH"
fi

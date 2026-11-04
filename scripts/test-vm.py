#!/usr/bin/env python3
"""Ark-only transport. No product imports, builds, tests or browsers on the host."""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import shlex
import socket
import subprocess
import sys
import tarfile
import uuid
import xml.etree.ElementTree as ET

VERSIONS = {"otk-tests-a": "1.18.34", "otk-tests-b": "1.18.35", "otk-tests-c": "1.19.3"}
WORK = "/home/tester/otk"
SOURCE = Path(__file__).resolve().parent.parent
EXCLUDED = {".git", ".envrc", "node_modules", ".test-state", "tmp", "test-results", "playwright-report"}


def capture(args):
    return subprocess.check_output(args, text=True, timeout=60).strip()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def ssh_args(guest, ip):
    options = {"IdentitiesOnly": "yes", "IdentityAgent": "none", "BatchMode": "yes",
               "StrictHostKeyChecking": "yes", "HostKeyAlias": guest,
               "HostKeyAlgorithms": "ssh-ed25519", "UserKnownHostsFile": "/home/user/.ssh/known_hosts",
               "GlobalKnownHostsFile": "/dev/null", "UpdateHostKeys": "no", "ControlMaster": "no",
               "ControlPath": "none", "ProxyCommand": "none", "ProxyJump": "none"}
    return ["ssh", "-F", "/dev/null", "-i", "/home/user/.ssh/id_vm-agent",
            *[a for k, v in options.items() for a in ("-o", f"{k}={v}")], f"tester@{ip}"]


def identify(guest):
    require(socket.gethostname() == "ark" and os.getuid() == 1000, "Run transport as user on Ark")
    require(guest in VERSIONS, "Unknown OTK guest")
    path = Path(f"/home/user/vms/forks/{guest}/fork.json")
    r = json.loads(path.read_text())
    i = r["identity"]
    require(r["schema"] == 1 and r["status"]["phase"] == "ready", "Guest receipt is not ready")
    require(r["creation_identity_sha256"] == hashlib.sha256(json.dumps(i, sort_keys=True).encode()).hexdigest(), "Creation identity changed")
    require(i["name"] == guest and i["owner"] == os.getuid() and i["directory"] == str(path.parent), "Foreign guest receipt")
    require(i["base"] == "/home/user/vms/otk/bases/arch-niri-otk-tests-base", "Foreign project base")
    xml = ET.fromstring(capture(["virsh", "-c", "qemu:///session", "dumpxml", guest]))
    require(xml.findtext("uuid") == i["uuid"], "Domain UUID changed")
    require([m.get("address") for m in xml.findall("./devices/interface/mac")] == [i["mac"]], "Domain MAC changed")
    disks = {d.get("file") for d in xml.findall("./devices/disk/source") if d.get("file")}
    require(disks == {p for p in i["storage"] if p.endswith(".qcow2")}, "Domain disks changed")
    require(xml.findtext("./devices/../os/nvram") == str(path.parent / "VARS.fd"), "Domain NVRAM changed")
    for p, identity in i["storage"].items():
        st = Path(p).stat()
        require(st.st_ino == identity["ino"] and st.st_uid == identity["uid"] and st.st_nlink == 1, "Storage identity changed")
    net = json.loads(capture(["virsh", "-c", "qemu:///session", "qemu-agent-command", guest,
                              '{"execute":"guest-network-get-interfaces"}']))["return"]
    ips = [a["ip-address"] for n in net if n.get("hardware-address", "").lower() == i["mac"]
           for a in n.get("ip-addresses", []) if a["ip-address-type"] == "ipv4"]
    ip = str(ipaddress.IPv4Address(r["status"]["ip"]))
    require(ips == [ip], "QGA IP differs from receipt; stop for receipt refresh")
    pin = capture(["ssh-keygen", "-F", guest, "-f", "/home/user/.ssh/known_hosts"])
    require(any(line.split()[1:] == r["status"]["public_key"].split() for line in pin.splitlines() if not line.startswith("#")), "SSH pin differs from receipt")
    ssh = ssh_args(guest, ip)
    proof = capture([*ssh, f"id -un; sudo -n /usr/bin/cat /sys/class/dmi/id/product_uuid; findmnt -rn -o FSTYPE -T {WORK}"])
    require(proof.splitlines()[:2] == ["tester", i["uuid"]], "Guest account/DMI mismatch")
    require(proof.splitlines()[2] not in ("tmpfs", "ramfs", "overlay"), "Workspace is not disk-backed")
    return ssh, r


def manifest():
    files = {}
    for directory, dirs, names in os.walk(SOURCE):
        dirs[:] = [d for d in dirs if d not in EXCLUDED and str(Path(directory, d).relative_to(SOURCE)) not in ("web/dist", "config")]
        for name in names:
            if name in EXCLUDED or name == "token" or name.endswith((".bak", ".local.toml")):
                continue
            path = Path(directory, name)
            require(not path.is_symlink(), f"Source symlink needs explicit delivery support: {path}")
            files[str(path.relative_to(SOURCE))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return dict(sorted(files.items()))


def deliver(ssh, output):
    files = manifest()
    tree = hashlib.sha256("".join(f"{h}  {p}\n" for p, h in files.items()).encode()).hexdigest()
    (output / "source.json").write_text(json.dumps({"tree": tree, "files": files}, indent=2))
    archive = output / "source.tar"
    with tarfile.open(archive, "w") as tar:
        for path in files:
            tar.add(SOURCE / path, arcname=path, recursive=False)
    subprocess.run([*ssh, f"mkdir -p {WORK}/tmp {WORK}/.test-state/transport"], check=True)
    with archive.open("rb") as stream:
        subprocess.run([*ssh, f"tar -xf - -C {WORK}"], stdin=stream, check=True)
    # Only prior source-owned removals are reconciled. Destination extras survive.
    code = '''import hashlib,json,pathlib,sys
w=pathlib.Path('/home/tester/otk'); m=json.load(sys.stdin); p=w/'.test-state/transport/source.json'
old=json.loads(p.read_text()) if p.exists() else {'files':{}}
for name,h in old['files'].items():
 f=w/name
 if name not in m['files'] and f.exists():
  if hashlib.sha256(f.read_bytes()).hexdigest()!=h: raise RuntimeError('Changed removed source: '+name)
  f.unlink()
for name,h in m['files'].items():
 if hashlib.sha256((w/name).read_bytes()).hexdigest()!=h: raise RuntimeError('Delivery mismatch: '+name)
p.write_text(json.dumps(m)); print(m['tree'])
'''
    verified = subprocess.check_output([*ssh, "python3 -c " + shlex.quote(code)], input=(output / "source.json").read_bytes()).decode().strip()
    require(verified == tree, "Guest source receipt mismatch")
    archive.unlink()
    return tree


def environment(guest):
    version = VERSIONS[guest]
    return {"PATH": "/opt/otk-test/node/bin:/home/tester/.deno/bin:/usr/local/bin:/usr/bin",
            "TMPDIR": WORK + "/tmp", "PLAYWRIGHT_BROWSERS_PATH": "/opt/otk-test/ms-playwright",
            "OTK_TEST_OPENCODE": f"/opt/otk-test/opencode/{version}/opencode", "OTK_TEST_VERSION": version,
            "OTK_TEST_PROVIDER_CACHE": f"/opt/otk-test/provider-cache/opencode-{version}",
            "OTK_TEST_ARTIFACTS": WORK + "/.test-state/artifacts", "OTK_TEST_GUEST": guest, "DENO_JOBS": "3"}


def run(guest, command, output, changed=None, base=None, matrix_full=False):
    output.mkdir(parents=True, exist_ok=False)
    ssh, receipt = identify(guest)
    tree = deliver(ssh, output)
    if changed is not None:
        subprocess.run([*ssh, f"dd of={WORK}/.test-state/transport/changed.paths status=none"], input=changed, check=True)
    env = environment(guest)
    env.update(OTK_TEST_BASE=base or "missing", OTK_TEST_DELIVERY_TREE=tree)
    env["OTK_TEST_MATRIX_FULL"] = "1" if matrix_full else "0"
    shell = f"cd {WORK} && exec env " + shlex.join([f"{k}={v}" for k, v in env.items()] + command)
    # Revalidate immediately before forwarding a workload, including after delivery.
    identify(guest)
    query = "import json,pathlib; p=pathlib.Path(" + repr(WORK + "/.test-state/runs") + "); print(json.dumps(sorted(x.name for x in p.iterdir()) if p.exists() else []))"
    before = set(json.loads(capture([*ssh, "python3 -c " + shlex.quote(query)])))
    (output / "pre-run.json").write_text(json.dumps(sorted(before)))
    with (output / "guest.log").open("wb") as log:
        result = subprocess.run([*ssh, shell], stdout=log, stderr=subprocess.STDOUT)
    after = set(json.loads(capture([*ssh, "python3 -c " + shlex.quote(query)])))
    names = sorted(after - before)
    require(all(name and Path(name).name == name and name not in (".", "..") for name in names), "Invalid run root")
    roots = [".test-state/runs/" + name for name in names]
    archive_command = shlex.join(["tar", "-cf", "-", "-C", WORK, *roots, ".test-state/transport"])
    with (output / "reports.tar").open("wb") as stream:
        copied = subprocess.run([*ssh, archive_command], stdout=stream)
    metadata = {"schema": 1, "guest": guest, "uuid": receipt["identity"]["uuid"], "tree": tree,
                "base": base, "command": command, "exit": result.returncode, "reportsExit": copied.returncode,
                "reportRoots": roots, "complete": copied.returncode == 0}
    (output / "receipt.json").write_text(json.dumps(metadata, indent=2))
    print(json.dumps(metadata), flush=True)
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("guest", choices=VERSIONS)
    parser.add_argument("action", choices=["run", "deliver", "identity"])
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.action == "identity":
        _, r = identify(args.guest)
        print(json.dumps({"guest": args.guest, "uuid": r["identity"]["uuid"], "ip": r["status"]["ip"]}))
        return
    output = Path("/home/user/TemporaryFiles/otk/plans/test-suite-rearchitecture/evidence/c16") / str(uuid.uuid4()) / args.guest
    if args.action == "deliver":
        output.mkdir(parents=True)
        ssh, _ = identify(args.guest)
        print(deliver(ssh, output))
        return
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    require(command and command[0] in ("deno", "npm"), "Forward a named Deno/npm guest command")
    r = run(args.guest, command, output)
    sys.exit(r["exit"] or r["reportsExit"])


if __name__ == "__main__":
    main()

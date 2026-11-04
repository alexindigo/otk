#!/usr/bin/env python3
"""Receipt-bound Ark transport and metadata aggregation; all lane logic is guest-side."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import io
import shlex
import tarfile
import time
import uuid

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("otk_transport", Path(__file__).with_name("test-vm.py"))
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)


def merge_reports(root, receipts):
    """Inspect/copy report metadata on Ark; Playwright renders only inside A."""
    counts = {key: 0 for key in ("first-pass", "flaky", "failed", "quarantined", "not-run")}
    blobs = root / "blobs.tar"
    blob_count = 0
    child_count = 0
    with tarfile.open(blobs, "w") as bundle:
        for receipt in receipts:
            allowed = receipt["reportRoots"]
            with tarfile.open(root / receipt["guest"] / "reports.tar") as archive:
                records = {}
                for path in allowed:
                    if not Path(path).name.startswith("otk-"):
                        continue
                    record = json.load(archive.extractfile(path + "/run.json"))
                    vm.require(record["schema"] == 1 and record["tree"] == receipt["tree"] and record["run"] == Path(path).name and "parentRun" in record, "Browser receipt identity/lineage mismatch")
                    records[record["run"]] = record
                for record in records.values():
                    visited = {record["run"]}
                    parent = record["parentRun"]
                    while parent is not None:
                        vm.require(parent in records and parent not in visited, "Orphan/cyclic browser run lineage")
                        visited.add(parent)
                        parent = records[parent]["parentRun"]
                qualification = {name for name, record in records.items() if record["parentRun"] is None}
                child_count += len(records) - len(qualification)
                for member in archive:
                    vm.require(member.name == ".test-state/transport" or member.name.startswith(".test-state/transport/") or any(member.name == path or member.name.startswith(path + "/") for path in allowed), "Report outside invocation receipt")
                    if not member.isfile():
                        continue
                    parts = Path(member.name).parts
                    ordinary = len(parts) >= 3 and parts[2] in qualification
                    if ordinary and len(parts) == 4 and parts[-1] == "outcomes.json":
                        report = json.load(archive.extractfile(member))
                        for key in counts:
                            counts[key] += report["counts"][key]
                    if ordinary and len(parts) == 5 and parts[3] == "blob" and member.name.endswith(".zip"):
                        content = archive.extractfile(member).read()
                        info = tarfile.TarInfo(f"blobs/{receipt['guest']}-{blob_count}.zip")
                        info.size = len(content)
                        bundle.addfile(info, io.BytesIO(content))
                        blob_count += 1
    if not blob_count:
        return {"counts": counts, "blobs": 0, "exit": 1}
    ssh, _ = vm.identify("otk-tests-a")
    destination = vm.WORK + "/.test-state/matrix/" + root.name
    subprocess.run([*ssh, "mkdir -p " + shlex.quote(destination)], check=True)
    with blobs.open("rb") as stream:
        subprocess.run([*ssh, f"tar -xf - -C {shlex.quote(destination)}"], stdin=stream, check=True)
    shell = f"cd {vm.WORK} && " + shlex.join(["env", *[f"{k}={v}" for k, v in vm.environment("otk-tests-a").items()],
        "PLAYWRIGHT_HTML_OUTPUT_DIR=" + destination + "/html", "PLAYWRIGHT_HTML_OPEN=never", "npm", "--prefix", "tests/browser", "exec", "--", "playwright", "merge-reports", "--reporter=html", destination + "/blobs"])
    with (root / "merge.log").open("wb") as log:
        result = subprocess.run([*ssh, shell], stdout=log, stderr=subprocess.STDOUT)
    if result.returncode == 0:
        with (root / "merged-html.tar").open("wb") as stream:
            subprocess.run([*ssh, f"tar -cf - -C {shlex.quote(destination)} html"], stdout=stream, check=True)
    return {"counts": counts, "blobs": blob_count, "retainedChildRuns": child_count, "guest": "otk-tests-a", "exit": result.returncode}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--lane", choices=["commit", "full"], required=True)
    p.add_argument("--base")
    p.add_argument("--guests")
    p.add_argument("--areas")
    p.add_argument("--shard")
    p.add_argument("--dry-run", action="store_true", help="Deliver and inspect guest lane plans without executing tiers")
    a = p.parse_args()
    started = time.monotonic()
    root = Path("/home/user/TemporaryFiles/otk/plans/test-suite-rearchitecture/evidence/c16") / ("matrix-" + str(uuid.uuid4()))
    base = "missing"
    paths = b""
    if a.base:
        resolved = subprocess.run(["git", "rev-parse", "--verify", a.base + "^{commit}"], cwd=vm.SOURCE, capture_output=True)
        if resolved.returncode == 0:
            base = resolved.stdout.decode().strip()
            # Disabling rename compression yields both old and new names, including deletions.
            paths = subprocess.check_output(["git", "diff", "--no-renames", "--name-only", "-z", base, "--"], cwd=vm.SOURCE)
    paths += subprocess.check_output(["git", "ls-files", "--others", "--exclude-standard", "-z"], cwd=vm.SOURCE)
    guests = a.guests.split(",") if a.guests else list(vm.VERSIONS)
    vm.require(len(guests) == len(set(guests)) and all(g in vm.VERSIONS for g in guests), "Unknown/duplicate guest")
    for guest in guests:
        vm.identify(guest)
    if a.lane == "full":
        vm.require(set(guests) == set(vm.VERSIONS), "Full matrix requires A/B/C")
    else:
        # Guest evaluates the map. Ark consumes only the returned routing metadata.
        r = vm.run("otk-tests-a", ["deno", "run", "-A", "scripts/tests/selection-cli.ts", "--changed-paths", ".test-state/transport/changed.paths"], root / "selection", paths, base)
        vm.require(r["exit"] == 0 and r["complete"], "Guest selection failed")
        selection = json.loads((root / "selection/guest.log").read_text())
        if not selection["broad"] and not a.guests:
            guests = ["otk-tests-a"]
        if selection["broad"]:
            vm.require(set(guests) == set(vm.VERSIONS), "Broad selection requires A/B/C")
    def invoke(guest):
        if a.lane == "full":
            command = ["deno", "task", "test:full", "--version", vm.VERSIONS[guest]]
        else:
            command = ["deno", "task", "test:commit", "--changed-paths", ".test-state/transport/changed.paths"]
            if a.areas:
                command += ["--areas", a.areas]
        if a.shard:
            command += ["--shard=" + a.shard]
        if a.dry_run:
            command += ["--dry-run"]
        try:
            return vm.run(guest, command, root / guest, paths, base, matrix_full=a.lane == "full")
        except Exception as error:
            return {"guest": guest, "tree": None, "complete": False, "exit": 1, "error": str(error)}
    with ThreadPoolExecutor(max_workers=3) as pool:
        receipts = list(pool.map(invoke, guests))
    trees = {r["tree"] for r in receipts}
    complete = len(receipts) == len(guests) and len(trees) == 1 and all(r["complete"] for r in receipts)
    merge = {"exit": 0, "qualification": False} if a.dry_run else merge_reports(root, receipts) if complete else {"exit": 1}
    result = {"schema": 1, "lane": a.lane, "base": base, "complete": complete, "receipts": receipts,
              "merge": merge, "qualification": not a.dry_run, "seconds": time.monotonic() - started, "targetSeconds": 900 if a.lane == "commit" else 2700,
              "exit": 0 if complete and not merge["exit"] and all(r["exit"] == 0 for r in receipts) else 1}
    (root / "matrix.json").write_text(json.dumps(result, indent=2))
    print(root / "matrix.json")
    sys.exit(result["exit"])


if __name__ == "__main__":
    main()

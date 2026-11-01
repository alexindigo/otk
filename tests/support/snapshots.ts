// SPDX-License-Identifier: LGPL-3.0-only
import { dirname, isAbsolute, join, relative, resolve } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { hash as digest, hashFiles } from "../../scripts/tests/source.ts";
export { digest };
export async function revision(
  files: string[],
  inputs: string[] = [],
): Promise<string> {
  const hashes = await hashFiles(files.sort());
  const input = [...files.map((path) => `${path}:${hashes[path]}`), ...inputs];
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(input.join("\n")),
      ),
    ),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}
export function stateRoot(): string {
  const tmp = Deno.env.get("TMPDIR");
  if (
    !tmp || !isAbsolute(tmp) ||
    ["/tmp", "/run", "/dev/shm"].some((p) =>
      tmp === p || tmp.startsWith(p + "/")
    )
  ) throw new Error("Snapshots require disk-backed workspace TMPDIR");
  return join(dirname(tmp), ".test-state");
}
export async function fileHashes(
  root: string,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const regular: string[] = [];
  async function walk(path: string) {
    for await (const entry of Deno.readDir(path)) {
      const file = join(path, entry.name), name = relative(root, file);
      if (entry.isDirectory) await walk(file);
      else if (entry.isSymlink) {
        files[name] = "symlink:" + await Deno.readLink(file);
      } else if (entry.isFile) regular.push(file);
      else throw new Error(`Unsupported snapshot file: ${name}`);
    }
  }
  await walk(root);
  for (const [path, hash] of Object.entries(await hashFiles(regular.sort()))) {
    files[relative(root, path)] = hash;
  }
  return Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
  );
}
export async function copyTree(
  source: string,
  destination: string,
): Promise<void> {
  const result = await new Deno.Command("/usr/bin/cp", {
    args: ["-a", source + "/.", destination],
    signal: AbortSignal.timeout(120_000),
  }).output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
}
export async function verifyFiles(
  root: string,
  expected: Record<string, string>,
): Promise<void> {
  if (JSON.stringify(await fileHashes(root)) !== JSON.stringify(expected)) {
    throw new Error("Snapshot file inventory/hash mismatch");
  }
}
/** Only call after stopping/joining every writer. Never remove a WAL by hand. */
export function checkpoint(path: string): void {
  const db = new DatabaseSync(path);
  try {
    const result = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()!;
    if (
      Number(result.busy) !== 0 || Number(result.log) > 0 ||
      Number(result.checkpointed) > 0
    ) throw new Error(`Snapshot checkpoint failed: ${JSON.stringify(result)}`);
    // Published read-only validation must not create WAL/SHM beside a template.
    db.exec("PRAGMA journal_mode=DELETE");
  } finally {
    db.close();
  }
  integrity(path);
}
export function integrity(path: string): void {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare("PRAGMA integrity_check").all();
    if (rows.length !== 1 || rows[0].integrity_check !== "ok") {
      throw new Error(`Snapshot integrity failed: ${JSON.stringify(rows)}`);
    }
  } finally {
    db.close();
  }
}
export async function checkpointDatabases(root: string): Promise<void> {
  for await (const entry of Deno.readDir(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory) await checkpointDatabases(path);
    else if (entry.isFile && /\.(db|sqlite|sqlite3)$/.test(entry.name)) {
      checkpoint(path);
    }
  }
}
/** Lock files are permanent inode-stable siblings, just like provider preparation. */
export async function exclusive<T>(
  target: string,
  run: () => Promise<T>,
): Promise<T> {
  await Deno.mkdir(dirname(target), { recursive: true });
  using lock = await Deno.open(target + ".lock", { create: true, write: true });
  await lock.lock(true);
  return await run();
}
export async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    return false;
  }
}
export async function destination(
  root: string,
  fixtureRoot: string,
): Promise<string> {
  const parent = await Deno.realPath(fixtureRoot);
  root = join(
    await Deno.realPath(dirname(resolve(root))),
    resolve(root).split("/").at(-1)!,
  );
  const rel = relative(parent, root);
  if (
    !rel || rel.startsWith("..") || isAbsolute(rel) ||
    ["/tmp", "/run", "/dev/shm"].some((p) =>
      parent === p || parent.startsWith(p + "/")
    )
  ) {
    throw new Error(
      "Scale destination must be inside the supplied disk-backed guest fixture root",
    );
  }
  await Deno.mkdir(root, { mode: 0o700 });
  return root;
}

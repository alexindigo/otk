// SPDX-License-Identifier: LGPL-3.0-only
import { join, relative } from "@std/path";

export async function hash(path: string): Promise<string> {
  const result = await new Deno.Command("sha256sum", {
    args: [path],
    signal: AbortSignal.timeout(30_000),
  }).output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).split(" ")[0];
}
/** Bounded argv/process population; NUL records preserve spaces/newlines in names. */
export async function hashFiles(
  paths: string[],
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (let first = 0; first < paths.length; first += 128) {
    const batch = paths.slice(first, first + 128);
    const result = await new Deno.Command("sha256sum", {
      args: ["--zero", "--", ...batch],
      signal: AbortSignal.timeout(30_000),
    }).output();
    if (!result.success) {
      throw new Error(new TextDecoder().decode(result.stderr));
    }
    const records = new TextDecoder().decode(result.stdout).split("\0");
    if (records.pop() !== "" || records.length !== batch.length) {
      throw new Error("Incomplete SHA256 inventory");
    }
    records.forEach((record, index) => {
      if (
        !/^[a-f0-9]{64}[ ]{2}/.test(record) || record.slice(66) !== batch[index]
      ) throw new Error("Mismatched SHA256 inventory record");
      hashes[batch[index]] = record.slice(0, 64);
    });
  }
  return hashes;
}
export async function sourceTree(root = Deno.cwd()): Promise<string> {
  const excluded = new Set([
    ".git",
    ".envrc",
    "node_modules",
    ".test-state",
    "tmp",
    "test-results",
    "playwright-report",
  ]);
  const files: string[] = [];
  async function walk(directory: string) {
    for await (const entry of Deno.readDir(directory)) {
      if (
        excluded.has(entry.name) || entry.name === "token" ||
        /\.(bak|local\.toml)$/.test(entry.name)
      ) continue;
      const path = join(directory, entry.name);
      if ([join(root, "web/dist"), join(root, "config")].includes(path)) {
        continue;
      }
      if (entry.isDirectory) await walk(path);
      else if (entry.isFile || entry.isSymlink) files.push(path);
    }
  }
  await walk(root);
  const lines: string[] = [];
  for (const file of files.sort()) {
    lines.push(`${await hash(file)}  ${relative(root, file)}\n`);
  }
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(lines.join("")),
  );
  return Array.from(
    new Uint8Array(bytes),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

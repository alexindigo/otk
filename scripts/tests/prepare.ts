// SPDX-License-Identifier: LGPL-3.0-only
import { join, relative } from "@std/path";
import { nativeBinary, nativeVersion } from "../../tests/support/native.ts";
import { validateProviderCache } from "../../tests/support/provider-cache.ts";

export async function hash(path: string): Promise<string> {
  const result = await new Deno.Command("sha256sum", {
    args: [path],
    signal: AbortSignal.timeout(30_000),
  }).output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).split(" ")[0];
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
export interface BuildReceipt {
  schema: 1;
  tree: string;
  binary: string;
  binarySha256: string;
  native: { path: string; version: string; sha256: string };
  providerCache: { path: string; sha256: string };
  web: Record<string, string>;
  deno: string;
  preparedAt: string;
  seconds: number;
}
export async function readBuild(tree: string): Promise<BuildReceipt> {
  const receipt: BuildReceipt = JSON.parse(
    await Deno.readTextFile(`.test-state/builds/${tree}/receipt.json`),
  );
  if (
    receipt.schema !== 1 || receipt.tree !== tree ||
    receipt.binarySha256 !== await hash(receipt.binary)
  ) {
    throw new Error(
      "Prepared binary identity mismatch; run deno task test:prepare",
    );
  }
  if (
    receipt.native.version !== nativeVersion ||
    receipt.native.sha256 !== await hash(nativeBinary)
  ) {
    throw new Error("Prepared native identity mismatch");
  }
  const cache = await validateProviderCache();
  if (
    receipt.providerCache.path !== cache ||
    receipt.providerCache.sha256 !== await hash(join(cache, "ready.json"))
  ) {
    throw new Error("Prepared provider cache identity mismatch");
  }
  for (const [path, digest] of Object.entries(receipt.web)) {
    if (await hash(path) !== digest) {
      throw new Error(`Prepared web asset changed: ${path}`);
    }
  }
  return receipt;
}
if (import.meta.main) {
  const start = performance.now();
  const versionIndex = Deno.args.indexOf("--version");
  if (versionIndex < 0 || Deno.args[versionIndex + 1] !== nativeVersion) {
    throw new Error("Select the guest's exact --version");
  }
  const tree = await sourceTree();
  if (Deno.env.get("OTK_TEST_TREE") && Deno.env.get("OTK_TEST_TREE") !== tree) {
    throw new Error("Delivered source hash mismatch");
  }
  const directory = join(Deno.cwd(), ".test-state/builds", tree);
  const binary = join(directory, "otk");
  try {
    await Deno.stat(join(directory, "receipt.json"));
    console.info(
      JSON.stringify({
        reused: true,
        receipt: await readBuild(tree),
        seconds: (performance.now() - start) / 1000,
      }),
    );
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    await Deno.mkdir(directory, { recursive: true });
    // The shipped compile recipe already owns frozen install and the one web build.
    const child = new Deno.Command(Deno.execPath(), {
      args: ["task", "compile", "x86_64-unknown-linux-gnu", binary],
      stdout: "inherit",
      stderr: "inherit",
      signal: AbortSignal.timeout(14 * 60_000),
    }).spawn();
    const status = await child.status;
    if (!status.success) throw new Error(`Compile exited ${status.code}`);
    const cache = await validateProviderCache();
    const web: Record<string, string> = {};
    const assets = async (directory: string) => {
      for await (const entry of Deno.readDir(directory)) {
        const path = join(directory, entry.name);
        if (entry.isDirectory) await assets(path);
        else if (entry.isFile) web[path] = await hash(path);
      }
    };
    await assets("web/dist");
    const receipt: BuildReceipt = {
      schema: 1,
      tree,
      binary,
      binarySha256: await hash(binary),
      native: {
        path: nativeBinary,
        version: nativeVersion,
        sha256: await hash(nativeBinary),
      },
      providerCache: {
        path: cache,
        sha256: await hash(join(cache, "ready.json")),
      },
      web,
      deno: Deno.version.deno,
      preparedAt: new Date().toISOString(),
      seconds: (performance.now() - start) / 1000,
    };
    await Deno.writeTextFile(
      join(directory, "receipt.json"),
      JSON.stringify(receipt, null, 2),
    );
    console.info(JSON.stringify(receipt));
  }
}

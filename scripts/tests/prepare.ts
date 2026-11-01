// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { nativeBinary, nativeVersion } from "../../tests/support/native.ts";
import { validateProviderCache } from "../../tests/support/provider-cache.ts";
import { prepareConsumers } from "../../tests/support/consumer-builds.ts";
import {
  SCALE_VARIANTS,
  SessionScale,
} from "../../tests/support/session-scale.ts";
import { withResources } from "../../tests/support/resources.ts";
import { FakeLlm } from "../../tests/support/fake-llm.ts";
import { hash, sourceTree } from "./source.ts";
export { hash, sourceTree } from "./source.ts";
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
  await prepareConsumers(tree);
  if (Deno.args.includes("--scale")) {
    await withResources("prepare versioned native snapshots", async () => {
      const fake = new FakeLlm();
      const snapshots: Record<string, { path: string; sha256: string }> = {};
      for (const variant of SCALE_VARIANTS) {
        const path = await SessionScale.generate(variant, fake);
        snapshots[variant] = {
          path,
          sha256: await hash(join(path, "snapshot.json")),
        };
      }
      await Deno.writeTextFile(
        join(directory, "snapshots.json"),
        JSON.stringify({ schema: 1, tree, snapshots }, null, 2),
      );
    });
  }
}

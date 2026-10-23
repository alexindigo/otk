// SPDX-License-Identifier: LGPL-3.0-only
import { dirname, join } from "@std/path";
import { FakeLlm } from "./fake-llm.ts";
import { OpencodeTest } from "./opencode.ts";
import {
  nativeVersion,
  providerCachePath,
  validateProviderCache,
} from "./provider-cache.ts";
import { resources, withResources } from "./resources.ts";

/** Task prerequisite, never a lazy registry fallback in an isolated fixture. */
export async function prepareProviderCache(): Promise<void> {
  const binary = await new Deno.Command("/usr/local/bin/opencode", {
    args: ["--version"],
    signal: AbortSignal.timeout(15_000),
  }).output();
  const version = new TextDecoder().decode(binary.stdout).trim();
  if (!binary.success || version !== nativeVersion) {
    throw new Error(
      `Native fixture requires opencode ${nativeVersion}, received ${version}: ${
        new TextDecoder().decode(binary.stderr)
      }`,
    );
  }
  const target = providerCachePath();
  await Deno.mkdir(dirname(target), { recursive: true });
  await withResources("prepare native provider dependencies", async () => {
    // Keep the inode: unlinking a lock file can let a third runner bypass waiters.
    // The kernel releases this lock even if the preparing process exits abruptly.
    const lock = await Deno.open(target + ".lock", {
      create: true,
      write: true,
    });
    resources().defer("cache preparation lock", () => lock.close());
    await lock.lock(true);
    // Recheck after joining an independent task's preparation.
    try {
      await Deno.stat(target);
      await validateProviderCache(target);
      console.info("Prepared provider cache:", target);
      return;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const stage = await Deno.makeTempDir({
      dir: dirname(target),
      prefix: ".provider-cache-",
    });
    resources().defer("cache preparation staging", async () => {
      try {
        await Deno.remove(stage, { recursive: true });
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    });
    console.info("Preparing provider cache:", target);
    const fake = new FakeLlm();
    const oc = await OpencodeTest.start(fake, {}, {
      packageCache: false,
      async prepare(oc) {
        const directory = join(oc.directory, ".opencode/tools");
        await Deno.mkdir(directory, { recursive: true });
        await Deno.writeTextFile(
          join(directory, "cache_probe.ts"),
          "export default {description:'Prepared package probe',args:{},async execute(){return 'Ready'}};",
        );
      },
    });
    await oc.stop();
    await Deno.mkdir(join(stage, "dependencies"));
    const origin = join(oc.root, "config/opencode");
    for (const name of ["package.json", "package-lock.json", "node_modules"]) {
      const result = await new Deno.Command("/usr/bin/cp", {
        args: ["-a", join(origin, name), join(stage, "dependencies", name)],
        signal: AbortSignal.timeout(30_000),
      }).output();
      if (!result.success) {
        throw new Error(new TextDecoder().decode(result.stderr));
      }
    }
    await Deno.writeTextFile(
      join(stage, "ready.json"),
      JSON.stringify({ opencode: nativeVersion }),
    );
    await validateProviderCache(stage);
    await Deno.rename(stage, target);
  });
  console.info("Prepared provider cache:", target);
}

if (import.meta.main) await prepareProviderCache();

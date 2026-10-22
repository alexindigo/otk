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

/** Explicit preparation, never a lazy registry fallback in an isolated fixture. */
export async function prepareProviderCache(): Promise<void> {
  const target = providerCachePath();
  try {
    await Deno.stat(target);
    await validateProviderCache(target);
    console.info("Prepared provider cache:", target);
    return;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await Deno.mkdir(dirname(target), { recursive: true });
  // Atomic creation is also the preparation lock across independent runners.
  const lock = target + ".lock";
  await withResources("prepare native provider dependencies", async () => {
    await Deno.mkdir(lock);
    resources().defer("cache preparation lock", async () => {
      try {
        await Deno.remove(lock, { recursive: true });
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    });
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
    await Deno.mkdir(join(lock, "dependencies"));
    const origin = join(oc.root, "config/opencode");
    for (const name of ["package.json", "package-lock.json", "node_modules"]) {
      const result = await new Deno.Command("/usr/bin/cp", {
        args: ["-a", join(origin, name), join(lock, "dependencies", name)],
      }).output();
      if (!result.success) {
        throw new Error(new TextDecoder().decode(result.stderr));
      }
    }
    await Deno.writeTextFile(
      join(lock, "ready.json"),
      JSON.stringify({ opencode: nativeVersion }),
    );
    await validateProviderCache(lock);
    await Deno.rename(lock, target);
  });
  console.info("Prepared provider cache:", target);
}

if (import.meta.main) await prepareProviderCache();

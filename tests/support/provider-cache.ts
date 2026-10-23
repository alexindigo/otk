// SPDX-License-Identifier: LGPL-3.0-only
import { dirname, isAbsolute, join } from "@std/path";

export const nativeVersion = "1.18.34";
export function providerCachePath(): string {
  const tmp = Deno.env.get("TMPDIR");
  if (!tmp || !isAbsolute(tmp)) {
    throw new Error("Provider fixtures require an absolute disk-backed TMPDIR");
  }
  return Deno.env.get("OTK_TEST_PROVIDER_CACHE") ??
    join(dirname(tmp), "provider-cache", `opencode-${nativeVersion}`);
}

export async function validateProviderCache(
  path = providerCachePath(),
): Promise<string> {
  try {
    const manifest = JSON.parse(
      await Deno.readTextFile(join(path, "ready.json")),
    );
    const plugin = JSON.parse(
      await Deno.readTextFile(
        join(
          path,
          "dependencies/node_modules/@opencode-ai/plugin/package.json",
        ),
      ),
    );
    const lock = JSON.parse(
      await Deno.readTextFile(join(path, "dependencies/package-lock.json")),
    );
    if (
      manifest.opencode !== nativeVersion || plugin.version !== nativeVersion ||
      lock.packages?.[""]?.dependencies?.["@opencode-ai/plugin"] !==
        nativeVersion
    ) {
      throw new Error("Native dependency version mismatch");
    }
  } catch (cause) {
    throw new Error(
      `Shared provider cache is missing or invalid: deno task prepare:test (${path})`,
      { cause },
    );
  }
  return path;
}

/** Config and DB stay private. Only the prepared immutable dependency tree is shared. */
export async function seedProviderPackages(directory: string): Promise<void> {
  const cache = await validateProviderCache();
  await Deno.mkdir(directory, { recursive: true });
  for (const name of ["package.json", "package-lock.json"]) {
    await Deno.copyFile(
      join(cache, "dependencies", name),
      join(directory, name),
    );
  }
  await Deno.symlink(
    join(cache, "dependencies/node_modules"),
    join(directory, "node_modules"),
  );
}

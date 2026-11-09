// SPDX-License-Identifier: LGPL-3.0-only
import { isAbsolute, relative, resolve } from "@std/path";
import type { CatalogFileListing } from "@otk/harness";
import type { Client } from "./client.ts";
import type { NativeReadiness } from "./readiness.ts";
export { CatalogFiles } from "@otk/harness";

export interface NativeFile {
  name: string;
  path: string;
  absolute: string;
  type: "file" | "directory";
  ignored: boolean;
}
/** Supported stock listings omit symlinks and mark native project-root ignores. */
export async function readCatalogFiles(
  client: Client,
  directory: string,
  path: string,
  signal: AbortSignal,
  metadata: NativeReadiness,
): Promise<CatalogFileListing> {
  const physical = await metadata.run(
    signal,
    () => Deno.realPath(resolve(directory, path)),
  );
  signal.throwIfAborted();
  const items = await client.json<NativeFile[]>("/file", {
    query: { directory, path },
    signal,
  });
  return {
    physical,
    items: items.filter((item) => !item.ignored && item.name !== ".git").map(
      (item) => {
        if (
          !item.path || !isAbsolute(item.absolute) ||
          !["file", "directory"].includes(item.type)
        ) {
          throw new Error("Malformed native file listing");
        }
        const path = relative(directory, item.absolute);
        if (path === ".." || path.startsWith("../") || isAbsolute(path)) {
          throw new Error("Native file listing escaped its directory");
        }
        return {
          path,
          canonicalPath: item.absolute,
          directory: item.type === "directory",
        };
      },
    ),
  };
}

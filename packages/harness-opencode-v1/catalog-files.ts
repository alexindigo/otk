// SPDX-License-Identifier: LGPL-3.0-only
import { isAbsolute, relative, resolve } from "@std/path";
import { type CatalogFileListing, ignoredFiles } from "@otk/harness";
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
  const candidates = items.filter((item) =>
    !item.ignored && item.name !== ".git"
  ).map(
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
  );
  // V1's ignored flag knows the project-root .gitignore and .ignore only.
  // Apply Git's nested and repository-local rules before admitting children.
  const key = (item: typeof candidates[number]) =>
    item.path + (item.directory ? "/" : "");
  const ignored = await metadata.run(
    signal,
    () => ignoredFiles(directory, candidates.map(key), signal),
  );
  return {
    physical,
    items: candidates.filter((item) => !ignored.has(key(item))),
  };
}

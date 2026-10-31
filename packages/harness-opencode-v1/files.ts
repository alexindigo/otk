// SPDX-License-Identifier: LGPL-3.0-only
import { isAbsolute, relative, resolve } from "@std/path";
import type { FilesCapability } from "@otk/harness";
import type { FileMatch } from "@otk/protocol";
import type { Client } from "./client.ts";
import type { Directory } from "./directory.ts";
import type { DirectoryCatalogs } from "./catalogs.ts";
export function files(
  client: Client,
  directory: Directory,
  catalogs?: DirectoryCatalogs,
): FilesCapability {
  return {
    async findFiles(sessionID, query, signal) {
      const dir = await directory.resolve(sessionID, signal);
      if (catalogs) {
        const values = await catalogs.get(dir, "files", signal);
        const search = (isAbsolute(query) ? relative(dir, query) : query)
          .toLowerCase();
        const exact = query
          ? values.find((item) => item.canonicalPath === resolve(dir, query))
          : undefined;
        if (exact) {
          return [
            { path: query, directory: exact.directory },
            ...values.filter((item) =>
              item !== exact && item.path.toLowerCase().includes(search)
            ).map(({ path, directory }) => ({ path, directory })),
          ];
        }
        return values.filter((item) => item.path.toLowerCase().includes(search))
          .map(({ path, directory }) => ({ path, directory }));
      }
      const search = isAbsolute(query) ? relative(dir, query) : query;
      const paths = await Promise.all(
        ["file", "directory"].map((type) =>
          client.json<string[]>("/find/file", {
            query: { directory: dir, query: search, type, limit: 100 },
            signal,
          })
        ),
      );
      const candidates = [
        ...new Set([
          ...(query ? [query === "/" ? query : query.replace(/\/+$/, "")] : []),
          ...paths.flat().map((path) =>
            path === "/" ? "." : path.replace(/\/+$/, "")
          ),
        ]),
      ];
      return (await Promise.all(candidates.map(async (path) => {
        signal?.throwIfAborted();
        const info = await statMatch(resolve(dir, path));
        signal?.throwIfAborted();
        return info ? { path, directory: info.isDirectory } : undefined;
      }))).filter((file): file is FileMatch => !!file);
    },
  };
}
/** Discovery alone may skip candidates whose metadata is no longer readable. */
async function statMatch(
  path: string,
): Promise<Deno.FileInfo | undefined> {
  try {
    return await Deno.stat(path);
  } catch {
    return undefined;
  }
}

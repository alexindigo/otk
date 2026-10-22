// SPDX-License-Identifier: LGPL-3.0-only
import { isAbsolute, relative, resolve } from "@std/path";
import type { FilesCapability } from "@otk/harness";
import type { FileMatch } from "@otk/protocol";
import type { Client } from "./client.ts";
import type { Directory } from "./directory.ts";
export function files(client: Client, directory: Directory): FilesCapability {
  return {
    async findFiles(sessionID, query) {
      const dir = await directory.resolve(sessionID);
      const search = isAbsolute(query) ? relative(dir, query) : query;
      const paths = await Promise.all(
        ["file", "directory"].map((type) =>
          client.json<string[]>("/find/file", {
            query: { directory: dir, query: search, type, limit: 100 },
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
        const info = await statMatch(resolve(dir, path));
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

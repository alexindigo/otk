// SPDX-License-Identifier: LGPL-3.0-only
import type { ContentSession } from "@otk/protocol";
import { opencodeV1SessionID as ids } from "./ids.ts";

/** One directory resolution contract for every native capability. */
export interface Directory {
  cached(id: string): string | undefined;
  resolve(id: string, signal?: AbortSignal): Promise<string>;
}
export function sessionDirectory(
  cached: Directory["cached"],
  getSession: (
    id: string,
    signal?: AbortSignal,
  ) => Promise<Pick<ContentSession, "directory">>,
): Directory {
  return {
    cached(id) {
      ids.decode(id);
      return cached(id);
    },
    async resolve(id, signal) {
      signal?.throwIfAborted();
      ids.decode(id);
      const directory = cached(id) ?? (await getSession(id, signal)).directory;
      signal?.throwIfAborted();
      return directory;
    },
  };
}

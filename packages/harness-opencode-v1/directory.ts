// SPDX-License-Identifier: LGPL-3.0-only
import type { ContentSession } from "@otk/protocol";
import type { SessionIdentity } from "@otk/harness";
import { opencodeV1SessionID as ids } from "./ids.ts";
import { HttpFailure, NativeRequestFailure } from "./client.ts";

/** One directory resolution contract for every native capability. */
export interface Directory {
  cached(id: string): string | undefined;
  resolve(id: string, signal?: AbortSignal): Promise<string>;
  validate(
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<SessionIdentity[]>;
}
export function sessionDirectory(
  cached: Directory["cached"],
  getSession: (
    id: string,
    signal?: AbortSignal,
  ) => Promise<
    Pick<ContentSession, "directory"> & {
      id?: string;
      parentID?: string | null;
    }
  >,
  validate?: Directory["validate"],
): Directory {
  return {
    async validate(wanted, signal) {
      signal?.throwIfAborted();
      const unique = [...new Set(wanted)];
      unique.forEach(ids.decode);
      if (!unique.length) return [];
      if (validate) return await validate(unique, signal);
      const result: SessionIdentity[] = [];
      // Stock has no batch GET. Serial admission never trusts a cached route.
      for (const id of unique) {
        try {
          const raw = await getSession(id, signal);
          signal?.throwIfAborted();
          if (raw.id !== undefined && ids.encode(raw.id) !== id) {
            throw new Error("Native identity mismatch");
          }
          result.push({
            id,
            directory: raw.directory,
            ...(raw.parentID ? { parentID: ids.encode(raw.parentID) } : {}),
          });
        } catch (error) {
          signal?.throwIfAborted();
          if (
            !(error instanceof NativeRequestFailure &&
              error.original instanceof HttpFailure &&
              error.original.status === 404)
          ) throw error;
        }
      }
      return result;
    },
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

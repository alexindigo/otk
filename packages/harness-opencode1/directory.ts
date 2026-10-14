// SPDX-License-Identifier: LGPL-3.0-only
import type { ContentSession } from "@otk/protocol";

/** One directory resolution contract for every native capability. */
export interface Directory {
  cached(id: string): string | undefined;
  resolve(id: string): Promise<string>;
}
export function sessionDirectory(
  cached: Directory["cached"],
  getSession: (id: string) => Promise<ContentSession>,
): Directory {
  return {
    cached,
    async resolve(id) {
      return cached(id) ?? (await getSession(id)).directory;
    },
  };
}

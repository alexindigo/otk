// SPDX-License-Identifier: LGPL-3.0-only
import { isSessionID } from "@otk/protocol";

/** All target surfaces borrow canonical titles; only the fallback strips qualification. */
export function sessionTitle(id: string, title?: string): string {
  return title?.trim() ||
    (isSessionID(id) ? id.slice(id.indexOf("-") + 1) : id);
}

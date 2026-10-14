// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ClientSession,
  createSession as clientSession,
  type SidecarConnection,
} from "@otk/client";
import type { IndexEntry } from "@otk/protocol";
import { solidState } from "./binding.ts";
export function createSession(
  connection: (id: string) => SidecarConnection,
  entry: (sidecarId: string, id: string) => IndexEntry | undefined,
): ClientSession {
  return clientSession(connection, entry, solidState);
}

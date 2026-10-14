// SPDX-License-Identifier: LGPL-3.0-only
import {
  apiBase,
  type ClientSidecars,
  createSidecars as clientSidecars,
} from "@otk/client";
import type { ServerFrame } from "@otk/protocol";
import { solidState } from "./binding.ts";
export function createSidecars(
  onFrame: (id: string, frame: ServerFrame) => void,
): ClientSidecars {
  return clientSidecars(onFrame, {
    connection: { api: apiBase("", import.meta.url) },
  }, solidState);
}

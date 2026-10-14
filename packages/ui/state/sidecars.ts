// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ClientSidecars,
  createSidecars as clientSidecars,
  type SidecarsOptions,
} from "@otk/client";
import type { ServerFrame } from "@otk/protocol";
import { solidState } from "./binding.ts";
export function createSidecars(
  onFrame: (id: string, frame: ServerFrame) => void,
  options: SidecarsOptions = {},
): ClientSidecars {
  return clientSidecars(onFrame, options, solidState);
}

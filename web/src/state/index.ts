// SPDX-License-Identifier: LGPL-3.0-only
import { type ClientIndex, createIndex as clientIndex } from "@otk/client";
import { solidState } from "./binding.ts";
export function createIndex(): ClientIndex {
  return clientIndex(solidState);
}

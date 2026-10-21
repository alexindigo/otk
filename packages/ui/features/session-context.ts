// SPDX-License-Identifier: LGPL-3.0-only
import type { Selection } from "@otk/client";

/** Shared session identity for tabs, chips and the Sessions view. No callbacks. */
export interface SessionContextTarget extends Selection {
  directory: string;
  title: string;
}

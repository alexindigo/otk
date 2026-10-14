// SPDX-License-Identifier: LGPL-3.0-only
import { HarnessError } from "@otk/harness";
import type { FrecencyOptions } from "@otk/store";

export const frecencyOptions: FrecencyOptions = {
  invalid: () =>
    new HarnessError("params", "Invalid frecency path length or value"),
};

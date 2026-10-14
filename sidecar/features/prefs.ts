// SPDX-License-Identifier: LGPL-3.0-only
import { DEFAULT_PREFS, isPreference, type Preferences } from "@otk/protocol";
import { HarnessError } from "@otk/harness";
import type { PrefsOptions } from "@otk/store";

export const prefsOptions: PrefsOptions<Preferences> = {
  defaults: DEFAULT_PREFS,
  validate: isPreference,
  invalid: () => new HarnessError("params", "Invalid preference key or value"),
};

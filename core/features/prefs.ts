// SPDX-License-Identifier: LGPL-3.0-only
import { DEFAULT_PREFS, isPreference, type Preferences } from "@otk/protocol";
import { HarnessError } from "@otk/harness";
import type { Prefs, PrefsOptions } from "@otk/store";
import type { Harness } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";

export const prefsOptions: PrefsOptions<Preferences> = {
  defaults: DEFAULT_PREFS,
  validate: isPreference,
  invalid: () => new HarnessError("params", "Invalid preference key or value"),
};

export function register(
  rpc: RpcRegistry,
  _harness: Harness,
  prefs: Prefs<Preferences>,
): void {
  rpc.register("prefs.get", {
    params: () => undefined,
    handler: () => prefs.get(),
  });
  rpc.register("prefs.set", {
    params: (p) => p,
    handler: (_ctx, p) => prefs.set(p.key, p.value),
  });
}

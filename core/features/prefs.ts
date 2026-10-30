// SPDX-License-Identifier: LGPL-3.0-only
import { DEFAULT_PREFS, isPreference, type Preferences } from "@otk/protocol";
import { HarnessError } from "@otk/harness";
import type { Prefs, PrefsOptions } from "@otk/store";
import type { Harness } from "@otk/harness";
import type { RpcRegistry } from "../ws/registry.ts";
import {
  localExecution,
  localWrite,
  type MetadataReceipt,
  metadataReceipt,
  readExecution,
} from "../requests/policies.ts";
import { object } from "../ws/params.ts";

export const preferencesReceipt = (
  options: PrefsOptions<Preferences>,
): MetadataReceipt<Preferences> =>
  metadataReceipt("preferences", (value) => {
    const snapshot = object(value);
    const result: Partial<Preferences> = {};
    for (const key of Object.keys(options.defaults)) {
      if (!options.validate(key, snapshot[key])) {
        throw new TypeError("Invalid preferences receipt");
      }
      Object.assign(result, { [key]: structuredClone(snapshot[key]) });
    }
    return result as Preferences;
  });

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
  const receipt = preferencesReceipt(prefs.options);
  rpc.register("prefs.get", {
    execution: readExecution(() => ({ resource: "preferences" })),
    params: () => undefined,
    handler: () => prefs.get(),
  });
  rpc.register("prefs.set", {
    execution: localExecution(
      () => ({ resource: "preferences" }),
      receipt,
    ),
    params: (p) => {
      if (!prefs.options.validate(p.key, p.value)) {
        throw prefs.options.invalid();
      }
      return { key: p.key, value: p.value };
    },
    handler: (ctx, p) =>
      localWrite(
        ctx,
        (tx) => prefs.set(p.key, p.value, tx),
        receipt,
      ),
  });
}

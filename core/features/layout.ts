// SPDX-License-Identifier: LGPL-3.0-only
import type { Preferences } from "@otk/protocol";
import type { Prefs } from "@otk/store";
import type { RpcRegistry } from "../ws/registry.ts";

/** Field intents merge at the authoritative owner, never against view props. */
export function register(rpc: RpcRegistry, prefs: Prefs<Preferences>): void {
  rpc.register("layout.patch", {
    params: (patch) => patch,
    // No await between reading and saving: other gestures/tabs cannot interleave.
    // Prefs validates the complete result before persistence or broadcast.
    handler: (_ctx, patch) =>
      prefs.set("shellLayout", { ...prefs.get().shellLayout, ...patch }),
  });
}
